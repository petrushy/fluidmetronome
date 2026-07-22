(function () {
  // Per-preset level trim. The hand-tuned voice gains drifted about 8x apart
  // -- bright-click peaked at 0.05 while cowbell hit 0.39 -- which made the
  // default metronome presets nearly inaudible on laptop speakers. These
  // factors normalise every preset to roughly the same peak; see
  // TARGET_PEAK below. Re-measure before changing a voice's gain.
  const PRESET_TRIM = {
    "bright-click": 7.0,
    "soft-click": 5.6,
    // Noise voices peak stochastically, so these are set from the measured
    // peak across runs rather than derived from the voice gain.
    "hihat-closed": 2.05,
    "hihat-open": 2.55,
    "cowbell": 0.9,
    "woodblock": 4.1,
    "thump": 1.5,
  };

  // "metronome" is the one preset that takes its voice from the track's
  // instrument, so it needs a trim per instrument rather than a single value.
  const METRONOME_TRIM = {
    "Click": 4.7,
    "Accent": 7.6,
    "Low": 1.6,
  };

  // Peak amplitude each preset aims for before the master gain. Leaves room for
  // several tracks landing on the same step without slamming the limiter.
  const TARGET_PEAK = 0.35;

  class FluidMetronomeEngine {
    constructor() {
      this.audioContext = null;
      this.masterGain = null;
      this.transportNode = null;
      this.workletReady = null;
      this.isRunning = false;
      this.transportGeneration = 0;
      this.patternRevision = 0;
      this.pattern = null;
      // Every transport generation receives its own output gate. Retiring a
      // gate silences sources already scheduled by Web Audio without muting a
      // preview or allowing a stopped generation to reappear on the next start.
      this.transportGain = null;
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

      // Catches the summed peak when several tracks fire on the same step.
      // Fast attack and a high ratio make this behave as a limiter rather than
      // an audible compressor, so single hits pass through untouched.
      this.masterLimiter = this.audioContext.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -6;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.002;
      this.masterLimiter.release.value = 0.12;

      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.audioContext.destination);
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

      if (Number(message.revision) !== this.patternRevision) {
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
        if (ageMs > 1200 && this.audioContext.state === "suspended") {
          // AudioContext stayed suspended despite start() — worklet is not running.
          snapshot.state = "idle";
        } else if (ageMs > 1200) {
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
        revision: this.patternRevision,
      });
    }

    setPattern(pattern) {
      if (!pattern || !Array.isArray(pattern.steps) || pattern.steps.length === 0) {
        throw new Error("Pattern is empty.");
      }

      const wasRunning = this.isRunning;
      this.pattern = pattern;
      this.patternRevision += 1;

      // The worklet can already have up to a lookahead window of old sources
      // queued. Put the new pattern on a fresh gate so those old hits cannot
      // survive a live edit and play with the wrong instruments or velocities.
      if (wasRunning) {
        this.replaceTransportOutput();
      }
      this.ensureRemoteTrackSamples();
      this.ensurePresetBuffers();
      this.postPatternToTransport();
    }

    scheduleStepPlayback(stepIndex, when) {
      if (!this.pattern) {
        return;
      }

      const scheduledWhen = Math.max(when, this.audioContext.currentTime + 0.0005);
      const destination = this.transportGain || this.masterGain;
      this.pattern.tracks.forEach((track, trackIndex) => {
        const velocity = track.step_velocities?.[stepIndex] ?? (track.enabled_steps?.[stepIndex] ? 3 : 0);
        if (!velocity) {
          return;
        }

        const sampleBuffer = this.trackSamples.get(trackIndex);
        if (sampleBuffer) {
          this.playSample(sampleBuffer, velocity, scheduledWhen, destination);
          return;
        }

        this.playPreset(track.sound_preset || "metronome", track.instrument, track.note, velocity, scheduledWhen, destination);
      });
    }

    playPreset(preset, instrument, note, velocity, when, destination = this.masterGain) {
      const gainScale = this.velocityGain(velocity);
      const presetKey = this.presetBufferKey(preset, instrument, note);
      const presetBuffer = this.presetBuffers.get(presetKey);
      if (presetBuffer) {
        this.playBuffer(presetBuffer, gainScale, when, destination);
        return;
      }

      this.primePresetBuffer(preset, instrument, note).catch((error) => {
        console.error("Failed to render preset buffer", error);
      });

      this.renderPresetToDestination(
        this.audioContext,
        destination,
        preset,
        instrument,
        note,
        gainScale,
        when,
      );
    }

    presetTrim(preset, instrument) {
      if (preset === "metronome" || !preset) {
        return METRONOME_TRIM[instrument] ?? METRONOME_TRIM.Click;
      }

      return PRESET_TRIM[preset] ?? 1;
    }

    renderPresetToDestination(context, destination, preset, instrument, note, rawGainScale, when) {
      // Applied here rather than at playback so pre-rendered preset buffers
      // carry the trim too, and both paths stay level-matched.
      const gainScale = rawGainScale * this.presetTrim(preset, instrument);

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

    playBuffer(buffer, gainScale, when, destination = this.masterGain) {
      const context = this.audioContext;
      const source = context.createBufferSource();
      const gain = context.createGain();

      source.buffer = buffer;
      gain.gain.setValueAtTime(gainScale, when);

      source.connect(gain);
      gain.connect(destination);
      source.start(when);
    }

    playSample(buffer, velocity, when, destination = this.masterGain) {
      this.playBuffer(buffer, this.velocityGain(velocity), when, destination);
    }

    ensureRemoteTrackSamples() {
      if (!this.pattern) {
        return;
      }

      this.pattern.tracks.forEach((track, trackIndex) => {
        const remoteUrl = track.sample_download_url;
        if (!remoteUrl) {
          const localKey = track.sample_name ? `local:${track.sample_name}` : null;
          if (this.trackSampleKeys.get(trackIndex) !== localKey) {
            this.trackSamples.delete(trackIndex);
            this.trackSampleKeys.delete(trackIndex);
          }
          return;
        }

        const nextKey = `remote:${remoteUrl}`;
        if (this.trackSampleKeys.get(trackIndex) === nextKey) {
          return;
        }

        // Mark the request before fetching. This prevents duplicate downloads
        // on each UI re-render and lets a later pattern change invalidate an
        // older request before it resolves.
        this.trackSamples.delete(trackIndex);
        this.trackSampleKeys.set(trackIndex, nextKey);
        this.loadRemoteSample(trackIndex, remoteUrl, nextKey).catch((error) => {
          // Permit a later pattern sync to retry a transient network failure.
          // Do not clear a newer selection that replaced this request meanwhile.
          if (this.trackSampleKeys.get(trackIndex) === nextKey) {
            this.trackSampleKeys.delete(trackIndex);
            this.trackSamples.delete(trackIndex);
          }
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
            gain: index === 0 ? 0.14 : 0.1,
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
          gainScale,
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
          gain: 0.16,
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
        gainScale,
        when,
      );
    }

    async loadRemoteSample(trackIndex, url, expectedKey = `remote:${url}`) {
      const context = this.ensureContext();
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Sample download failed with status ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      // A different pattern/source may have claimed this track slot while the
      // network request was pending. Never let a late response overwrite it.
      if (this.trackSampleKeys.get(trackIndex) !== expectedKey) {
        return;
      }

      this.trackSamples.set(trackIndex, audioBuffer);
    }

    createTransportOutput() {
      const context = this.ensureContext();
      const gate = context.createGain();
      gate.gain.value = 1;
      gate.connect(this.masterGain);
      this.transportGain = gate;
      return gate;
    }

    retireTransportOutput() {
      const gate = this.transportGain;
      this.transportGain = null;
      if (!gate || !this.audioContext) {
        return;
      }

      const now = this.audioContext.currentTime;
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(Math.max(gate.gain.value, 0.0001), now);
      gate.gain.exponentialRampToValueAtTime(0.0001, now + 0.003);
    }

    replaceTransportOutput() {
      this.retireTransportOutput();
      this.createTransportOutput();
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

        this.replaceTransportOutput();
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
      this.retireTransportOutput();
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
    // The Rust model persists the display name while the decoded local buffer
    // lives only in this page. Match the same key so edits retain the sample,
    // but switching pattern or selecting a preset clears it immediately.
    engine.trackSampleKeys.set(trackIndex, `local:${file.name}`);
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
