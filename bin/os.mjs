#!/usr/bin/env node
/**
 * The OS: one window over the whole brain.
 *
 * The retrieval stage already answers questions, the nightly already indexes and
 * the ledgers already hold the memory. What was missing was a surface: a place
 * where all of it is visible at once and reachable without remembering which
 * script lives in which folder. Every panel here calls something that already
 * worked from a terminal.
 *
 * Panels: departments and their ledgers, semantic search over the corpus, the
 * link graph, an image library, a file browser, and agent threads that drive the
 * claude and codex CLIs on whatever subscription you are already signed into.
 * No API key is read anywhere in this file.
 *
 * Zero dependencies, same as the rest of this repo. Node's own http and child
 * process are enough, and a build step would be one more thing to keep alive.
 *
 *   npm run os        then open http://127.0.0.1:4180
 *
 * Long jobs do not block the request. They are spawned, given an id, and polled.
 * A browser tab that closes mid-run loses nothing: the job keeps going and the
 * output is still there on the next poll.
 *
 * Add your own panels by adding a route to `routes` below and a section to
 * os/index.html. That is the whole extension model.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brain } from "./lib/search.mjs";
import {
  openThreads, flushThreads, listThreads, getThread, createThread, deleteThread,
  renameThread, setSession, addMessage, updateLast, notePaths,
} from "./lib/threads.mjs";
import { listDir, peek, reveal, allowed } from "./lib/browse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const WIN = process.platform === "win32";
const PORT = Number(process.env.OS_PORT || 4180);

if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

// Whatever you called your org in org.config.json is what the window calls itself.
const ORG_NAME = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "org.config.json"), "utf8"));
    return cfg?.org?.atlasTitle || cfg?.org?.name || "Org OS";
  } catch {
    return "Org OS";
  }
})();

// Your server, if you have one. The health panel pings it and shows the vhosts
// it finds. Leave it unset and that panel simply reports no host configured.
const VPS_HOST = process.env.VPS_HOST || "";

// The Codex CLI, if you use it as a second agent lane beside Claude. On Windows
// the desktop app ships its own signed binary; elsewhere the npm shim on PATH
// is usually the one that is actually logged in. Override with CODEX_BIN.
const CODEX =
  process.env.CODEX_BIN ||
  (WIN
    ? join(HOME, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe")
    : "codex");

/* ------------------------------------------------------------------ jobs -- */

/**
 * A spawned process with its output accumulating in memory.
 *
 * Kept deliberately dumb. There is no persistence and no queue: this is a
 * single-operator machine, and a job that outlives the server was not worth
 * finishing anyway.
 */
const jobs = new Map();

/* The CLI session ids live on the thread records now, in state/agent-threads.json.
   openThreads() is called below once ROOT is known. */

function runJob(label, command, args, { cwd = ROOT, env = process.env, stdin = null, onDone = null, shell = WIN } = {}) {
  const id = randomUUID().slice(0, 8);
  const job = {
    id,
    label,
    command: [command, ...args].join(" "),
    started: new Date().toISOString(),
    state: "running",
    out: "",
    code: null,
  };
  jobs.set(id, job);

  // shell:true on Windows so .ps1 and .cmd resolve the way they do in a console.
  // Pass shell:false whenever the program or an argument can contain a space.
  // cmd.exe re-splits the argument list, so "C:\Program Files\nodejs\node.exe"
  // arrives as the command "C:\Program" and a stray argument.
  const child = spawn(command, args, { cwd, env, shell, windowsHide: true });
  const push = (chunk) => {
    job.out += chunk.toString();
    // A runaway process should not eat the machine's memory.
    if (job.out.length > 400_000) job.out = job.out.slice(-400_000);
  };
  // A prompt goes in on stdin rather than as an argument, because cmd.exe
  // mangles anything with newlines or quotes in it once shell:true is on.
  if (stdin !== null) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  }

  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("error", (err) => {
    job.state = "failed";
    job.out += `\n[spawn error] ${err.message}\n`;
    if (onDone) { try { onDone(job); } catch {} }
  });
  child.on("close", (code) => {
    job.code = code;
    if (job.state === "running") job.state = code === 0 ? "done" : "failed";
    // Whoever started this may want the finished transcript. A callback rather
    // than a poll, because the thread store needs the output exactly once.
    if (onDone) { try { onDone(job); } catch {} }
  });

  return job;
}

/**
 * A short command, run to completion, output returned.
 *
 * The opposite of runJob: no id, no polling, no entry in the Jobs panel. For
 * anything that answers in a second or two, where making the browser poll for
 * a result it could have had in the first response is just ceremony.
 *
 * Rejects on a non-zero exit with the tail of the output, because a Python
 * traceback's last two lines are the part worth showing.
 */
function run(command, args, { cwd = ROOT, timeout = 30_000, shell = WIN } = {}) {
  return new Promise((resolve, reject) => {
    // shell:false whenever an argument can contain a space. cmd.exe re-splits
    // the argument list, so a one-line thesis arrives as four arguments and
    // argparse rejects three of them.
    const child = spawn(command, args, { cwd, shell, windowsHide: true });
    let out = "";
    let err = "";
    const kill = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not finish inside ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(kill); reject(e); });
    child.on("close", (code) => {
      clearTimeout(kill);
      if (code === 0) return resolve(out);
      const tail = (err || out).trim().split(/\r?\n/).slice(-2).join(" ");
      reject(new Error(tail || `${command} exited ${code}`));
    });
  });
}

/*
 * The CLIs' own housekeeping, which is not part of any answer.
 *
 * Only used for mining paths out of a transcript. The transcript itself is
 * stored raw, so nothing an agent said is ever thrown away here.
 */
const CLI_NOISE = [
  /^Ignoring \d+ permissions\.allow entries/,
  /^OpenAI Codex v/,
  /^(workdir|model|provider|approval|sandbox|reasoning \w+):/,
  /^session id: /,
  /^-{4,}$/,
  /this workspace has not been trusted/,
  /hasTrustDialogAccepted/,
];

function answerOnly(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => !CLI_NOISE.some((re) => re.test(l.trim())))
    .join("\n");
}

/* --------------------------------------------------------------- probes -- */

/** Resolve within a deadline, and say how long it took either way. */
async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  }
}

function fetchWithin(url, ms, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function probeSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL or key missing from .env");
  const res = await fetchWithin(`${url}/rest/v1/`, 6000, { headers: { apikey: key } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return "reachable";
}

async function probeOllama() {
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const res = await fetchWithin(`${host}/api/tags`, 4000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const want = process.env.LOCAL_EMBEDDING_MODEL || "mxbai-embed-large";
  const has = (body.models || []).some((m) => (m.name || "").startsWith(want));
  if (!has) throw new Error(`${want} not pulled`);
  return want;
}

/**
 * The VPS, checked the way a person would: can anything reach it at all.
 *
 * Checked over HTTPS rather than SSH because Caddy answers even when every
 * agent on the box is out of credit, which is the distinction that matters.
 * A timeout here means the machine is gone, not that a token expired.
 */
async function probeVps() {
  if (!VPS_HOST) throw new Error("no VPS_HOST configured");
  // Set VPS_HOST to the hostname your reverse proxy actually serves, not a bare
  // IP. Caddy and nginx both route by name and usually have no site block for
  // the address itself, so https://<ip>/ is refused on a perfectly healthy box
  // and this panel reads "down" while everything is running. If you have no
  // real DNS, a wildcard resolver like <ip>.sslip.io gives you a name for free.
  const res = await fetchWithin(`https://${VPS_HOST}/`, 8000).catch((e) => {
    throw new Error(e.name === "AbortError" ? "timed out, no answer on 443" : e.message);
  });
  // 401 is the CRM asking for a password, which is a working server. Anything
  // that answers at all means Caddy is up and holding a certificate.
  return res.status === 401 ? "up, behind auth" : `HTTP ${res.status}`;
}

/* ------------------------------------------------------------ the brain -- */

let brainApi = null;
async function getBrain() {
  if (brainApi) return brainApi;
  const { brain } = await import("./lib/search.mjs");
  brainApi = brain();
  return brainApi;
}

async function brainStats() {
  const { store } = await import("./lib/store.mjs");
  const db = store();
  const rows = await db.rest("/rpc/brain_stats", { method: "POST", body: {} });
  return rows;
}

/* ---------------------------------------------------------- the library -- */

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);

/**
 * Every image under a handful of roots, newest first.
 *
 * Filename and folder matching only. Jack's version indexes pixels with a vision
 * model so "burger" finds a burger nobody named; that is the right end state and
 * it is a separate build. Saying so here is cheaper than pretending otherwise:
 * this finds what you named, which already beats opening six folders.
 */
let libraryCache = { at: 0, files: [] };

async function scanLibrary() {
  if (Date.now() - libraryCache.at < 120_000 && libraryCache.files.length) {
    return libraryCache.files;
  }
  // Where the library looks for images. Point LIBRARY_ROOTS at your own folders
  // (semicolon-separated) if these are not the ones you keep work in.
  const roots = (process.env.LIBRARY_ROOTS
    ? process.env.LIBRARY_ROOTS.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
    : [join(HOME, "Pictures"), join(HOME, "Desktop"), join(HOME, "Downloads")]
  ).filter((p) => existsSync(p));

  const files = [];
  const seen = new Set();
  const MAX = 4000;

  async function walk(dir, depth) {
    if (files.length >= MAX || depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!IMAGE_EXT.has(extname(entry.name).toLowerCase())) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const s = await stat(full);
        files.push({ path: full, name: entry.name, size: s.size, mtime: s.mtimeMs });
      } catch {
        /* a file that vanished between readdir and stat is not an error */
      }
    }
  }

  for (const root of roots) await walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  libraryCache = { at: Date.now(), files };
  return files;
}

/** Raw bytes, for uploads. readBody parses JSON and would choke on a binary blob. */
function readRaw(req, cap = 25_000_000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) return reject(new Error("upload too large"));
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/* ---------------------------------------------------------------- graph -- */

/** One page of a PostgREST table, with the service key. */
async function rest(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL or key missing from .env");
  const res = await fetch(`${url}/rest/v1${path}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** Every row of a table, in pages, because PostgREST caps a single response. */
async function restAll(path, select, page = 1000) {
  const out = [];
  for (let offset = 0; ; offset += page) {
    const sep = path.includes("?") ? "&" : "?";
    const rows = await rest(`${path}${sep}select=${select}&order=id&limit=${page}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < page) return out;
    if (out.length > 40_000) return out;          // a runaway query is a bug, not a graph
  }
}

let graphCache = { at: 0, data: null };

/**
 * The link graph, small enough to draw.
 *
 * 4,700 documents and 11,000 links is more than a browser can lay out and more
 * than an eye can read, and most of that mass is leaves: notes nothing points
 * at. So the graph is cut to the most connected nodes and the edges between
 * them, which is the part that actually has shape. Degree is computed over the
 * whole graph first, so a node's size still reflects its real connectedness.
 */
async function buildGraph() {
  if (graphCache.data && Date.now() - graphCache.at < 300_000) return graphCache.data;

  const [docs, links] = await Promise.all([
    restAll("/documents", "id,title,department,vault,doc_type,bytes"),
    restAll("/links?dst_id=not.is.null", "id,src_id,dst_id"),
  ]);

  const degree = new Map();
  const bump = (id) => degree.set(id, (degree.get(id) || 0) + 1);
  for (const l of links) { bump(l.src_id); bump(l.dst_id); }

  graphCache = {
    at: Date.now(),
    data: { docs, links, degree, totals: { documents: docs.length, links: links.length } },
  };
  return graphCache.data;
}

async function graphSlice({ department, limit }) {
  const { docs, links, degree, totals } = await buildGraph();

  let pool = docs;
  if (department) pool = pool.filter((d) => d.department === department);

  const ranked = pool
    .map((d) => ({ ...d, degree: degree.get(d.id) || 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);

  const keep = new Set(ranked.map((d) => d.id));
  const edges = links
    .filter((l) => keep.has(l.src_id) && keep.has(l.dst_id) && l.src_id !== l.dst_id)
    .map((l) => [l.src_id, l.dst_id]);

  return {
    totals,
    shown: ranked.length,
    departments: [...new Set(docs.map((d) => d.department).filter(Boolean))].sort(),
    nodes: ranked.map((d) => ({
      id: d.id,
      title: d.title || "untitled",
      department: d.department || null,
      vault: d.vault || null,
      degree: d.degree,
    })),
    edges,
  };
}

/* ----------------------------------------------------------------- http -- */

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const routes = {
  /** Everything the header needs, each probe independent so one failure is local. */
  "GET /api/health": async () => {
    const [supabase, ollama, vps] = await Promise.all([
      timed(probeSupabase),
      timed(probeOllama),
      timed(probeVps),
    ]);
    const stats = await timed(brainStats);
    return {
      supabase,
      ollama,
      vps: { ...vps, host: VPS_HOST },
      brain: stats.ok ? stats.value : null,
      brainError: stats.ok ? null : stats.error,
    };
  },

  "POST /api/search": async (body) => {
    const api = await getBrain();
    const hits = await api.search(body.q, {
      department: body.department || null,
      k: Number(body.k) || 10,
    });
    return { hits };
  },

  "GET /api/sessions": async (_body, url) => {
    const api = await getBrain();
    const rows = await api.recentSessions(
      url.searchParams.get("department"),
      Number(url.searchParams.get("limit")) || 12,
      url.searchParams.get("source")
    );
    return { sessions: rows };
  },

  "GET /api/library": async (_body, url) => {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const all = await scanLibrary();
    const hits = q
      ? all.filter((f) => (f.path.toLowerCase().includes(q)))
      : all;
    return { total: all.length, matched: hits.length, files: hits.slice(0, 120) };
  },

  /** Serve a local file as an image so the library can show thumbnails. */
  "GET /api/file": null, // handled inline, it streams rather than returning JSON
  /** The departments, straight from the config, so the rail is never stale. */
  "GET /api/config": async () => {
    const raw = JSON.parse(await readFile(join(ROOT, "org.config.json"), "utf8"));
    return {
      org: raw.org,
      departments: (raw.departments || []).map((d) => ({
        id: d.id, name: d.name, color: d.color, mission: d.mission,
        paths: d.paths || [],
        gaps: (d.clusters || []).flatMap((c) =>
          (c.items || []).filter((i) => i.type === "gap").map((i) => i.label)),
      })),
    };
  },

  /** The link graph, cut to something a browser can lay out in 3D. */
  "GET /api/graph": async (_body, url) => {
    const department = url.searchParams.get("dept") || "";
    const limit = Math.min(2000, Math.max(50, Number(url.searchParams.get("limit")) || 600));
    return graphSlice({ department, limit });
  },

  "POST /api/chat": async (body) => {
    const message = String(body.message || "").trim();
    if (!message) throw new Error("message is required");
    const agent = String(body.agent || "claude");

    // A thread id from the client, or a new record. Either way the transcript
    // is written down before the process starts, so a tab that closes mid-run
    // still has the question in it when it comes back.
    let t = body.thread ? getThread(String(body.thread)) : null;
    if (!t) t = createThread(agent, "");
    addMessage(t.id, "you", message);
    addMessage(t.id, agent, "");

    /* Every run ends here: the finished output onto the last turn, and the real
       paths mined out of it onto the thread. Doing it once on close rather than
       on every poll is what keeps the file counts honest.

       Paths are read from the answer only. Both CLIs print a preamble that
       names their own config files, and a thread whose file list is always
       .claude.json and settings.json tells you nothing about the work. */
    const finish = (job) => {
      updateLast(t.id, job.out);
      notePaths(t.id, answerOnly(job.out));
    };

    if (agent === "claude") {
      const id = t.session || randomUUID();
      const args = t.session
        ? ["-p", "--output-format", "text", "--resume", id]
        : ["-p", "--output-format", "text", "--session-id", id];
      setSession(t.id, id);
      const job = runJob(`claude: ${message.slice(0, 50)}`, "claude", args, {
        stdin: message,
        onDone: finish,
      });
      return { job: job.id, thread: t.id, session: id };
    }

    if (agent === "chatgpt") {
      if (!existsSync(CODEX)) throw new Error("codex not found at " + CODEX);
      const base = ["--color", "never", "--skip-git-repo-check"];
      const args = t.session
        ? ["exec", "resume", t.session, ...base, "-"]
        : ["exec", ...base, "-"];
      const job = runJob(`chatgpt: ${message.slice(0, 50)}`, CODEX, args, {
        stdin: message,
        onDone: (j) => {
          // Codex picks its own session id and prints it, so it is read back
          // off the transcript rather than set going in.
          const found = /session id:\s*([0-9a-f-]{36})/i.exec(j.out);
          if (found && !t.session) setSession(t.id, found[1]);
          finish(j);
        },
      });
      return { job: job.id, thread: t.id, session: t.session };
    }

    if (agent === "vps") {
      const job = runJob(
        `vps: ${message.slice(0, 50)}`,
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", `root@${VPS_HOST}`, message],
        { onDone: finish },
      );
      return { job: job.id, thread: t.id, session: null };
    }

    throw new Error("unknown agent: " + agent);
  },

  /* ------------------------------------------------------------ threads -- */

  /** Every conversation, newest first, without the transcripts. */
  "GET /api/threads": async () => ({
    // The preview line is the last thing said, minus the CLI's own preamble,
    // which is otherwise the first hundred characters of every Claude thread.
    threads: listThreads().map((t) => ({ ...t, last: answerOnly(t.last).trim().slice(0, 110) })),
  }),

  /** One conversation in full: turns, files touched, folders touched. */
  "GET /api/thread": async (_body, url) => {
    const t = getThread(String(url.searchParams.get("id") || ""));
    if (!t) throw new Error("no such thread");
    return {
      ...t,
      // Busiest first. A file the agent went back to is the one he wants.
      files: t.files.slice().sort((a, b) => b.count - a.count || b.at.localeCompare(a.at)),
      folders: t.folders.slice().sort((a, b) => b.count - a.count || b.at.localeCompare(a.at)),
    };
  },

  "POST /api/thread/new": async (body) => createThread(String(body.agent || "claude"), ""),

  "POST /api/thread/rename": async (body) => {
    const t = renameThread(String(body.id || ""), String(body.title || ""));
    if (!t) throw new Error("no such thread");
    return { ok: true, title: t.title };
  },

  "POST /api/thread/delete": async (body) => ({ ok: deleteThread(String(body.id || "")) }),

  /* ------------------------------------------------------------- browse -- */

  /**
   * One folder for the sidebar. Not recursive: the tree opens a level at a
   * time, which is the only way to click on a vault without waiting on 40,000
   * files.
   */
  "GET /api/tree": async (_body, url) => {
    const path = url.searchParams.get("path") || ROOT;
    return listDir(path);
  },

  /** The first slice of a text file, for the preview pane. */
  "GET /api/peek": async (_body, url) => peek(url.searchParams.get("path") || ""),

  /**
   * Hand a path to Windows: open it in whatever owns it, or show it sitting in
   * its folder. This is what "where is it" means when you are looking at a
   * thumbnail in a browser tab.
   */
  "POST /api/open": async (body) => {
    const path = String(body.path || "");
    if (!existsSync(path)) throw new Error("nothing at " + path);
    if (!allowed(path)) throw new Error("that path is outside your home folder");
    return reveal(path, { select: body.reveal !== false });
  },

  /** Bring the index up to date without opening a terminal. */
  "POST /api/index": async () => {
    const job = runJob("index", "node", [join(ROOT, "bin", "index.mjs")]);
    return { job: job.id };
  },

  "POST /api/doctor": async () => {
    const job = runJob("doctor", "node", [join(ROOT, "bin", "doctor.mjs")]);
    return { job: job.id };
  },

  "GET /api/jobs": async () => ({
    jobs: [...jobs.values()]
      .sort((a, b) => b.started.localeCompare(a.started))
      .slice(0, 30)
      .map(({ out, ...rest }) => ({ ...rest, bytes: out.length })),
  }),

  "GET /api/job": async (_body, url) => {
    const job = jobs.get(url.searchParams.get("id"));
    if (!job) throw new Error("no such job");
    return job;
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    // Streaming a local image file, so the library can render thumbnails
    // without copying anything into the repo.
    /*
     * A dropped video, straight to disk.
     *
     * Raw bytes with the name in a header rather than multipart, because
     * parsing multipart by hand to carry one file is a hundred lines that can
     * only ever go wrong. The browser is on the same machine, so this exists
     * only for the drag and drop case; pasting a path skips it entirely.
     */
    if (key === "POST /api/upload") {
      const name = basename(String(req.headers["x-filename"] || "clip.mp4")).replace(/[^\w.\-]/g, "_");
      const dir = join(ROOT, "var", "uploads");
      await mkdir(dir, { recursive: true });
      const out = join(dir, `${Date.now().toString(36)}-${name}`);
      const body = await readRaw(req);
      await writeFile(out, body);
      return json(res, 200, { path: out, bytes: body.length });
    }

    if (key === "GET /api/file") {
      const path = url.searchParams.get("path") || "";
      if (!existsSync(path) || !IMAGE_EXT.has(extname(path).toLowerCase())) {
        return json(res, 404, { error: "not an image on this machine" });
      }
      const buf = await readFile(path);
      res.writeHead(200, {
        "content-type": MIME[extname(path).toLowerCase()] || "application/octet-stream",
        "content-length": buf.length,
        "cache-control": "private, max-age=3600",
      });
      return res.end(buf);
    }


    if (routes[key]) {
      const body = req.method === "POST" ? await readBody(req) : {};
      return json(res, 200, await routes[key](body, url));
    }

    // Everything else is the app itself.
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = join(ROOT, "os", rel);
    if (!file.startsWith(join(ROOT, "os")) || !existsSync(file)) {
      return json(res, 404, { error: "not found" });
    }
    const buf = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": buf.length,
    });
    res.end(buf);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

/**
 * The brain, built once and only if something asks for it.
 *
 * Constructing it reads the environment and sets up an embedder, which is
 * wasted work on a session that never speaks, and it throws when the embedding
 * provider is not configured. A search that cannot run should cost the caller a
 * fallback, not the whole server.
 */
let _brain;
function brainOnce() {
  if (_brain === undefined) {
    try {
      _brain = brain();
    } catch (err) {
      process.stderr.write(`brain unavailable: ${err.message}\n`);
      _brain = null;
    }
  }
  return _brain;
}

server.listen(PORT, "127.0.0.1", () => {
  const n = openThreads(ROOT);
  process.stdout.write(`${ORG_NAME} on http://127.0.0.1:${PORT}, ${n} agent threads\n`);
});

// Writes to the thread store are batched, so a Ctrl-C a second after the last
// reply would otherwise lose it.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushThreads();
    process.exit(0);
  });
}
process.on("exit", flushThreads);
