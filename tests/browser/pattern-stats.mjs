// The loop summary must agree with the grid at all times, including after
// edits that change spacing, and must handle a loop that does not close on a
// whole beat.
//
// Usage: node tests/browser/pattern-stats.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer(8905);
const browser = await (name === "webkit" ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".pattern-stats");

// Read the displayed summary alongside the truth from the grid itself.
const read = () => page.evaluate(() => {
  const stat = (label) => {
    const node = [...document.querySelectorAll(".pattern-stat")]
      .find((n) => n.querySelector("dt").textContent.trim() === label);
    return node?.querySelector("dd").textContent.trim() ?? null;
  };
  const delays = [...document.querySelectorAll(".delay-chip input")].map((i) => Number(i.value));
  return {
    shown: { columns: stat("Columns"), ticks: stat("Mini-ticks"), beats: stat("Full beats") },
    actual: {
      columns: delays.length,
      ticks: delays.reduce((a, b) => a + b, 0),
      perBeat: Number(document.querySelector(".ticks-input").value),
    },
  };
});

const agrees = (r, label) => {
  const expectedBeats = r.actual.ticks / r.actual.perBeat;
  const shownBeats = Number(r.shown.beats);
  check(
    label,
    Number(r.shown.columns) === r.actual.columns &&
      Number(r.shown.ticks) === r.actual.ticks &&
      Math.abs(shownBeats - expectedBeats) < 0.005,
    `shown ${r.shown.columns}col ${r.shown.ticks}ticks ${r.shown.beats}beats | ` +
      `actual ${r.actual.columns}col ${r.actual.ticks}ticks ${expectedBeats.toFixed(3)}beats`,
  );
};

let r = await read();
agrees(r, "summary matches the demo pattern");
check("demo totals are 6 columns / 40 ticks / 5 beats",
  r.shown.columns === "6" && r.shown.ticks === "40" && r.shown.beats === "5",
  `${r.shown.columns}/${r.shown.ticks}/${r.shown.beats}`);

// --- adding a column updates both counts ---
await page.getByRole("button", { name: "Add Column" }).click();
await page.waitForTimeout(250);
r = await read();
agrees(r, "summary follows Add Column");
check("column count incremented", r.shown.columns === "7", r.shown.columns);

// --- editing a column's spacing changes ticks but not columns ---
await page.locator(".delay-chip input").first().fill("3");
await page.waitForTimeout(250);
r = await read();
agrees(r, "summary follows a spacing edit");

// --- a loop that does not close on a whole beat shows a fraction ---
const fractional = await read();
const expected = fractional.actual.ticks / fractional.actual.perBeat;
if (Math.abs(expected - Math.round(expected)) > 1e-9) {
  check("fractional beats are shown with decimals",
    fractional.shown.beats.includes("."), fractional.shown.beats);
} else {
  console.log(`      (loop happens to be whole at ${expected} beats; forcing a fraction)`);
  await page.locator(".delay-chip input").first().fill("1");
  await page.waitForTimeout(250);
  const f2 = await read();
  agrees(f2, "summary matches after forcing a fraction");
  const e2 = f2.actual.ticks / f2.actual.perBeat;
  check("fractional beats are shown with decimals",
    Math.abs(e2 - Math.round(e2)) < 1e-9 || f2.shown.beats.includes("."),
    `${f2.shown.beats} for ${e2}`);
}

// --- changing mini-ticks per beat rescales the beat count, not the ticks ---
const beforeTicks = (await read()).shown.ticks;
await page.fill(".ticks-input", "4");
await page.waitForTimeout(250);
r = await read();
agrees(r, "summary follows a mini-ticks/beat change");
check("mini-tick total is unchanged by ticks-per-beat",
  r.shown.ticks === beforeTicks, `${beforeTicks} -> ${r.shown.ticks}`);

// --- deleting a column via the header menu keeps it honest ---
await page.locator(".column-menu-button").first().click();
await page.waitForSelector(".column-menu");
await page.locator(".column-menu-item", { hasText: "Delete column" }).click();
await page.waitForTimeout(250);
r = await read();
agrees(r, "summary follows a column delete");

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] loop summary stays accurate` : `[${name}] ${failures} FAILING`);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
