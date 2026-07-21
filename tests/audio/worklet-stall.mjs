// Drives the real audio worklet with patterns that must not hang the audio
// render thread. A stalled loop there takes down the whole tab, not just sound,
// so these run without a browser and should stay fast.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(resolve(root, "js/audio-worklet.js"), "utf8");

globalThis.sampleRate = 48000;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage: () => {} };
  }
};

let Processor;
globalThis.registerProcessor = (_name, cls) => {
  Processor = cls;
};
new Function(src)();

let failures = 0;

function drive(label, pattern, { expectStall }) {
  const processor = new Processor();
  const messages = [];
  processor.port.postMessage = (m) => messages.push(m);

  processor.port.onmessage({ data: { type: "pattern", pattern } });
  processor.port.onmessage({ data: { type: "start", generation: 1 } });

  const output = [[new Float32Array(128)]];
  const started = Date.now();
  for (let i = 0; i < 100; i += 1) {
    globalThis.currentFrame = i * 128;
    processor.process([], output);
    if (Date.now() - started > 3000) {
      failures += 1;
      console.log(`FAIL  ${label}: hung (>3s)`);
      return;
    }
  }

  const stalled = messages.some((m) => m.type === "stalled");
  const triggers = messages.filter((m) => m.type === "trigger").length;
  const ok = expectStall ? stalled : !stalled && triggers > 0;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS " : "FAIL "} ${label.padEnd(24)} triggers=${triggers} stalled=${stalled}`,
  );
}

const track = { name: "P", step_velocities: [3, 3, 3] };
const base = { bpm: 108, ticks_per_beat: 8, tracks: [track], modulators: [] };

// The original hang: a zero-length step never advances nextStepFrame.
drive("delay_ticks: 0", {
  ...base,
  steps: [{ delay_ticks: 8 }, { delay_ticks: 0 }, { delay_ticks: 8 }],
}, { expectStall: false });

// Degenerate tempo values make the horizon non-finite; the loop would then
// silently never run, producing no sound and no diagnostic.
drive("bpm: 0", { ...base, bpm: 0, steps: [{ delay_ticks: 8 }] }, { expectStall: true });
drive("bpm: Infinity", { ...base, bpm: Infinity, steps: [{ delay_ticks: 8 }] }, { expectStall: true });
drive("ticks_per_beat: 0", { ...base, ticks_per_beat: 0, steps: [{ delay_ticks: 8 }] }, { expectStall: true });

drive("healthy 8/5/7", {
  ...base,
  steps: [{ delay_ticks: 8 }, { delay_ticks: 5 }, { delay_ticks: 7 }],
}, { expectStall: false });

drive("healthy + modulator", {
  ...base,
  steps: [{ delay_ticks: 8 }, { delay_ticks: 5 }],
  modulators: [{
    id: 1, function: "Sin", amplitude_ticks: 4, wavelength_ticks: 16,
    phase_degrees: 0, muted: false, restart_each_loop: true,
  }],
}, { expectStall: false });

console.log(failures === 0 ? "\nworklet cannot stall the audio thread" : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);
