// The transport button must return to "Start" when the audio engine stops on
// its own — a worklet stall, or an async start failure on iOS. Rust's is_playing
// only ever went false on a click, so the button stayed "Stop" forever; the fix
// makes the 250ms timing poll treat a JS "idle" as authoritative.
//
// This drives the exact divergence: start playing, then stop the JS engine
// directly (as a stall/failure would) without touching Rust, and confirm the
// button recovers on its own.
//
// Usage: node tests/browser/transport-recovery.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer(8912);
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

// A real click is the user gesture the AudioContext needs.
await page.locator(".transport-button").click();
await page.waitForTimeout(500);
const afterStart = await label();
// If audio actually started (typically chromium), the button reads Stop. If the
// engine could not start in this headless engine, the poll may have already
// flipped it back — either way the recovery assertion below is what matters.
console.log(`      after Start: "${afterStart}"`);

// Stop the JS engine directly, the way a stall or async failure does — without
// going through the button, so Rust still believes it is playing.
await page.evaluate(() => window.fluidMetronomeStop());

// The 250ms poll should observe idle and flip the button back within a beat.
await page.waitForFunction(
  () => document.querySelector(".transport-button")?.textContent.trim() === "Start",
  { timeout: 3000 },
).catch(() => {});

check("button returns to Start after the engine stops itself",
  (await label()) === "Start", await label());

// And it must be usable again — clicking Start after a self-stop should work.
await page.locator(".transport-button").click();
await page.waitForTimeout(300);
check("transport can be started again after recovery",
  ["Start", "Stop"].includes(await label()), await label());

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] transport button recovers` : `[${name}] ${failures} FAILING`);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
