// Layout invariants that only a real browser can confirm.
//
// Both regressions guarded here shipped once, because CSS that compiles fine
// can still be wrong:
//   - the sound menu was cropped by an ancestor scroll container
//   - the label rail drifted out of step with the grid rows, one gap per track
//
// Usage: node tests/browser/layout.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer();
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
await page.waitForSelector(".sequencer-card");

const addTrack = page.getByRole("button", { name: "Add Instrument" });
await addTrack.click();
await addTrack.click();
await page.waitForTimeout(300);

// --- label rail must advance in the same pitch as the grid ---
const align = await page.evaluate(() => {
  const labels = [...document.querySelectorAll(".label-row")];
  const cols = document.querySelectorAll(".board-header .delay-chip").length;
  const cells = [...document.querySelectorAll(".board-grid .grid-cell")];
  const mid = (el) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };
  return labels.map((l, i) =>
    cells[i * cols] ? Math.round(mid(l) - mid(cells[i * cols])) : null);
});
check("label rows align with grid rows", align.every((d) => d === 0), `drift=${JSON.stringify(align)}`);

// --- sound menu must escape every clipping ancestor ---
const summaries = page.locator(".sound-menu > summary");
await summaries.nth((await summaries.count()) - 1).click();
// Every row owns a popover; only the one just opened becomes visible.
const openPopover = page.locator(".sound-menu-popover").last();
await openPopover.waitFor({ state: "visible" });

const menu = await openPopover.evaluate((el) => {
  let clipper = null;
  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") {
      clipper = n.className;
      break;
    }
  }
  const r = el.getBoundingClientRect();
  const covered = [0.05, 0.5, 0.95].some((f) => {
    const y = r.top + r.height * f;
    if (y < 0 || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, y);
    return hit ? !(el.contains(hit) || hit === el) : false;
  });
  return { clipper, covered };
});
check("sound menu has no clipping ancestor", menu.clipper === null, `clipper=${menu.clipper}`);
check("sound menu is not painted over", !menu.covered);

// --- the page itself must never scroll sideways ---
for (const width of [1280, 900, 430]) {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    view: window.innerWidth,
  }));
  check(
    `no horizontal page scroll at ${width}px`,
    overflow.body <= overflow.view + 1,
    `body=${overflow.body} view=${overflow.view}`,
  );
}

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] layout invariants hold` : `[${name}] ${failures} FAILING`);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
