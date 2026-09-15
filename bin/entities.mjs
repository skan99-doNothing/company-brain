#!/usr/bin/env node
/**
 * entities.mjs — one identity for a thing across every department.
 *
 *   npm run entities                 seed from the vault, then find mentions
 *   npm run entities -- --report     what the org already knows, no writes
 *   npm run entities -- --enrich 20  have a local model describe the top N
 *   npm run entities -- --dry        show the seed, write nothing
 *
 * The expensive version of this is GraphRAG: an LLM reads every chunk and
 * extracts entities and relationships. Measured here, gemma4 takes 200 seconds
 * per document warm. 1,368 documents is 76 hours, and it has to re-run whenever
 * the corpus moves, which is nightly. That build does not survive contact with
 * this machine.
 *
 * The seed comes from what you have already declared instead. You write
 * [[People/Some Name]] and [[10_Projects/Some Project]], so the namespace before
 * the slash is the kind, stated by the person who knows. org.config.json names
 * every unit. A directory under vaults/code is a repository he made, and one
 * under vaults/loose/vps is a service he deployed. None of those costs a model
 * call and all of them are more trustworthy than extraction, because a human
 * created them on purpose.
 *
 * The repositories matter more than the rest and were missing for a week. The
 * config's units are the org chart's own vocabulary, so seeding from it alone
 * produced a graph whose "projects" were things like backtest-report and
 * edge-journal: units that are not built yet. Forty-four repositories and eight
 * deployed services, the actual work, were not named anywhere on the page.
 *
 * The seed only knows names that were linked. Finding every document that says
 * a name, including the ones nobody linked, is one indexed regex scan in
 * Postgres, and the departments those documents sit in are the cross-department
 * identity that nothing else here could produce.
 *
 * --enrich is the only part that calls a model, it is opt-in, and it runs over
 * entities rather than documents, so it costs tens of calls and not thousands.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, loadConfig } from "./lib/config.mjs";
import { store } from "./lib/store.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); }
catch { console.error("no .env at the org root"); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : Number(argv[i + 1]); };

const DRY = flag("--dry");
const REPORT = flag("--report");
const ENRICH = flag("--enrich") ? num("--enrich", 20) : 0;

const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };
const db = store();

/* ------------------------------------------------------------------ kinds -- */

/**
 * The vault's own folder namespaces, which are its declaration of what kind of
 * thing something is. Anything not on this list is a document reference rather
 * than an entity: 30_Reference and 40_Sources hold material, not subjects.
 */
const NAMESPACES = {
  "people": "person",
  "companies": "company",
  "10_projects": "project",
  "20_areas": "area",
  "topics": "topic",
};

/**
 * Directory names that are ordinary English before they are anything else.
 *
 * This is the same lesson departments taught: "Self" and "Product" matched 268
 * and 247 documents across all eight departments and measured the language, not
 * the business. A repo called `ideas` or `portfolio` would do exactly that, and
 * `bin` would match every path in every shell transcript on disk.
 */
const TOO_COMMON = new Set([
  "bin", "ideas", "portfolio", "followup", "docs", "src", "lib", "test", "tests",
  "temp", "tmp", "old", "new", "misc", "shared", "common", "assets", "public",
]);

/** Filing, not a project: a leading underscore or dot is someone's scratch drawer. */
const isFiling = (name) => /^[._]/.test(name);

/* --------------------------------------------------------------- git ---- */

/**
 * How big a repository actually is, from its own history.
 *
 * The graph sized every repository the same, so openscreen at 477 commits and a
 * folder with two looked identical, and the picture said nothing about scale.
 * Commit count and last commit are the only two numbers that need no judgement
 * and no model, and git already holds both.
 *
 * The remote is deliberately stripped of credentials before it is written
 * anywhere. One repository on this machine has a GitHub token embedded in its
 * origin URL, and copying that into a database row, a generated page or a
 * ledger would spread it to three more places.
 */
function gitFacts(dir) {
  const git = (...args) => {
    try {
      return execFileSync("git", ["-C", dir, ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();
    } catch { return ""; }
  };

  const commits = git("rev-list", "--count", "HEAD");
  if (!commits) return null;                       // not a repository, or no commits yet
  const last = git("log", "-1", "--format=%as");

  let where = "";
  const remote = git("remote", "get-url", "origin");
  if (remote) {
    // https://user:TOKEN@github.com/owner/repo.git -> github.com/owner/repo
    const m = /(?:@|\/\/)([^/@]+)\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote.replace(/\/+$/, ""));
    if (m) where = `${m[1]}/${m[2]}`;
  }

  return [
    `${Number(commits).toLocaleString()} commit${commits === "1" ? "" : "s"}`,
    last ? `last ${last}` : "",
    where || "no remote",
  ].filter(Boolean).join(" \u00b7 ");
}

/* ------------------------------------------------------------------- seed -- */

async function seed() {
  const found = new Map();   // lowercased name -> { name, kind, source, note }
  const add = (name, kind, source, note) => {
    const clean = String(name).trim();
    if (clean.length < 3) return;
    // "People Index" and "Topics Index" are the folder's own contents page, and
    // STATE is a filename convention repeated in every topic folder. Both are
    // filing, not things the business talks about.
    if (/\bindex$/i.test(clean) || clean === "STATE") return;
    const key = clean.toLowerCase();
    // First writer wins: a name declared in the vault outranks the same name
    // appearing later as a config label.
    if (!found.has(key)) found.set(key, { name: clean, kind, source, note: note || null });
  };

  // 1. Wikilink targets in a namespace that names a kind.
  const links = [];
  for (let offset = 0; ; offset += 1000) {
    const part = await db.rest(`/links?select=link_text&limit=1000&offset=${offset}`);
    links.push(...part);
    if (part.length < 1000) break;
  }
  for (const l of links) {
    const t = String(l.link_text ?? "");
    if (!t.includes("/") || t.startsWith(".")) continue;
    const [ns, ...rest] = t.split("/");
    const kind = NAMESPACES[ns.toLowerCase()];
    if (!kind || !rest.length) continue;
    // The last segment is the name; the rest is filing.
    add(rest[rest.length - 1].replace(/\.md$/i, ""), kind, "wikilink");
  }

  // 2. Every unit org.config.json names.
  //
  // Departments themselves are deliberately not entities. Their names are
  // ordinary English words, so "Self" matched 268 documents in all eight
  // departments and "Product" 247, which is a measure of the language and not
  // of the business. Departments are already first class everywhere else here.
  const { cfg } = loadConfig();
  for (const d of cfg.departments ?? []) {
    for (const cluster of d.clusters ?? []) {
      for (const item of cluster.items ?? []) {
        if (item.label) add(item.label, item.type === "gap" ? "project" : "tool", "config");
      }
    }
  }

  // 3. Every repository on disk, and every service deployed to the VPS.
  //
  // A folder under vaults/code is a repository you made; a folder under
  // vaults/loose/vps is a thing he deployed and is running. Both are the most
  // concrete declaration in the whole system, and neither was being read. They
  // come last so a name the vault already typed keeps the kind the vault gave
  // it: the repo directory `Vibefix` does not overwrite `[[10_Projects/VibeFix]]`.
  for (const [rel, kind] of [["vaults/code", "repo"], ["vaults/loose/vps", "service"]]) {
    const dir = join(ROOT, ...rel.split("/"));
    if (!existsSync(dir)) continue;
    let kids = [];
    try {
      kids = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    } catch { continue; }
    for (const name of kids) {
      if (isFiling(name) || TOO_COMMON.has(name.toLowerCase())) continue;
      add(name, kind, rel, kind === "repo" ? gitFacts(join(dir, name)) : null);
    }
  }

  return [...found.values()];
}

/* ----------------------------------------------------------------- report -- */

async function report() {
  const rows = await db.rest("/rpc/entity_reach", { method: "POST", body: { min_depts: 2, k: 30 } });
  if (!rows.length) {
    console.log("no entity reaches two departments yet. Run npm run entities first.");
    return;
  }
  console.log(`\n${rows.length} things this org talks about in more than one department`);
  console.log(`${c.dim}A name that is also an ordinary word counts every innocent use of it, so read${c.off}`);
  console.log(`${c.dim}the proper nouns first and treat a single common word in all eight as noise.\n${c.off}`);
  console.log(`${c.dim}${"name".padEnd(30)}${"kind".padEnd(12)}${"docs".padStart(5)}${"depts".padStart(7)}  where${c.off}`);
  for (const r of rows) {
    console.log(
      "  " + String(r.name).slice(0, 28).padEnd(28) +
      String(r.kind).padEnd(12) +
      String(r.documents).padStart(5) +
      String(r.departments).padStart(7) +
      "  " + c.dim + (r.depts ?? []).join(", ") + c.off
    );
  }
}

/* ----------------------------------------------------------------- enrich -- */

/**
 * One line saying what a thing is, written by a local model reading the
 * documents that mention it. Opt-in and slow: about 200 seconds per entity on
 * this hardware, which is fine for 20 and absurd for 1,368.
 */
async function enrich(limit) {
  const model = process.env.LOCAL_CHAT_MODEL || "gemma4:latest";
  const rows = await db.rest("/rpc/entity_reach", { method: "POST", body: { min_depts: 1, k: limit } });
  console.log(`${c.dim}describing ${rows.length} entities with ${model}${c.off}`);

  for (const r of rows) {
    const docs = await db.rest("/rpc/entity_documents", {
      method: "POST", body: { entity_name: r.name, k: 6 },
    });
    const context = docs.map((d) => `${d.title} [${d.department ?? "org"}]`).join("\n");

    try {
      const res = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        body: JSON.stringify({
          model, stream: false, options: { temperature: 0, num_ctx: 4096 },
          messages: [
            {
              role: "system",
              content:
                "Say in one sentence of at most 20 words what this thing is, using only " +
                "the document titles given. If the titles do not say, reply exactly: unknown.",
            },
            { role: "user", content: `Thing: ${r.name}\nKind: ${r.kind}\nSeen in:\n${context}` },
          ],
        }),
        signal: AbortSignal.timeout(600_000),
      });
      const body = await res.json();
      const note = String(body.message?.content ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      if (!note || /^unknown/i.test(note)) { console.log(`  ${c.dim}${r.name}: no description${c.off}`); continue; }
      await db.rest(`/entities?name=eq.${encodeURIComponent(r.name)}`, {
        method: "PATCH", prefer: "return=minimal", body: { note },
      });
      console.log(`  ${r.name}: ${note.slice(0, 90)}`);
    } catch (err) {
      console.log(`  ${c.yellow}${r.name}: ${String(err.message).slice(0, 80)}${c.off}`);
    }
  }
}

/* ------------------------------------------------------------------- main -- */

if (REPORT) { await report(); process.exit(0); }
if (ENRICH) { await enrich(ENRICH); await report(); process.exit(0); }

const rows = await seed();
const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
console.log(`${rows.length} entities seeded: ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(", ")}`);

if (DRY) {
  for (const r of rows) console.log(`  ${r.kind.padEnd(9)}${r.name.padEnd(28)}${c.dim}${r.note || r.source}${c.off}`);
  process.exit(0);
}

// Names are the key, so re-running merges rather than duplicating.
//
// A row with no note of its own is sent without the column, so merging cannot
// blank a description --enrich wrote earlier. A repository does carry a note,
// and that one is a measurement rather than a description: it should overwrite,
// because a commit count from last week is wrong.
// A name the vault spells one way and a directory spells another is one thing.
//
// The seed deduplicates on the lowercased name, but the table is keyed on the
// name as written, so `Predict-Market-Bot` from a wikilink and
// `predict-market-bot` from the directory survived as two rows across two runs
// and appeared on the graph as two dots with identical edges. Anything whose
// lowercased name is not in this run's seed, but whose lowercased name is, is a
// spelling this org has stopped using.
{
  const live = new Set(rows.map((r) => r.name));
  const keys = new Set(rows.map((r) => r.name.toLowerCase()));
  const existing = await db.rest("/entities?select=name");
  const stale = existing
    .map((e) => e.name)
    .filter((n) => !live.has(n) && keys.has(n.toLowerCase()));
  for (const name of stale) {
    await db.rest(`/entities?name=eq.${encodeURIComponent(name)}`, {
      method: "DELETE", prefer: "return=minimal",
    });
    console.log(`${c.dim}dropped duplicate spelling: ${name}${c.off}`);
  }
}

// Two requests, not one. PostgREST rejects a bulk insert whose objects do not
// all carry the same keys (PGRST102, "All object keys must match"), so rows
// that omit `note` cannot travel with rows that set it.
for (const withNote of [true, false]) {
  const body = rows
    .filter((r) => Boolean(r.note) === withNote)
    .map(({ source, note, ...rest }) => (withNote ? { ...rest, note } : rest));
  if (!body.length) continue;
  await db.rest("/entities?on_conflict=name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body,
  });
}

process.stdout.write("finding mentions ");
const t0 = Date.now();
const out = await db.rest("/rpc/rebuild_entity_mentions", { method: "POST", body: {} });
const n = typeof out === "number" ? out : (Array.isArray(out) ? out[0]?.rebuild_entity_mentions : null);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`${c.green}${Number(n).toLocaleString()}${c.off} mentions across the corpus`);

await report();
