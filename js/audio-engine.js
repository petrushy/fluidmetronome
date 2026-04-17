(function () {
  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD_SECONDS = 0.12;

  class FluidMetronomeEngine {
    constructor() {
      this.audioContext = null;
      this.masterGain = null;
      this.schedulerId = null;
      this.isRunning = false;
      this.nextNoteTime = 0;
      this.nextStepIndex = 0;
      this.pattern = null;
      this.trackSamples = new Map();
      this.trackSampleKeys = new Map();
      this.noiseBuffer = null;
      this.nextStepTick = 0;
      this.loopCount = 0;
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

    resumeContext() {
      const context = this.ensureContext();
      if (context.state === "suspended") {
        context.resume().catch((error) => {
          console.error("Failed to resume AudioContext", error);
        });
      }
    }

    setPattern(pattern) {
      if (!pattern || !Array.isArray(pattern.steps) || pattern.steps.length === 0) {
        throw new Error("Pattern is empty.");
      }

      this.pattern = pattern;
      this.ensureRemoteTrackSamples();

      if (this.isRunning && this.audioContext) {
        const now = this.audioContext.currentTime;
        this.nextNoteTime = Math.max(this.nextNoteTime, now + 0.03);
      }
    }

    tickDurationSeconds() {
      return 60 / this.pattern.bpm / this.pattern.ticks_per_beat;
    }

    scheduleCurrentStep(stepIndex, when) {
      if (!this.pattern) {
        return;
      }

      const step = this.pattern.steps[stepIndex];
      const stepTick = this.nextStepTick;
      const modulationSeconds = this.modulationSeconds(stepTick);
      const scheduledWhen = Math.max(when + modulationSeconds, this.audioContext.currentTime + 0.001);
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

      this.nextStepTick += step.delay_ticks;
      this.nextNoteTime = when + step.delay_ticks * this.tickDurationSeconds();
      if (stepIndex + 1 >= this.pattern.steps.length) {
        this.nextStepIndex = 0;
        this.loopCount += 1;
      } else {
        this.nextStepIndex = stepIndex + 1;
      }
    }

    playPreset(preset, instrument, note, velocity, when) {
      switch (preset) {
        case "bright-click":
          this.playClick({ ...this.instrumentSettings("Accent"), gain: 0.22 }, note, velocity, when);
          return;
        case "soft-click":
          this.playClick({ ...this.instrumentSettings("Click"), gain: 0.12, highpass: 500 }, note, velocity, when);
          return;
        case "hihat-closed":
          this.playNoisePreset({ highpass: 6500, bandpass: 9000, decay: 0.035, gain: 0.18 }, velocity, when);
          return;
        case "hihat-open":
          this.playNoisePreset({ highpass: 5000, bandpass: 7600, decay: 0.12, gain: 0.14 }, velocity, when);
          return;
        case "cowbell":
          this.playMetalPreset([540, 800], note, velocity, when);
          return;
        case "woodblock":
          this.playWoodblockPreset(note, velocity, when);
          return;
        case "thump":
          this.playClick({ ...this.instrumentSettings("Low"), frequency: 180, highpass: 80, decay: 0.09 }, note, velocity, when);
          return;
        case "metronome":
        default:
          this.playClick(this.instrumentSettings(instrument), note, velocity, when);
      }
    }

    playClick(settings, note, velocity, when) {
      const context = this.audioContext;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const transient = context.createBiquadFilter();

      const velocityGain = this.velocityGain(velocity);
      const baseFrequency = this.noteFrequency(note, settings.frequency);

      oscillator.type = settings.type;
      oscillator.frequency.setValueAtTime(baseFrequency * settings.pitchStart, when);
      oscillator.frequency.exponentialRampToValueAtTime(baseFrequency, when + settings.pitchDrop);

      transient.type = "highpass";
      transient.frequency.setValueAtTime(settings.highpass, when);

      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(settings.gain * velocityGain, when + settings.attack);
      gain.gain.exponentialRampToValueAtTime(settings.sustain * velocityGain, when + settings.body);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + settings.decay);

      oscillator.connect(transient);
      transient.connect(gain);
      gain.connect(this.masterGain);
      oscillator.start(when);
      oscillator.stop(when + settings.decay + 0.02);
    }

    playNoisePreset(settings, velocity, when) {
      const context = this.audioContext;
      const source = context.createBufferSource();
      const highpass = context.createBiquadFilter();
      const bandpass = context.createBiquadFilter();
      const gain = context.createGain();

      source.buffer = this.getNoiseBuffer();
      highpass.type = "highpass";
      highpass.frequency.setValueAtTime(settings.highpass, when);
      bandpass.type = "bandpass";
      bandpass.frequency.setValueAtTime(settings.bandpass, when);
      bandpass.Q.value = 0.8;

      const scaledGain = settings.gain * this.velocityGain(velocity);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(scaledGain, when + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + settings.decay);

      source.connect(highpass);
      highpass.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(this.masterGain);
      source.start(when);
      source.stop(when + settings.decay + 0.03);
    }

    playMetalPreset(partials, note, velocity, when) {
      const base = this.noteFrequency(note, partials[0]);
      partials.forEach((partial, index) => {
        this.playClick(
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
          velocity,
          when,
        );
      });
    }

    playWoodblockPreset(note, velocity, when) {
      this.playClick(
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
        velocity,
        when,
      );
    }

    playSample(buffer, velocity, when) {
      const context = this.audioContext;
      const source = context.createBufferSource();
      const gain = context.createGain();

      source.buffer = buffer;
      gain.gain.setValueAtTime(this.velocityGain(velocity), when);

      source.connect(gain);
      gain.connect(this.masterGain);
      source.start(when);
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

    getNoiseBuffer() {
      if (this.noiseBuffer) {
        return this.noiseBuffer;
      }

      const context = this.ensureContext();
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
      return buffer;
    }

    modulationSeconds(stepTick) {
      if (!this.pattern?.modulators?.length) {
        return 0;
      }

      const tickDuration = this.tickDurationSeconds();
      const cycleTicks = this.pattern.steps.reduce((sum, step) => sum + step.delay_ticks, 0);
      const totalOffsetTicks = this.pattern.modulators.reduce((sum, modulator) => {
        if (modulator.muted) {
          return sum;
        }
        sum += this.modulatorOffsetTicks(modulator, stepTick, cycleTicks);
        return sum;
      }, 0);

      return totalOffsetTicks * tickDuration;
    }

    modulatorOffsetTicks(modulator, stepTick, cycleTicks) {
      const wavelength = Math.max(1, Number(modulator.wavelength_ticks) || 1);
      const amplitude = Number(modulator.amplitude_ticks) || 0;
      const phaseDegrees = Number(modulator.phase_degrees) || 0;
      const domainTick = modulator.restart_each_loop && cycleTicks > 0
        ? stepTick % cycleTicks
        : stepTick;
      const phaseTicks = (phaseDegrees / 360) * wavelength;
      const shiftedTick = domainTick + phaseTicks;
      const phase = ((shiftedTick % wavelength) + wavelength) % wavelength;
      const normalizedPhase = phase / wavelength;

      switch (modulator.function) {
        case "Cos":
          return amplitude * Math.cos(normalizedPhase * Math.PI * 2);
        case "Raise":
          return amplitude * normalizedPhase;
        case "Drop":
          return amplitude * (1 - normalizedPhase);
        case "Rnd": {
          const segment = Math.floor(shiftedTick / wavelength);
          return amplitude * this.seededUnitValue(modulator.id, segment);
        }
        case "Sin":
        default:
          return amplitude * Math.sin(normalizedPhase * Math.PI * 2);
      }
    }

    seededUnitValue(seedA, seedB) {
      const x = Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453;
      return (x - Math.floor(x)) * 2 - 1;
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

    scheduler = () => {
      if (!this.isRunning || !this.audioContext || !this.pattern) {
        return;
      }

      while (this.nextNoteTime < this.audioContext.currentTime + SCHEDULE_AHEAD_SECONDS) {
        this.scheduleCurrentStep(this.nextStepIndex, this.nextNoteTime);
      }
    };

    start(pattern) {
      this.setPattern(pattern);
      this.resumeContext();

      this.stopScheduler();
      this.isRunning = true;
      this.nextStepIndex = 0;
      this.nextStepTick = 0;
      this.loopCount = 0;
      this.nextNoteTime = this.audioContext.currentTime + 0.05;
      this.scheduler();
      this.schedulerId = window.setInterval(this.scheduler, LOOKAHEAD_MS);
      return true;
    }

    stopScheduler() {
      if (this.schedulerId !== null) {
        window.clearInterval(this.schedulerId);
        this.schedulerId = null;
      }
    }

    stop() {
      this.isRunning = false;
      this.stopScheduler();
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
})();
