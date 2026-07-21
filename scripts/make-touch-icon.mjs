// Renders the app icon to a 180x180 opaque PNG for iOS home screens.
// iOS masks the icon with its own rounded rectangle, so the source is a
// full-bleed square with no transparency and no pre-rounded corners.
//
// Run when the icon design changes: node scripts/make-touch-icon.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "static/icons/apple-touch-icon.png");
const SIZE = 180;

// Same marks as static/icons/icon.svg, but a full square background (no rx) so
// iOS can apply its own corner mask cleanly.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${SIZE}" height="${SIZE}">
  <rect width="256" height="256" fill="#16324f"/>
  <rect x="34" y="138" width="24" height="56" rx="12" fill="#f8f3eb"/>
  <rect x="76" y="102" width="24" height="92" rx="12" fill="#f8f3eb"/>
  <rect x="118" y="66" width="24" height="128" rx="12" fill="#c76431"/>
  <rect x="160" y="122" width="24" height="72" rx="12" fill="#f8f3eb"/>
  <rect x="202" y="86" width="24" height="108" rx="12" fill="#2a8f6a"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
  { waitUntil: "networkidle" },
);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: SIZE, height: SIZE }, omitBackground: false });
await browser.close();

console.log(`wrote ${out}`);
