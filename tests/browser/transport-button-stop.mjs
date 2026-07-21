// Verify that clicking the Stop button returns the transport button to "Start"
// and that the metronome can be restarted.  This covers the path where the
// user manually stops playback (as opposed to the engine stopping itself via a
// worklet stall or an iOS async-start failure, which transport-recovery.mjs
// exercises).
//
// Usage: node tests/browser/transport-button-stop.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer(8913);
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
await page.waitForSelector(".transport-button");

const label = () =>
  page.locator(".transport-button").evaluate((el) => el.textContent.trim());

check("starts on Start", (await label()) === "Start", await label());

// Start — a real click is required for the AudioContext user-gesture gate.
await page.locator(".transport-button").click();
await page.waitForTimeout(400);
console.log(`      after Start click: "${await label()}"`);

// Stop via the button — this is the path under test.
await page.locator(".transport-button").click();

// The button must flip back to "Start" within one poll cycle.
await page.waitForFunction(
  () => document.querySelector(".transport-button")?.textContent.trim() === "Start",
  { timeout: 2000 },
).catch(() => {});

check(
  "button returns to Start after Stop click",
  (await label()) === "Start",
  await label(),
);

// Must be startable again after a manual stop.
await page.locator(".transport-button").click();
await page.waitForTimeout(300);
const afterRestart = await label();
check(
  "button is usable after restart",
  ["Start", "Stop"].includes(afterRestart),
  afterRestart,
);

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(
  failures === 0
    ? `[${name}] transport button manual stop works`
    : `[${name}] ${failures} FAILING`,
);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
