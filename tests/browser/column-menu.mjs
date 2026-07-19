// Exercises the column menu against the running app: every action must change
// the grid the way its label promises, and the menu must stay reachable.
//
// The menu is fixed-position, so anything pushed off screen cannot be scrolled
// back into view -- hence the viewport sweep.
//
// Usage: node tests/browser/column-menu.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer();
const browser = await (name === "webkit" ? webkit : chromium).launch();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".board-header");

const readGrid = () => page.evaluate(() => {
  const delays = [...document.querySelectorAll(".delay-chip input")].map((i) => i.value);
  const cols = delays.length;
  const cells = [...document.querySelectorAll(".board-grid .grid-cell")];
  const marks = [];
  for (let c = 0; c < cols; c += 1) {
    const col = [];
    for (let r = 0; r * cols + c < cells.length; r += 1) {
      const mark = cells[r * cols + c].querySelector(".grid-mark");
      col.push(mark ? mark.className.replace("grid-mark", "").trim() || "off" : "?");
    }
    marks.push(col);
  }
  return { delays, marks };
});

const openMenu = async (col) => {
  await page.locator(".column-menu-button").nth(col).click();
  await page.waitForSelector(".column-menu", { state: "visible" });
};
const clickAction = async (label) => {
  await page.locator(".column-menu-item", { hasText: label }).click();
  await page.waitForTimeout(180);
};

let before = await readGrid();
await openMenu(1);
await clickAction("Add column to right");
let after = await readGrid();
check(
  "add right inserts an empty column with the neighbour's spacing",
  after.delays.length === before.delays.length + 1 &&
    after.delays[2] === before.delays[1] &&
    after.marks[2].every((m) => m === "off"),
  `${before.delays} -> ${after.delays}`,
);

before = await readGrid();
await openMenu(1);
await clickAction("Add column to left");
after = await readGrid();
check(
  "add left inserts an empty column in place",
  after.delays.length === before.delays.length + 1 && after.marks[1].every((m) => m === "off"),
);

before = await readGrid();
await openMenu(0);
await clickAction("Duplicate to right");
after = await readGrid();
check(
  "duplicate right copies spacing and hits",
  after.delays[1] === before.delays[0] &&
    JSON.stringify(after.marks[1]) === JSON.stringify(before.marks[0]),
  `col0 ${JSON.stringify(before.marks[0])} -> col1 ${JSON.stringify(after.marks[1])}`,
);

before = await readGrid();
await openMenu(0);
await clickAction("Duplicate to left");
after = await readGrid();
check(
  "duplicate left copies into place",
  JSON.stringify(after.marks[0]) === JSON.stringify(before.marks[0]),
);

before = await readGrid();
await openMenu(1);
await clickAction("Delete column");
after = await readGrid();
check("delete removes that column", after.delays.length === before.delays.length - 1);

while ((await page.locator(".column-menu-button").count()) > 1) {
  await openMenu(0);
  await clickAction("Delete column");
}
await openMenu(0);
check(
  "delete is disabled on the last column",
  await page.locator(".column-menu-item", { hasText: "Delete column" }).isDisabled(),
);
await page.close();

// --- the menu must stay on screen and clickable ---
for (const vp of [
  { width: 1280, height: 900 },
  { width: 1280, height: 620 },
  { width: 900, height: 560 },
  { width: 430, height: 740 },
]) {
  const p = await browser.newPage({ viewport: vp });
  await p.goto(server.url, { waitUntil: "networkidle" });
  await p.waitForSelector(".board-header");

  const buttons = p.locator(".column-menu-button");
  const n = await buttons.count();

  for (const col of [0, n - 1]) {
    await buttons.nth(col).scrollIntoViewIfNeeded();
    await buttons.nth(col).click();
    await p.waitForSelector(".column-menu", { state: "visible" });

    const r = await p.locator(".column-menu").evaluate((el) => {
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left), right: Math.round(b.right),
        top: Math.round(b.top), bottom: Math.round(b.bottom),
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
    const inside = r.left >= 0 && r.top >= 0 && r.right <= r.vw + 1 && r.bottom <= r.vh + 1;

    let clickable = true;
    try {
      await p.locator(".column-menu-item", { hasText: "Add column to left" })
        .click({ timeout: 4000 });
    } catch {
      clickable = false;
    }

    check(
      `menu on screen at ${vp.width}x${vp.height} col${col}`,
      inside && clickable,
      `[${r.left},${r.top} → ${r.right},${r.bottom}]${inside ? "" : " OFFSCREEN"}${clickable ? "" : " UNCLICKABLE"}`,
    );

    if (await p.locator(".column-menu-backdrop").count()) {
      await p.locator(".column-menu-backdrop").click({ position: { x: 2, y: 2 } });
    }
  }
  await p.close();
}

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] column menu behaves` : `[${name}] ${failures} FAILING`);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
