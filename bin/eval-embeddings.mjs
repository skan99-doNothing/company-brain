#!/usr/bin/env node
/**
 * eval-embeddings.mjs — does a given embedding model actually find the right note?
 *
 *   node bin/eval-embeddings.mjs                 compare local and Voyage
 *   node bin/eval-embeddings.mjs --local-only    skip Voyage (no key, no throttle)
 *   node bin/eval-embeddings.mjs --model bge-m3  try a different local model
 *
 * The questions below are real questions about this org with a known correct
 * source file. The corpus is the org's own memory: briefs, ledgers, decisions,
 * CLAUDE.md and HOME.md. That is small enough to embed under a throttled free
 * tier, and it is the material every department agent will be reading, so it is
 * the right thing to be accurate on.
 *
 * Scored on recall@1, recall@3 and MRR. This is the harness the design doc calls
 * for in Phase 2; it exists early because a model choice needed evidence.
 */

import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";

import { ROOT } from "./lib/config.mjs";
import { splitFrontmatter, titleFor, chunkMarkdown } from "./lib/markdown.mjs";
import { localEmbedder } from "./lib/embed-local.mjs";
import { embedder } from "./lib/embed.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); } catch { /* local-only still works */ }

const argv = process.argv.slice(2);
const LOCAL_ONLY = argv.includes("--local-only");
const MODEL = (() => { const i = argv.indexOf("--model"); return i === -1 ? undefined : argv[i + 1]; })();

/**
 * question -> the file, or files, that actually answer it.
 *
 * More than one answer is allowed because more than one file can legitimately
 * be right. The ledger rule is stated in both CLAUDE.md and HOME.md, and an
 * earlier version of this list scored a model wrong for returning HOME.md. A
 * bad label makes a model look worse than it is, which is the same failure as
 * flattering it.
 */
const QUESTIONS = [
  ["why is there no vector database for the notes", ["memory.md", "decisions.md"]],
  ["what happens if a session changes something but writes nothing to the ledger", ["CLAUDE.md", "HOME.md"]],
  ["why does searching from the org root find nothing in the vaults", ["CLAUDE.md", "memory.md"]],
  ["which department owns the rules for how the vault is organised", ["memory.md"]],
  ["what tracks whether the work actually turns into revenue", ["product.md", "revenue.md"]],
  ["where does a decision that would be expensive to reverse get written down", ["decisions.md", "CLAUDE.md"]],
];

// -------------------------------------------------------------- build corpus --

const FILES = [
  ...["growth", "memory", "product", "revenue"].map((d) => `departments/${d}.md`),
  ...["growth", "memory", "product", "revenue"].map((d) => `state/${d}.md`),
  "decisions.md", "CLAUDE.md", "HOME.md",
];

const corpus = [];
for (const rel of FILES) {
  let text;
  try { text = readFileSync(resolve(ROOT, rel), "utf8"); } catch { continue; }
  const { body } = splitFrontmatter(text);
  const title = titleFor({}, body, basename(rel));
  for (const ch of chunkMarkdown(body, { docTitle: title })) {
    corpus.push({
      source: basename(rel),
      text: ch.heading_path ? `${ch.heading_path}\n\n${ch.content}` : ch.content,
    });
  }
}

console.log(`corpus: ${corpus.length} chunks from ${FILES.length} files`);
console.log(`questions: ${QUESTIONS.length}\n`);

// ------------------------------------------------------------------- scoring --

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (a) => Math.sqrt(dot(a, a));
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b) || 1);

async function score(name, embedAll, embedQuery) {
  const started = Date.now();
  const vectors = await embedAll(corpus.map((c) => c.text));
  const indexSeconds = (Date.now() - started) / 1000;

  let hit1 = 0, hit3 = 0, mrr = 0;
  const misses = [];

  for (const [question, expected] of QUESTIONS) {
    const qv = await embedQuery(question);
    const ranked = corpus
      .map((c, i) => ({ source: c.source, score: cosine(qv, vectors[i]) }))
      .sort((a, b) => b.score - a.score);

    // Rank of the best-placed acceptable file, deduplicated by source so a file
    // with many chunks cannot occupy the whole top three on its own.
    const seen = [];
    for (const r of ranked) { if (!seen.includes(r.source)) seen.push(r.source); }
    const accept = Array.isArray(expected) ? expected : [expected];
    const ranks = accept.map((a) => seen.indexOf(a) + 1).filter((r) => r > 0);
    const rank = ranks.length ? Math.min(...ranks) : 0;

    if (rank === 1) hit1++;
    if (rank >= 1 && rank <= 3) hit3++;
    if (rank >= 1) mrr += 1 / rank;
    if (rank > 3 || rank === 0) {
      misses.push({ question, expected: accept.join(" or "), got: seen.slice(0, 3), rank });
    }
  }

  const n = QUESTIONS.length;
  return {
    name,
    recall1: hit1 / n,
    recall3: hit3 / n,
    mrr: mrr / n,
    indexSeconds,
    chunksPerSecond: corpus.length / indexSeconds,
    misses,
  };
}

// --------------------------------------------------------------------- runs --

const results = [];

const local = localEmbedder(MODEL ? { model: MODEL } : {});
try {
  const p = await local.probe();
  console.log(`local:  ${p.model} at ${p.dimensions} dims`);
  results.push(await score(`ollama ${p.model}`, (t) => local.embedAll(t), (t) => local.embedQuery(t)));
} catch (e) {
  console.log(`local:  unavailable (${e.message})`);
}

if (!LOCAL_ONLY && process.env.VOYAGE_API_KEY) {
  const remote = embedder({ slow: true });
  console.log(`remote: ${remote.model} at ${remote.dimensions} dims (throttled)\n`);
  try {
    results.push(await score(
      `voyage ${remote.model}`,
      (t) => remote.embedAll(t, { inputType: "document" }),
      (t) => remote.embedQuery(t)
    ));
  } catch (e) {
    console.log(`remote: failed (${e.message})`);
  }
}

// ------------------------------------------------------------------ report --

console.log("\n  model                        recall@1  recall@3     MRR    chunks/sec");
for (const r of results) {
  console.log(
    "  " + r.name.padEnd(28) +
    (r.recall1 * 100).toFixed(0).padStart(7) + "%" +
    (r.recall3 * 100).toFixed(0).padStart(9) + "%" +
    r.mrr.toFixed(3).padStart(9) +
    r.chunksPerSecond.toFixed(1).padStart(13)
  );
}

for (const r of results) {
  if (!r.misses.length) continue;
  console.log(`\n  ${r.name} missed ${r.misses.length}:`);
  for (const m of r.misses) {
    console.log(`    "${m.question}"`);
    console.log(`      wanted ${m.expected}, got ${m.got.join(", ")}${m.rank ? ` (rank ${m.rank})` : " (not found)"}`);
  }
}
