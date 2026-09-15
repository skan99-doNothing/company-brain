#!/usr/bin/env node
/**
 * Reads org.config.json and builds your org:
 *
 *   vaults/<root>        junction (Windows) or symlink (macOS, Linux) to a real folder
 *   departments/<id>.md  a brief per department
 *   state/<id>.md        a ledger per department, only if it does not already exist
 *   HOME.md              the dashboard
 *   .mcp.json            connectors, if any are declared
 *   Open-Org.cmd / .sh   the launcher
 *
 * Nothing outside this folder is created, moved, renamed or deleted. Links point at
 * folders you already have; removing a link never touches its target.
 *
 *   node bin/init.mjs              build, never overwrite an existing ledger
 *   node bin/init.mjs --force      also rewrite briefs, HOME.md and launchers
 *   node bin/init.mjs --dry-run    print what would happen, change nothing
 *   node bin/init.mjs --config x   use a different config file
 */
import { readFile, writeFile, mkdir, symlink, lstat, readlink, access } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const DRY = argv.includes("--dry-run");
const cfgArg = argv.indexOf("--config");
const CONFIG = cfgArg >= 0 ? argv[cfgArg + 1] : "org.config.json";
const WIN = platform() === "win32";

const c = { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", cyn: "\x1b[36m", off: "\x1b[0m" };
const say = (s = "") => console.log(s);
const ok = (s) => say(`  ${c.grn}+${c.off} ${s}`);
const skip = (s) => say(`  ${c.dim}=${c.off} ${c.dim}${s}${c.off}`);
const warn = (s) => say(`  ${c.yel}!${c.off} ${s}`);
const die = (s) => { console.error(`\n${c.red}x${c.off} ${s}\n`); process.exit(1); };

async function exists(p) { try { await access(p); return true; } catch { return false; } }

/** ~ expansion plus forward slashes on every platform. */
function expand(p) {
  let s = String(p).trim();
  if (s.startsWith("~")) s = join(homedir(), s.slice(1));
  return resolve(s.split("/").join(WIN ? "\\" : "/"));
}

/* ------------------------------------------------------------------ config */

let cfg;
try {
  cfg = JSON.parse(await readFile(join(ROOT, CONFIG), "utf8"));
} catch (e) {
  die(`Could not read ${CONFIG}\n  ${e.message}\n\n  Copy one of the examples to start:\n    cp examples/solo-creator.json org.config.json`);
}

const errs = [];
if (!cfg.org?.name) errs.push("org.name is required");
if (!Array.isArray(cfg.departments) || !cfg.departments.length) errs.push("departments must be a non-empty array");
const seen = new Set();
for (const d of cfg.departments ?? []) {
  if (!d.id || !/^[a-z0-9][a-z0-9-]*$/.test(d.id)) errs.push(`department id "${d.id}" must be lowercase and filename-safe`);
  if (seen.has(d.id)) errs.push(`duplicate department id "${d.id}"`);
  seen.add(d.id);
  if (!d.name) errs.push(`department "${d.id}" needs a name`);
  for (const cl of d.clusters ?? []) {
    for (const it of cl.items ?? []) {
      if (!["core", "tool", "gap"].includes(it.type)) {
        errs.push(`${d.id}/${cl.name}/${it.label}: type must be core, tool or gap`);
      }
    }
  }
}
if (errs.length) die(`${CONFIG} has problems:\n\n  ${errs.join("\n  ")}`);

const ORG = cfg.org.name;
say(`\n${c.cyn}${ORG}${c.off} ${c.dim}// ${cfg.departments.length} departments${DRY ? "  (dry run)" : ""}${c.off}\n`);

/* ------------------------------------------------------------------- links */

say("links");
const links = [];
for (const [key, target] of Object.entries(cfg.roots ?? {})) links.push([join(ROOT, "vaults", key), expand(target), key]);
for (const [key, target] of Object.entries(cfg.loose ?? {})) links.push([join(ROOT, "vaults", "loose", key), expand(target), `loose/${key}`]);

if (!links.length) warn("no roots declared, so nothing is linked. Add paths under \"roots\" in your config.");

for (const [linkPath, target, label] of links) {
  if (!(await exists(target))) { warn(`${label} -> ${target}  ${c.red}target missing, skipped${c.off}`); continue; }

  // A link that lives inside its own target would recurse forever.
  if (ROOT.toLowerCase().startsWith(target.toLowerCase() + (WIN ? "\\" : "/"))) {
    warn(`${label} -> ${target}  ${c.red}skipped: this org folder lives inside that target, which would recurse${c.off}`);
    continue;
  }

  let cur = null;
  try { const st = await lstat(linkPath); if (st.isSymbolicLink()) cur = await readlink(linkPath); else cur = "__real_dir__"; } catch { /* absent */ }

  if (cur === "__real_dir__") { warn(`${label} exists as a real folder, not a link. Left alone.`); continue; }
  if (cur && resolve(cur).toLowerCase() === target.toLowerCase()) { skip(`${label} -> ${target}`); continue; }
  if (cur) { warn(`${label} points at ${cur}, not ${target}. Remove it and re-run to repoint.`); continue; }

  if (DRY) { ok(`${label} -> ${target}  ${c.dim}(would link)${c.off}`); continue; }
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    // "junction" on Windows needs no admin rights and behaves like a dir symlink.
    await symlink(target, linkPath, WIN ? "junction" : "dir");
    ok(`${label} -> ${target}`);
  } catch (e) {
    warn(`${label} -> ${target}  ${c.red}${e.code || e.message}${c.off}`);
    if (!WIN) warn(`  on macOS and Linux this needs no special rights; check the path exists`);
  }
}

/* --------------------------------------------------------------- templates */

const tplDept = await readFile(join(ROOT, "templates", "department.md"), "utf8");
const tplLedger = await readFile(join(ROOT, "templates", "ledger.md"), "utf8");
const tplAgent = (await exists(join(ROOT, "templates", "agent.md")))
  ? await readFile(join(ROOT, "templates", "agent.md"), "utf8")
  : null;
const today = new Date().toISOString().slice(0, 10);

function fill(tpl, map) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (map[k] ?? ""));
}

function pathTable(d) {
  const rows = (d.paths ?? []).map((p) => `| \`${p}\` |`);
  if (!rows.length) return "_No paths declared yet. Add them under `paths` in org.config.json._";
  return ["| Path |", "|---|", ...rows].join("\n");
}

function clusterTable(d) {
  if (!d.clusters?.length) return "_No clusters declared yet._";
  const out = [];
  for (const cl of d.clusters) {
    out.push(`### ${cl.name}`, "");
    out.push("| Unit | State | What it is | Where |", "|---|---|---|---|");
    for (const it of cl.items ?? []) {
      const state = it.type === "gap" ? "**not built**" : it.type === "tool" ? "connector" : "in use";
      out.push(`| \`${it.label}\` | ${state} | ${it.desc ?? ""} | \`${it.where ?? ""}\` |`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Connectors this department should reach for.
 *
 * Taken from cluster items of type "tool", but only those that are actually
 * declared in mcpServers. A brief can name a connector that was never wired up,
 * and telling an agent to use something that does not exist wastes a turn and
 * teaches it to distrust its own instructions.
 */
function connectorList(d, cfg) {
  const declared = new Set(Object.keys(cfg.mcpServers ?? {}));
  const named = (d.clusters ?? [])
    .flatMap((cl) => (cl.items ?? []).filter((i) => i.type === "tool"))
    .map((i) => i.label);

  const live = [...new Set(named.filter((n) => declared.has(n)))];
  const missing = [...new Set(named.filter((n) => !declared.has(n)))];

  const lines = ["- `brain` for search, department state, neighbours and duplicates."];
  for (const n of live) lines.push(`- \`${n}\``);
  if (missing.length) {
    lines.push(
      `\nNamed in this department's brief but not wired up in \`.mcp.json\`, so do not ` +
      `attempt them: ${missing.map((m) => `\`${m}\``).join(", ")}.`
    );
  }
  return lines.join("\n");
}

function gapList(d) {
  const gaps = (d.clusters ?? []).flatMap((cl) => (cl.items ?? []).filter((i) => i.type === "gap"));
  if (!gaps.length) return "- Nothing outstanding.";
  return gaps.map((g) => `- \`${g.label}\` ${g.desc ?? ""}`).join("\n");
}

/* -------------------------------------------------------- briefs + ledgers */

say("\ndepartments");
await mkdir(join(ROOT, "departments"), { recursive: true });
await mkdir(join(ROOT, "state"), { recursive: true });

for (const d of cfg.departments) {
  const ledgerRel = d.ledger ?? `state/${d.id}.md`;
  const briefPath = join(ROOT, "departments", `${d.id}.md`);
  const ledgerPath = join(ROOT, ledgerRel.split("/").join(WIN ? "\\" : "/"));

  const map = {
    ID: d.id, NAME: d.name, SUB: d.sub ?? "", COLOR: d.color ?? "#8A8272",
    MISSION: d.mission ?? "", HOME: d.home ?? "", LEDGER: ledgerRel,
    NOTE: d.note ?? "", DATE: today, ORG,
    PATHS: pathTable(d), CLUSTERS: clusterTable(d), GAPS: gapList(d),
    CONNECTORS: connectorList(d, cfg),
  };

  const writeBrief = FORCE || !(await exists(briefPath));
  if (!writeBrief) skip(`departments/${d.id}.md  (exists, use --force to rewrite)`);
  else if (DRY) ok(`departments/${d.id}.md  ${c.dim}(would write)${c.off}`);
  else { await writeFile(briefPath, fill(tplDept, map), "utf8"); ok(`departments/${d.id}.md`); }

  // Ledgers are memory. Never clobber one, not even with --force.
  if (await exists(ledgerPath)) skip(`${ledgerRel}  (kept, this is your memory)`);
  else if (DRY) ok(`${ledgerRel}  ${c.dim}(would create)${c.off}`);
  else { await mkdir(dirname(ledgerPath), { recursive: true }); await writeFile(ledgerPath, fill(tplLedger, map), "utf8"); ok(ledgerRel); }

  // One agent per department, generated rather than hand-written. Eight
  // near-identical files maintained by hand drift apart within a month, and
  // nobody notices until one of them is quietly wrong.
  if (tplAgent) {
    const agentPath = join(ROOT, ".claude", "agents", `${d.id}.md`);
    const writeAgent = FORCE || !(await exists(agentPath));
    if (!writeAgent) skip(`.claude/agents/${d.id}.md  (exists, use --force to rewrite)`);
    else if (DRY) ok(`.claude/agents/${d.id}.md  ${c.dim}(would write)${c.off}`);
    else {
      await mkdir(dirname(agentPath), { recursive: true });
      await writeFile(agentPath, fill(tplAgent, map), "utf8");
      ok(`.claude/agents/${d.id}.md`);
    }
  }
}

/* ------------------------------------------------------------------- HOME */

const rows = cfg.departments.map((d) => {
  const gaps = (d.clusters ?? []).flatMap((cl) => (cl.items ?? []).filter((i) => i.type === "gap")).length;
  return `| ${d.name} | ${d.mission ?? ""} | [departments/${d.id}.md](departments/${d.id}.md) | [${d.ledger ?? `state/${d.id}.md`}](${d.ledger ?? `state/${d.id}.md`}) | ${gaps || "none"} |`;
});
const linkLines = links.map(([, t, l]) => `vaults/${l.padEnd(16)} ->  ${t}`).join("\n");

const home = `---
type: dashboard
updated: ${today}
---

# ${ORG}

${cfg.org.tagline ?? "The company brain."}

Open Claude here, not in the individual folders. Rules for sessions: [CLAUDE.md](CLAUDE.md) ·
Decisions: [decisions.md](decisions.md) · Map: \`atlas/index.html\`

## Departments

| Department | Owns | Brief | Ledger | Gaps |
|---|---|---|---|---|
${rows.join("\n")}

## What is linked here

\`\`\`
${linkLines || "nothing linked yet, add paths under \"roots\" in org.config.json"}
\`\`\`

These are ${WIN ? "Windows junctions" : "symlinks"}. Nothing was moved. Deleting one never touches its target.

## Daily loop

\`\`\`
/brief <department>          read the brief and ledger, see what is in flight
  ... do the work ...
/log <department> "..."      append to the ledger, cross-reference other departments
\`\`\`

Weekly: \`/review\`. Unsure where something belongs: \`/route\`. Brief looks stale: \`/sync\`.

## The one rule

Read the ledger before. Append to it after. A session that changes something and writes
nothing has thrown that context away, and the next session starts cold.

_Generated by \`npm run init\` on ${today}. Edit org.config.json and re-run to update._
`;

say("");
const writeHome = FORCE || !(await exists(join(ROOT, "HOME.md")));
if (!writeHome) skip("HOME.md  (exists, use --force to rewrite)");
else if (DRY) ok(`HOME.md  ${c.dim}(would write)${c.off}`);
else { await writeFile(join(ROOT, "HOME.md"), home, "utf8"); ok("HOME.md"); }

/* --------------------------------------------------------------- .mcp.json */

if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
  const p = join(ROOT, ".mcp.json");
  const n = Object.keys(cfg.mcpServers).length;
  const writeMcp = FORCE || !(await exists(p));
  if (!writeMcp) skip(".mcp.json  (exists, use --force to rewrite)");
  else if (DRY) ok(`.mcp.json  ${c.dim}(would write ${n} servers)${c.off}`);
  else { await writeFile(p, JSON.stringify({ mcpServers: cfg.mcpServers }, null, 2) + "\n", "utf8"); ok(`.mcp.json  (${n} servers)`); }
} else skip(".mcp.json  (none declared)");

/* -------------------------------------------------------------- launchers */

const cmd = `@echo off\r\nREM Opens Claude at the org root. Pin this to your taskbar.\r\ncd /d "%~dp0"\r\nnode bin\\sync-inventory.mjs --quiet 2>nul\r\nclaude %*\r\n`;
const sh = `#!/usr/bin/env bash\n# Opens Claude at the org root.\ncd "$(dirname "$0")" || exit 1\nnode bin/sync-inventory.mjs --quiet 2>/dev/null\nexec claude "$@"\n`;
for (const [file, body] of [["Open-Org.cmd", cmd], ["open-org.sh", sh]]) {
  const p = join(ROOT, file);
  const w = FORCE || !(await exists(p));
  if (!w) skip(`${file}  (exists)`);
  else if (DRY) ok(`${file}  ${c.dim}(would write)${c.off}`);
  else { await writeFile(p, body, "utf8"); ok(file); }
}
if (!DRY && !WIN) { try { const { chmod } = await import("node:fs/promises"); await chmod(join(ROOT, "open-org.sh"), 0o755); } catch { /* not fatal */ } }

/* ------------------------------------------------------------------- done */

const totalGaps = cfg.departments.reduce((n, d) => n + (d.clusters ?? []).flatMap((cl) => cl.items ?? []).filter((i) => i.type === "gap").length, 0);
say(`\n${c.grn}done${c.off}  ${cfg.departments.length} departments, ${links.length} links, ${totalGaps} gaps declared`);
say(`${c.dim}next:  npm run sync    then open ${WIN ? "Open-Org.cmd" : "./open-org.sh"}${c.off}\n`);
