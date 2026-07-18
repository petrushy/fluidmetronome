class FluidMetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pattern = null;
    this.isRunning = false;
    this.generation = 0;
    this.nextStepIndex = 0;
    this.nextStepTick = 0;
    this.nextStepFrame = 0;
    this.baseLeadInFrames = sampleRate * 0.12;
    this.baseLookaheadFrames = sampleRate * 0.3;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      switch (data.type) {
        case "pattern":
          this.pattern = data.pattern;
          if (!this.pattern?.steps?.length) {
            this.nextStepIndex = 0;
            this.nextStepTick = 0;
            return;
          }

          this.nextStepIndex %= this.pattern.steps.length;
          break;
        case "start":
          this.generation = data.generation || 0;
          this.isRunning = true;
          this.nextStepIndex = 0;
          this.nextStepTick = 0;
          this.nextStepFrame = currentFrame + this.baseLeadInFrames;
          break;
        case "stop":
          this.generation = data.generation || this.generation;
          this.isRunning = false;
          break;
      }
    };
  }

  process(_inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) {
        channel.fill(0);
      }
    }

    if (!this.isRunning || !this.pattern?.steps?.length) {
      return true;
    }

    const horizonFrame = currentFrame + this.scheduleHorizonFrames();
    while (this.nextStepFrame < horizonFrame) {
      this.scheduleCurrentStep();
    }

    return true;
  }

  scheduleCurrentStep() {
    const step = this.pattern.steps[this.nextStepIndex];
    if (!step) {
      return;
    }

    const stepFrame = this.nextStepFrame;
    const modulationFrames = this.totalModulationTicks(this.nextStepTick) * this.tickDurationFrames();
    this.port.postMessage({
      type: "trigger",
      generation: this.generation,
      stepIndex: this.nextStepIndex,
      when: (stepFrame + modulationFrames) / sampleRate,
    });

    this.nextStepTick += step.delay_ticks;
    this.nextStepFrame = stepFrame + step.delay_ticks * this.tickDurationFrames();
    this.nextStepIndex = (this.nextStepIndex + 1) % this.pattern.steps.length;
  }

  tickDurationFrames() {
    return sampleRate * 60 / this.pattern.bpm / this.pattern.ticks_per_beat;
  }

  cycleTicks() {
    return this.pattern.steps.reduce((sum, step) => sum + step.delay_ticks, 0);
  }

  scheduleHorizonFrames() {
    const maxAdvanceTicks = (this.pattern.modulators || []).reduce((sum, modulator) => {
      if (modulator.muted) {
        return sum;
      }

      return sum + Math.abs(Number(modulator.amplitude_ticks) || 0);
    }, 0);

    return this.baseLookaheadFrames + maxAdvanceTicks * this.tickDurationFrames();
  }

  totalModulationTicks(stepTick) {
    if (!this.pattern?.modulators?.length) {
      return 0;
    }

    const cycleTicks = this.cycleTicks();
    return this.pattern.modulators.reduce((sum, modulator) => {
      if (modulator.muted) {
        return sum;
      }

      return sum + this.modulatorOffsetTicks(modulator, stepTick, cycleTicks);
    }, 0);
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
}

registerProcessor("fluid-metronome-processor", FluidMetronomeProcessor);
