// Muting a beat manipulator must toggle on tap and be visibly obvious: the
// button flips Mute<->Unmute, the row gets .is-muted, and the fields dim.
// Runs with real touch (iPhone emulation) so it exercises the tap path, not a
// mouse click.
//
// Usage: node tests/browser/modulator-mute.mjs [chromium|webkit]
import { chromium, webkit, devices } from "playwright";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer(8914);
const browser = await (name === "webkit" ? webkit : chromium).launch();
// A touch-capable mobile context, the way a phone actually drives it.
const context = await browser.newContext(
  name === "webkit" ? { ...devices["iPhone 13"] } : { ...devices["Pixel 5"] },
);
const page = await context.newPage();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(server.url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Add Modulator" }).tap();
await page.waitForSelector(".modulator-item");

const state = () => page.evaluate(() => {
  const item = document.querySelector(".modulator-item");
  const btn = item.querySelector(".modulator-actions button");
  const field = item.querySelector(".modulator-field");
  return {
    label: btn.textContent.trim(),
    muted: item.classList.contains("is-muted"),
    fieldOpacity: Number(getComputedStyle(field).opacity),
  };
});

const muteButton = page.locator(".modulator-actions button", { hasText: /Mute|Unmute/ }).first();

const before = await state();
check("starts unmuted", before.label === "Mute" && !before.muted && before.fieldOpacity > 0.9,
  JSON.stringify(before));

await muteButton.tap();
await page.waitForTimeout(200);
const muted = await state();
check("tap mutes: label, class, and dimming all change",
  muted.label === "Unmute" && muted.muted === true && muted.fieldOpacity < 0.6,
  JSON.stringify(muted));

await muteButton.tap();
await page.waitForTimeout(200);
const unmuted = await state();
check("tap again unmutes",
  unmuted.label === "Mute" && unmuted.muted === false && unmuted.fieldOpacity > 0.9,
  JSON.stringify(unmuted));

// The button must actually be the top element at its centre -- nothing (e.g. the
// graph SVG) overlapping and eating the tap.
const reachable = await muteButton.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return el === hit || el.contains(hit);
});
check("mute button is not overlapped", reachable);

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] mute toggles on tap` : `[${name}] ${failures} FAILING`);

await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
