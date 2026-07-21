// The modulator diagram is drawn from a Rust copy of the worklet's arithmetic.
// Two implementations of the same formula can drift, and a drifted diagram is
// worse than none -- it looks authoritative while being wrong.
//
// So this reads the curve the app actually rendered and compares it against the
// worklet's own modulatorOffsetTicks, loaded from js/audio-worklet.js.
//
// Usage: node tests/browser/modulator-shape.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startServer } from "./server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2] === "webkit" ? "webkit" : "chromium";

// --- load the worklet's real implementation ---
globalThis.sampleRate = 48000;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
};
let Processor;
globalThis.registerProcessor = (_n, cls) => { Processor = cls; };
new Function(readFileSync(resolve(root, "js/audio-worklet.js"), "utf8"))();
const worklet = new Processor();

// Must match the constants in modulator_shape() in src/app.rs.
const WIDTH = 128, HEIGHT = 44, SAMPLES = 96;

const server = await startServer(8908);
const browser = await (name === "webkit" ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".modulators-card");
await page.getByRole("button", { name: "Add Modulator" }).click();
await page.waitForSelector(".modulator-shape");

const setField = async (label, value) => {
  const field = page.locator(".modulator-field", { hasText: label }).first();
  await field.locator("input").fill(String(value));
  await page.waitForTimeout(160);
};

// Read what the app drew, plus the modulator settings it drew it from.
const readShape = () => page.evaluate(() => {
  const svg = document.querySelector(".modulator-shape");
  const points = svg.querySelector(".shape-curve").getAttribute("points")
    .trim().split(/\s+/).map((p) => p.split(",").map(Number));
  const start = svg.querySelector(".shape-start");
  const fieldValue = (label) => {
    const field = [...document.querySelectorAll(".modulator-field")]
      .find((f) => f.querySelector("span")?.textContent.trim().includes(label));
    const input = field?.querySelector("input, select");
    return input ? input.value : null;
  };
  const stat = (label) => {
    const node = [...document.querySelectorAll(".pattern-stat")]
      .find((n) => n.querySelector("dt").textContent.trim() === label);
    return Number(node.querySelector("dd").textContent.trim());
  };
  return {
    points,
    startY: Number(start.getAttribute("cy")),
    columnXs: [...svg.querySelectorAll(".shape-column")].map((l) => Number(l.getAttribute("x1"))),
    delays: [...document.querySelectorAll(".delay-chip input")].map((i) => Number(i.value)),
    id: Number(svg.getAttribute("data-modulator-id")),
    cycleTicks: stat("Mini-ticks"),
    fn: fieldValue("Function"),
    amplitude: Number(fieldValue("Amplitude")),
    wavelength: Number(fieldValue("Wavelength")),
    phase: Number(fieldValue("Phase")),
    restart: !!document.querySelector(".modulator-item input[type=checkbox]:checked"),
  };
});

// Recompute the curve from the worklet and compare it to the drawn one.
const comparePoints = (shape, label) => {
  const modulator = {
    id: shape.id,
    function: shape.fn,
    amplitude_ticks: shape.amplitude,
    wavelength_ticks: shape.wavelength,
    phase_degrees: shape.phase,
    muted: false,
    restart_each_loop: shape.restart,
  };

  const domain = shape.cycleTicks > 0 ? shape.cycleTicks : Math.max(1, shape.wavelength);
  const scale = Math.max(Math.abs(shape.amplitude), Number.EPSILON);
  const mid = HEIGHT / 2, reach = mid - 4;

  let worst = 0;
  let worstAt = null;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const progress = i / SAMPLES;
    const tick = progress * domain;
    // The worklet's own function, not a reimplementation.
    const value = worklet.modulatorOffsetTicks(modulator, tick, shape.cycleTicks);
    // Positive plots upward; SVG y grows downward.
    const expectedY = mid - Math.max(-1, Math.min(1, value / scale)) * reach;
    const expectedX = progress * WIDTH;

    const [x, y] = shape.points[i];
    const dx = Math.abs(x - expectedX);
    const dy = Math.abs(y - expectedY);
    if (Math.max(dx, dy) > worst) {
      worst = Math.max(dx, dy);
      worstAt = `tick ${tick.toFixed(2)}: drew ${y.toFixed(2)}, worklet says ${expectedY.toFixed(2)}`;
    }
  }

  // 0.01 is the rounding the SVG points are written with.
  check(`${label} matches the worklet`, worst <= 0.02,
    `max deviation ${worst.toFixed(4)}px${worst > 0.02 ? ` (${worstAt})` : ""}`);
};

// --- the default modulator ---
let shape = await readShape();
check("a curve is drawn", shape.points.length === SAMPLES + 1, `${shape.points.length} points`);
comparePoints(shape, "default Sin");

// --- the start marker must sit on the value at tick 0 ---
const startCheck = (shape, expectedValue, label) => {
  const scale = Math.max(Math.abs(shape.amplitude), Number.EPSILON);
  const mid = HEIGHT / 2, reach = mid - 4;
  const expectedY = mid - Math.max(-1, Math.min(1, expectedValue / scale)) * reach;
  check(label, Math.abs(shape.startY - expectedY) < 0.05,
    `marker at ${shape.startY}, expected ${expectedY.toFixed(2)}`);
};
startCheck(shape, 0, "Sin starts on the zero line");

// --- every function, against the worklet ---
for (const fn of ["Cos", "Raise", "Drop", "Rnd", "Sin"]) {
  await page.locator(".modulator-field select").first().selectOption(fn);
  await page.waitForTimeout(180);
  shape = await readShape();
  check(`${fn} is selected in the menu`, shape.fn === fn, shape.fn ?? "");
  comparePoints(shape, fn);
}

// --- Cos and Drop must start at full deflection, not zero ---
await page.locator(".modulator-field select").first().selectOption("Cos");
await page.waitForTimeout(180);
shape = await readShape();
startCheck(shape, shape.amplitude, "Cos starts at full amplitude");

await page.locator(".modulator-field select").first().selectOption("Drop");
await page.waitForTimeout(180);
shape = await readShape();
startCheck(shape, shape.amplitude, "Drop starts at full amplitude");

// --- edits must move the curve ---
await page.locator(".modulator-field select").first().selectOption("Sin");
await setField("Wavelength", 8);
shape = await readShape();
comparePoints(shape, "Sin at wavelength 8");

await setField("Phase", 90);
shape = await readShape();
comparePoints(shape, "Sin at phase 90");
startCheck(shape, shape.amplitude, "phase 90 starts at full amplitude");

// --- a negative amplitude must flip the curve, not hide it ---
await setField("Phase", 0);
await setField("Amplitude", -3);
shape = await readShape();
comparePoints(shape, "negative amplitude");
// A quarter of the way through the first wavelength sin peaks at +1, so a
// positive amplitude plots above the axis and a negative one below it.
const quarterIndex = Math.round((SAMPLES * shape.wavelength) / (4 * shape.cycleTicks));
const firstQuarter = shape.points[quarterIndex];
check("negative amplitude inverts the curve", firstQuarter[1] > HEIGHT / 2,
  `y=${firstQuarter?.[1]} at index ${quarterIndex} (axis ${HEIGHT / 2})`);

// --- the column bars must sit on the ticks where columns actually fire ---
await page.locator(".modulator-field select").first().selectOption("Sin");
await setField("Amplitude", 2);
shape = await readShape();

// Running totals of delay_ticks, first column at 0.
const expectedTicks = [];
shape.delays.reduce((tick, delay) => { expectedTicks.push(tick); return tick + delay; }, 0);
const expectedXs = expectedTicks.map((t) => (t / shape.cycleTicks) * WIDTH);

check("one bar per column", shape.columnXs.length === shape.delays.length,
  `${shape.columnXs.length} bars for ${shape.delays.length} columns`);
check("first column sits at tick 0", Math.abs(shape.columnXs[0]) < 0.02, String(shape.columnXs[0]));
check("bars land on the column ticks",
  expectedXs.every((x, i) => Math.abs(shape.columnXs[i] - x) <= 0.02),
  `drew [${shape.columnXs.map((x) => x.toFixed(1))}] expected [${expectedXs.map((x) => x.toFixed(1))}]`);

// Editing a column's spacing must move the bars with it.
await page.locator(".delay-chip input").first().fill("2");
await page.waitForTimeout(250);
const moved = await readShape();
const movedExpected = [];
moved.delays.reduce((tick, delay) => { movedExpected.push(tick); return tick + delay; }, 0);
check("bars follow a spacing edit",
  movedExpected.every((t, i) => Math.abs(moved.columnXs[i] - (t / moved.cycleTicks) * WIDTH) <= 0.02),
  `delays [${moved.delays}]`);

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] diagram agrees with the worklet` : `[${name}] ${failures} FAILING`);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
