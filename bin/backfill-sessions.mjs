#!/usr/bin/env node
/**
 * backfill-sessions.mjs — give recent_sessions a history.
 *
 *   node bin/backfill-sessions.mjs --dry     report, write nothing
 *   node bin/backfill-sessions.mjs           embed and upsert
 *   node bin/backfill-sessions.mjs --limit 20
 *
 * The Stop hook records sessions from now on. This fills in what happened
 * before it existed, so a department agent asking "has this been tried" gets an
 * answer rather than silence.
 *
 * Two sources, deliberately combined. The saved chat notes in the vault carry
 * frontmatter (session_id, date, cwd, turns) and go back furthest, but hold no
 * record of which files were touched. The raw transcripts under ~/.claude
 * expire on a retention window but do carry that. Where both exist, the note
 * supplies identity and the transcript supplies the facts.
 *
 * No model is used here. A summary invented for 557 past sessions would be 557
 * plausible sentences nobody can check, which is worse than a factual one:
 * the entry is built from the session's own title, the user's own first words,
 * and the files it actually wrote.
 */

import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve, dirname, join, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
// Where your exported CLI transcripts live. Override with SESSION_NOTES.
const NOTES = process.env.SESSION_NOTES || join(HOME, "Documents", "Chats", "Claude", "Code");
const PROJECTS = join(HOME, ".claude", "projects");

process.loadEnvFile(join(ROOT, ".env"));

const { store } = await import("./lib/store.mjs");
const { queryEmbedder } = await import("./lib/search.mjs");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const LIMIT = Number((() => { const i = argv.indexOf("--limit"); return i === -1 ? "0" : argv[i + 1]; })());

const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };

// Same redaction as the hook: these summaries are embedded and become searchable.
const SECRET_PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{16,}/g, "supabase-secret-key"],
  [/\bsbp_[a-f0-9]{40}\b/g, "supabase-access-token"],
  [/sb_publishable_[A-Za-z0-9_-]{16,}/g, "supabase-publishable-key"],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "jwt"],
  [/\bpa-[A-Za-z0-9_-]{32,}\b/g, "voyage-key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, "openai-key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "github-token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
  [/\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@/gi, "postgres-url"],
];
const redact = (t) => SECRET_PATTERNS.reduce((s, [re, l]) => s.replace(re, `[REDACTED:${l}]`), String(t ?? ""));

// ------------------------------------------------------------------ routing --

const cfg = JSON.parse(readFileSync(join(ROOT, "org.config.json"), "utf8"));
const claims = (() => {
  const out = [];
  for (const d of cfg.departments ?? []) {
    for (const p of d.paths ?? []) {
      const abs = resolve(ROOT, p);
      let real = abs;
      try { real = realpathSync(abs); } catch { /* gone */ }
      out.push({ department: d.id, path: real.toLowerCase().split(sep).join("/") });
    }
  }
  return out.sort((a, b) => b.path.length - a.path.length);
})();

const norm = (p) => String(p ?? "").toLowerCase().split("\\").join("/").replace(/\/+$/, "");
function departmentFor(p) {
  const q = norm(p);
  if (!q) return null;
  for (const cl of claims) if (q === cl.path || q.startsWith(cl.path + "/")) return cl.department;
  return null;
}

// -------------------------------------------------------------------- notes --

function parseNote(file) {
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;

  const fm = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, "$1");
  }

  const body = text.slice(end + 4);

  // Notes written before the hook was rewritten use a different frontmatter
  // (topics, source: claude-code) and carry the id in the body instead, as
  // "*Session: <uuid> — <date>*". Reading only the newer shape silently dropped
  // 244 of 558 sessions, which looked like a parser working fine.
  const inBody = body.match(/^\*Session:\s*([0-9a-f-]{16,})\s*[—-]+\s*(\d{4}-\d{2}-\d{2})/m);

  const sessionId = fm.session_id || inBody?.[1];
  if (!sessionId) return null;

  // The first thing the user actually said, which beats anything invented.
  const firstYou = body.match(/\*\*You:\*\*\s*([\s\S]{0,600}?)(?:\n\n---|\n\n\*\*Claude:\*\*|$)/);
  const h1 = body.match(/^#\s+(.+)$/m);

  return {
    sessionId,
    date: fm.date || inBody?.[2] || null,
    title: fm.title || h1?.[1]?.trim() || basename(file, ".md"),
    cwd: fm.cwd || "",
    turns: Number(fm.turns || 0),
    firstUserTurn: (firstYou?.[1] ?? "").replace(/\s+/g, " ").trim(),
    notePath: file,
  };
}

/** Files a session wrote, when its raw transcript still exists. */
const transcriptIndex = new Map();
if (existsSync(PROJECTS)) {
  for (const proj of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, proj);
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith(".jsonl")) transcriptIndex.set(f.replace(/\.jsonl$/, ""), join(dir, f));
    }
  }
}

function filesTouched(sessionId) {
  const path = transcriptIndex.get(sessionId);
  if (!path) return null;
  const touched = new Set();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes("tool_use")) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type === "tool_use" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(b.name) && b.input?.file_path) {
          touched.add(b.input.file_path);
        }
      }
    }
  } catch { return null; }
  return [...touched];
}

// --------------------------------------------------------------------- main --

if (!existsSync(NOTES)) {
  console.error(`no saved sessions at ${NOTES}`);
  process.exit(1);
}

let notes = readdirSync(NOTES)
  .filter((f) => f.endsWith(".md"))
  .map((f) => parseNote(join(NOTES, f)))
  .filter(Boolean);

console.log(`${notes.length} saved Claude Code sessions with a session_id`);

const db = store();
const existing = new Set(
  (await db.rest("/sessions?select=session_id&limit=10000")).map((r) => r.session_id)
);
notes = notes.filter((n) => !existing.has(n.sessionId));
if (LIMIT) notes = notes.slice(0, LIMIT);

// Build the record before deciding anything, so the dry run shows the truth.
const records = notes.map((n) => {
  const touched = filesTouched(n.sessionId);
  const dept = departmentFor(n.cwd) ??
    (touched?.length ? departmentFor(touched[0]) : null);

  const parts = [n.title];
  if (n.firstUserTurn) parts.push(`Asked: ${n.firstUserTurn.slice(0, 300)}`);
  if (touched?.length) parts.push(`Touched ${touched.length} file${touched.length === 1 ? "" : "s"}.`);

  return {
    session_id: n.sessionId,
    started_at: n.date ? `${n.date}T12:00:00.000Z` : new Date().toISOString(),
    department: dept,
    cwd: n.cwd || null,
    summary: redact(parts.join(" ")),
    files_touched: (touched ?? []).map(redact).slice(0, 50),
    decisions: [],
    open_threads: [],
    friction: [],
    transcript_path: n.notePath,
    hasTranscript: touched !== null,
  };
});

// One session can be saved under two note filenames: the chat hook appends a
// short id suffix when a date and slug collide, and a resumed session is written
// again. Postgres rejects a batch that touches the same conflict key twice, so
// collapse them here, keeping whichever record carries the most information.
const bySession = new Map();
for (const r of records) {
  const prev = bySession.get(r.session_id);
  const score = (x) => (x.department ? 4 : 0) + (x.hasTranscript ? 2 : 0) + (x.cwd ? 1 : 0);
  if (!prev || score(r) > score(prev) || (score(r) === score(prev) && r.summary.length > prev.summary.length)) {
    bySession.set(r.session_id, r);
  }
}
const collapsed = records.length - bySession.size;
if (collapsed) console.log(`${collapsed} duplicate session ids collapsed`);
records.length = 0;
records.push(...bySession.values());

const routed = records.filter((r) => r.department).length;
const withFiles = records.filter((r) => r.hasTranscript).length;
const byDept = {};
for (const r of records) byDept[r.department ?? "(unrouted)"] = (byDept[r.department ?? "(unrouted)"] ?? 0) + 1;

console.log(
  `${records.length} to backfill, ${routed} routed to a department, ` +
  `${withFiles} still have a raw transcript for file details`
);
for (const [d, n] of Object.entries(byDept).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${d}`);
}

if (DRY) {
  console.log(`\n${c.dim}dry run. Example:${c.off}`);
  const ex = records.find((r) => r.department) ?? records[0];
  if (ex) console.log(`  [${ex.department}] ${ex.summary.slice(0, 220)}`);
  process.exit(0);
}
if (!records.length) { console.log("nothing to do"); process.exit(0); }

const embed = queryEmbedder();
let done = 0;

for (let i = 0; i < records.length; i += 25) {
  const batch = records.slice(i, i + 25);
  const vectors = await Promise.all(batch.map((r) => embed.embedQuery(r.summary)));

  await db.rest("/sessions?on_conflict=session_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: batch.map((r, j) => {
      const { hasTranscript, ...row } = r;
      return { ...row, embedding: "[" + vectors[j].join(",") + "]" };
    }),
  });

  done += batch.length;
  process.stdout.write(`\r  ${done}/${records.length}`);
}

process.stdout.write("\r" + " ".repeat(24) + "\r");
const total = await db.rest("/sessions?select=session_id&limit=10000");
console.log(`${c.green}backfilled${c.off} ${done} sessions, ${total.length} now in the table`);
