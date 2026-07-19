// Mini-ticks per beat must be freely typable, accept fractions, and reach both
// the beat readout and the exported pattern.
//
// Usage: node tests/browser/ticks-input.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer(8906);
const browser = await (name === "webkit" ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const work = await mkdtemp(join(tmpdir(), "fm-ticks-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".ticks-input");

const beats = () => page.evaluate(() => {
  const node = [...document.querySelectorAll(".pattern-stat")]
    .find((n) => n.querySelector("dt").textContent.trim() === "Full beats");
  return node?.querySelector("dd").textContent.trim() ?? null;
});
const field = () => page.locator(".ticks-input").inputValue();

check("field is a text-entry input, not a dropdown",
  (await page.locator(".ticks-input").count()) === 1 &&
    (await page.locator(".control-card select").count()) === 0);
check("field shows the actual value without a trailing zero", (await field()) === "8", await field());

// --- typing a whole number ---
await page.fill(".ticks-input", "4");
await page.waitForTimeout(250);
check("whole number applies", (await beats()) === "10", `beats=${await beats()}`);

// --- typing a fraction, keystroke by keystroke, is not fought by re-renders ---
await page.locator(".ticks-input").fill("");
await page.locator(".ticks-input").pressSequentially("7.5", { delay: 60 });
await page.waitForTimeout(250);
check("fraction survives being typed character by character",
  (await field()) === "7.5", await field());
// 40 mini-ticks / 7.5 = 5.333...
check("fractional value reaches the beat readout",
  (await beats()).startsWith("5.33"), `beats=${await beats()}`);

// --- the value is what gets exported ---
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export" }).click(),
]);
const file = join(work, "ticks.json");
await download.saveAs(file);
const parsed = JSON.parse(await readFile(file, "utf8"));
check("fraction is stored in the pattern", parsed.pattern.ticks_per_beat === 7.5,
  String(parsed.pattern.ticks_per_beat));

// --- blur returns the display to the value in use ---
await page.fill(".ticks-input", "0.0001");
await page.locator(".ticks-input").blur();
await page.waitForTimeout(250);
check("out-of-range entry is clamped and shown clamped",
  Number(await field()) >= 0.01, await field());

// --- an empty field must not wipe the tempo model ---
await page.fill(".ticks-input", "");
await page.waitForTimeout(200);
const duringEmpty = await beats();
await page.locator(".ticks-input").blur();
await page.waitForTimeout(250);
check("clearing the field leaves the pattern playable",
  duringEmpty !== null && Number(await field()) > 0, `field=${await field()}`);

// --- and the transport still starts ---
await page.getByRole("button", { name: "Start" }).click();
await page.waitForTimeout(700);
const label = await page.evaluate(() =>
  document.querySelector(".transport-button")?.textContent?.trim());
const timing = await page.evaluate(() =>
  document.querySelector(".timing-copy strong")?.textContent?.trim());
check("transport runs with a fractional subdivision", label === "Stop", label ?? "");
check("timing does not report a stall", timing !== "Timing idle", timing ?? "");

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] mini-ticks input accepts free text` : `[${name}] ${failures} FAILING`);

await rm(work, { recursive: true, force: true });
await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
