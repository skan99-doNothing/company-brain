#!/usr/bin/env node
/**
 * eval-search.mjs — score the live retrieval path, not a model in isolation.
 *
 *   node bin/eval-search.mjs            score every question
 *   node bin/eval-search.mjs --verbose  show what each question returned
 *   node bin/eval-search.mjs --k 5      how deep a hit still counts
 *   node bin/eval-search.mjs --audit    check every expected answer still exists
 *   node bin/eval-search.mjs --dept X   score only that department's questions
 *
 * The questions live in eval-questions.mjs. Run --audit after anything that
 * moves files: a question whose expected path is gone scores zero forever and
 * reads as a search regression, which is a slow and expensive way to be lied
 * to by your own instrument.
 *
 * eval-embeddings.mjs answers "is this embedding model any good". This answers
 * the question that actually matters: does the whole stack, embedding plus
 * hybrid fusion plus weighting, put the right file in front of you.
 *
 * Every question is one you could really ask, and every expected answer is a
 * path fragment rather than a filename, so a correct answer that lives in an
 * unexpected file still counts. Tune search_chunks against these numbers. Do not
 * tune it against one query you happen to be looking at, which is how the
 * literal-token arm got built twice and thrown away once.
 */

import { resolve } from "node:path";
import { ROOT } from "./lib/config.mjs";
import { brain } from "./lib/search.mjs";
import { QUESTIONS } from "./eval-questions.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); }
catch { console.error("no .env at the org root"); process.exit(1); }

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const K = Number((() => { const i = argv.indexOf("--k"); return i === -1 ? "3" : argv[i + 1]; })());
const AUDIT = argv.includes("--audit");
const ONLY = (() => { const i = argv.indexOf("--dept"); return i === -1 ? null : argv[i + 1]; })();

const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
// Paths are absolute on disk and only the part below the root is worth reading.
// Trimmed against ROOT rather than a folder name, so a clone called anything
// still prints short paths.
const short = (p) => {
  const r = ROOT.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const f = p.replace(/\\/g, "/");
  return f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length) : f;
};
const hits = (path, fragments) => fragments.some((f) => norm(path).includes(norm(f)));

const b = brain();
const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };

/**
 * Does every expected answer still exist?
 *
 * A fragment that matches nothing makes its question unanswerable, and the
 * score drops with no indication that the question rather than the search is
 * broken. Checked against source_path directly rather than through search,
 * because search is the thing under test.
 */
if (AUDIT) {
  const { store } = await import("./lib/store.mjs");
  const db = store();
  const paths = [];
  for (let offset = 0; ; offset += 1000) {
    const part = await db.rest(`/documents?select=source_path&limit=1000&offset=${offset}`);
    paths.push(...part.map((r) => r.source_path.replace(/\\/g, "/").toLowerCase()));
    if (part.length < 1000) break;
  }
  let bad = 0;
  for (const [question, expected] of QUESTIONS) {
    const dead = expected.filter((f) => !paths.some((p) => p.includes(f.replace(/\\/g, "/").toLowerCase())));
    if (dead.length === expected.length) {
      bad++;
      console.log(`  ${c.red}unanswerable${c.off}  "${question}"`);
      console.log(`      no document matches: ${expected.join(" or ")}`);
    } else if (dead.length) {
      console.log(`  ${c.dim}stale fragment${c.off}  "${question}" -> ${dead.join(", ")}`);
    }
  }
  console.log(
    `\n  ${QUESTIONS.length} questions checked against ${paths.length} documents, ` +
    (bad ? `${c.red}${bad} unanswerable${c.off}` : `${c.green}all answerable${c.off}`)
  );
  process.exit(bad ? 1 : 0);
}

const asked = ONLY ? QUESTIONS.filter(([, , d]) => d === ONLY) : QUESTIONS;

let at1 = 0, atK = 0, mrr = 0;
const failures = [];

for (const [question, expected, dept = null] of asked) {
  const rows = await b.search(question, { department: dept, k: 10 });

  // Deduplicate by document: a file with many chunks should not fill the top N.
  const seen = [];
  for (const r of rows) if (!seen.includes(r.source_path)) seen.push(r.source_path);

  const rank = seen.findIndex((p) => hits(p, expected)) + 1;
  if (rank === 1) at1++;
  if (rank >= 1 && rank <= K) atK++;
  if (rank >= 1) mrr += 1 / rank;
  if (rank < 1 || rank > K) failures.push({ question, expected, got: seen.slice(0, 3), rank });

  if (VERBOSE) {
    const mark = rank === 1 ? `${c.green}1${c.off}` : rank > 0 && rank <= K ? `${c.green}${rank}${c.off}` : `${c.red}miss${c.off}`;
    console.log(`  [${mark}] ${question}`);
    for (const p of seen.slice(0, 3)) console.log(`         ${c.dim}${short(p)}${c.off}`);
  }
}

const n = asked.length;
console.log(
  `\n  ${n} questions   recall@1 ${(at1 / n * 100).toFixed(0)}%   ` +
  `recall@${K} ${(atK / n * 100).toFixed(0)}%   MRR ${(mrr / n).toFixed(3)}`
);

if (failures.length) {
  console.log(`\n  ${failures.length} outside the top ${K}:`);
  for (const f of failures) {
    console.log(`    "${f.question}"`);
    console.log(`      wanted a path containing: ${f.expected.join(" or ")}`);
    console.log(`      got: ${f.got.map((p) => short(p)).join("\n           ")}`);
    console.log(`      ${f.rank ? `correct answer was rank ${f.rank}` : "correct answer not in top 10"}`);
  }
}
