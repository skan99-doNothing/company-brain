#!/usr/bin/env node
/**
 * ingest-codex.mjs — put Codex sessions into the same memory as Claude's.
 *
 *   npm run codex                  index every session not already stored
 *   npm run codex -- --rebuild     re-read all of them
 *   npm run codex -- --dry         say what would happen, write nothing
 *   npm run codex -- --limit 20    stop after N files
 *
 * The sessions table was built for Claude Code, filled by the Stop hook. Codex
 * keeps the same kind of record at ~/.codex/sessions and nobody read it, so
 * every hour spent in Codex was invisible to the org that is meant to remember
 * what happened. 130 rollout files, 1.3 GB.
 *
 * What is stored is a session row, not a transcript: when, where, which
 * department owns that folder, what was asked, how much was done. The rollout
 * file stays where it is and its path is recorded, so the full text is one open
 * away and none of it is duplicated into the vault.
 *
 * Nothing here summarises with a model. Codex already names each thread, and
 * that name is in ~/.codex/session_index.jsonl. A name the tool wrote at the
 * time beats a summary generated later from a truncated read.
 */

import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ROOT, loadConfig, departmentFor, norm } from "./lib/config.mjs";
import { store } from "./lib/store.mjs";
import { queryEmbedder } from "./lib/search.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); }
catch { console.error("no .env at the org root"); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : Number(argv[i + 1]); };

const DRY = flag("--dry");
const REBUILD = flag("--rebuild");
const LIMIT = num("--limit", Infinity);

const CODEX = join(homedir(), ".codex");
const SESSIONS = join(CODEX, "sessions");

const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };

if (!existsSync(SESSIONS)) {
  console.error(`no Codex sessions at ${SESSIONS}`);
  process.exit(1);
}

/* -------------------------------------------------------------- mojibake -- */

/**
 * Codex writes UTF-8 that something upstream already read as cp1252, so a
 * right single quote arrives as the three characters â€™. Left alone it goes
 * into the index and the embedding, and a search for "don't" stops matching.
 *
 * The repair is the inverse of the damage: take the string back to the bytes
 * cp1252 would have produced, then read those bytes as UTF-8. Only applied when
 * the signature is present, because running it on clean text corrupts it.
 */
const MOJIBAKE = /Ã[\x80-\xbf]|â€|Â[\xa0-\xbf]/;
function demojibake(s) {
  if (!s || !MOJIBAKE.test(s)) return s;
  try {
    const fixed = Buffer.from(s, "latin1").toString("utf8");
    return fixed.includes("�") ? s : fixed;
  } catch { return s; }
}

/* ------------------------------------------------------------ thread names -- */

/** id -> the name Codex gave the thread, which is the best summary available. */
function threadNames() {
  const file = join(CODEX, "session_index.jsonl");
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.id && r.thread_name) out.set(r.id, demojibake(String(r.thread_name)));
    } catch { /* a partial last line is normal on a live file */ }
  }
  return out;
}

/* -------------------------------------------------------------- injected -- */

/**
 * Codex files its own scaffolding under the same user_message type you
 * uses, so a naive read makes the summary of five sessions read "The following
 * is the Codex agent history whose request action you are assessing". Those
 * are Codex reviewing itself, not work that was asked for.
 *
 * Matched on the opening rather than anywhere in the text, because a real
 * prompt can quote any of these while discussing them.
 */
const INJECTED = [
  "<",                                        // bracketed context blocks
  "The following is the Codex agent history",  // its own safety review pass
  "You are Codex",
  "# Instructions",
];
const injected = (t) => INJECTED.some((p) => t.startsWith(p));

/* ----------------------------------------------------------------- files -- */

function rollouts(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push({ path: p, bytes: st.size });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------- one file -- */

/**
 * One pass per file, line by line. The largest rollout here is 265 MB, so
 * nothing may hold the file in memory and nothing may parse a line it does not
 * need. The cheap type check runs before JSON.parse.
 */
async function readSession(file) {
  const s = {
    session_id: null, started_at: null, cwd: null,
    prompts: [], commands: 0, turns: 0, models: new Set(), lastAt: null,
  };

  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;

    // Every line carries a timestamp; the last one is when the session stopped.
    const ti = line.indexOf('"timestamp":"');
    if (ti !== -1) s.lastAt = line.slice(ti + 13, ti + 37);

    const isMeta = line.includes('"session_meta"');
    const isUser = line.includes('"user_message"');
    const isExec = line.includes('"name":"exec"');
    const isTurn = line.includes('"task_started"');
    const isCtx = line.includes('"turn_context"');
    if (!isMeta && !isUser && !isExec && !isTurn && !isCtx) continue;

    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload;
    if (!p || typeof p !== "object") continue;

    if (row.type === "session_meta") {
      // First record wins, and the order is not incidental.
      //
      // A subagent rollout carries two of these. Ordinal 0 is this file's own
      // thread, with forked_from_id and a source.subagent.thread_spawn block.
      // Ordinal 1 is the parent's record, copied in so the subagent inherits the
      // parent's instructions. Last-writer-wins therefore gave every subagent of
      // one parent the parent's id, so three spawned threads and the parent all
      // arrived in one wave as the same row and Postgres refused the upsert with
      // 21000. It also meant the filename-based skip never matched, so those
      // files were re-read and re-failed on every run rather than once.
      //
      // Taking the first record keeps each thread answerable under the id Codex
      // put in its own filename, which is what the skip check already assumed.
      s.session_id ??= p.id;
      s.started_at ??= p.timestamp ?? row.timestamp;
      s.cwd ??= p.cwd;
    } else if (row.type === "turn_context") {
      if (p.cwd && !s.cwd) s.cwd = p.cwd;
      if (p.model) s.models.add(String(p.model));
    } else if (p.type === "user_message" && typeof p.message === "string") {
      const t = demojibake(p.message).trim();
      if (t && !injected(t)) s.prompts.push(t);
    } else if (p.type === "task_started") {
      s.turns++;
    } else if (p.name === "exec") {
      s.commands++;
    }
  }
  return s;
}

/* ------------------------------------------------------------- routing -- */

/**
 * Codex records the real working directory. The org claims paths through
 * vaults/, which are Windows junctions, so a session run in
 * C:\\Users\\you\\Desktop\\content never matches the claim on
 * Org/vaults/content even though they are the same folder. Every Codex session
 * came back unrouted because of it.
 *
 * Resolving each claim through the junction gives a second path that means the
 * same department, and both go into the list. Longest first still holds, so a
 * nested claim keeps beating a broad one across either spelling.
 */
function claimsThroughJunctions(claims) {
  const extra = [];
  for (const c of claims) {
    let real;
    try { real = norm(realpathSync(c.abs)); } catch { continue; }
    if (real !== c.abs) extra.push({ ...c, abs: real });
  }
  return [...claims, ...extra].sort((a, b) => b.abs.length - a.abs.length);
}

/* ------------------------------------------------------------------ main -- */

const { claims: declared } = loadConfig();
const claims = claimsThroughJunctions(declared);
const db = store();
const embed = queryEmbedder();
const names = threadNames();

const files = rollouts(SESSIONS);
console.log(`${files.length} rollout files, ${(files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(0)} MB`);

// Which are already stored, so a re-run is cheap.
const existing = new Set();
if (!REBUILD) {
  for (let offset = 0; ; offset += 1000) {
    const part = await db.rest(`/sessions?source=eq.codex&select=session_id&limit=1000&offset=${offset}`);
    for (const r of part) existing.add(r.session_id);
    if (part.length < 1000) break;
  }
  if (existing.size) console.log(`${c.dim}${existing.size} already stored${c.off}`);
}

let done = 0, skipped = 0, empty = 0;
const rows = [];

for (const f of files) {
  if (done + skipped >= LIMIT) break;

  // The id is in the filename, so an already-stored session costs no read at
  // all. Without this a re-run would stream 1.3 GB to learn nothing.
  const guess = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/i.exec(f.path)?.[1];
  if (guess && existing.has(guess)) { skipped++; continue; }

  const s = await readSession(f.path);

  // A session counts if Codex named the thread or if a real prompt survived
  // the scaffolding filter. Requiring a prompt threw away 30 sessions that
  // ran in a real project folder and were only missing a clean opening line,
  // which took their department routing with them.
  const named = names.get(s.session_id);
  if (!s.session_id || (!named && !s.prompts.length)) { empty++; continue; }

  const dept = s.cwd ? departmentFor(resolve(s.cwd), claims) : null;
  const summary = named || s.prompts[0].slice(0, 120);
  const opening = s.prompts.length ? s.prompts[0].slice(0, 600) : "";

  rows.push({
    session_id: s.session_id,
    source: "codex",
    started_at: s.started_at ?? s.lastAt,
    department: dept,
    cwd: s.cwd,
    summary,
    transcript_path: f.path,
    files_touched: [],
    decisions: [],
    // Codex does not mark anything as open, and inventing threads it never
    // named would put fiction into the one table sessions are read from.
    open_threads: [],
    friction: [],
    // What was actually asked, which is what a later search should match on.
    _text: opening ? `${summary}\n\n${opening}` : summary,
  });
  done++;
  process.stdout.write(`\r${c.dim}read ${done}${c.off}   `);
}

console.log(`\n${done} readable, ${skipped} already stored, ${empty} with no user prompt`);

/**
 * One id may appear once per wave.
 *
 * PostgREST turns a wave into a single INSERT ... ON CONFLICT, and Postgres
 * refuses to let one of those touch the same row twice: SQLSTATE 21000, "ON
 * CONFLICT DO UPDATE command cannot affect row a second time". It is a 500, so
 * store.mjs retries it three times and the whole run then dies, which is how
 * the nightly lost its Codex step every night from 8 September.
 *
 * The cause was subagent rollouts taking their parent's id, fixed in
 * readSession. This stays as the guard: a collision now drops the later file and
 * says which two produced it, rather than failing the run.
 */
const byId = new Map();
const collisions = [];
for (const r of rows) {
  const first = byId.get(r.session_id);
  if (first) { collisions.push({ id: r.session_id, kept: first.transcript_path, dropped: r.transcript_path }); continue; }
  byId.set(r.session_id, r);
}
const unique = [...byId.values()];

if (collisions.length) {
  console.log(`\n${c.yellow}${collisions.length} file${collisions.length === 1 ? "" : "s"} carried an id another file already claimed${c.off}`);
  for (const k of collisions.slice(0, 10)) {
    console.log(`  ${k.id}`);
    console.log(`${c.dim}    kept    ${k.kept}${c.off}`);
    console.log(`${c.dim}    dropped ${k.dropped}${c.off}`);
  }
}

if (!unique.length || DRY) {
  if (DRY) for (const r of unique.slice(0, 10)) {
    console.log(`  ${String(r.started_at).slice(0, 10)}  ${r.session_id}  ${r.department ?? "-"}  ${r.summary.slice(0, 48)}`);
  }
  process.exit(collisions.length && DRY ? 1 : 0);
}

// Embedded so a Codex session turns up in the same search as everything else.
process.stdout.write("embedding ");
const vectors = await embed.embedAll(unique.map((r) => r._text));
console.log(`${vectors.length} vectors`);

const payload = unique.map((r, i) => {
  const { _text, ...rest } = r;
  return { ...rest, embedding: vectors[i] };
});

for (let i = 0; i < payload.length; i += 50) {
  const wave = payload.slice(i, i + 50);
  // rest() takes prefer as its own option; passing a headers object here was
  // silently dropped, which turned every upsert into a plain insert and made a
  // re-run fail on the unique constraint instead of updating.
  await db.rest("/sessions?on_conflict=session_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: wave,
  });
  process.stdout.write(`\r${c.dim}wrote ${Math.min(i + 50, payload.length)}/${payload.length}${c.off}   `);
}

const byDept = {};
for (const r of payload) byDept[r.department ?? "(unrouted)"] = (byDept[r.department ?? "(unrouted)"] || 0) + 1;

console.log(`\n${c.green}stored${c.off} ${payload.length} Codex sessions`);
console.log(Object.entries(byDept).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));
