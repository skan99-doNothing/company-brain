#!/usr/bin/env node
/**
 * serve-brain-map.mjs — the map with the real search behind it.
 *
 *   npm run map:serve            http://127.0.0.1:8975
 *   npm run map:serve -- --port 9000
 *
 * The generated page works on its own: double-click it and you get the map,
 * the ledgers, the agents, and instant search over every document title and
 * path. What it cannot do alone is search by meaning, because that needs an
 * embedder and a key, and neither belongs inside a file you can email.
 *
 * So the page asks. On load it pings `api/health` on its own origin. Opened
 * from disk that request fails and the page stays in title-search mode without
 * saying anything. Served from here it succeeds, and the same search box starts
 * returning passages ranked by meaning as well as by name.
 *
 * The same server also opens files. A row in the index is a real document on
 * disk, and clicking it should show that document, not a path to copy. So there
 * is a small file API: read one, write one back, reveal it in Explorer.
 *
 * Bound to 127.0.0.1 on purpose. The search endpoint reaches the whole index,
 * and the file API writes to disk, so this is not something to expose on a
 * network. Every path it accepts must already be a document in the index, which
 * is a whitelist rather than a check: a path that is not indexed is refused
 * whatever it points at, so no amount of ../ reaches anything.
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "atlas", "brain-map.html");

const argv = process.argv.slice(2);
const PORT = Number((() => { const i = argv.indexOf("--port"); return i === -1 ? "8975" : argv[i + 1]; })());

const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };

if (!existsSync(PAGE)) {
  console.error(`no page at ${PAGE}\nrun: npm run map`);
  process.exit(1);
}

process.loadEnvFile(join(ROOT, ".env"));
const { brain } = await import("./lib/search.mjs");
const b = brain();

/** Read a JSON body with a hard cap, so a stuck client cannot grow the heap. */
function readJson(req, limit = 64 * 1024) {
  return new Promise((ok, fail) => {
    let n = 0;
    const parts = [];
    req.on("data", (chunk) => {
      n += chunk.length;
      if (n > limit) { fail(new Error("body too large")); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on("end", () => {
      try { ok(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); }
      catch (e) { fail(e); }
    });
    req.on("error", fail);
  });
}

/* --------------------------------------------------------- path safety -- */

const FWD = (p) => String(p).split("\\").join("/");
const PREFIX = FWD(ROOT) + "/";

/**
 * Every path the page may touch, taken from the index.
 *
 * This is the whole security model and it is deliberately not a string check.
 * Rejecting "../" or requiring a prefix invites a bypass; requiring that the
 * path is a document the indexer already wrote down cannot be talked around,
 * because the set is finite and came from a filesystem walk this server did not
 * perform. Cached for a minute so opening ten files is one query.
 */
let allowed = null;
let allowedAt = 0;

async function allowedPaths() {
  if (allowed && Date.now() - allowedAt < 60_000) return allowed;
  const seen = new Map();
  for (let offset = 0; ; offset += 1000) {
    const part = await b.db.rest(`/documents?select=source_path,title,department&limit=1000&offset=${offset}`);
    for (const r of part) {
      const rel = FWD(r.source_path).replace(PREFIX, "");
      seen.set(rel.toLowerCase(), { rel, abs: r.source_path, title: r.title, department: r.department });
    }
    if (part.length < 1000) break;
  }
  allowed = seen;
  allowedAt = Date.now();
  return allowed;
}

/** Only text a person would edit. Nothing here should ever hand back a binary. */
const EDITABLE = /\.(md|markdown|txt|json|ya?ml|csv|sql|mjs|cjs|js|ts|css|html?|py|sh|toml|ini)$/i;

async function lookup(rawPath) {
  const rel = FWD(rawPath ?? "").replace(PREFIX, "").replace(/^\/+/, "");
  const hit = (await allowedPaths()).get(rel.toLowerCase());
  if (!hit) return { error: "not an indexed document" };
  if (!existsSync(hit.abs)) return { error: "indexed, but no longer on disk" };
  return hit;
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/api/health") {
    return send(res, 200, { ok: true, search: "hybrid", files: true });
  }

  // Read one document, whole, exactly as it is on disk.
  if (url.pathname === "/api/file" && req.method === "GET") {
    const hit = await lookup(url.searchParams.get("path"));
    if (hit.error) return send(res, 404, { error: hit.error });
    const st = statSync(hit.abs);
    if (st.size > 2 * 1024 * 1024) {
      return send(res, 413, { error: `${(st.size / 1048576).toFixed(1)} MB is too large to open here` });
    }
    return send(res, 200, {
      path: hit.rel,
      abs: hit.abs,
      title: hit.title,
      department: hit.department,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      editable: EDITABLE.test(hit.rel),
      text: readFileSync(hit.abs, "utf8"),
    });
  }

  // Write it back.
  //
  // Through a temporary file and a rename, so an interrupted write leaves the
  // original intact rather than truncated. These are notes that exist in one
  // place; a half-written ledger is worse than a failed save.
  if (url.pathname === "/api/file" && req.method === "PUT") {
    const hit = await lookup(url.searchParams.get("path"));
    if (hit.error) return send(res, 404, { error: hit.error });
    if (!EDITABLE.test(hit.rel)) return send(res, 415, { error: "not a text file this can edit" });

    let body;
    try { body = await readJson(req, 4 * 1024 * 1024); }
    catch { return send(res, 400, { error: "bad body" }); }
    if (typeof body.text !== "string") return send(res, 400, { error: "no text" });

    // The page sends back the mtime it opened. If disk has moved on since, the
    // nightly reindex or another editor got there first and this would silently
    // overwrite it.
    if (body.mtime && statSync(hit.abs).mtime.toISOString() !== body.mtime) {
      return send(res, 409, { error: "changed on disk since you opened it. Reopen and redo the edit." });
    }

    const tmp = hit.abs + ".saving";
    try {
      writeFileSync(tmp, body.text, "utf8");
      renameSync(tmp, hit.abs);
    } catch (err) {
      return send(res, 500, { error: String(err.message).slice(0, 200) });
    }
    const st = statSync(hit.abs);
    console.log(`${c.green}saved${c.off} ${hit.rel} ${c.dim}${st.size} bytes${c.off}`);
    return send(res, 200, { ok: true, bytes: st.size, mtime: st.mtime.toISOString() });
  }

  // Show it where it lives.
  if (url.pathname === "/api/reveal" && req.method === "POST") {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: "bad body" }); }
    const hit = await lookup(body.path);
    if (hit.error) return send(res, 404, { error: hit.error });
    // execFile with an argument array, never a shell string: the path comes
    // from the index and not from a person, but a filename with a quote in it
    // should still be impossible to turn into a command.
    execFile("explorer.exe", ["/select,", hit.abs], () => { /* explorer exits non-zero on success */ });
    return send(res, 200, { ok: true, abs: hit.abs });
  }

  if (url.pathname === "/api/search" && req.method === "POST") {
    let body;
    try { body = await readJson(req); }
    catch { return send(res, 400, { error: "bad body" }); }

    const q = String(body.q ?? "").slice(0, 400).trim();
    if (!q) return send(res, 400, { error: "empty query" });

    // The department comes from the page's own list, but it still reaches a
    // query string, so it is checked against the config rather than trusted.
    const known = new Set(JSON.parse(readFileSync(join(ROOT, "org.config.json"), "utf8")).departments.map((d) => d.id));
    const dept = body.department && known.has(body.department) ? body.department : null;
    const k = Math.max(1, Math.min(20, Number(body.k) || 8));

    try {
      const hits = await b.search(q, { department: dept, k });
      const prefix = ROOT.split("\\").join("/") + "/";
      return send(res, 200, {
        hits: hits.map((h) => ({
          title: h.title,
          path: String(h.source_path ?? "").split("\\").join("/").replace(prefix, ""),
          department: h.department,
          doc_type: h.doc_type,
          heading: h.heading_path,
          content: String(h.content ?? "").slice(0, 420),
          score: h.score,
        })),
      });
    } catch (err) {
      console.error(`${c.yellow}search failed${c.off}: ${String(err.message).slice(0, 200)}`);
      return send(res, 502, { error: "search failed", detail: String(err.message).slice(0, 200) });
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = readFileSync(PAGE);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length });
    return res.end(html);
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${c.green}brain map${c.off}  http://127.0.0.1:${PORT}`);
  console.log(`${c.dim}search by meaning is live. Ctrl+C to stop.${c.off}`);
});
