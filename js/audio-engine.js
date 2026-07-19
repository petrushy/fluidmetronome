(function () {
  class FluidMetronomeEngine {
    constructor() {
      this.audioContext = null;
      this.masterGain = null;
      this.transportNode = null;
      this.workletReady = null;
      this.isRunning = false;
      this.transportGeneration = 0;
      this.pattern = null;
      this.trackSamples = new Map();
      this.trackSampleKeys = new Map();
      this.noiseBuffers = new Map();
      this.presetBuffers = new Map();
      this.presetBufferPromises = new Map();
      this.timingStatus = {
        state: "idle",
        latest_lead_ms: null,
        worst_lead_ms: null,
        late_hits: 0,
        checked_at_ms: 0,
      };
    }

    ensureContext() {
      if (this.audioContext) {
        return this.audioContext;
      }

      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) {
        throw new Error("Web Audio is not supported in this browser.");
      }

      this.audioContext = new Context({ latencyHint: "interactive" });
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.7;
      this.masterGain.connect(this.audioContext.destination);
      return this.audioContext;
    }

    async resumeContext() {
      const context = this.ensureContext();
      if (context.state === "suspended") {
        try {
          await context.resume();
        } catch (error) {
          console.error("Failed to resume AudioContext", error);
        }
      }

      return context;
    }

    async ensureTransportNode() {
      if (this.transportNode) {
        return this.transportNode;
      }

      if (this.workletReady) {
        return this.workletReady;
      }

      const context = this.ensureContext();
      this.workletReady = context.audioWorklet.addModule("/js/audio-worklet.js")
        .then(() => {
          const node = new AudioWorkletNode(context, "fluid-metronome-processor", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });

          node.port.onmessage = (event) => {
            this.handleTransportMessage(event.data || {});
          };
          node.connect(context.destination);
          this.transportNode = node;

          if (this.pattern) {
            this.postPatternToTransport();
          }

          return node;
        })
        .catch((error) => {
          this.workletReady = null;
          throw error;
        });

      return this.workletReady;
    }

    handleTransportMessage(message) {
      if (message.type === "stalled") {
        if (message.generation === this.transportGeneration) {
          console.error("Transport stalled: pattern cannot advance.");
          this.stop();
        }
        return;
      }

      if (message.type !== "trigger" || !this.isRunning || !this.pattern) {
        return;
      }

      if (message.generation !== this.transportGeneration) {
        return;
      }

      const when = Number(message.when);
      const stepIndex = Number(message.stepIndex);
      if (!Number.isFinite(when) || !Number.isInteger(stepIndex)) {
        return;
      }

      this.updateTimingStatus(when);
      this.scheduleStepPlayback(stepIndex, when);
    }

    updateTimingStatus(when) {
      if (!this.audioContext) {
        return;
      }

      const now = this.audioContext.currentTime;
      const leadMs = (when - now) * 1000;
      const checkedAtMs = performance.now();
      const isLate = leadMs < 2;
      const recentLateHits = isLate
        ? Math.min(this.timingStatus.late_hits + 1, 99)
        : Math.max(this.timingStatus.late_hits - 1, 0);
      const worstLeadMs = this.timingStatus.worst_lead_ms === null
        ? leadMs
        : Math.min(this.timingStatus.worst_lead_ms, leadMs);

      this.timingStatus = {
        state: isLate ? "late" : "tight",
        latest_lead_ms: leadMs,
        worst_lead_ms: worstLeadMs,
        late_hits: recentLateHits,
        checked_at_ms: checkedAtMs,
      };
    }

    timingSnapshot() {
      const snapshot = { ...this.timingStatus };
      if (this.isRunning && this.audioContext) {
        const ageMs = performance.now() - snapshot.checked_at_ms;
        if (ageMs > 1200) {
          snapshot.state = "unknown";
        } else if (snapshot.late_hits > 0 || (snapshot.latest_lead_ms ?? 999) < 2) {
          snapshot.state = "late";
        } else {
          snapshot.state = "tight";
        }
      } else {
        snapshot.state = "idle";
      }

      return snapshot;
    }

    postPatternToTransport() {
      if (!this.transportNode || !this.pattern) {
        return;
      }

      this.transportNode.port.postMessage({
        type: "pattern",
        pattern: this.pattern,
      });
    }

    setPattern(pattern) {
      if (!pattern || !Array.isArray(pattern.steps) || pattern.steps.length === 0) {
        throw new Error("Pattern is empty.");
      }

      this.pattern = pattern;
      this.ensureRemoteTrackSamples();
      this.ensurePresetBuffers();
      this.postPatternToTransport();
    }

    scheduleStepPlayback(stepIndex, when) {
      if (!this.pattern) {
        return;
      }

      const scheduledWhen = Math.max(when, this.audioContext.currentTime + 0.0005);
      this.pattern.tracks.forEach((track, trackIndex) => {
        const velocity = track.step_velocities?.[stepIndex] ?? (track.enabled_steps?.[stepIndex] ? 3 : 0);
        if (!velocity) {
          return;
        }

        const sampleBuffer = this.trackSamples.get(trackIndex);
        if (sampleBuffer) {
          this.playSample(sampleBuffer, velocity, scheduledWhen);
          return;
        }

        this.playPreset(track.sound_preset || "metronome", track.instrument, track.note, velocity, scheduledWhen);
      });
    }

    playPreset(preset, instrument, note, velocity, when) {
      const gainScale = this.velocityGain(velocity);
      const presetKey = this.presetBufferKey(preset, instrument, note);
      const presetBuffer = this.presetBuffers.get(presetKey);
      if (presetBuffer) {
        this.playBuffer(presetBuffer, gainScale, when);
        return;
      }

      this.primePresetBuffer(preset, instrument, note).catch((error) => {
        console.error("Failed to render preset buffer", error);
      });

      this.renderPresetToDestination(
        this.audioContext,
        this.masterGain,
        preset,
        instrument,
        note,
        gainScale,
        when,
      );
    }

    renderPresetToDestination(context, destination, preset, instrument, note, gainScale, when) {
      switch (preset) {
        case "bright-click":
          this.renderClickVoice(context, destination, { ...this.instrumentSettings("Accent"), gain: 0.22 }, note, gainScale, when);
          return;
        case "soft-click":
          this.renderClickVoice(context, destination, { ...this.instrumentSettings("Click"), gain: 0.12, highpass: 500 }, note, gainScale, when);
          return;
        case "hihat-closed":
          this.renderNoiseVoice(context, destination, { highpass: 6500, bandpass: 9000, decay: 0.035, gain: 0.18 }, gainScale, when);
          return;
        case "hihat-open":
          this.renderNoiseVoice(context, destination, { highpass: 5000, bandpass: 7600, decay: 0.12, gain: 0.14 }, gainScale, when);
          return;
        case "cowbell":
          this.renderMetalVoice(context, destination, [540, 800], note, gainScale, when);
          return;
        case "woodblock":
          this.renderWoodblockVoice(context, destination, note, gainScale, when);
          return;
        case "thump":
          this.renderClickVoice(context, destination, { ...this.instrumentSettings("Low"), frequency: 180, highpass: 80, decay: 0.09 }, note, gainScale, when);
          return;
        case "metronome":
        default:
          this.renderClickVoice(context, destination, this.instrumentSettings(instrument), note, gainScale, when);
      }
    }

    playClick(settings, note, velocity, when) {
      this.renderClickVoice(
        this.audioContext,
        this.masterGain,
        settings,
        note,
        this.velocityGain(velocity),
        when,
      );
    }

    playNoisePreset(settings, velocity, when) {
      this.renderNoiseVoice(
        this.audioContext,
        this.masterGain,
        settings,
        this.velocityGain(velocity),
        when,
      );
    }

    playMetalPreset(partials, note, velocity, when) {
      this.renderMetalVoice(
        this.audioContext,
        this.masterGain,
        partials,
        note,
        this.velocityGain(velocity),
        when,
      );
    }

    playWoodblockPreset(note, velocity, when) {
      this.renderWoodblockVoice(
        this.audioContext,
        this.masterGain,
        note,
        this.velocityGain(velocity),
        when,
      );
    }

    playBuffer(buffer, gainScale, when) {
      const context = this.audioContext;
      const source = context.createBufferSource();
      const gain = context.createGain();

      source.buffer = buffer;
      gain.gain.setValueAtTime(gainScale, when);

      source.connect(gain);
      gain.connect(this.masterGain);
      source.start(when);
    }

    playSample(buffer, velocity, when) {
      this.playBuffer(buffer, this.velocityGain(velocity), when);
    }

    ensureRemoteTrackSamples() {
      if (!this.pattern) {
        return;
      }

      this.pattern.tracks.forEach((track, trackIndex) => {
        const remoteUrl = track.sample_download_url;
        if (!remoteUrl) {
          if (this.trackSampleKeys.get(trackIndex)?.startsWith("remote:")) {
            this.trackSamples.delete(trackIndex);
            this.trackSampleKeys.delete(trackIndex);
          }
          return;
        }

        const nextKey = `remote:${remoteUrl}`;
        if (this.trackSampleKeys.get(trackIndex) === nextKey) {
          return;
        }

        this.loadRemoteSample(trackIndex, remoteUrl).catch((error) => {
          console.error("Failed to load remote sample", error);
        });
      });
    }

    getNoiseBuffer(context = this.ensureContext()) {
      const sampleRate = context.sampleRate;
      if (this.noiseBuffers.has(sampleRate)) {
        return this.noiseBuffers.get(sampleRate);
      }
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffers.set(sampleRate, buffer);
      return buffer;
    }

    presetBufferKey(preset, instrument, note) {
      return `${preset}|${instrument || ""}|${note || ""}`;
    }

    ensurePresetBuffers() {
      if (!this.pattern) {
        return;
      }

      this.pattern.tracks.forEach((track, trackIndex) => {
        if (this.trackSamples.has(trackIndex)) {
          return;
        }

        this.primePresetBuffer(track.sound_preset || "metronome", track.instrument, track.note).catch((error) => {
          console.error("Failed to prewarm preset buffer", error);
        });
      });
    }

    async preparePatternSounds() {
      if (!this.pattern) {
        return;
      }

      const renders = this.pattern.tracks
        .filter((_, trackIndex) => !this.trackSamples.has(trackIndex))
        .map((track) => this.primePresetBuffer(track.sound_preset || "metronome", track.instrument, track.note));
      await Promise.all(renders);
    }

    presetDurationSeconds(preset, instrument) {
      switch (preset) {
        case "hihat-open":
          return 0.22;
        case "thump":
          return 0.18;
        case "cowbell":
          return 0.16;
        case "woodblock":
          return 0.12;
        case "metronome":
        case "bright-click":
        case "soft-click":
        default:
          return Math.max(0.12, this.instrumentSettings(instrument).decay + 0.05);
      }
    }

    async primePresetBuffer(preset, instrument, note) {
      const key = this.presetBufferKey(preset, instrument, note);
      if (this.presetBuffers.has(key)) {
        return this.presetBuffers.get(key);
      }

      if (this.presetBufferPromises.has(key)) {
        return this.presetBufferPromises.get(key);
      }

      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineContext) {
        return null;
      }

      const context = this.ensureContext();
      const sampleRate = context.sampleRate;
      const duration = this.presetDurationSeconds(preset, instrument);
      const offline = new OfflineContext(1, Math.ceil(sampleRate * duration), sampleRate);
      const renderWhen = 0.005;

      this.renderPresetToDestination(offline, offline.destination, preset, instrument, note, 1, renderWhen);

      const promise = offline.startRendering()
        .then((buffer) => {
          this.presetBuffers.set(key, buffer);
          this.presetBufferPromises.delete(key);
          return buffer;
        })
        .catch((error) => {
          this.presetBufferPromises.delete(key);
          throw error;
        });

      this.presetBufferPromises.set(key, promise);
      return promise;
    }

    renderClickVoice(context, destination, settings, note, gainScale, when) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const transient = context.createBiquadFilter();

      const baseFrequency = this.noteFrequency(note, settings.frequency);

      oscillator.type = settings.type;
      oscillator.frequency.setValueAtTime(baseFrequency * settings.pitchStart, when);
      oscillator.frequency.exponentialRampToValueAtTime(baseFrequency, when + settings.pitchDrop);

      transient.type = "highpass";
      transient.frequency.setValueAtTime(settings.highpass, when);

      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(settings.gain * gainScale, when + settings.attack);
      gain.gain.exponentialRampToValueAtTime(settings.sustain * gainScale, when + settings.body);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + settings.decay);

      oscillator.connect(transient);
      transient.connect(gain);
      gain.connect(destination);
      oscillator.start(when);
      oscillator.stop(when + settings.decay + 0.02);
    }

    renderNoiseVoice(context, destination, settings, gainScale, when) {
      const source = context.createBufferSource();
      const highpass = context.createBiquadFilter();
      const bandpass = context.createBiquadFilter();
      const gain = context.createGain();

      source.buffer = this.getNoiseBuffer(context);
      highpass.type = "highpass";
      highpass.frequency.setValueAtTime(settings.highpass, when);
      bandpass.type = "bandpass";
      bandpass.frequency.setValueAtTime(settings.bandpass, when);
      bandpass.Q.value = 0.8;

      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(settings.gain * gainScale, when + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + settings.decay);

      source.connect(highpass);
      highpass.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(destination);
      source.start(when);
      source.stop(when + settings.decay + 0.03);
    }

    renderMetalVoice(context, destination, partials, note, gainScale, when) {
      const base = this.noteFrequency(note, partials[0]);
      partials.forEach((partial, index) => {
        this.renderClickVoice(
          context,
          destination,
          {
            frequency: index === 0 ? base : base * (partial / partials[0]),
            gain: (index === 0 ? 0.14 : 0.1) * gainScale,
            sustain: 0.04,
            attack: 0.001,
            body: 0.01,
            decay: 0.07,
            pitchStart: 1.06,
            pitchDrop: 0.012,
            highpass: 700,
            type: "square",
          },
          note,
          1,
          when,
        );
      });
    }

    renderWoodblockVoice(context, destination, note, gainScale, when) {
      this.renderClickVoice(
        context,
        destination,
        {
          frequency: this.noteFrequency(note, 880),
          gain: 0.16 * gainScale,
          sustain: 0.05,
          attack: 0.001,
          body: 0.012,
          decay: 0.05,
          pitchStart: 1.18,
          pitchDrop: 0.01,
          highpass: 400,
          type: "triangle",
        },
        note,
        1,
        when,
      );
    }

    async loadRemoteSample(trackIndex, url) {
      const context = this.ensureContext();
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Sample download failed with status ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      this.trackSamples.set(trackIndex, audioBuffer);
      this.trackSampleKeys.set(trackIndex, `remote:${url}`);
    }

    instrumentSettings(instrument) {
      switch (instrument) {
        case "Accent":
          return {
            frequency: 1760,
            gain: 0.2,
            sustain: 0.06,
            attack: 0.0015,
            body: 0.012,
            decay: 0.04,
            pitchStart: 1.3,
            pitchDrop: 0.01,
            highpass: 900,
            type: "triangle",
          };
        case "Low":
          return {
            frequency: 220,
            gain: 0.22,
            sustain: 0.08,
            attack: 0.002,
            body: 0.018,
            decay: 0.07,
            pitchStart: 1.08,
            pitchDrop: 0.016,
            highpass: 120,
            type: "triangle",
          };
        case "Click":
        default:
          return {
            frequency: 1320,
            gain: 0.18,
            sustain: 0.045,
            attack: 0.001,
            body: 0.008,
            decay: 0.028,
            pitchStart: 1.45,
            pitchDrop: 0.008,
            highpass: 700,
            type: "triangle",
          };
      }
    }

    noteFrequency(note, fallbackFrequency) {
      if (!note || typeof note !== "string") {
        return fallbackFrequency;
      }

      const trimmed = note.trim();
      if (/^-?\d+$/.test(trimmed)) {
        const midi = Number.parseInt(trimmed, 10);
        if (Number.isFinite(midi) && midi >= 0 && midi <= 127) {
          return 440 * 2 ** ((midi - 69) / 12);
        }
      }

      const match = trimmed.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
      if (!match) {
        return fallbackFrequency;
      }

      const [, letter, accidental, octaveText] = match;
      const octave = Number.parseInt(octaveText, 10);
      const semitoneMap = {
        C: 0,
        D: 2,
        E: 4,
        F: 5,
        G: 7,
        A: 9,
        B: 11,
      };

      let semitone = semitoneMap[letter.toUpperCase()];
      if (accidental === "#") semitone += 1;
      if (accidental === "b") semitone -= 1;

      const midi = (octave + 1) * 12 + semitone;
      return 440 * 2 ** ((midi - 69) / 12);
    }

    velocityGain(velocity) {
      switch (velocity) {
        case 1:
          return 0.45;
        case 2:
          return 0.72;
        case 3:
        default:
          return 1;
      }
    }

    // Audition a single sound outside the transport. Plays the track's loaded
    // sample when it has one, so what you hear is what the grid would play.
    async preview(trackIndex, preset, instrument, note, velocity) {
      await this.resumeContext();

      // A short lead keeps the attack intact; scheduling at currentTime exactly
      // can clip the first milliseconds.
      const when = this.audioContext.currentTime + 0.02;
      const sampleBuffer = trackIndex === null ? null : this.trackSamples.get(trackIndex);

      if (sampleBuffer) {
        this.playSample(sampleBuffer, velocity, when);
        return true;
      }

      await this.primePresetBuffer(preset, instrument, note).catch(() => null);
      this.playPreset(preset, instrument, note, velocity, when);
      return true;
    }

    start(pattern) {
      this.setPattern(pattern);
      this.isRunning = true;
      this.transportGeneration += 1;
      this.timingStatus = {
        state: "unknown",
        latest_lead_ms: null,
        worst_lead_ms: null,
        late_hits: 0,
        checked_at_ms: performance.now(),
      };
      const generation = this.transportGeneration;
      void this.startTransport(generation);
      return true;
    }

    async startTransport(generation) {
      try {
        await this.resumeContext();
        await this.ensureTransportNode();
        await this.preparePatternSounds();
        if (!this.isRunning || generation !== this.transportGeneration) {
          return;
        }

        this.postPatternToTransport();
        this.transportNode.port.postMessage({
          type: "start",
          generation,
        });
      } catch (error) {
        this.isRunning = false;
        console.error("Failed to start transport", error);
      }
    }

    stop() {
      this.isRunning = false;
      this.transportGeneration += 1;
      this.timingStatus = {
        state: "idle",
        latest_lead_ms: null,
        worst_lead_ms: null,
        late_hits: 0,
        checked_at_ms: performance.now(),
      };
      if (this.transportNode) {
        this.transportNode.port.postMessage({
          type: "stop",
          generation: this.transportGeneration,
        });
      }
    }
  }

  const engine = new FluidMetronomeEngine();

  window.fluidMetronomeStart = function (patternJson) {
    const pattern = JSON.parse(patternJson);
    engine.start(pattern);
    return true;
  };

  window.fluidMetronomeStop = function () {
    engine.stop();
  };

  window.fluidMetronomeSetPattern = function (patternJson) {
    const pattern = JSON.parse(patternJson);
    engine.setPattern(pattern);
  };

  window.fluidMetronomeLoadTrackSample = async function (trackIndex, file) {
    const context = engine.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    engine.trackSamples.set(trackIndex, audioBuffer);
    engine.trackSampleKeys.set(trackIndex, `local:${file.name}:${file.size}:${file.lastModified}`);
    return true;
  };

  // trackIndex may be -1 to audition a preset that no track has adopted yet.
  window.fluidMetronomePreviewSound = async function (trackIndex, preset, instrument, note) {
    const index = trackIndex < 0 ? null : trackIndex;
    return engine.preview(index, preset || "metronome", instrument, note, 3);
  };

  window.fluidMetronomeGetTimingStatus = function () {
    return JSON.stringify(engine.timingSnapshot());
  };
})();
