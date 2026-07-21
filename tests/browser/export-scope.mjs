// With several patterns in the library, Export must write only the selected
// one, named after it. The original round-trip test had a single pattern, so it
// could not tell "exports current" from "exports everything".
import { chromium } from "playwright";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";

const server = await startServer(8903);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const work = await mkdtemp(join(tmpdir(), "fm-scope-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS " : "FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".pattern-card");

// Build a library of three, each with a distinguishable column count.
await page.getByRole("button", { name: "New" }).click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Add Column" }).click();
await page.waitForTimeout(200);

await page.getByRole("button", { name: "New" }).click();
await page.waitForTimeout(200);
for (let i = 0; i < 3; i += 1) {
  await page.getByRole("button", { name: "Add Column" }).click();
  await page.waitForTimeout(120);
}

const state = await page.evaluate(() => ({
  titles: [...document.querySelectorAll(".pattern-select-field option")].map((o) => o.textContent),
  selected: document.querySelector(".pattern-select-field select").value,
  delays: [...document.querySelectorAll(".delay-chip input")].map((i) => i.value),
}));
console.log(`      library: ${JSON.stringify(state.titles)}  current has ${state.delays.length} columns`);
check("library really holds three patterns", state.titles.length === 3);

const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export" }).click(),
]);
const file = join(work, "out.json");
await download.saveAs(file);
const parsed = JSON.parse(await readFile(file, "utf8"));

check(
  "export contains exactly one pattern",
  parsed.pattern !== undefined && parsed.patterns === undefined,
  `keys: ${Object.keys(parsed).join(",")} title: ${parsed.pattern?.title}`,
);
check(
  "the exported pattern is the selected one",
  parsed.pattern?.steps.length === state.delays.length,
  `exported ${parsed.pattern?.steps.length} columns, selected has ${state.delays.length}`,
);
check(
  "filename matches the selected pattern",
  download.suggestedFilename().startsWith("pattern-3"),
  download.suggestedFilename(),
);

// Now select a different pattern and export again.
await page.selectOption(".pattern-select-field select", { index: 0 });
await page.waitForTimeout(300);
const first = await page.evaluate(() => ({
  delays: [...document.querySelectorAll(".delay-chip input")].map((i) => i.value),
  title: document.querySelector(".pattern-select-field select").selectedOptions[0].textContent,
}));

const [d2] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export" }).click(),
]);
const file2 = join(work, "out2.json");
await d2.saveAs(file2);
const parsed2 = JSON.parse(await readFile(file2, "utf8"));

check(
  "switching selection changes what is exported",
  parsed2.pattern?.steps.length === first.delays.length,
  `exported ${parsed2.pattern?.steps.length} columns for "${first.title}" (${first.delays.length})`,
);
check(
  "filename follows the newly selected pattern",
  d2.suggestedFilename() !== download.suggestedFilename(),
  `${download.suggestedFilename()} -> ${d2.suggestedFilename()}`,
);

console.log(failures === 0 ? "\nexport is scoped to the selected pattern" : `\n${failures} FAILING`);
await rm(work, { recursive: true, force: true });
await browser.close();
await server.stop();
process.exit(failures === 0 ? 0 : 1);
