// Round-trips a pattern through the Export and Import buttons: the exported
// file must be readable, re-importable, and must preserve the grid exactly.
//
// Usage: node tests/browser/pattern-io.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer();
const browser = await (name === "webkit" ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const work = await mkdtemp(join(tmpdir(), "fm-io-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".pattern-card");

const readState = () => page.evaluate(() => ({
  titles: [...document.querySelectorAll(".pattern-select-field option")].map((o) => o.textContent),
  delays: [...document.querySelectorAll(".delay-chip input")].map((i) => i.value),
  error: document.querySelector(".status-error")?.textContent ?? null,
}));

const before = await readState();

// --- export ---
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export" }).click(),
]);

const suggested = download.suggestedFilename();
const exported = join(work, "exported.json");
await download.saveAs(exported);
const raw = await readFile(exported, "utf8");

check(
  "filename is slugged from the title",
  suggested === "varmland-groove.fluidmetronome.json",
  suggested,
);

let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  check("export is valid JSON", false, String(e));
}

if (parsed) {
  check("export carries a versioned envelope",
    parsed.format === "fluidmetronome.patterns" && parsed.version === 1);
  check("export contains the current pattern",
    Array.isArray(parsed.patterns) && parsed.patterns.length === 1 &&
      parsed.patterns[0].title === "Värmland Groove",
    parsed.patterns?.[0]?.title);
  check("export preserves uneven spacing",
    JSON.stringify(parsed.patterns[0].steps.map((s) => String(s.delay_ticks))) ===
      JSON.stringify(before.delays),
    `${parsed.patterns[0].steps.map((s) => s.delay_ticks)} vs ${before.delays}`);
}

// --- import the file we just wrote ---
await page.setInputFiles('.file-button input[type="file"]', exported);
await page.waitForTimeout(400);
let after = await readState();

check("import adds a pattern rather than replacing",
  after.titles.length === before.titles.length + 1,
  `${before.titles.length} -> ${after.titles.length}`);
check("import disambiguates a colliding title",
  after.titles.some((t) => t.includes("(2)")), JSON.stringify(after.titles));
check("imported grid matches the original",
  JSON.stringify(after.delays) === JSON.stringify(before.delays),
  `${after.delays} vs ${before.delays}`);
check("import reports no error", after.error === null, after.error ?? "");

// --- a bare grid (hand-edited) should still import ---
const bare = join(work, "bare.json");
await writeFile(bare, JSON.stringify(parsed.patterns[0]), "utf8");
const beforeBare = await readState();
await page.setInputFiles('.file-button input[type="file"]', bare);
await page.waitForTimeout(400);
after = await readState();
check("bare grid imports",
  after.titles.length === beforeBare.titles.length + 1 && after.error === null,
  after.error ?? "");

// --- malformed input must surface an error, not corrupt the library ---
const junk = join(work, "junk.json");
await writeFile(junk, "this is not a pattern", "utf8");
const beforeJunk = await readState();
await page.setInputFiles('.file-button input[type="file"]', junk);
await page.waitForTimeout(400);
after = await readState();
check("malformed file is rejected with a message",
  after.error !== null && after.titles.length === beforeJunk.titles.length,
  after.error ?? "no error shown");

// --- a zero delay must be sanitised on import, not passed to the worklet ---
const hostile = join(work, "hostile.json");
await writeFile(hostile, JSON.stringify({
  format: "fluidmetronome.patterns",
  version: 1,
  patterns: [{
    title: "Hostile", bpm: 0, ticks_per_beat: 0,
    steps: [{ delay_ticks: 0 }, { delay_ticks: 4 }],
    tracks: [{ name: "P", instrument: "Click", note: "C4",
               sound_preset: "metronome", step_velocities: [3, 3] }],
    modulators: [],
  }],
}), "utf8");
await page.setInputFiles('.file-button input[type="file"]', hostile);
await page.waitForTimeout(400);
after = await readState();
check("hostile pattern is sanitised on import",
  after.error === null && after.delays.every((d) => Number(d) >= 1),
  `delays=${after.delays} error=${after.error ?? "none"}`);

// The app must still be alive and able to play after all that.
await page.getByRole("button", { name: "Start" }).click();
await page.waitForTimeout(600);
const playing = await page.evaluate(() =>
  document.querySelector(".transport-button")?.textContent?.trim());
check("transport still runs after imports", playing === "Stop", playing ?? "");

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] pattern export/import round-trips` : `[${name}] ${failures} FAILING`);

await rm(work, { recursive: true, force: true });
await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
