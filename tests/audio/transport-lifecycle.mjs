// Exercises the engine-side lifetime rules that an AudioWorklet arithmetic test
// cannot see: pattern revisions, decoded local-sample ownership, and muting a
// transport generation that already has Web Audio sources queued.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
globalThis.window = {};
globalThis.performance = performance;

let src = readFileSync(resolve(root, "js/audio-engine.js"), "utf8").trimEnd();
if (!src.endsWith("})();")) throw new Error("unexpected audio-engine.js tail");
src = src.slice(0, -"})();".length) + "globalThis.__engine = engine; })();";
new Function(src)();

const engine = globalThis.__engine;
engine.ensurePresetBuffers = () => {};

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const pattern = (sampleName = null) => ({
  bpm: 120,
  ticks_per_beat: 8,
  steps: [{ delay_ticks: 8 }],
  tracks: [{
    name: "Pulse",
    instrument: "Click",
    note: "C4",
    sound_preset: "metronome",
    sample_name: sampleName,
    sample_download_url: null,
    step_velocities: [3],
  }],
  modulators: [],
});

// A loaded local file must remain while the model still names it, but disappear
// immediately when a preset is selected or a different pattern owns the slot.
engine.trackSamples.set(0, { local: true });
engine.trackSampleKeys.set(0, "local:claves.wav");
engine.setPattern(pattern("claves.wav"));
check("matching local sample survives a normal pattern sync", engine.trackSamples.has(0));

engine.setPattern(pattern());
check("clearing the model sample also clears decoded local audio", !engine.trackSamples.has(0));
check("clearing the model sample also clears its ownership key", !engine.trackSampleKeys.has(0));

// A worklet message calculated from an older pattern must never use the current
// pattern's tracks. This is especially important while editing a running grid.
const outbound = [];
engine.transportNode = { port: { postMessage: (message) => outbound.push(message) } };
engine.setPattern(pattern());
const revision = engine.patternRevision;
const sentRevision = outbound.at(-1)?.revision;
check("pattern messages carry the engine revision", sentRevision === revision, `${sentRevision} vs ${revision}`);

engine.isRunning = true;
engine.transportGeneration = 4;
engine.audioContext = { currentTime: 10 };
let scheduled = 0;
engine.scheduleStepPlayback = () => { scheduled += 1; };
engine.handleTransportMessage({ type: "trigger", generation: 4, revision: revision - 1, stepIndex: 0, when: 10.1 });
check("stale worklet trigger is ignored", scheduled === 0);
engine.handleTransportMessage({ type: "trigger", generation: 4, revision, stepIndex: 0, when: 10.1 });
check("current worklet trigger is accepted", scheduled === 1);

// stop() must mute a generation even when its Web Audio sources were scheduled
// before the stop message reached the worklet.
const gateCalls = [];
engine.audioContext = {
  currentTime: 4,
  createGain: () => ({
    gain: {
      value: 1,
      cancelScheduledValues: (at) => gateCalls.push(["cancel", at]),
      setValueAtTime: (value, at) => gateCalls.push(["set", value, at]),
      exponentialRampToValueAtTime: (value, at) => gateCalls.push(["ramp", value, at]),
    },
    connect: () => {},
  }),
};
engine.masterGain = {};
engine.transportNode = null;
engine.createTransportOutput();
engine.stop();
check("stop retires the transport output gate", engine.transportGain === null);
check("stop schedules a short mute ramp", gateCalls.some(([kind]) => kind === "ramp"));

console.log(failures === 0
  ? "\ntransport lifecycle protections hold"
  : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);
