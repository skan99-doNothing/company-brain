/**
 * Agent threads, kept on disk.
 *
 * Before this, a thread was one entry in a Map: agent plus session id, gone the
 * moment the server restarted, and the transcript lived only in the DOM of
 * whichever tab happened to be open. So a conversation with Claude about a repo
 * was unfindable an hour later, which made the panel a toy.
 *
 * Now every thread is a record: who it is with, what was said, and which files
 * and folders came up. That last part is the interesting one. Both CLIs name
 * real paths as they work, so reading the paths back out of the transcript
 * gives a free answer to "what was this thread touching", and it is an honest
 * answer because a path is only kept if it exists on this machine.
 *
 * One JSON file rather than a database. A few hundred threads of a few thousand
 * words is a couple of megabytes, and the whole repo runs on zero dependencies.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_MESSAGES = 200;   // per thread, oldest dropped
const MAX_TEXT = 60_000;    // per message

let FILE = "";
let ROOT = "";
let db = { threads: [] };
let dirty = false;
let flushTimer = null;

/** Point the store at the repo. Called once, from the server. */
export function openThreads(root) {
  ROOT = root;
  FILE = join(root, "state", "agent-threads.json");
  try {
    if (existsSync(FILE)) db = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(db.threads)) db = { threads: [] };
  } catch {
    // A corrupt store is not worth taking the server down for. Start clean and
    // leave the old file alone so it can still be looked at by hand.
    db = { threads: [] };
  }
  return db.threads.length;
}

/* Writes are batched. A long agent run appends to the transcript on every poll,
   and fsyncing a megabyte each time would be the slowest thing in the process. */
function save() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(db, null, 1), "utf8");
    } catch {
      // disk full, or the folder went away. The in-memory copy still serves.
    }
  }, 1200);
}

export function flushThreads() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(db, null, 1), "utf8");
  } catch {}
}

/* ----------------------------------------------------------------- read -- */

/** Every thread, newest activity first, without the transcripts. */
export function listThreads() {
  return db.threads
    .slice()
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .map((t) => ({
      id: t.id,
      agent: t.agent,
      title: t.title,
      created: t.created,
      updated: t.updated,
      messages: t.messages.length,
      files: t.files.length,
      folders: t.folders.length,
      last: t.messages.length ? t.messages[t.messages.length - 1].text.slice(0, 900) : "",
    }));
}

export function getThread(id) {
  return db.threads.find((t) => t.id === id) || null;
}

/* ---------------------------------------------------------------- write -- */

export function createThread(agent, title = "") {
  const now = new Date().toISOString();
  const t = {
    id: randomUUID(),
    agent,
    title: title.trim() || "New thread",
    created: now,
    updated: now,
    session: null,     // the CLI's own resume id, so the agent keeps its context
    messages: [],
    files: [],         // { path, kind, at, count }
    folders: [],       // { path, at, count }
  };
  db.threads.push(t);
  save();
  return t;
}

export function deleteThread(id) {
  const i = db.threads.findIndex((t) => t.id === id);
  if (i < 0) return false;
  db.threads.splice(i, 1);
  save();
  return true;
}

export function renameThread(id, title) {
  const t = getThread(id);
  if (!t) return null;
  t.title = String(title).trim().slice(0, 90) || t.title;
  t.updated = new Date().toISOString();
  save();
  return t;
}

export function setSession(id, session) {
  const t = getThread(id);
  if (!t) return;
  t.session = session;
  save();
}

/**
 * Add a turn.
 *
 * The first thing he says becomes the title, because a list of threads all
 * called "New thread" is the same as no list at all.
 */
export function addMessage(id, role, text, extra = {}) {
  const t = getThread(id);
  if (!t) return null;
  const msg = {
    role,
    text: String(text || "").slice(0, MAX_TEXT),
    at: new Date().toISOString(),
    ...extra,
  };
  t.messages.push(msg);
  if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES);
  if (role === "you" && (t.title === "New thread" || !t.title)) {
    t.title = msg.text.replace(/\s+/g, " ").trim().slice(0, 70) || "New thread";
  }
  t.updated = msg.at;
  save();
  return msg;
}

/** Replace the text of the last agent turn, which is how a poll updates it. */
export function updateLast(id, text) {
  const t = getThread(id);
  if (!t || !t.messages.length) return;
  const last = t.messages[t.messages.length - 1];
  if (last.role === "you") return;
  last.text = String(text || "").slice(0, MAX_TEXT);
  t.updated = new Date().toISOString();
  save();
}

/* ----------------------------------------------------------- path mining -- */

/*
 * Paths as the CLIs actually print them.
 *
 * Three shapes cover nearly all of it: a Windows absolute path, a posix
 * absolute path, and a repo-relative path with at least one slash. Anything
 * matched is checked against the filesystem before it is kept, which throws
 * away the false positives that a regex this loose would otherwise collect:
 * version strings, package names, and prose with a slash in it.
 */
const WINDOWS = /[A-Za-z]:[\\/][^\s"'`<>|?*\n)(\]]+/g;
const POSIX = /(?:^|[\s"'`(])(\/(?:[\w.\-+@]+\/)+[\w.\-+@]+)/g;
const RELATIVE = /(?:^|[\s"'`(])((?:[\w.\-+@]+[\\/]){1,6}[\w.\-+@]+\.[A-Za-z0-9]{1,6})/g;

const IGNORE = [
  /node_modules/i,
  /[\\/]\.git[\\/]/i,
  /^https?:/i,
];

function candidates(text) {
  const body = String(text || "");
  const out = new Set();
  for (const re of [WINDOWS, POSIX, RELATIVE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) {
      const raw = (m[1] || m[0]).replace(/[.,;:)\]]+$/, "").trim();
      if (raw.length < 4 || raw.length > 400) continue;
      if (IGNORE.some((bad) => bad.test(raw))) continue;
      out.add(raw);
    }
  }
  return [...out];
}

/** Where a printed path actually is, or null if it is not on this machine. */
function land(raw) {
  const tries = isAbsolute(raw) ? [raw] : [resolve(ROOT, raw), resolve(process.cwd(), raw)];
  for (const p of tries) {
    try {
      const s = statSync(p);
      return { path: p, dir: s.isDirectory() };
    } catch {
      // not there; try the next interpretation
    }
  }
  return null;
}

/**
 * Read the paths out of a chunk of agent output and record them on the thread.
 *
 * Counted rather than just listed, because a file the agent came back to six
 * times is the file the thread is about, and one mentioned in passing is not.
 * The folder list is the parents of the files, which is what the sidebar opens
 * on, plus any directory named outright.
 */
export function notePaths(id, text) {
  const t = getThread(id);
  if (!t || !ROOT) return { files: [], folders: [] };
  const now = new Date().toISOString();
  let added = 0;

  for (const raw of candidates(text)) {
    const hit = land(raw);
    if (!hit) continue;

    if (hit.dir) {
      const seen = t.folders.find((f) => f.path === hit.path);
      if (seen) { seen.count += 1; seen.at = now; }
      else { t.folders.push({ path: hit.path, at: now, count: 1 }); added += 1; }
      continue;
    }

    const seen = t.files.find((f) => f.path === hit.path);
    if (seen) { seen.count += 1; seen.at = now; }
    else { t.files.push({ path: hit.path, at: now, count: 1 }); added += 1; }

    const parent = dirname(hit.path);
    const pf = t.folders.find((f) => f.path === parent);
    if (pf) { pf.count += 1; pf.at = now; }
    else { t.folders.push({ path: parent, at: now, count: 1 }); }
  }

  if (added) save();
  return { files: t.files, folders: t.folders };
}
