#!/usr/bin/env node
/**
 * skill-usage.mjs — which of the installed skills have ever actually run.
 *
 *   npm run skills                 the report
 *   npm run skills -- --unused     only the ones with no evidence
 *   npm run skills -- --used       only the ones with evidence, newest first
 *   npm run skills -- --since 90   ignore evidence older than 90 days
 *   npm run skills -- --json       the same numbers, machine readable
 *   npm run skills -- --md FILE    write the report to a markdown file
 *
 * The obvious way to answer "which skills do I actually use" is a hook that
 * logs every invocation from today onward, and then waiting three months. That
 * is the wrong build: the answer is already sitting on disk. Every session
 * transcript under ~/.claude/projects records the tool calls made in it, and a
 * skill invocation is a tool call like any other. This reads the record that
 * already exists rather than starting a new one.
 *
 * Three ways a skill leaves a trace, all counted:
 *
 *   tool    the Skill tool was called with the skill's name. The strongest
 *           signal, and the only one that means the skill was loaded on purpose.
 *   slash   the session opened with /name, which is how a person asks for one
 *           by hand. Only counted when the name matches something installed,
 *           because most slash commands are built into the CLI.
 *   read    a SKILL.md under the skill's own directory was read. Weaker: it can
 *           mean the skill ran, or that somebody was looking at how it works.
 *
 * The window is not all time, and the report says so. Claude Code deletes
 * transcripts after cleanupPeriodDays, which defaults to 30, so a skill with no
 * trace has not run recently rather than never. Raising that setting is what
 * makes this measurement worth more next quarter than it is today.
 */

import { readFileSync, readdirSync, existsSync, statSync, createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

const ONLY_UNUSED = has("--unused");
const ONLY_USED = has("--used");
const AS_JSON = has("--json");
const MD_OUT = val("--md", null);
const SINCE_DAYS = Number(val("--since", 0)) || 0;
const CUTOFF = SINCE_DAYS ? Date.now() - SINCE_DAYS * 86400000 : 0;

const c = {
  dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

/* ------------------------------------------------------------ inventory -- */

/** Lowercase forward slashes, so a Windows path from a transcript compares. */
const norm = (p) => p.replace(/\\/g, "/").toLowerCase();

/**
 * A skill is a directory sitting directly under a skills root with a SKILL.md
 * in it. Deeper SKILL.md files are that skill's own reference material, not
 * separately addressable, so they are folded into their parent.
 */
function skillsIn(root, scope, plugin, enabled) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    out.push({
      key: plugin ? `${plugin}:${name}` : name,
      name, scope, plugin: plugin || null, enabled, dir, path: norm(dir),
    });
  }
  return out;
}

function inventory() {
  const skills = [];
  skills.push(...skillsIn(join(HOME, ".claude", "skills"), "user", null, true));
  skills.push(...skillsIn(join(ROOT, ".claude", "skills"), "org", null, true));

  // Only the version of a plugin that is actually installed. The cache keeps
  // older ones, and counting those would report skills nothing can reach.
  const pluginsFile = join(HOME, ".claude", "plugins", "installed_plugins.json");
  let enabledMap = {};
  try {
    const s = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
    enabledMap = s.enabledPlugins || {};
  } catch { /* no settings, treat every installed plugin as enabled */ }

  if (existsSync(pluginsFile)) {
    const reg = JSON.parse(readFileSync(pluginsFile, "utf8")).plugins || {};
    for (const [full, entries] of Object.entries(reg)) {
      const plugin = full.split("@")[0];
      const enabled = enabledMap[full] !== false;
      for (const e of entries) {
        if (!e.installPath) continue;
        skills.push(...skillsIn(join(e.installPath, "skills"), "plugin", plugin, enabled));
        skills.push(...skillsIn(join(e.installPath, ".claude", "skills"), "plugin", plugin, enabled));
      }
    }
  }

  // Two plugins can ship a skill of the same name; the key already separates
  // them. Same key twice means two install entries for one plugin.
  const byKey = new Map();
  for (const s of skills) if (!byKey.has(s.key)) byKey.set(s.key, s);

  // A disabled plugin's skills are on disk and out of reach, so counting them
  // as installed would overstate what a session actually carries. They are
  // reported as a single line instead, because turning one back on is a flag.
  const all = [...byKey.values()];
  const dormant = all.filter((s) => !s.enabled);
  return { skills: all.filter((s) => s.enabled), dormant };
}

/* ------------------------------------------------------------- evidence -- */

function transcripts(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Every line of every transcript, but parsed only when a cheap substring says
 * it might carry a skill. 360 MB of JSON is minutes to parse in full and
 * seconds to scan.
 */
async function evidence(skills) {
  const byKey = new Map(skills.map((s) => [s.key.toLowerCase(), s.key]));
  const byName = new Map();
  for (const s of skills) {
    if (!byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s.key);
  }
  // Longest path first, so a nested skills root wins over the root above it.
  const byPath = skills.map((s) => [s.path, s.key]).sort((a, b) => b[0].length - a[0].length);

  const hits = [];
  const unknown = new Map();

  const record = (raw, channel, ts, cwd) => {
    const k = String(raw || "").trim().replace(/^\//, "");
    if (!k) return;
    const key = byKey.get(k.toLowerCase()) || (channel === "tool" ? null : byName.get(k.toLowerCase()));
    if (!key) {
      // Only the Skill tool proves a name was meant as a skill. A slash command
      // that matches nothing installed is almost always a built-in CLI command.
      if (channel === "tool") unknown.set(k, (unknown.get(k) || 0) + 1);
      return;
    }
    hits.push({ key, channel, ts, cwd });
  };

  const fromPath = (p) => {
    const n = norm(p);
    for (const [dir, key] of byPath) if (n.startsWith(dir + "/")) return key;
    return null;
  };

  const files = transcripts(join(HOME, ".claude", "projects"));
  let scanned = 0;
  let lo = "", hi = "";

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      // The oldest and newest moment on record, which is the honest span of
      // this report. Read off every line, not only the ones carrying a skill,
      // or a quiet week would look like the edge of history.
      const ti = line.indexOf('"timestamp":"');
      if (ti !== -1) {
        const t = line.slice(ti + 13, ti + 33);
        if (t > "2000" ) {
          if (!lo || t < lo) lo = t;
          if (!hi || t > hi) hi = t;
        }
      }

      const wantsTool = line.includes('"Skill"');
      const wantsSlash = line.includes("<command-name>");
      const wantsRead = line.includes("SKILL.md");
      if (!wantsTool && !wantsSlash && !wantsRead) continue;

      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(row.timestamp || "") || 0;
      if (CUTOFF && ts && ts < CUTOFF) continue;
      const cwd = row.cwd || "";

      const content = row.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_use") {
            if (block.name === "Skill") record(block.input?.skill, "tool", ts, cwd);
            const fp = block.input?.file_path;
            if (fp && /skill\.md$/i.test(fp)) {
              const key = fromPath(fp);
              if (key) hits.push({ key, channel: "read", ts, cwd });
            }
          } else if (block?.type === "text" && wantsSlash) {
            for (const m of String(block.text).matchAll(/<command-name>([^<]+)<\/command-name>/g)) {
              record(m[1], "slash", ts, cwd);
            }
          }
        }
      } else if (typeof content === "string" && wantsSlash) {
        for (const m of content.matchAll(/<command-name>([^<]+)<\/command-name>/g)) {
          record(m[1], "slash", ts, cwd);
        }
      }
    }
    scanned++;
  }

  return { hits, unknown, files: scanned, from: lo.slice(0, 10), to: hi.slice(0, 10) };
}

/* --------------------------------------------------------------- report -- */

const { skills, dormant } = inventory();
const dormantPlugins = [...new Set(dormant.map((s) => s.plugin))];
process.stderr.write(`${c.dim}reading transcripts `);
const started = Date.now();
const { hits, unknown, files, from, to } = await evidence(skills);
process.stderr.write(`${files} files in ${((Date.now() - started) / 1000).toFixed(1)}s${c.off}\n`);

const use = new Map();
for (const s of skills) use.set(s.key, { ...s, tool: 0, slash: 0, read: 0, total: 0, last: 0, where: new Set() });
for (const h of hits) {
  const u = use.get(h.key);
  if (!u) continue;
  u[h.channel]++;
  u.total++;
  if (h.ts > u.last) u.last = h.ts;
  if (h.cwd) u.where.add(h.cwd);
}

const rows = [...use.values()];
const used = rows.filter((r) => r.total > 0).sort((a, b) => b.total - a.total || b.last - a.last);
const never = rows.filter((r) => r.total === 0);
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "");
const shortCwd = (p) => p.replace(/\\/g, "/").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "");

if (AS_JSON) {
  console.log(JSON.stringify({
    installed: rows.length,
    dormant: dormant.length,
    dormantPlugins,
    used: used.length,
    never: never.length,
    sinceDays: SINCE_DAYS || null,
    windowFrom: from,
    windowTo: to,
    skills: rows.map((r) => ({
      key: r.key, scope: r.scope, plugin: r.plugin, enabled: r.enabled,
      tool: r.tool, slash: r.slash, read: r.read, total: r.total,
      last: r.last ? new Date(r.last).toISOString() : null,
      projects: [...r.where],
    })),
    unrecognised: [...unknown].map(([name, n]) => ({ name, n })),
  }, null, 2));
  process.exit(0);
}

const lines = [];
const say = (s = "") => lines.push(s);

const span = SINCE_DAYS ? `the last ${SINCE_DAYS} days` : `${from} to ${to}`;
say(`${c.bold}${rows.length} skills installed${c.off}, ${c.green}${used.length} used${c.off}, ${c.yellow}${never.length} not seen${c.off} ${c.dim}· ${span}${c.off}`);
say(`${c.dim}user ${rows.filter((r) => r.scope === "user").length}  ·  plugin ${rows.filter((r) => r.scope === "plugin").length}  ·  org ${rows.filter((r) => r.scope === "org").length}${c.off}`);
if (dormant.length) {
  say(`${c.dim}${dormant.length} more sit in ${dormantPlugins.length} disabled plugins, on disk and not loaded${c.off}`);
}
say(`${c.dim}That span is every transcript still on disk, not all time. Claude Code deletes${c.off}`);
say(`${c.dim}them after cleanupPeriodDays, so "not seen" means not lately, not never.${c.off}`);
say();

if (!ONLY_UNUSED) {
  say(`${c.bold}used${c.off}  ${c.dim}tool = the Skill tool ran it, slash = asked for by name, read = its SKILL.md was opened${c.off}`);
  say(`${c.dim}${"skill".padEnd(38)}${"tool".padStart(5)}${"slash".padStart(6)}${"read".padStart(6)}  last        where${c.off}`);
  for (const r of used) {
    const w = [...r.where].map(shortCwd);
    say(
      "  " + r.key.slice(0, 36).padEnd(36) +
      String(r.tool || "").padStart(5) +
      String(r.slash || "").padStart(6) +
      String(r.read || "").padStart(6) +
      "  " + day(r.last).padEnd(12) +
      c.dim + (w.slice(0, 2).join(", ") + (w.length > 2 ? ` +${w.length - 2}` : "")) + c.off
    );
  }
  say();
}

if (!ONLY_USED) {
  // Grouped by what it would take to remove them. A plugin skill goes away by
  // uninstalling one plugin; a user skill is a directory to delete by hand.
  const byPlugin = new Map();
  const loose = [];
  for (const r of never) {
    if (r.scope === "plugin") {
      if (!byPlugin.has(r.plugin)) byPlugin.set(r.plugin, []);
      byPlugin.get(r.plugin).push(r.name);
    } else loose.push(r);
  }

  say(`${c.bold}not seen, installed by hand${c.off}  ${c.dim}${loose.length} directories under ~/.claude/skills and Org/.claude/skills${c.off}`);
  // Two per row, wide enough that the long generated names stay readable. A
  // truncated name is a name you have to go and look up, which defeats a list
  // whose whole purpose is deciding what to delete.
  const names = loose.map((r) => r.key).sort();
  for (let i = 0; i < names.length; i += 2) {
    say("  " + names.slice(i, i + 2).map((n) => n.padEnd(46)).join("").trimEnd());
  }
  say();

  const plugins = [...byPlugin].sort((a, b) => b[1].length - a[1].length);
  const pluginTotal = plugins.reduce((n, [, v]) => n + v.length, 0);
  say(`${c.bold}not seen, came with a plugin${c.off}  ${c.dim}${pluginTotal} skills across ${plugins.length} plugins, removed by uninstalling the plugin${c.off}`);
  for (const [plugin, list] of plugins) {
    say("  " + String(list.length).padStart(3) + "  " + plugin + c.dim + "  " + list.slice(0, 4).join(", ") + (list.length > 4 ? ` +${list.length - 4}` : "") + c.off);
  }
  say();
}

if (unknown.size) {
  say(`${c.yellow}called but not found on disk${c.off}  ${c.dim}bundled with the CLI itself, or installed once and removed since${c.off}`);
  for (const [name, n] of [...unknown].sort((a, b) => b[1] - a[1])) {
    say("  " + String(n).padStart(3) + "  " + name);
  }
  say();
}

console.log(lines.join("\n"));

if (MD_OUT) {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const body = [
    "# Skill usage",
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run skills\` from ${files} session transcripts.`,
    "",
    "```",
    ...lines.map(strip),
    "```",
    "",
  ].join("\n");
  writeFileSync(resolve(MD_OUT), body, "utf8");
  console.log(`${c.dim}written to ${resolve(MD_OUT)}${c.off}`);
}
