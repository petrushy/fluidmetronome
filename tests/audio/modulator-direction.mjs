// Confirms the sign convention of modulation by measuring real trigger times
// out of the worklet: a positive value at a column must delay that column, a
// negative one must pull it earlier.
//
// Also pins down what modulation does NOT do -- it displaces each note
// independently rather than editing the column's delay_ticks, so the gap
// between two columns moves by the difference of their offsets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SAMPLE_RATE = 48000;
globalThis.sampleRate = SAMPLE_RATE;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
};
let Processor;
globalThis.registerProcessor = (_n, cls) => { Processor = cls; };
new Function(readFileSync(resolve(root, "js/audio-worklet.js"), "utf8"))();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const BPM = 120;
const TICKS_PER_BEAT = 8;
// 60 / 120 / 8 = 62.5ms per mini-tick.
const TICK_SECONDS = 60 / BPM / TICKS_PER_BEAT;

// Four columns of 8 ticks: a 32-tick loop, columns firing at ticks 0/8/16/24.
const basePattern = (modulators) => ({
  bpm: BPM,
  ticks_per_beat: TICKS_PER_BEAT,
  steps: [{ delay_ticks: 8 }, { delay_ticks: 8 }, { delay_ticks: 8 }, { delay_ticks: 8 }],
  tracks: [{ name: "P", step_velocities: [3, 3, 3, 3] }],
  modulators,
});

// Collect the scheduled time of each column over one loop.
function triggerTimes(modulators) {
  const processor = new Processor();
  const triggers = [];
  processor.port.postMessage = (m) => { if (m.type === "trigger") triggers.push(m); };

  // currentFrame is a global the worklet reads; "start" anchors the lead-in to
  // it, so it has to be rewound before each run or the second run starts where
  // the first one stopped.
  globalThis.currentFrame = 0;
  processor.port.onmessage({ data: { type: "pattern", pattern: basePattern(modulators) } });
  processor.port.onmessage({ data: { type: "start", generation: 1 } });

  // One loop is 32 ticks at 62.5ms = 2s; run past it with room to spare.
  const output = [[new Float32Array(128)]];
  const quanta = Math.ceil((3 * SAMPLE_RATE) / 128);
  for (let i = 0; i < quanta; i += 1) {
    globalThis.currentFrame = i * 128;
    processor.process([], output);
  }

  // First pass through each column, plus every hit of column 0 so successive
  // loops can be compared.
  const byColumn = new Map();
  for (const t of triggers) {
    if (!byColumn.has(t.stepIndex)) byColumn.set(t.stepIndex, t.when);
  }
  const firsts = [0, 1, 2, 3].map((i) => byColumn.get(i));
  firsts.columnZeroHits = triggers.filter((t) => t.stepIndex === 0).map((t) => t.when);
  return firsts;
}

const baseline = triggerTimes([]);
check("all four columns are scheduled", baseline.every((t) => Number.isFinite(t)),
  baseline.map((t) => t?.toFixed(4)).join(", "));
check("unmodulated columns are evenly spaced",
  Math.abs((baseline[1] - baseline[0]) - 8 * TICK_SECONDS) < 1e-9 &&
  Math.abs((baseline[2] - baseline[1]) - 8 * TICK_SECONDS) < 1e-9,
  `gaps ${((baseline[1] - baseline[0]) * 1000).toFixed(1)}ms`);

// Cos, amplitude +2, wavelength 32 = the loop. At tick 0 cos is +1 (so +2
// ticks), at tick 16 it is -1 (so -2 ticks). Columns 1 and 3 sit on zeros.
const cos = [{
  id: 1, function: "Cos", amplitude_ticks: 2, wavelength_ticks: 32,
  phase_degrees: 0, muted: false, restart_each_loop: true,
}];
const modulated = triggerTimes(cos);
// The worklet starts a modulated transport late enough that the furthest
// negative offset still has its normal lead-in. That is a common origin shift
// for every column, not part of any column's modulation value.
const transportOriginShiftTicks = 2;
const deltaTicks = modulated.map(
  (t, i) => (t - baseline[i]) / TICK_SECONDS - transportOriginShiftTicks,
);

console.log(`      shift per column, in mini-ticks: [${deltaTicks.map((d) => d.toFixed(3)).join(", ")}]`);

check("a POSITIVE value delays that column",
  Math.abs(deltaTicks[0] - 2) < 1e-6,
  `column 0 (cos=+1, amplitude 2) moved ${deltaTicks[0].toFixed(3)} ticks later`);
check("a NEGATIVE value pulls that column earlier",
  Math.abs(deltaTicks[2] + 2) < 1e-6,
  `column 2 (cos=-1, amplitude 2) moved ${deltaTicks[2].toFixed(3)} ticks`);
check("a ZERO value leaves the column alone",
  Math.abs(deltaTicks[1]) < 1e-6 && Math.abs(deltaTicks[3]) < 1e-6,
  `columns 1 and 3 moved ${deltaTicks[1].toFixed(3)} / ${deltaTicks[3].toFixed(3)}`);

// Inverting the amplitude must mirror every shift.
const inverted = triggerTimes([{ ...cos[0], amplitude_ticks: -2 }]);
const invertedTicks = inverted.map(
  (t, i) => (t - baseline[i]) / TICK_SECONDS - transportOriginShiftTicks,
);
check("a negative amplitude mirrors the shifts",
  invertedTicks.every((d, i) => Math.abs(d + deltaTicks[i]) < 1e-6),
  `[${invertedTicks.map((d) => d.toFixed(3)).join(", ")}]`);

// --- what modulation is NOT ---
// The transport advances by the unmodulated delay_ticks, so a modulator does
// not rewrite a column's spacing. The audible gap between two columns changes
// by the DIFFERENCE of their offsets.
const gapBase = (baseline[1] - baseline[0]) / TICK_SECONDS;
const gapMod = (modulated[1] - modulated[0]) / TICK_SECONDS;
check("the gap moves by the difference of the two offsets",
  Math.abs((gapMod - gapBase) - (deltaTicks[1] - deltaTicks[0])) < 1e-6,
  `gap went ${gapBase.toFixed(2)} -> ${gapMod.toFixed(2)} ticks ` +
    `(offsets ${deltaTicks[0].toFixed(2)} then ${deltaTicks[1].toFixed(2)})`);

// Offsets displace, they do not accumulate: the same column must land exactly
// one cycle later on the next loop, not creep. This is the property that keeps
// a modulated pattern from drifting out of time over minutes.
const cycleSeconds = 32 * TICK_SECONDS;
const hits = modulated.columnZeroHits;
const loopGaps = hits.slice(1).map((t, i) => t - hits[i]);
check("the same column lands exactly one cycle later each loop",
  loopGaps.length > 0 && loopGaps.every((g) => Math.abs(g - cycleSeconds) < 1e-9),
  `gaps ${loopGaps.map((g) => (g * 1000).toFixed(2)).join(", ")}ms, cycle ${(cycleSeconds * 1000).toFixed(2)}ms`);

console.log(failures === 0
  ? "\npositive = later, negative = earlier"
  : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);
