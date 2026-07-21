// Minimal static server for dist/, so browser tests are a single command.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

export async function startServer(port = 8899) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = join(root, path === "/" ? "/index.html" : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((ok, fail) => {
    server.on("error", fail);
    server.listen(port, ok);
  });

  return {
    url: `http://localhost:${port}/index.html`,
    stop: () => new Promise((ok) => server.close(ok)),
  };
}
