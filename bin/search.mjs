#!/usr/bin/env node
/**
 * search.mjs — ask the brain a question from the command line.
 *
 *   node bin/search.mjs "why is there no vector database"
 *   node bin/search.mjs --dept capital "what did we test and park"
 *   node bin/search.mjs --k 5 "skool cookie auth"
 *   node bin/search.mjs --why "front2back"     show which signals fired
 *
 * The ranking itself lives in the database. This is a thin viewer over it, kept
 * so the ordering can be judged by eye before anything depends on it.
 */

import { resolve } from "node:path";
import { ROOT } from "./lib/config.mjs";
import { brain } from "./lib/search.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); }
catch { console.error("no .env at the org root"); process.exit(1); }

const argv = process.argv.slice(2);
const take = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};

const DEPT = take("--dept");
const K = Number(take("--k", "8"));
const WHY = flag("--why");
const query = argv.join(" ").trim();

if (!query) {
  console.error('usage: node bin/search.mjs [--dept <id>] [--k N] [--why] "your question"');
  process.exit(1);
}

const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", off: "\x1b[0m" };
const rel = (p) => p.replace(/^.*[\\/]Org[\\/]/, "").replace(/\\/g, "/");
const flat = (s) => s.replace(/\s+/g, " ").trim();

const rows = await brain().search(query, { department: DEPT, k: K });

console.log(`\n${c.bold}${query}${c.off}${DEPT ? `${c.dim}  [${DEPT}]${c.off}` : ""}\n`);
if (!rows.length) { console.log("  no matches\n"); process.exit(0); }

for (const [i, r] of rows.entries()) {
  const signals = [
    r.vec_rank ? `vec#${r.vec_rank}` : null,
    r.lex_rank ? `lex#${r.lex_rank}` : null,
    r.trg_rank ? `trg#${r.trg_rank}` : null,
    r.graph_hits ? `graph×${r.graph_hits}` : null,
  ].filter(Boolean).join(" ");

  console.log(`${c.green}${String(i + 1).padStart(2)}.${c.off} ${c.bold}${r.title}${c.off}  ${c.dim}${r.department ?? "org"} · ${r.doc_type}${c.off}`);
  if (r.heading_path) console.log(`    ${c.dim}${r.heading_path}${c.off}`);
  console.log(`    ${flat(r.content).slice(0, 190)}`);
  console.log(`    ${c.dim}${rel(r.source_path)}${WHY ? `  ${signals}  score ${Number(r.score).toFixed(5)}` : ""}${c.off}\n`);
}
