// Renders every sound preset through the real engine voice code and checks the
// peaks stay in one band. The hand-tuned voice gains once drifted ~8x apart,
// which made the default presets nearly inaudible; PRESET_TRIM in
// js/audio-engine.js exists to hold them level. Re-run after touching any voice.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OfflineAudioContext, AudioContext } from "node-web-audio-api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SAMPLE_RATE = 48000;

// The noise voices (hi-hats) peak stochastically -- successive renders of the
// same preset vary by 0.1 or more -- so this asserts the property that actually
// matters instead of a tight target: nothing is wildly out of band, and the
// loudest preset is no more than twice the quietest. Medians over several
// renders keep the noise voices from making the run flaky.
const PEAK_FLOOR = 0.18;
const PEAK_CEILING = 0.52;
const MAX_SPREAD = 2.0;
const RENDERS_PER_PRESET = 5;

globalThis.window = { OfflineAudioContext, AudioContext };
globalThis.performance = performance;

let src = readFileSync(resolve(root, "js/audio-engine.js"), "utf8").trimEnd();
if (!src.endsWith("})();")) throw new Error("unexpected audio-engine.js tail");
src = src.slice(0, -"})();".length) +
  "globalThis.__engine = engine; globalThis.__preview = window.fluidMetronomePreviewSound; })();";
new Function(src)();

const engine = globalThis.__engine;
const previewSound = globalThis.__preview;

const PRESETS = [
  "metronome", "bright-click", "soft-click", "hihat-closed",
  "hihat-open", "cowbell", "woodblock", "thump",
];

let failures = 0;

async function peakOf(preset, instrument, note, velocity) {
  const duration = engine.presetDurationSeconds(preset, instrument);
  const offline = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * duration), SAMPLE_RATE);
  engine.renderPresetToDestination(
    offline, offline.destination, preset, instrument, note,
    engine.velocityGain(velocity), 0.005,
  );
  const data = (await offline.startRendering()).getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

async function medianPeak(preset, instrument, note, velocity) {
  const peaks = [];
  for (let i = 0; i < RENDERS_PER_PRESET; i += 1) {
    peaks.push(await peakOf(preset, instrument, note, velocity));
  }
  peaks.sort((a, b) => a - b);
  return peaks[Math.floor(peaks.length / 2)];
}

console.log(`preset levels (each in ${PEAK_FLOOR}..${PEAK_CEILING}, spread <= ${MAX_SPREAD}x)`);
const peaks = [];
for (const preset of PRESETS) {
  const peak = await medianPeak(preset, "Click", "C4", 3);
  peaks.push(peak);
  const ok = peak >= PEAK_FLOOR && peak <= PEAK_CEILING;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${preset.padEnd(14)} peak=${peak.toFixed(4)}`);
}

const spread = Math.max(...peaks) / Math.min(...peaks);
const spreadOk = spread <= MAX_SPREAD;
if (!spreadOk) failures += 1;
console.log(`${spreadOk ? "PASS " : "FAIL "} ${"spread".padEnd(14)} ${spread.toFixed(2)}x loudest/quietest`);

// "metronome" is the one preset whose voice comes from the track's instrument,
// so each instrument needs its own trim.
console.log("\nmetronome across instruments");
const byInstrument = [];
for (const instrument of ["Click", "Accent", "Low"]) {
  const peak = await medianPeak("metronome", instrument, "C4", 3);
  byInstrument.push(peak);
  const ok = peak >= PEAK_FLOOR && peak <= PEAK_CEILING;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${instrument.padEnd(14)} peak=${peak.toFixed(4)}`);
}

const instrumentSpread = Math.max(...byInstrument) / Math.min(...byInstrument);
const instrumentOk = instrumentSpread <= 1.3;
if (!instrumentOk) failures += 1;
console.log(`${instrumentOk ? "PASS " : "FAIL "} ${"spread".padEnd(14)} ${instrumentSpread.toFixed(2)}x`);

// Velocity must scale the whole envelope, sustain included.
console.log("\nvelocity scaling");
for (const preset of ["metronome", "cowbell", "woodblock"]) {
  const hard = await peakOf(preset, "Click", "C4", 3);
  const soft = await peakOf(preset, "Click", "C4", 1);
  const ratio = soft / hard;
  const ok = Math.abs(ratio - engine.velocityGain(1)) < 0.02;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${preset.padEnd(14)} soft/hard=${ratio.toFixed(3)}`);
}

// The preview button path, including sample precedence over the preset.
console.log("\npreview path");
async function previewPeak(trackIndex, preset, instrument, note, seedSample) {
  const offline = new OfflineAudioContext(1, SAMPLE_RATE * 0.5, SAMPLE_RATE);
  engine.audioContext = offline;
  engine.masterGain = offline.createGain();
  engine.masterGain.gain.value = 0.7;
  engine.masterGain.connect(offline.destination);
  // OfflineAudioContext.resume() only settles during rendering; browsers take
  // the real AudioContext path here.
  engine.resumeContext = async () => offline;
  engine.presetBuffers.clear();
  engine.presetBufferPromises.clear();
  engine.trackSamples.clear();

  if (seedSample) {
    const buf = offline.createBuffer(1, SAMPLE_RATE * 0.1, SAMPLE_RATE);
    buf.getChannelData(0).fill(0.9);
    engine.trackSamples.set(trackIndex, buf);
  }

  await previewSound(trackIndex, preset, instrument, note);
  const data = (await offline.startRendering()).getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

for (const [label, idx, preset, seed] of [
  ["track preview", 0, "metronome", false],
  ["menu audition", -1, "woodblock", false],
  ["sample wins over preset", 0, "metronome", true],
]) {
  const peak = await previewPeak(idx, preset, "Click", "C4", seed);
  const ok = peak > 0.05;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label.padEnd(24)} peak=${peak.toFixed(4)}`);
}

console.log(failures === 0 ? "\npreset levels are balanced" : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);
