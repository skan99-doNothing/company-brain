#!/usr/bin/env node
/**
 * Checks that the install is actually wired up, and explains anything that is not.
 *
 *   node bin/doctor.mjs
 *
 * Exits non-zero if something is genuinely broken, so CI can use it.
 */
import { readFile, access, lstat, readlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const WIN = platform() === "win32";
const c = { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", off: "\x1b[0m" };

let fails = 0, warns = 0;
const pass = (s) => console.log(`  ${c.grn}ok${c.off}   ${s}`);
const fail = (s, fix) => { fails++; console.log(`  ${c.red}fail${c.off} ${s}`); if (fix) console.log(`       ${c.dim}${fix}${c.off}`); };
const warn = (s, fix) => { warns++; console.log(`  ${c.yel}warn${c.off} ${s}`); if (fix) console.log(`       ${c.dim}${fix}${c.off}`); };
async function exists(p) { try { await access(p); return true; } catch { return false; } }

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
        if (await exists(p)) pass(`${rel} -> ${t}`);
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

/* search caveat, the thing that bites everyone */
console.log(`\n${c.dim}note  ripgrep does not follow links, so a search from this root will not descend
      into vaults/. Name the scope instead:  rg "term" vaults/<root>
      Reading, editing and globbing through a link path all work normally.${c.off}`);

console.log(`\n${fails ? c.red : c.grn}${fails} failed${c.off}, ${warns} warning(s)\n`);
process.exit(fails ? 1 : 0);
