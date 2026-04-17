class FluidMetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      // This placeholder receives grid updates from the UI thread.
      // Real playback should schedule clicks against currentFrame/currentTime.
      this.lastMessage = event.data;
    };
  }

  process() {
    return true;
  }
}

registerProcessor("fluid-metronome-processor", FluidMetronomeProcessor);

