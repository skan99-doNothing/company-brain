#!/usr/bin/env node
/**
 * index.mjs — keep Supabase in step with the markdown on disk.
 *
 *   node bin/index.mjs                 incremental: only files whose hash changed
 *   node bin/index.mjs --rebuild       wipe the index and rebuild from disk
 *   node bin/index.mjs --dry           report what would change, write nothing
 *   node bin/index.mjs --dept capital  restrict to one department's paths
 *   node bin/index.mjs --limit 50      stop after N files, for a smoke test
 *   node bin/index.mjs --slow          Voyage's unpaid limits: 3 req/min, 10K tokens/min
 *   node bin/index.mjs --no-relate     skip the correlation rebuild at the end
 *
 * The index is derived. Nothing here is a source of truth, so --rebuild is a
 * normal operation rather than a recovery step.
 *
 * Order matters. Documents are upserted first so every path has an id, then
 * links are resolved against that map, because a wikilink can point at a note
 * that is indexed later in the same run. The correlation rebuild comes last of
 * all, after stale documents are deleted, because it averages the chunks that
 * exist at the end rather than the ones that existed at the start.
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";

import { ROOT, loadConfig, departmentFor, vaultFor, docTypeFor, norm } from "./lib/config.mjs";
import { loadIgnore, collectFiles, missingRoots } from "./lib/walk.mjs";
import { splitFrontmatter, titleFor, extractLinks, chunkMarkdown, estimateTokens } from "./lib/markdown.mjs";
import { embedder } from "./lib/embed.mjs";
import { localEmbedder } from "./lib/embed-local.mjs";
import { store } from "./lib/store.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); }
catch { console.error('no .env at the org root. The retrieval stage is not set up: see "Retrieval" in the README.'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };

const REBUILD = flag("--rebuild");
const NO_RELATE = flag("--no-relate");
const DRY = flag("--dry");
const SLOW = flag("--slow");        // Voyage's unpaid limits: 3 req/min, 10K tokens/min
const ONLY_DEPT = value("--dept");
const LIMIT = Number(value("--limit") || 0);

const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", off: "\x1b[0m" };
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------ discover --

const { cfg, claims } = loadConfig();
const excluded = cfg.index?.exclude ?? [];
const ignore = loadIgnore(excluded);

// --dept takes a comma-separated list, so the corpus can be indexed in tiers.
// The cost is very unevenly distributed: three departments are 90% of the
// tokens, and they are not the three that hold the org's memory.
const wanted = ONLY_DEPT ? ONLY_DEPT.split(",").map((s) => s.trim()).filter(Boolean) : null;
const departments = wanted
  ? cfg.departments.filter((d) => wanted.includes(d.id))
  : cfg.departments;

if (wanted) {
  const unknown = wanted.filter((w) => !cfg.departments.some((d) => d.id === w));
  if (unknown.length) {
    console.error(`no department with id: ${unknown.join(", ")}`);
    console.error(`known: ${cfg.departments.map((d) => d.id).join(", ")}`);
    process.exit(1);
  }
}

const roots = [...new Set(departments.flatMap((d) => d.paths ?? []))];
// The org's own memory is part of the corpus and is the highest value part per
// token, so it rides along with any tier that includes the memory department.
if (!wanted || wanted.includes("memory")) {
  roots.push("departments", "state", "decisions.md", "HOME.md", "CLAUDE.md");
}

const gone = missingRoots(roots);
let files = collectFiles(roots, ignore);

// Department paths nest: Memory owns vaults/context and Capital owns
// vaults/context/Projects/Trading inside it. Walking Memory's root therefore
// sweeps up Capital's files, which ownership then correctly reassigns. For a
// tiered run that is wrong, so keep only files the selected departments own.
// Org-level files (briefs, ledgers, decisions) have no owner and ride with memory.
if (wanted) {
  const before = files.length;
  files = files.filter((f) => {
    const owner = departmentFor(f, claims);
    if (owner === null) return wanted.includes("memory");
    return wanted.includes(owner);
  });
  const dropped = before - files.length;
  if (dropped) console.log(`${dropped} files skipped: owned by departments outside this run`);
}

if (LIMIT) files = files.slice(0, LIMIT);

console.log(
  `${files.length} markdown files under ${roots.length} declared paths` +
  (excluded.length ? ` (${excluded.length} paths excluded from the index)` : "")
);
if (gone.length) {
  console.log(`${c.yellow}${gone.length} declared paths no longer exist:${c.off}`);
  for (const g of gone) console.log(`  ${c.yellow}missing${c.off}  ${g}`);
}

// --------------------------------------------------------------------- parse --

const db = store();
if (REBUILD && !DRY) {
  console.log("--rebuild: clearing the index");
  await db.truncateAll();
}

const known = REBUILD && !DRY ? new Map() : await db.documentIndex();

const pending = [];   // files that changed and need embedding
let unchanged = 0;
let totalChunks = 0;

for (const file of files) {
  let text, st;
  try { text = readFileSync(file, "utf8"); st = statSync(file); }
  catch { continue; }                                   // vanished mid-run

  const hash = sha(text);
  const prior = known.get(file);
  if (prior && prior.hash === hash && !REBUILD) { unchanged++; continue; }

  const { frontmatter, body } = splitFrontmatter(text);
  const title = titleFor(frontmatter, body, basename(file));
  const chunks = chunkMarkdown(body, { docTitle: title });
  totalChunks += chunks.length;

  pending.push({
    file,
    doc: {
      source_path: file,
      vault: vaultFor(file),
      department: departmentFor(file, claims),
      doc_type: docTypeFor(file),
      title,
      frontmatter,
      mtime: st.mtime.toISOString(),
      content_hash: hash,
      bytes: Buffer.byteLength(text),
    },
    chunks,
    links: extractLinks(body),
  });
}

/**
 * Documents that should no longer be in the index.
 *
 * Two reasons, not one. The file may be gone, or it may still exist but now sit
 * behind an exclusion, which is what happens whenever index.exclude grows. Only
 * a full run can judge the second case: a --dept or --limit run sees a
 * deliberate subset of the corpus and must not delete everything outside it.
 */
const fullRun = !wanted && !LIMIT;
const present = new Set(files.map((f) => norm(f)));

const stale = [...known.entries()].filter(([path]) => {
  try { statSync(path); }
  catch { return true; }                       // file is gone
  return fullRun && !present.has(norm(path));  // file exists but is now excluded
});

const tokens = pending.reduce((n, p) => n + p.chunks.reduce((m, ch) => m + ch.token_count, 0), 0);

console.log(
  `${unchanged} unchanged, ${pending.length} to index, ` +
  `${totalChunks} chunks, ~${tokens.toLocaleString()} tokens, ${stale.length} to delete`
);

if (DRY) {
  const byDept = {};
  for (const p of pending) byDept[p.doc.department ?? "(none)"] = (byDept[p.doc.department ?? "(none)"] ?? 0) + 1;
  for (const [d, n] of Object.entries(byDept).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${d}`);
  }
  console.log(`${c.dim}dry run, nothing written${c.off}`);
  process.exit(0);
}

// ---------------------------------------------------------- embed and write --

/**
 * Work proceeds in waves: embed a wave, write it, then start the next. A crash
 * or a rate-limit give-up therefore costs at most one wave, because everything
 * already written matches on content hash next run and is skipped. That is what
 * makes a long throttled run survivable.
 */
if (pending.length) {
  // EMBEDDING_PROVIDER picks the backend. Both expose the same shape, so nothing
  // downstream knows or cares which one produced a vector. Switching providers
  // means changing this variable and re-running with --rebuild, because vectors
  // are only comparable to vectors from the same model.
  const provider = (process.env.EMBEDDING_PROVIDER || "voyage").toLowerCase();

  const embed = provider === "local"
    ? localEmbedder()
    : embedder({
        slow: SLOW,
        // Throttling must be visible. A run that silently slows to a crawl looks
        // identical to a run that is working, which is how the first attempt
        // burned an hour before anyone noticed.
        onThrottle: ({ attempt, waitMs, penalty, budget }) =>
          console.log(
            `\n  ${c.yellow}throttled${c.off} attempt ${attempt}, waiting ${Math.round(waitMs / 1000)}s ` +
            `(budget now ${budget} tok/min, penalty ${penalty.toFixed(2)}x)`
          ),
      });

  if (provider === "local") {
    const p = await embed.probe();
    if (p.dimensions !== Number(process.env.EMBEDDING_DIMENSIONS || 1024)) {
      console.error(
        `${c.red}dimension mismatch${c.off}: ${p.model} returns ${p.dimensions} but the ` +
        `schema declares ${process.env.EMBEDDING_DIMENSIONS}. Migrate the vector columns first.`
      );
      process.exit(1);
    }
  }
  // Guard the arithmetic: a provider that forgets to expose maxBatchTokens makes
  // this NaN, every size comparison false, and the whole corpus one giant wave
  // that checkpoints nothing.
  const waveBudget = Math.min(Number(embed.maxBatchTokens) || 40_000, 50_000);
  console.log(
    provider === "local"
      ? `embedding ${totalChunks} chunks with ${embed.model} locally via Ollama, no rate limit`
      : `embedding ${totalChunks} chunks with ${embed.model} at ${embed.dimensions} dims ` +
        `(${embed.rpm} req/min, ${embed.tpm.toLocaleString()} tokens/min)`
  );

  const started = Date.now();
  let doneFiles = 0, doneChunks = 0;
  let wave = [], waveTokens = 0;

  const flushWave = async () => {
    if (!wave.length) return;

    const texts = wave.flatMap((p) =>
      p.chunks.map((ch) => (ch.heading_path ? `${ch.heading_path}\n\n${ch.content}` : ch.content))
    );
    const vectors = await embed.embedAll(texts);

    let v = 0;
    for (const p of wave) for (const ch of p.chunks) ch.embedding = vectors[v++];

    for (const p of wave) {
      const id = await db.upsertDocument(p.doc);
      await db.deleteChunks(id);
      await db.deleteLinks(id);
      await db.insertChunks(id, p.chunks);
      await db.insertLinks(id, p.links);     // dst_id filled in by the resolve pass
      doneFiles++;
      doneChunks += p.chunks.length;
    }

    const elapsed = (Date.now() - started) / 1000;
    const rate = doneChunks / Math.max(elapsed, 1);
    const eta = rate > 0 ? Math.round((totalChunks - doneChunks) / rate) : 0;
    process.stdout.write(
      `\r  ${doneFiles}/${pending.length} files, ${doneChunks}/${totalChunks} chunks` +
      (eta > 0 ? `, ~${Math.floor(eta / 60)}m ${eta % 60}s left   ` : "   ")
    );

    wave = [];
    waveTokens = 0;
  };

  for (const p of pending) {
    const t = p.chunks.reduce((n, ch) => n + ch.token_count, 0);
    if (wave.length && waveTokens + t > waveBudget) await flushWave();
    wave.push(p);
    waveTokens += t;
  }
  await flushWave();

  process.stdout.write("\r" + " ".repeat(72) + "\r");
  console.log(`embedded and written, ${embed.tokensUsed.toLocaleString()} tokens billed`);
}

// ---------------------------------------------------------------- resolve -----

/**
 * Links are written unresolved and resolved afterwards, against the whole
 * document table rather than just this run's files. A wikilink can point at a
 * note indexed later, or in an earlier run that crashed, and this pass is
 * idempotent, so re-running heals whatever the last run left dangling.
 */
async function page(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await db.rest(`${path}&order=id&limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const allDocs = await page("/documents?select=id,source_path");
const byName = new Map();
for (const d of allDocs) {
  const name = basename(d.source_path).replace(/\.md$/i, "").toLowerCase();
  if (!byName.has(name)) byName.set(name, d.id);
}

/**
 * Ask dst_id, not the flag.
 *
 * A link written this run has resolved = false, which is what this query used
 * to look for. But a link that resolved correctly and then had its target
 * re-indexed has resolved = true and a null dst_id: the foreign key is
 * "on delete set null", and re-indexing a document deletes and re-inserts it,
 * so every link pointing INTO that document is quietly orphaned. Selecting on
 * the flag alone never saw those again. Forty had accumulated, every one of
 * them pointing at a document that was sitting in the index the whole time.
 *
 * dst_id is the fact. resolved is a cache of it. Ask the fact.
 */
const dangling = await page("/links?dst_id=is.null&select=id,link_text,resolved");
const byTarget = new Map();
for (const l of dangling) {
  const key = l.link_text.replace(/\.md$/i, "").split("/").pop().toLowerCase();
  const dst = byName.get(key);
  if (!dst) continue;
  if (!byTarget.has(dst)) byTarget.set(dst, []);
  byTarget.get(dst).push(l.id);
}

let nowResolved = 0;
for (const [dst, ids] of byTarget) {
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    await db.rest(`/links?id=in.(${slice.join(",")})`, {
      method: "PATCH",
      body: { dst_id: dst, resolved: true },
      prefer: "return=minimal",
    });
    nowResolved += slice.length;
  }
}

// The other half of the same repair. A link that lost its target and found no
// new one is still carrying resolved = true from before, which is how the
// count of broken links and the count of unresolved ones came to disagree by
// forty. Say what is true, so the next run inherits a fact and not a lie.
const lying = dangling.filter(function (l) {
  if (!l.resolved) return false;
  return !byName.has(l.link_text.replace(/\.md$/i, "").split("/").pop().toLowerCase());
});
for (let i = 0; i < lying.length; i += 200) {
  const slice = lying.slice(i, i + 200).map(function (l) { return l.id; });
  await db.rest(`/links?id=in.(${slice.join(",")})`, {
    method: "PATCH",
    body: { resolved: false },
    prefer: "return=minimal",
  });
}
if (lying.length) console.log(`${lying.length} links were flagged resolved with nothing to point at; corrected`);

if (stale.length) {
  console.log(`removing ${stale.length} documents that are gone or newly excluded`);
  await db.deleteDocuments(stale.map(([, r]) => r.id));
}

/**
 * Which documents are about the same thing, rebuilt from the embeddings this
 * run just wrote.
 *
 * It has to be here rather than left to the caller. The edges are derived from
 * chunk vectors, so the moment a file is re-indexed or deleted they describe a
 * corpus that no longer exists, and nothing in the page that reads them can
 * tell. Skipped when nothing moved, because rebuilding identical edges costs
 * seconds and buys nothing.
 */
let relatedEdges = null;
const changed = pending.length + stale.length;
if (!DRY && !NO_RELATE && changed) {
  process.stdout.write("correlating documents ");
  const t0 = Date.now();
  try {
    const out = await db.rest("/rpc/rebuild_related", { method: "POST", body: {} });
    relatedEdges = typeof out === "number" ? out : (Array.isArray(out) ? out[0]?.rebuild_related : null);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    // A failed correlation is not a failed index. Say so and keep the exit code
    // clean: the documents and links written above are all still correct.
    console.log(`\n${c.yellow}correlation skipped${c.off}: ${String(err.message).slice(0, 160)}`);
    console.log(`${c.dim}run npm run relate once the cause is fixed${c.off}`);
  }
} else if (!DRY && !NO_RELATE) {
  console.log(`${c.dim}nothing changed, correlations left alone${c.off}`);
}

const final = await db.counts();
console.log(
  `\n${c.green}indexed${c.off}  ${final.documents} documents, ${final.chunks} chunks, ${final.links} links` +
  `\n         ${nowResolved} links resolved this run, ${dangling.length - nowResolved} still point outside the index` +
  (relatedEdges === null ? "" : `\n         ${relatedEdges.toLocaleString()} correlation edges rebuilt`)
);
