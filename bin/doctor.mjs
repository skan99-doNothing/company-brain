#!/usr/bin/env node
/**
 * Checks that the install is actually wired up, and explains anything that is not.
 *
 *   node bin/doctor.mjs                 wiring only: offline, no .env, no network
 *   node bin/doctor.mjs --deep          adds index drift and a real MCP handshake
 *   node bin/doctor.mjs --deep --json   the same findings, machine readable
 *
 * Exits non-zero if something is genuinely broken, so CI can use it.
 *
 * The default run stays offline on purpose. This is the first thing a fresh
 * clone of the template runs, before there is a Supabase project or a .env, so
 * nothing in the default path may need either. Everything that talks to the
 * database or spawns a connector lives behind --deep.
 *
 * It reports and never repairs. A check that quietly fixed what it found would
 * hide the drift it exists to surface, and every repair here already has a
 * command of its own that a person can read before running it.
 *
 * Two things this deliberately does not check, because they are already owned:
 * whether a department has gone quiet, and whether anything in flight has
 * stalled. Both are `npm run supervise`, which reads the ledgers, git and the
 * eval history to answer them properly.
 */
import { readFile, access, lstat, readlink, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const WIN = platform() === "win32";
const c = { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", off: "\x1b[0m" };

const argv = process.argv.slice(2);
const DEEP = argv.includes("--deep");
const num = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : Number(argv[i + 1]); };
const MCP_TIMEOUT = num("--mcp-timeout", 25) * 1000;

let fails = 0, warns = 0;
const pass = (s) => console.log(`  ${c.grn}ok${c.off}   ${s}`);
const fail = (s, fix) => { fails++; console.log(`  ${c.red}fail${c.off} ${s}`); if (fix) console.log(`       ${c.dim}${fix}${c.off}`); };
const warn = (s, fix) => { warns++; console.log(`  ${c.yel}warn${c.off} ${s}`); if (fix) console.log(`       ${c.dim}${fix}${c.off}`); };
async function exists(p) { try { await access(p); return true; } catch { return false; } }

/**
 * Does a link actually lead somewhere. Use this, not exists(), for junctions:
 * on Windows access() on a directory junction whose target has been deleted
 * still succeeds, so a dangling junction reported ok. stat() follows the
 * reparse point and throws, which is the behaviour we need from a drift check.
 */
async function resolves(p) { try { await stat(p); return true; } catch { return false; } }

console.log("\ncompany-brain doctor\n");

/* node */
const major = Number(process.versions.node.split(".")[0]);
if (major >= 18) pass(`node ${process.versions.node}`);
else fail(`node ${process.versions.node} is too old`, "needs node 18 or newer");

/* config */
let cfg = null;
if (!(await exists(join(ROOT, "org.config.json")))) {
  fail("org.config.json missing", "cp examples/solo-creator.json org.config.json");
} else {
  try {
    cfg = JSON.parse(await readFile(join(ROOT, "org.config.json"), "utf8"));
    pass(`org.config.json parses, ${cfg.departments?.length ?? 0} departments`);
  } catch (e) { fail(`org.config.json is not valid JSON: ${e.message}`, "a trailing comma is the usual cause"); }
}

/* links */
if (cfg) {
  const links = [
    ...Object.entries(cfg.roots ?? {}).map(([k, v]) => [`vaults/${k}`, v]),
    ...Object.entries(cfg.loose ?? {}).map(([k, v]) => [`vaults/loose/${k}`, v]),
  ];
  if (!links.length) warn("no roots declared", 'add folders under "roots" in org.config.json');
  for (const [rel, target] of links) {
    const p = join(ROOT, rel);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const t = await readlink(p);
        if (await resolves(p)) pass(`${rel} -> ${t}`);
        else fail(`${rel} points at ${t}, which no longer exists`, "fix the path in org.config.json, delete the link, re-run npm run init");
      } else warn(`${rel} is a real folder, not a link`, "expected a link; init will not touch it");
    } catch {
      fail(`${rel} is not linked (target: ${target})`, "npm run init");
    }
  }
}

/* generated files */
for (const f of ["HOME.md", "CLAUDE.md", "decisions.md"]) {
  if (await exists(join(ROOT, f))) pass(f);
  else if (f === "HOME.md") fail(`${f} missing`, "npm run init");
  else fail(`${f} missing`, "this ships with the template, restore it from git");
}

/* briefs and ledgers */
if (cfg) {
  let missingBrief = 0, missingLedger = 0;
  for (const d of cfg.departments ?? []) {
    if (!(await exists(join(ROOT, "departments", `${d.id}.md`)))) missingBrief++;
    const led = (d.ledger ?? `state/${d.id}.md`).split("/").join(WIN ? "\\" : "/");
    if (!(await exists(join(ROOT, led)))) missingLedger++;
  }
  if (missingBrief) fail(`${missingBrief} department brief(s) missing`, "npm run init");
  else pass(`${cfg.departments.length} briefs present`);
  if (missingLedger) fail(`${missingLedger} ledger(s) missing`, "npm run init");
  else pass(`${cfg.departments.length} ledgers present`);
}

/* declared department paths */
//
// The links check above proves a root resolves. It says nothing about the paths
// the departments actually claim, and those are what the briefs, the indexer and
// the agents all read. A department pointing at a folder that was renamed looks
// perfectly healthy until a session opens it and finds nothing.
//
// stat() rather than access(), because these run through junctions and a
// dangling junction satisfies access() on Windows.
if (cfg) {
  const sep = WIN ? "\\" : "/";
  const broken = [];
  let claimed = 0, skipped = 0;
  for (const d of cfg.departments ?? []) {
    for (const rel of d.paths ?? []) {
      claimed++;
      // A path under a root that is not linked yet is already a link failure
      // above. Counting it twice makes one unlinked root look like six problems.
      const parts = rel.split("/");
      const rootRel = parts[0] === "vaults" && parts[1] === "loose" ? parts.slice(0, 3) : parts.slice(0, 2);
      if (!(await resolves(join(ROOT, rootRel.join(sep))))) { skipped++; continue; }
      if (!(await resolves(join(ROOT, parts.join(sep))))) broken.push([d.id, rel]);
    }
  }
  // A warning rather than a failure. A department may legitimately point at a
  // folder that does not exist yet, which is the normal state of a fresh clone
  // before anything has been filed, and doctor's exit code gates CI.
  if (broken.length) {
    warn(`${broken.length} of ${claimed} declared department path(s) do not exist`,
      "create the folder, fix the path in org.config.json, or drop it, then npm run sync");
    for (const [dept, rel] of broken.slice(0, 12)) console.log(`       ${c.dim}${dept}  ${rel}${c.off}`);
    if (broken.length > 12) console.log(`       ${c.dim}and ${broken.length - 12} more${c.off}`);
  } else if (claimed - skipped > 0) {
    pass(`${claimed - skipped} declared department paths all resolve`);
  }
  if (skipped) console.log(`  ${c.dim}skip${c.off} ${skipped} declared path(s) sit under a root that is not linked yet`);
}

/* skills and agents */
for (const [dir, label] of [[".claude/skills", "skills"], [".claude/agents", "agents"]]) {
  const p = join(ROOT, dir);
  if (await exists(p)) {
    const n = (await readdir(p)).length;
    pass(`${n} ${label} in ${dir}`);
  } else warn(`${dir} missing`, "restore it from git");
}

/* inventory freshness */
const invP = join(ROOT, "state", "inventory.json");
if (await exists(invP)) {
  try {
    const inv = JSON.parse(await readFile(invP, "utf8"));
    const age = Math.floor((Date.now() - Date.parse(inv.generated)) / 86400000);
    if (inv.totals?.missing) warn(`inventory lists ${inv.totals.missing} missing path(s)`, "npm run sync, then fix the paths in org.config.json");
    if (age > 7) warn(`inventory is ${age} days old`, "npm run sync");
    else pass(`inventory ${age === 0 ? "generated today" : `${age} day(s) old`}, ${inv.totals?.md ?? 0} markdown files`);
  } catch { warn("inventory.json is unreadable", "npm run sync"); }
} else warn("no inventory yet", "npm run sync");

/* mcp */
if (await exists(join(ROOT, ".mcp.json"))) {
  try {
    const m = JSON.parse(await readFile(join(ROOT, ".mcp.json"), "utf8"));
    pass(`.mcp.json, ${Object.keys(m.mcpServers ?? {}).length} servers`);
  } catch { fail(".mcp.json is not valid JSON", "Claude Code will ignore it until this parses"); }
} else if (cfg && Object.keys(cfg.mcpServers ?? {}).length) warn(".mcp.json not generated", "npm run init");

/* ------------------------------------------------------------------ deep -- */

/**
 * Ask an MCP server to introduce itself, and report whether it does.
 *
 * A server is configured correctly when its command exists, its arguments point
 * at real files, and it completes an `initialize` handshake. Only the third
 * proves anything. A server on cookie auth works until the cookie expires, a
 * server launched from a path in another repo breaks when that repo moves, and
 * an http endpoint answers 401 the moment its token is wrong. All three look
 * perfectly fine in a static read of .mcp.json.
 *
 * Windows needs shell:true to launch npx at all, which means arguments carry
 * their own quotes, and killing the shell would otherwise orphan the node
 * process it spawned. Hence taskkill with /T.
 */
async function handshake(name, spec) {
  const req = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "org-doctor", version: "1.0.0" },
    },
  });

  if (spec.type === "http" || spec.url) {
    try {
      const res = await fetch(spec.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: req,
        signal: AbortSignal.timeout(MCP_TIMEOUT),
      });
      const text = (await res.text()).slice(0, 300);
      if (!res.ok) return { ok: false, why: `HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 120)}` };
      return { ok: /"result"|"serverInfo"|"protocolVersion"/.test(text), why: text.replace(/\s+/g, " ").slice(0, 120) };
    } catch (e) { return { ok: false, why: e.message.slice(0, 120) }; }
  }

  if (!spec.command) return { ok: false, why: "no command and no url" };

  // Any argument that is an absolute path must exist, checked before spawning so
  // a typo reads as a typo instead of a server that died on startup.
  for (const a of spec.args ?? []) {
    if (/^[A-Za-z]:[\\/]|^\//.test(a) && !(await resolves(a))) return { ok: false, why: `argument does not exist: ${a}` };
  }

  return await new Promise((done) => {
    const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    const cmd = WIN ? [spec.command, ...(spec.args ?? [])].map(quote).join(" ") : spec.command;
    let child;
    try {
      child = spawn(cmd, WIN ? [] : (spec.args ?? []), {
        shell: WIN,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(spec.env ?? {}) },
      });
    } catch (e) { return done({ ok: false, why: e.message.slice(0, 120) }); }

    let out = "", err = "", settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (WIN && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill();
      } catch { /* already gone */ }
      done(v);
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `no initialize response in ${MCP_TIMEOUT / 1000}s${err ? `: ${err.replace(/\s+/g, " ").slice(0, 100)}` : ""}` }),
      MCP_TIMEOUT
    );

    child.stdout.on("data", (b) => {
      out += b;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id !== 1) continue;
          if (m.error) return finish({ ok: false, why: String(m.error.message ?? JSON.stringify(m.error)).slice(0, 120) });
          const info = m.result?.serverInfo;
          return finish({ ok: true, why: info ? `${info.name} ${info.version ?? ""}`.trim() : "initialized" });
        } catch { /* a partial line is normal, wait for the rest */ }
      }
    });
    child.stderr.on("data", (b) => { err += b; });
    child.on("error", (e) => finish({ ok: false, why: e.message.slice(0, 120) }));
    child.on("exit", (code) => finish({ ok: false, why: `exited ${code} before answering${err ? `: ${err.replace(/\s+/g, " ").slice(0, 100)}` : ""}` }));

    child.stdin.write(req + "\n");
  });
}

if (DEEP) {
  console.log(`\n${c.dim}deep checks${c.off}`);

  /* index drift: what the database claims against what is on disk */
  //
  // The retrieval layer is optional. The template ships the router without it, so
  // its absence is a fact to state rather than a fault to report: an install with
  // no indexer has no index to drift.
  let env = true;
  try { process.loadEnvFile(join(ROOT, ".env")); } catch { env = false; }
  const hasIndexer = await exists(join(ROOT, "bin", "lib", "store.mjs"));

  if (!hasIndexer) {
    console.log(`  ${c.dim}skip${c.off} no retrieval layer installed, so there is no index to check`);
  } else if (!env) {
    warn("no .env, so the index was not checked", "cp .env.example .env and fill it in");
  } else {
    try {
      const { store } = await import("./lib/store.mjs");
      const db = store();
      const docs = await db.documentIndex();

      let gone = 0, stale = 0, unreadable = 0;
      const goneList = [], staleList = [];
      for (const [path, rec] of docs) {
        let text;
        try { text = await readFile(path, "utf8"); }
        catch (e) {
          if (e.code === "ENOENT") { gone++; if (goneList.length < 8) goneList.push(path); }
          else unreadable++;
          continue;
        }
        if (createHash("sha256").update(text).digest("hex") !== rec.hash) {
          stale++;
          if (staleList.length < 8) staleList.push(path);
        }
      }

      // A warning, not a failure: the next indexer run deletes rows whose file is
      // gone, so this is drift with a known repair rather than a broken install.
      if (gone) {
        warn(`${gone} indexed document(s) no longer exist on disk`, "npm run index  (it deletes rows whose file is gone)");
        for (const p of goneList) console.log(`       ${c.dim}${p}${c.off}`);
      } else pass(`every one of ${docs.size} indexed documents still exists`);

      if (stale) {
        warn(`${stale} document(s) changed since they were indexed`, "npm run index");
        for (const p of staleList) console.log(`       ${c.dim}${p}${c.off}`);
      } else pass("no document hashes are stale");

      if (unreadable) warn(`${unreadable} indexed file(s) could not be read`, "usually a permission or a lock, not drift");
    } catch (e) {
      fail(`could not read the index: ${e.message.slice(0, 140)}`, "check SUPABASE_URL and the key in .env, and that the project is awake");
    }
  }

  /* mcp: do the servers actually answer */
  let mcp = null;
  try { mcp = JSON.parse(await readFile(join(ROOT, ".mcp.json"), "utf8")).mcpServers ?? {}; } catch { /* reported above */ }
  const servers = Object.entries(mcp ?? {}).filter(([k]) => !k.startsWith("//"));
  // No .mcp.json is a valid install, not a fault: connectors are optional and
  // init only writes the file when the config declares an mcpServers block.
  if (!servers.length) console.log(`  ${c.dim}skip${c.off} no MCP servers declared, so none were tested`);
  else {
    const results = await Promise.all(servers.map(async ([name, spec]) => [name, await handshake(name, spec)]));
    const bad = results.filter(([, r]) => !r.ok);
    for (const [name, r] of results) {
      if (r.ok) pass(`mcp ${name}${r.why ? `  ${c.dim}${r.why}${c.off}` : ""}`);
      else warn(`mcp ${name} did not initialize`, r.why);
    }
    if (bad.length) {
      console.log(`       ${c.dim}a connector that fails here fails the same way in a session${c.off}`);
    }
  }
}

/* search caveat, the thing that bites everyone */
console.log(`\n${c.dim}note  ripgrep does not follow links, so a search from this root will not descend
      into vaults/. Name the scope instead:  rg "term" vaults/<root>
      Reading, editing and globbing through a link path all work normally.${c.off}`);

if (!DEEP) {
  console.log(`${c.dim}      this run checked wiring only. --deep also compares the index against
      disk and asks every MCP server to initialize.${c.off}`);
}
console.log(`${c.dim}      whether a department has gone quiet or something in flight has stalled
      is npm run supervise, not this.${c.off}`);

console.log(`\n${fails ? c.red : c.grn}${fails} failed${c.off}, ${warns} warning(s)\n`);
process.exit(fails ? 1 : 0);
