#!/usr/bin/env node
/**
 * supervise.mjs — what has stopped moving, and what nobody wrote down.
 *
 *   npm run supervise              the report
 *   npm run supervise -- --json    the same findings, machine readable
 *   npm run supervise -- --quiet   print nothing when there is nothing to say
 *
 * The other tools here answer questions. This one asks them. It is the part of
 * a long-horizon system that notices progress has stalled, which is the only
 * one of the four that cannot be triggered by a person, because a person who
 * remembered to check did not need it.
 *
 * Every finding is derived, never stored. There is no supervisor state file to
 * drift out of date: the ledgers, git history, the index and the nightly log
 * already contain the evidence, and this reads them fresh each run.
 *
 * Six checks, and each one exists because it caught something real:
 *
 *   stalled      an in flight item that git says has not been touched in weeks
 *   silent       a department whose ledger has no recent entry
 *   unstarted    a department that has never recorded what it is doing
 *   contradicted an in flight item naming something the org has since removed
 *   unlinked     a subject in three or more departments that no ledger connects
 *   regressed    retrieval scoring worse than the run before
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ROOT, loadConfig } from "./lib/config.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); } catch { /* only the DB checks need it */ }

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const QUIET = argv.includes("--quiet");
const num = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : Number(argv[i + 1]); };

const STALL_DAYS = num("--stall", 21);
const SILENT_DAYS = num("--silent", 30);

const c = {
  dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m",
  red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", cyan: "\x1b[36m",
};

const today = new Date();
const daysSince = (iso) => Math.floor((today - new Date(iso)) / 86400000);
const findings = [];
const note = (level, check, department, headline, detail) =>
  findings.push({ level, check, department, headline, detail });

const { cfg } = loadConfig();
const departments = (cfg.departments ?? []).map((d) => ({ id: d.id, name: d.name }));

/* ------------------------------------------------------------- ledgers -- */

/** Split a ledger into its sections, keyed by heading. */
function sections(text) {
  const out = {};
  let key = null, buf = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (key) out[key] = buf.join("\n");
      key = m[1].toLowerCase();
      buf = [];
    } else if (key) buf.push(line);
  }
  if (key) out[key] = buf.join("\n");
  return out;
}

/** Top level bullets, joined across their wrapped continuation lines. */
function bullets(block) {
  if (!block) return [];
  const out = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^-\s+/.test(line)) out.push(line.replace(/^-\s+/, "").trim());
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += " " + line.trim();
  }
  return out;
}

const ledgers = new Map();
for (const d of departments) {
  const path = join(ROOT, "state", `${d.id}.md`);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  ledgers.set(d.id, { ...d, path, text, s: sections(text) });
}

/* -------------------------------------------- silent and unstarted -- */

for (const [id, led] of ledgers) {
  const dates = [...led.text.matchAll(/^-\s+(\d{4}-\d{2}-\d{2})\s+·/gm)].map((m) => m[1]).sort();
  const last = dates[dates.length - 1];

  if (!last) {
    note("warn", "unstarted", id, "no dated entry has ever been written",
      "This department has a ledger and no history. Anything done in it so far was lost.");
  } else if (daysSince(last) > SILENT_DAYS) {
    note("info", "silent", id, `${daysSince(last)} days since the last ledger entry`,
      `Newest entry is ${last}. Either nothing is happening here, or work is happening and not being recorded.`);
  }

  const flight = bullets(led.s["in flight"]);
  if (!flight.length || flight.every((b) => /^nothing logged yet/i.test(b))) {
    note("info", "unstarted", id, "nothing recorded as in flight",
      "A department with no stated work in progress cannot be picked up by anyone else.");
  }
}

/* ------------------------------------------------------------ stalled -- */

/**
 * How long an in flight item has been sitting there, from git rather than from
 * a date nobody wrote. `log -S` finds the commit that introduced the text, and
 * the last line of that history is when it first appeared.
 */
function firstSeen(file, needle) {
  try {
    const out = execFileSync(
      "git",
      ["log", "--format=%aI", "-S", needle, "--", file],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const lines = out.split("\n").filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
  } catch { return null; }
}

for (const [id, led] of ledgers) {
  for (const item of bullets(led.s["in flight"])) {
    if (/^nothing logged yet/i.test(item)) continue;
    // A distinctive slice, short enough to survive later edits to the tail of
    // the same bullet and long enough not to match another line by accident.
    const needle = item.replace(/[`\[\]]/g, "").slice(0, 48);
    const since = firstSeen(`state/${id}.md`, needle);
    if (!since) continue;
    const age = daysSince(since);
    if (age > STALL_DAYS) {
      note(age > STALL_DAYS * 3 ? "warn" : "info", "stalled", id,
        `in flight for ${age} days`, item.slice(0, 160));
    }
  }
}

/* ------------------------------------------------------- contradicted -- */

/**
 * An in flight item that names a unit the org chart no longer has.
 *
 * This is the check that pays for the rest. state/self.md still asks for
 * garmin-mcp to be plugged in; garmin-mcp was cut from the config on 7
 * September. Nothing else in the system compares the two, so the instruction
 * sits there looking live.
 */
const liveLabels = new Set();
for (const d of cfg.departments ?? []) {
  for (const cluster of d.clusters ?? []) {
    for (const item of cluster.items ?? []) if (item.label) liveLabels.add(item.label.toLowerCase());
  }
}

// Labels this repo has named at some point, taken from git history of the config.
let pastLabels = new Set();
try {
  const past = execFileSync("git", ["log", "--format=%H", "--", "org.config.json"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .trim().split("\n").filter(Boolean);
  for (const sha of past.slice(0, 12)) {
    const blob = execFileSync("git", ["show", `${sha}:org.config.json`],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const m of blob.matchAll(/"label":\s*"([^"]+)"/g)) pastLabels.add(m[1].toLowerCase());
  }
} catch { pastLabels = new Set(); }

const removed = [...pastLabels].filter((l) => !liveLabels.has(l) && l.length > 3);

for (const [id, led] of ledgers) {
  for (const item of bullets(led.s["in flight"])) {
    for (const gone of removed) {
      if (item.toLowerCase().includes(gone)) {
        note("warn", "contradicted", id,
          `in flight names "${gone}", which the org chart no longer has`,
          item.slice(0, 160));
        break;
      }
    }
  }
}

/* ----------------------------------------------------------- unlinked -- */

/**
 * A subject in three or more departments that no ledger cross-references.
 *
 * The rule in CLAUDE.md is that work touching a second department gets a line
 * in that department's Cross-references. The entity table can now say which
 * subjects actually span departments, so the two can be compared, which is the
 * first check here that could not have been written a week ago.
 */
try {
  const { store } = await import("./lib/store.mjs");
  const db = store();
  const reach = await db.rest("/rpc/entity_reach", { method: "POST", body: { min_depts: 3, k: 40 } });

  const crossText = [...ledgers.values()]
    .map((l) => (l.s["cross-references"] ?? "").toLowerCase())
    .join("\n");

  for (const e of reach ?? []) {
    // Ordinary words spanning every department measure the language, not the
    // business, so only proper nouns are worth flagging as unrecorded.
    if (!/[A-Z]/.test(e.name) || e.name.length < 4) continue;
    if (crossText.includes(e.name.toLowerCase())) continue;
    note("info", "unlinked", (e.depts ?? [])[0] ?? null,
      `"${e.name}" spans ${e.departments} departments and no ledger connects them`,
      `${e.documents} documents in ${(e.depts ?? []).join(", ")}. A cross-reference line would make that visible to the next session.`);
  }
} catch (err) {
  note("info", "unlinked", null, "could not check cross-references",
    String(err.message).slice(0, 120));
}

/* ---------------------------------------------------------- regressed -- */

const logPath = join(ROOT, "state", "nightly.log");
if (existsSync(logPath)) {
  const scores = [...readFileSync(logPath, "utf8")
    .matchAll(/(\d+) questions\s+recall@1 (\d+)%/g)]
    .map((m) => ({ n: Number(m[1]), at1: Number(m[2]) }));
  // Only comparable against a run with the same number of questions: growing
  // the set moves the score for reasons that are not a regression.
  const same = scores.filter((s) => s.n === scores[scores.length - 1]?.n);
  if (same.length >= 2) {
    const [prev, last] = [same[same.length - 2], same[same.length - 1]];
    if (last.at1 < prev.at1) {
      note("warn", "regressed", null,
        `retrieval fell from ${prev.at1}% to ${last.at1}% recall@1`,
        `Same ${last.n} questions both runs, so this is a real change. Check what was indexed or tuned since.`);
    }
  }
}

/* ------------------------------------------------------------- output -- */

const order = { warn: 0, info: 1 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.check.localeCompare(b.check));

/**
 * No process.exit() past this point.
 *
 * The entity check makes an HTTP call, and undici holds its socket open for a
 * few seconds afterwards. Calling process.exit() while that handle is alive
 * trips a libuv assertion on Windows: the script prints its whole report, then
 * dies with exit 127 and "UV_HANDLE_CLOSING", which reads as a crash to
 * anything that shells out to it and made the MCP tool fail on a report that
 * had already been generated correctly. Falling off the end lets node close
 * the socket and exit clean.
 */
if (AS_JSON) {
  console.log(JSON.stringify({ generated: today.toISOString(), findings }, null, 2));
} else if (!findings.length) {
  if (!QUIET) console.log(`${c.green}nothing is stalled and nothing is unrecorded${c.off}`);
} else if (!QUIET || findings.some((f) => f.level === "warn")) {
  const warns = findings.filter((f) => f.level === "warn").length;
  console.log(
    `\n${c.bold}${findings.length} things want attention${c.off}` +
    (warns ? `, ${c.yellow}${warns} of them now${c.off}` : "") + "\n"
  );

  for (const f of findings) {
    const tag = f.level === "warn" ? `${c.yellow}${f.check}${c.off}` : `${c.dim}${f.check}${c.off}`;
    console.log(`  ${tag.padEnd(24)} ${f.department ? c.cyan + f.department + c.off + "  " : ""}${f.headline}`);
    if (f.detail) console.log(`  ${c.dim}${f.detail.slice(0, 150)}${c.off}\n`);
  }
}
