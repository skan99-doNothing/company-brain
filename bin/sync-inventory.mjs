#!/usr/bin/env node
/**
 * Walks every path declared in org.config.json and writes state/inventory.json.
 *
 * Briefs are written by hand and start drifting the moment they are saved. This does
 * not. Its most useful output is the list of paths a brief claims that no longer exist.
 *
 *   node bin/sync-inventory.mjs           scan and print a summary
 *   node bin/sync-inventory.mjs --quiet   scan silently (used by the launcher)
 *   node bin/sync-inventory.mjs --json    print the whole thing to stdout
 */
import { readdir, writeFile, readFile, access, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const QUIET = process.argv.includes("--quiet");
const JSONOUT = process.argv.includes("--json");
const MAX_DEPTH = 6;

const SKIP = new Set([
  ".git", "node_modules", ".venv", "venv", "anaconda3", "__pycache__", ".next", ".nuxt",
  "dist", "build", "out", ".turbo", ".cache", ".parcel-cache", "coverage", ".pytest_cache",
  ".mypy_cache", ".ipynb_checkpoints", "target", "vendor", "Pods", ".obsidian", ".svelte-kit",
]);

const c = { dim: "\x1b[2m", red: "\x1b[31m", yel: "\x1b[33m", off: "\x1b[0m" };
async function exists(p) { try { await access(p); return true; } catch { return false; } }

let cfg;
try { cfg = JSON.parse(await readFile(join(ROOT, "org.config.json"), "utf8")); }
catch (e) { console.error("Could not read org.config.json:", e.message); process.exit(1); }

/** Count files under a directory, bounded so a stray node_modules cannot hang it. */
async function scan(dir, depth = 0, acc = { md: 0, files: 0, dirs: 0, newest: 0 }) {
  if (depth > MAX_DEPTH) return acc;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".") && ![".claude", ".agents", ".github"].includes(e.name)) continue;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { acc.dirs++; await scan(p, depth + 1, acc); }
    else {
      acc.files++;
      if (e.name.endsWith(".md")) acc.md++;
      try { const st = await stat(p); if (st.mtimeMs > acc.newest) acc.newest = st.mtimeMs; } catch { /* ignore */ }
    }
  }
  return acc;
}

/** Which Claude machinery a folder carries, which is a good proxy for "worked in". */
async function claudeBits(dir) {
  const bits = [];
  if (await exists(join(dir, "CLAUDE.md"))) bits.push("CLAUDE.md");
  if (await exists(join(dir, ".mcp.json"))) {
    bits.push("mcp");
    try {
      const j = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
      for (const n of Object.keys(j.mcpServers ?? {})) bits.push("mcp:" + n);
    } catch { /* malformed, the plain marker still stands */ }
  }
  const sk = join(dir, ".claude", "skills");
  if (await exists(sk)) {
    try {
      for (const d of await readdir(sk, { withFileTypes: true })) if (d.isDirectory()) bits.push("skill:" + d.name);
    } catch { /* ignore */ }
  }
  return bits;
}

const out = {
  generated: new Date().toISOString(),
  org: cfg.org?.name ?? "org",
  departments: {},
  totals: { md: 0, files: 0, paths: 0, missing: 0, gaps: 0 },
};

for (const d of cfg.departments ?? []) {
  const rows = [];
  for (const rel of d.paths ?? []) {
    const abs = join(ROOT, rel.split("/").join(process.platform === "win32" ? "\\" : "/"));
    if (!(await exists(abs))) { rows.push({ path: rel, missing: true }); out.totals.missing++; continue; }
    const s = await scan(abs);
    rows.push({
      path: rel, md: s.md, files: s.files, dirs: s.dirs,
      newest: s.newest ? new Date(s.newest).toISOString().slice(0, 10) : null,
      claude: await claudeBits(abs),
    });
    out.totals.md += s.md; out.totals.files += s.files; out.totals.paths++;
  }
  rows.sort((a, b) => (b.md ?? 0) - (a.md ?? 0));
  const gaps = (d.clusters ?? []).flatMap((cl) => cl.items ?? []).filter((i) => i.type === "gap").length;
  out.totals.gaps += gaps;
  out.departments[d.id] = { name: d.name, gaps, paths: rows };
}

await mkdir(join(ROOT, "state"), { recursive: true });
await writeFile(join(ROOT, "state", "inventory.json"), JSON.stringify(out, null, 2) + "\n", "utf8");

if (JSONOUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
if (QUIET) process.exit(0);

console.log(`\ninventory written  ${out.generated.slice(0, 10)}`);
console.log(`${c.dim}  ${out.totals.paths} paths, ${out.totals.md} markdown, ${out.totals.files} files, ${out.totals.gaps} gaps${c.off}`);
for (const [id, dep] of Object.entries(out.departments)) {
  const md = dep.paths.reduce((n, r) => n + (r.md ?? 0), 0);
  const gone = dep.paths.filter((r) => r.missing).length;
  console.log(`  ${id.padEnd(12)} ${String(md).padStart(5)} md  ${dep.paths.length} paths  ${dep.gaps} gaps${gone ? `  ${c.red}${gone} missing${c.off}` : ""}`);
}
if (out.totals.missing) {
  console.log(`\n${c.yel}!${c.off} ${out.totals.missing} declared path(s) do not exist. A brief is pointing somewhere that moved.`);
  for (const [id, dep] of Object.entries(out.departments)) {
    for (const r of dep.paths) if (r.missing) console.log(`    ${id}: ${r.path}`);
  }
}
console.log();
