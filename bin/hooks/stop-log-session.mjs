#!/usr/bin/env node
/**
 * stop-log-session.mjs — write the ledger, so nobody has to remember to.
 *
 * Registered as a Stop hook. Reads the session transcript, works out which
 * department the work belonged to, extracts what changed, appends a dated line
 * to that department's ledger, cross-references any second department, and
 * upserts a session row for retrieval.
 *
 *   node bin/hooks/stop-log-session.mjs                 read hook JSON on stdin
 *   node bin/hooks/stop-log-session.mjs --session <f>   run against one .jsonl
 *   node bin/hooks/stop-log-session.mjs --dry           print, write nothing
 *
 * Why this exists: eight ledgers sat empty for 18 days because /log is something
 * a session has to choose to run at the end, when its context is thinnest and it
 * has already decided it is finished. This runs whether or not anyone remembers.
 *
 * Two rules govern everything here.
 *
 * It must never break a session. Every failure path logs to stderr and exits 0.
 * A hook that can fail loudly is a hook that gets uninstalled.
 *
 * It must never write a secret. Chat notes and ledger lines are indexed and
 * become searchable, so the same redaction the chat hook learned applies here.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_PROJECTS = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claude", "projects");
const MARKER = join(ROOT, "state", ".logged-sessions.json");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const SESSION_FILE = (() => { const i = argv.indexOf("--session"); return i === -1 ? null : argv[i + 1]; })();

const log = (...a) => process.stderr.write("[org-log] " + a.join(" ") + "\n");

// ------------------------------------------------------------------ redact --

const SECRET_PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{16,}/g, "supabase-secret-key"],
  [/\bsbp_[a-f0-9]{40}\b/g, "supabase-access-token"],
  [/sb_publishable_[A-Za-z0-9_-]{16,}/g, "supabase-publishable-key"],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "jwt"],
  [/\bpa-[A-Za-z0-9_-]{32,}\b/g, "voyage-key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "openai-key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, "openai-key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "github-token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "slack-token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-api-key"],
  [/\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@/gi, "postgres-url"],
];

const redact = (text) =>
  SECRET_PATTERNS.reduce((s, [re, label]) => s.replace(re, `[REDACTED:${label}]`), String(text ?? ""));

// ------------------------------------------------------------------ config --

function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, "org.config.json"), "utf8"));
}

/**
 * Real filesystem paths for each department, resolved through the junctions.
 * A session's cwd is a real path like C:\Users\you\Code\someapp, while the
 * config says vaults/code/ppshop, so the link has to be followed to compare them.
 * Longest path first, because department paths nest.
 */
function departmentClaims(cfg) {
  const claims = [];
  for (const d of cfg.departments ?? []) {
    for (const p of d.paths ?? []) {
      const abs = resolve(ROOT, p);
      let real = abs;
      try { real = realpathSync(abs); } catch { /* path is gone; keep the nominal one */ }
      claims.push({ department: d.id, path: real.toLowerCase().split(sep).join("/") });
    }
  }
  return claims.sort((a, b) => b.path.length - a.path.length);
}

const norm = (p) => String(p ?? "").toLowerCase().split("\\").join("/").replace(/\/+$/, "");

function departmentFor(somePath, claims) {
  const p = norm(somePath);
  if (!p) return null;
  for (const c of claims) if (p === c.path || p.startsWith(c.path + "/")) return c.department;
  return null;
}

// -------------------------------------------------------------- transcript --

function findTranscript(sessionId) {
  if (!existsSync(CLAUDE_PROJECTS)) return null;
  for (const proj of readdirSync(CLAUDE_PROJECTS)) {
    const f = join(CLAUDE_PROJECTS, proj, sessionId + ".jsonl");
    if (existsSync(f)) return f;
  }
  return null;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return "";
};

const isNoise = (t) =>
  !t || t.startsWith("<local-command") || t.startsWith("<command-name>") ||
  t.startsWith("Caveat:") || t.startsWith("[Request interrupted") || t.startsWith("<system-reminder>");

/**
 * Everything factual about the session, taken from the transcript itself rather
 * than asked of a model. Files written, commands run, the user's own words.
 * A model is used later only for the judgement half, and only as a bonus.
 */
function extractFacts(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
  const msgs = [];
  for (const l of lines) { try { msgs.push(JSON.parse(l)); } catch { /* skip torn line */ } }

  const filesTouched = new Set();
  const commands = [];
  const userTurns = [];
  let cwd = "";
  let startedAt = null;

  for (const m of msgs) {
    cwd ||= m.cwd || "";
    startedAt ||= m.timestamp || null;

    const content = m.message?.content;
    if (m.type === "user") {
      const t = textOf(content).trim();
      if (!isNoise(t)) userTurns.push(t);
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(block.name) && input.file_path) {
        filesTouched.add(input.file_path);
      }
      if (block.name === "Bash" && input.command) {
        commands.push(String(input.command).split("\n")[0].slice(0, 200));
      }
    }
  }

  return {
    cwd,
    startedAt: startedAt ?? new Date().toISOString(),
    filesTouched: [...filesTouched],
    commands,
    userTurns,
    turnCount: userTurns.length,
  };
}

/** Did this session actually change anything? A read-only session gets no line. */
const WRITING_COMMAND = /\b(git\s+(commit|merge|rebase|push|revert|reset)|npm\s+run\s+(init|index|sync)|node\s+bin\/)/;

function changedSomething(facts) {
  if (facts.filesTouched.length) return true;
  return facts.commands.some((c) => WRITING_COMMAND.test(c));
}

// ------------------------------------------------------------------ summary --

/**
 * The judgement half: what it means next time.
 *
 * Local model, strict JSON, short timeout, and a deterministic fallback. This is
 * the only part that can be wrong, so it is the only part allowed to fail.
 */
async function summarise(facts, department) {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const model = process.env.LEDGER_MODEL || "gemma4:latest";

  const intent = facts.userTurns.slice(0, 3).join("\n---\n").slice(0, 3000);
  const files = facts.filesTouched.slice(0, 25).map((f) => f.replace(ROOT + sep, "")).join("\n");

  const prompt = [
    `A Claude Code session just ended in the "${department ?? "unrouted"}" department of a solo operator's company.`,
    "",
    "What the user asked for (context only, do not summarise the request):",
    intent || "(nothing recorded)",
    "",
    "Files written or edited:",
    files || "(none)",
    "",
    "Commands run:",
    facts.commands.slice(0, 15).join("\n") || "(none)",
    "",
    "Write a ledger entry describing what the session DID, not what was requested.",
    "Respond with JSON only, no markdown, matching exactly:",
    '{"changed": "<what changed, max 25 words, past tense>",',
    ' "means_next_time": "<what a future session should know so it does not repeat this, max 25 words>",',
    ' "open": ["<up to 3 unfinished items, each max 12 words, or an empty array>"]}',
    "",
    "Rules: be concrete and factual. Ground every claim in the files and commands listed above.",
    "Do not invent numbers, file names or outcomes. Do not restate the request.",
    "If nothing meaningful changed, say so plainly in 'changed'.",
  ].join("\n");

  const res = await fetch(`${host.replace(/\/+$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, format: "json", stream: false, options: { temperature: 0.2 } }),
    signal: AbortSignal.timeout(Number(process.env.LEDGER_TIMEOUT_MS || 90_000)),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);

  const parsed = JSON.parse((await res.json()).response);

  // Length is enforced here, not merely requested in the prompt. A model that
  // ignores "max 25 words" would otherwise put a paragraph in a ledger meant to
  // be skimmed, and the first real run did exactly that.
  const clip = (v, max) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
    return (stop > max * 0.6 ? cut.slice(0, stop) : cut).replace(/[,;:\s]+$/, "") + "…";
  };

  if (!clip(parsed.changed, 10)) throw new Error("model returned no 'changed' field");

  return {
    changed: clip(parsed.changed, 220),
    meansNextTime: clip(parsed.means_next_time, 220),
    open: (Array.isArray(parsed.open) ? parsed.open : []).map((o) => clip(o, 90)).filter(Boolean).slice(0, 3),
  };
}

/** Used when the model is unavailable or returns nonsense. Facts only, no judgement. */
function fallbackSummary(facts) {
  const names = facts.filesTouched.slice(0, 6).map((f) => f.split(/[\\/]/).pop());
  const changed = names.length
    ? `Edited ${facts.filesTouched.length} file${facts.filesTouched.length === 1 ? "" : "s"}: ${names.join(", ")}${facts.filesTouched.length > 6 ? ", and others" : ""}.`
    : `Ran ${facts.commands.length} commands; no files were written.`;
  return {
    changed,
    meansNextTime: "Summary was not generated, so this entry records only what changed. Read the linked session note for context.",
    open: [],
  };
}

// ------------------------------------------------------------------- ledger --

/**
 * Exclusive lock around a ledger write.
 *
 * Appending under a heading is read, modify, write. This hook is registered
 * globally, so it fires for every Claude session on this machine, and you
 * runs several terminals at once. Two sessions ending together would both read
 * the file, both write it, and one entry would vanish with no error anywhere.
 *
 * `wx` fails if the lock exists, which is the atomic test-and-set. A lock older
 * than the stale window is broken rather than waited on, so a process killed
 * mid-write cannot block ledger writes forever.
 */
const LOCK_STALE_MS = 60_000;

async function withLock(filePath, fn) {
  const lock = filePath + ".lock";
  const deadline = Date.now() + 30_000;

  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = Infinity;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = Infinity; }
      if (age > LOCK_STALE_MS) {
        log(`breaking stale lock on ${filePath} (${Math.round(age / 1000)}s old)`);
        try { unlinkSync(lock); } catch { /* someone else won the race; loop */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`could not lock ${filePath} after 30s`);
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    }
  }

  try { return await fn(); }
  finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

function appendUnderHeading(filePath, heading, text) {
  const s = readFileSync(filePath, "utf8");
  const heads = [...s.matchAll(/^## /gm)].map((m) => m.index);
  const i = s.indexOf("## " + heading);
  if (i < 0) throw new Error(`no "## ${heading}" in ${filePath}`);
  const next = heads.find((h) => h > i) ?? s.length;
  const body = s.slice(i, next).replace(/\s+$/, "").replace(/\n- Nothing (yet|logged yet)\.$/, "");
  writeFileSync(filePath, s.slice(0, i) + body + "\n" + text + "\n\n" + s.slice(next), "utf8");
}

const loadMarkers = () => { try { return JSON.parse(readFileSync(MARKER, "utf8")); } catch { return []; } };
const saveMarkers = (ids) => {
  mkdirSync(dirname(MARKER), { recursive: true });
  writeFileSync(MARKER, JSON.stringify(ids.slice(-500), null, 0), "utf8");
};

// --------------------------------------------------------------------- main --

async function run(sessionId, jsonlPath) {
  const cfg = loadConfig();
  const claims = departmentClaims(cfg);
  const facts = extractFacts(jsonlPath);

  if (!changedSomething(facts)) {
    log(`session ${sessionId}: nothing changed, no ledger entry`);
    return;
  }

  // The department that owns the most touched files wins; cwd breaks a tie and
  // covers sessions whose work happened through commands rather than edits.
  const counts = new Map();
  for (const f of facts.filesTouched) {
    const d = departmentFor(f, claims);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const cwdDept = departmentFor(facts.cwd, claims);
  if (cwdDept) counts.set(cwdDept, (counts.get(cwdDept) ?? 0) + 0.5);

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const department = ranked[0]?.[0] ?? cwdDept ?? null;
  const secondary = ranked.slice(1).map(([d]) => d);

  if (!department) {
    log(`session ${sessionId}: could not route (cwd ${facts.cwd}), no ledger entry`);
    return;
  }

  let summary;
  try { summary = await summarise(facts, department); }
  catch (e) { log(`summary failed (${e.message}), using facts only`); summary = fallbackSummary(facts); }

  const date = facts.startedAt.slice(0, 10);
  const line = redact(
    `- ${date} · ${summary.changed} ${summary.meansNextTime}`.replace(/\s+/g, " ").trim() +
    (summary.open.length ? `\n  Open: ${summary.open.join("; ")}` : "")
  );

  const ledgerPath = join(ROOT, "state", `${department}.md`);
  if (DRY) {
    console.log(`department: ${department}${secondary.length ? `  (also ${secondary.join(", ")})` : ""}`);
    console.log(`ledger: ${ledgerPath}`);
    console.log(line);
    return;
  }
  if (!existsSync(ledgerPath)) { log(`no ledger at ${ledgerPath}`); return; }

  await withLock(ledgerPath, () => appendUnderHeading(ledgerPath, "Log", line));
  log(`wrote ${department} ledger`);

  for (const other of secondary) {
    const p = join(ROOT, "state", `${other}.md`);
    if (!existsSync(p)) continue;
    try {
      await withLock(p, () => appendUnderHeading(p, "Cross-references", redact(`- ${date} · ${department}: ${summary.changed}`)));
      log(`cross-referenced ${other}`);
    } catch (e) { log(`cross-reference into ${other} failed: ${e.message}`); }
  }

  const markers = loadMarkers();
  markers.push(sessionId);
  saveMarkers(markers);

  await recordSession(sessionId, facts, department, summary);
}

/** Best effort. The ledger on disk is the record; the row is for retrieval. */
async function recordSession(sessionId, facts, department, summary) {
  try {
    process.loadEnvFile(join(ROOT, ".env"));
    const { store } = await import("../lib/store.mjs");
    const { queryEmbedder } = await import("../lib/search.mjs");

    const db = store();
    const text = redact(`${summary.changed} ${summary.meansNextTime}`);
    const embedding = await queryEmbedder().embedQuery(text);

    await db.rest("/sessions?on_conflict=session_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{
        session_id: sessionId,
        started_at: facts.startedAt,
        department,
        cwd: facts.cwd,
        summary: text,
        files_touched: facts.filesTouched.map((f) => redact(f)),
        decisions: [],
        open_threads: summary.open,
        friction: [],
        transcript_path: null,
        embedding: "[" + embedding.join(",") + "]",
      }],
    });
    log("session row upserted");
  } catch (e) {
    log(`session row skipped: ${e.message}`);
  }
}

// ------------------------------------------------------------------- entry --

async function main() {
  if (SESSION_FILE) {
    const id = SESSION_FILE.split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    return run(id, SESSION_FILE);
  }

  const input = await new Promise((res) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => res(buf));
    setTimeout(() => res(buf), 5000);
  });

  let sessionId;
  try { sessionId = JSON.parse(input).session_id; } catch { /* no payload */ }
  if (!sessionId) return log("no session_id on stdin");

  if (loadMarkers().includes(sessionId)) return log(`session ${sessionId} already logged`);

  const jsonl = findTranscript(sessionId);
  if (!jsonl) return log(`no transcript for ${sessionId}`);
  return run(sessionId, jsonl);
}

// Never break a session. Whatever happens, exit 0.
main().catch((e) => log(`failed: ${e.stack ?? e.message}`)).finally(() => process.exit(0));
