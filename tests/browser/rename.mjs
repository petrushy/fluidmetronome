// Renaming must update both places the title is stored: the picker entry and
// the grid that gets written into an exported file. If they drift, an export
// ends up named after one title and containing another.
import { chromium, webkit } from "playwright";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";

const name = process.argv[2] === "webkit" ? "webkit" : "chromium";
const server = await startServer(8904);
const browser = await (name === "webkit" ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const work = await mkdtemp(join(tmpdir(), "fm-rename-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".pattern-card");

const titles = () => page.evaluate(() =>
  [...document.querySelectorAll(".pattern-select-field option")].map((o) => o.textContent));

const rename = async (text, { commitWith = "button" } = {}) => {
  await page.getByRole("button", { name: "Rename" }).click();
  await page.waitForSelector(".rename-input");
  await page.fill(".rename-input", text);
  if (commitWith === "enter") {
    await page.press(".rename-input", "Enter");
  } else {
    await page.getByRole("button", { name: "Save" }).click();
  }
  await page.waitForTimeout(250);
};

// --- rename via the Save button ---
await rename("Slängpolska på Öland");
check("picker shows the new title",
  (await titles()).includes("Slängpolska på Öland"), JSON.stringify(await titles()));
check("rename closes the editor",
  (await page.locator(".rename-input").count()) === 0);

// --- both stored titles moved: filename and contents must agree ---
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export" }).click(),
]);
const file = join(work, "renamed.json");
await download.saveAs(file);
const parsed = JSON.parse(await readFile(file, "utf8"));

check("filename follows the new title",
  download.suggestedFilename() === "slangpolska-pa-oland.fluidmetronome.json",
  download.suggestedFilename());
check("file contents carry the new title",
  parsed.pattern.title === "Slängpolska på Öland", parsed.pattern.title);

// --- Enter commits ---
await rename("Second Name", { commitWith: "enter" });
check("Enter commits the rename",
  (await titles()).includes("Second Name"), JSON.stringify(await titles()));

// --- Escape cancels ---
await page.getByRole("button", { name: "Rename" }).click();
await page.waitForSelector(".rename-input");
await page.fill(".rename-input", "Discarded");
await page.press(".rename-input", "Escape");
await page.waitForTimeout(250);
check("Escape discards the edit",
  !(await titles()).includes("Discarded") && (await titles()).includes("Second Name"),
  JSON.stringify(await titles()));

// --- Cancel button discards too ---
await page.getByRole("button", { name: "Rename" }).click();
await page.fill(".rename-input", "Also discarded");
await page.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(250);
check("Cancel discards the edit",
  !(await titles()).includes("Also discarded"), JSON.stringify(await titles()));

// --- a blank name must not wipe the title ---
await rename("   ");
check("blank rename is refused",
  (await titles()).includes("Second Name"), JSON.stringify(await titles()));

// --- renaming affects only the selected pattern ---
await page.getByRole("button", { name: "New" }).click();
await page.waitForTimeout(250);
await rename("Only This One");
const all = await titles();
check("other patterns keep their names",
  all.includes("Second Name") && all.includes("Only This One"), JSON.stringify(all));

// --- the rename survives a reload, i.e. it was persisted ---
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".pattern-card");
check("rename persists across reload",
  (await titles()).includes("Only This One"), JSON.stringify(await titles()));

console.log(`\n[${name}] page errors:`, errors.length ? errors : "none");
console.log(failures === 0 ? `[${name}] rename behaves` : `[${name}] ${failures} FAILING`);

await rm(work, { recursive: true, force: true });
await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
