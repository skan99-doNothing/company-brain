#!/usr/bin/env node
/**
 * Serves the atlas over http so it can fetch org.config.json and state/inventory.json.
 * Opening atlas/index.html straight off the filesystem works too, but the browser
 * blocks those fetches, so it falls back to the demo data baked into the page.
 *
 *   node bin/serve-atlas.mjs [port]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const PORT = Number(process.argv[2]) || 4173;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") rel = "/atlas/index.html";
    // keep the server inside the project folder
    const file = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, () => {
  console.log(`\n  atlas  http://localhost:${PORT}/`);
  console.log(`  ctrl-c to stop\n`);
});
