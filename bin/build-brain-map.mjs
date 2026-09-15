#!/usr/bin/env node
/**
 * build-brain-map.mjs — render the org as one page you can open on its own.
 *
 *   npm run map                 write atlas/brain-map.html
 *   npm run map -- --out DIR    also drop a body-only copy for publishing
 *   npm run map -- --offline    skip the database, leave the index counts blank
 *
 * Three sources, none of them retyped:
 *
 *   org.config.json   departments, clusters, units and their state
 *   state/*.md        the ledgers, so the page can show what is in flight
 *   the index         document, passage and session counts per department
 *
 * The page is static once written, which is the point: it opens with no server
 * and no keys. Re-run this after a ledger changes or the index is rebuilt.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "brain-map.html");
const OUT = join(ROOT, "atlas", "brain-map.html");

const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const OUT_DIR = (() => { const i = argv.indexOf("--out"); return i === -1 ? null : argv[i + 1]; })();

const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };

/**
 * Last measured by `npm run eval`. It is a number about the search stack, not
 * about the corpus, so no query can regenerate it. Update it here, with the
 * date, when the eval is run again.
 */
const RECALL = { value: 81, measured: "2026-09-04" };

/* -------------------------------------------------------- ledger parsing -- */

/** Split a ledger into its `## ` sections, dropping the frontmatter. */
function sections(md) {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const out = {};
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

/**
 * Ledger entries are markdown bullets that wrap over several indented lines,
 * so a naive split on newline turns one entry into five. A blank line or a new
 * `- ` ends the current entry; anything else is a continuation.
 */
function bullets(text) {
  if (!text) return [];
  const items = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^- /.test(line)) {
      if (cur !== null) items.push(cur);
      cur = line.slice(2).trim();
    } else if (cur !== null && line.trim()) {
      cur += " " + line.trim();
    } else if (cur !== null) {
      items.push(cur);
      cur = null;
    }
  }
  if (cur !== null) items.push(cur);
  return items.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * A freshly created ledger says "Nothing logged yet." rather than being empty,
 * sometimes with an instruction after it. That is a real sentence in the file
 * but it is not work in flight, so it is separated out instead of counted, and
 * kept so the page can still show what the file says.
 */
const PLACEHOLDER = /^(nothing|none)\b/i;
const realItems = (text) => bullets(text).filter((s) => !PLACEHOLDER.test(s));
const placeholder = (text) => bullets(text).find((s) => PLACEHOLDER.test(s)) || "";

/** Log lines carry their own date: `- 2026-09-04 · text`. */
function logEntries(text) {
  return bullets(text).map((s) => {
    const m = s.match(/^(\d{4}-\d{2}-\d{2})\s*[·–—-]*\s*(.*)$/);
    return m ? { date: m[1], text: m[2] } : { date: "", text: s };
  });
}

function readLedger(path) {
  if (!existsSync(path)) return null;
  const md = readFileSync(path, "utf8");
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const updated = fm ? (fm[1].match(/^updated:\s*(.+)$/m) || [])[1] : "";
  const s = sections(md);
  return {
    updated: (updated || "").trim(),
    scoreboard: (s["Scoreboard"] || "").replace(/\s*\n\s*/g, " ").trim(),
    inFlight: realItems(s["In flight"]),
    inFlightNote: placeholder(s["In flight"]),
    contextBank: realItems(s["Context bank"]),
    friction: realItems(s["Friction"]),
    crossRefs: realItems(s["Cross-references"]),
      log: logEntries(s["Log"]).filter((e) => !PLACEHOLDER.test(e.text)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  };
}

/* --------------------------------------------------------------- agents -- */

/**
 * The agents are real files with YAML frontmatter, and eight of the ten are
 * generated from the same config as the map, so their names line up with
 * department ids without any matching heuristic. The two that do not
 * (`librarian`, `dept-analyst`) work across the whole org and are reported as
 * shared rather than dropped.
 */
function readAgents(dir) {
  if (!existsSync(dir)) return [];
  const deptIds = new Set(JSON.parse(readFileSync(join(ROOT, "org.config.json"), "utf8")).departments.map((d) => d.id));
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const field = (k) => (fm[1].match(new RegExp("^" + k + ":\\s*(.+)$", "m")) || [])[1] || "";
    const name = field("name").trim() || file.replace(/\.md$/, "");
    const tools = field("tools").split(",").map((s) => s.trim()).filter(Boolean);
    // Each department agent opens with a numbered "Start every task this way"
    // list. That list is the agent's standing operating procedure, it is already
    // written, and it is the only part of the body worth putting on a card.
    //
    // Scanned line by line rather than matched with one regex. The obvious
    // pattern ends with `(?=...|$)` under the /m flag, where `$` matches the end
    // of every line, so the lazy body captures nothing and every agent silently
    // reports zero steps. Same shape as the ledger bullet reader above: a new
    // number starts an item, an indented line continues it, a blank line ends it.
    const body = text.slice(fm[0].length);
    const sop = [];
    let step = null;
    for (const raw of body.split("\n")) {
      const numbered = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (numbered) {
        if (step !== null) sop.push(step);
        step = numbered[1].trim();
      } else if (step !== null && raw.trim() && /^\s/.test(raw)) {
        step += " " + raw.trim();
      } else if (step !== null) {
        sop.push(step);
        step = null;
        if (sop.length) break; // first list only; later sections are not the SOP
      }
    }
    if (step !== null) sop.push(step);

    out.push({
      name,
      description: field("description").trim(),
      model: field("model").trim(),
      sop,
      tools,
      brainTools: tools.filter((t) => t.startsWith("mcp__brain__")).map((t) => t.replace("mcp__brain__", "")),
      plainTools: tools.filter((t) => !t.startsWith("mcp__")),
      department: deptIds.has(name) ? name : null,
      path: ".claude/agents/" + file,
    });
  }
  return out.sort((a, b) => (a.department ? 0 : 1) - (b.department ? 0 : 1) || a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------- link health -- */

/**
 * "196 broken links" was one number covering three unrelated situations, which
 * made it useless: you could not tell which of them you were supposed to do
 * anything about. Splitting them needs one thing the database does not have,
 * which is what is on disk, so this walks the vaults once and asks of every
 * unresolved link: is there a file with that name anywhere?
 *
 *   cold     yes, but in a folder the index skips on purpose (Chats, Archive).
 *            The link works in Obsidian. Nothing to fix.
 *   missing  no. The note was linked and never written. Only you can fix that,
 *            and the schema keeps these deliberately: a link to a note that
 *            does not exist is a statement of intent worth searching for.
 *
 * A third case, a link pointing at a document that IS indexed, would be a bug
 * in the resolver rather than anything about the corpus. It should always be
 * zero; if it is not, say so loudly rather than folding it into the other two.
 */
function markdownOnDisk(root) {
  const byName = new Map();
  const seen = new Set();
  (function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        // vaults/ is a folder of junctions, so a cycle is one bad link away.
        if (seen.has(p)) continue;
        seen.add(p);
        walk(p, depth + 1);
      } else if (/\.md$/i.test(e.name)) {
        const key = e.name.replace(/\.md$/i, "").toLowerCase();
        const rel = p.split("\\").join("/").replace(root.split("\\").join("/") + "/", "");
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(rel);
      }
    }
  })(join(root, "vaults"), 0);
  return byName;
}

async function linkHealth(db, indexedPaths) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const part = await db.rest(`/links?dst_id=is.null&select=link_text&order=id&limit=1000&offset=${offset}`);
    rows.push(...part);
    if (part.length < 1000) break;
  }
  const disk = markdownOnDisk(ROOT);
  const indexed = new Set([...indexedPaths].map((p) => p.toLowerCase()));

  const out = { unresolved: rows.length, cold: 0, missing: 0, orphaned: 0, wanted: [] };
  const tally = new Map();
  for (const r of rows) {
    const name = String(r.link_text).replace(/\.md$/i, "").split("/").pop().toLowerCase();
    const hits = disk.get(name) || [];
    if (!hits.length) {
      out.missing++;
      // The extractor picks up a few things that were never note names: a bare
      // ellipsis inside a truncated quote, a quoted column header from a code
      // block. They count as unresolved, because they are, but they do not
      // belong on a list of notes worth writing.
      const label = String(r.link_text).split("/").pop();
      if (/[a-z]/i.test(label) && !/^["'“]/.test(label)) {
        tally.set(label, (tally.get(label) || 0) + 1);
      }
    } else if (hits.some((p) => indexed.has(p.toLowerCase()))) {
      out.orphaned++;
    } else {
      out.cold++;
    }
  }
  out.wanted = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, n]) => ({ name, n }));
  return out;
}

/* ------------------------------------------------------------------ main -- */

const cfg = JSON.parse(readFileSync(join(ROOT, "org.config.json"), "utf8"));
const agents = readAgents(join(ROOT, ".claude", "agents"));

const ledgers = {};
const missingLedgers = [];
for (const d of cfg.departments) {
  const led = readLedger(join(ROOT, d.ledger));
  if (led) ledgers[d.id] = led;
  else missingLedgers.push(d.ledger);
}

let index = {};
let docs = [];
let entities = [];
let ementions = [];
let brain = null;
let links = null;
let related = null;
let stats = { documents: 0, passages: 0, sessions: 0, recall: RECALL.value, recallMeasured: RECALL.measured };

if (!OFFLINE) {
  try {
    process.loadEnvFile(join(ROOT, ".env"));
    const { store } = await import("./lib/store.mjs");
    const db = store();

    const rows = await db.rest("/rpc/department_stats", { method: "POST", body: {} });
    for (const r of rows) {
      index[r.department] = {
        documents: r.documents,
        passages: r.passages,
        sessions: r.sessions,
        newest: r.newest,
      };
      stats.documents += r.documents;
      stats.passages += r.passages;
      stats.sessions += r.sessions;
    }

    brain = await db.rest("/rpc/brain_stats", { method: "POST", body: {} });

    // Which documents are about the same thing, from the embeddings rather
    // than from anyone having typed a link. Built by npm run relate; if that
    // has never run the table is empty and the section stays off the page.
    try {
      related = await db.rest("/rpc/related_stats", { method: "POST", body: {} });
      if (!related || !related.edges) related = null;
    } catch {
      related = null;
    }

    // Every document's title and path, so the page can answer "where is X"
    // with no key and no network. Passages are deliberately left out: they are
    // 9,500 rows of full text and would make the file unopenable. Searching by
    // meaning needs the embedder, which is what `npm run map:serve` is for.
    // PostgREST caps a response at its own max-rows regardless of the limit
    // asked for, so this paged silently at 1,000 the first time the corpus
    // grew past it and 116 documents vanished from the offline search with no
    // error anywhere. Page it.
    const rowsDoc = [];
    for (let offset = 0; ; offset += 1000) {
      const part = await db.rest(
        "/documents?select=id,source_path,title,department,doc_type,mtime" +
        "&order=mtime.desc&limit=1000&offset=" + offset
      );
      rowsDoc.push(...part);
      if (part.length < 1000) break;
    }
    const prefix = ROOT.split("\\").join("/") + "/";
    links = await linkHealth(db, rowsDoc.map((r) => String(r.source_path).split("\\").join("/").replace(ROOT.split("\\").join("/") + "/", "")));

    docs = rowsDoc.map((r) => [
      String(r.source_path).split("\\").join("/").replace(prefix, ""),
      r.title || "",
      r.department || "",
      r.doc_type || "",
      (r.mtime || "").slice(0, 10),
    ]);

    // The entity layer, baked flat so the page can draw it with no key and no
    // network. Two arrays rather than nested objects: each name once, and the
    // mentions as index pairs into `entities` and `docs`. 1,396 mentions cost
    // about 12 KB that way and several times that as repeated names and paths.
    //
    // Built by npm run entities. If that has never run both arrays stay empty
    // and the tab does not appear.
    try {
      const ents = await db.rest("/entities?select=id,name,kind,note&order=name");
      const mentions = [];
      for (let offset = 0; ; offset += 1000) {
        const part = await db.rest(
          "/entity_mentions?select=entity_id,document_id,hits&limit=1000&offset=" + offset
        );
        mentions.push(...part);
        if (part.length < 1000) break;
      }

      const docIndexById = new Map(rowsDoc.map((r, i) => [r.id, i]));
      const hitsByEntity = new Map();
      for (const m of mentions) {
        const di = docIndexById.get(m.document_id);
        if (di === undefined) continue;            // excluded from the index since
        if (!hitsByEntity.has(m.entity_id)) hitsByEntity.set(m.entity_id, []);
        hitsByEntity.get(m.entity_id).push([di, m.hits || 1]);
      }

      // An entity nothing mentions is a name in the config rather than a thing
      // the corpus knows about, and it would sit on the graph as a dot with no
      // edges. Widest reach first, so the interesting ones are laid out first.
      const kept = [];
      for (const e of ents) {
        const hits = hitsByEntity.get(e.id);
        if (!hits || !hits.length) continue;
        const depts = new Set();
        for (const [di] of hits) if (docs[di][2]) depts.add(docs[di][2]);
        hits.sort((a, b) => b[1] - a[1]);
        // The note on a repository starts with its commit count, which is the
        // only measure of scale here that needs no judgement. Pulled out as a
        // number so the graph can size a node by it.
        const m = /^([\d,]+) commits?/.exec(e.note || "");
        kept.push({
          name: e.name,
          kind: e.kind || "topic",
          note: e.note || "",
          documents: hits.length,
          depts: [...depts].sort(),
          commits: m ? Number(m[1].replace(/,/g, "")) : 0,
          hits,
        });
      }
      kept.sort((a, b) => b.depts.length - a.depts.length || b.documents - a.documents);

      entities = kept.map(({ hits, ...rest }) => rest);
      ementions = [];
      kept.forEach((e, ei) => { for (const [di, n] of e.hits) ementions.push([ei, di, n]); });
    } catch (err) {
      console.error(`${c.yellow}entity layer unreachable${c.off}: ${String(err.message).slice(0, 100)}`);
      entities = [];
      ementions = [];
    }
  } catch (err) {
    console.error(`${c.yellow}index unreachable${c.off}: ${String(err.message).slice(0, 140)}`);
    console.error(`${c.dim}writing the page without index counts. Re-run when it is back.${c.off}`);
    index = {};
    docs = [];
    entities = [];
    ementions = [];
    brain = null;
    links = null;
    related = null;
  }
}

const ORG = {
  generated: new Date().toISOString().slice(0, 10),
  root: ROOT.split("\\").join("/"),
  stats,
  brain,
  links,
  related,
  index,
  docs,
  entities,
  ementions,
  agents,
  ledgers,
  // The two lists that decide what the index contains and who owns each part
  // of it. Both are config, not derived, and both are the honest answer to
  // "can I change what is in the memory": you change these, then re-index.
  excluded: (cfg.index && cfg.index.exclude) || [],
  departments: cfg.departments.map((d) => ({
    id: d.id,
    name: d.name,
    sub: d.sub,
    color: d.color,
    mission: d.mission,
    home: d.home,
    ledger: d.ledger,
    paths: d.paths || [],
    clusters: d.clusters.map((cl) => ({
      name: cl.name,
      items: cl.items.map((it) => ({ label: it.label, type: it.type, desc: it.desc, where: it.where })),
    })),
  })),
};

const body = readFileSync(TEMPLATE, "utf8");
if (!body.includes("__ORG_DATA__")) {
  console.error("templates/brain-map.html has no __ORG_DATA__ placeholder");
  process.exit(1);
}
// Two hazards, both from ledger prose ending up inside a <script> tag.
//
// A "</script>" anywhere in a ledger would close the block early and blank the
// page, so every "<" is escaped. That is still valid JSON.
//
// The replacement must be a function, not a string. String.replace reads "$&",
// "$`" and "$'" in the replacement as backreferences, and a Labs entry quotes
// the regex `^( line-comment | block-comment | whitespace )*$` followed by a
// backtick. That "$`" spliced the whole template prefix into the middle of the
// data and truncated the JSON. A replacer function disables the substitution.
const json = JSON.stringify(ORG).replace(/</g, "\\u003c");
const filled = body.replace("__ORG_DATA__", () => json);

// Standalone: the same page plus the document skeleton the artifact host adds
// for you, so double-clicking the file in Explorer works.
const standalone =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  "<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n" +
  "</head>\n<body>\n" + filled + "\n</body>\n</html>\n";

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, standalone, "utf8");

if (OUT_DIR) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "org-brain.html"), filled, "utf8");
}

/* --------------------------------------------------------------- report -- */

const units = ORG.departments.flatMap((d) => d.clusters.flatMap((cl) => cl.items));
const inFlight = Object.values(ledgers).reduce((s, l) => s + l.inFlight.length, 0);
const logs = Object.values(ledgers).reduce((s, l) => s + l.log.length, 0);

if (entities.length) {
  const spanning = entities.filter((e) => e.depts.length > 1).length;
  console.log(`entities: ${entities.length} named things, ${ementions.length.toLocaleString()} mentions, ${spanning} spanning two or more departments`);
}
console.log(`${c.green}wrote${c.off} ${OUT.replace(ROOT + "\\", "").replace(ROOT + "/", "")}  ${(standalone.length / 1024).toFixed(0)} KB`);
if (OUT_DIR) console.log(`${c.dim}      body-only copy in ${OUT_DIR}${c.off}`);
console.log(
  `${ORG.departments.length} departments · ` +
  `${ORG.departments.reduce((s, d) => s + d.clusters.length, 0)} clusters · ` +
  `${units.length} units (${units.filter((u) => u.type === "core").length} in use, ` +
  `${units.filter((u) => u.type === "tool").length} connectors, ` +
  `${units.filter((u) => u.type === "gap").length} not built)`
);
console.log(`${Object.keys(ledgers).length} ledgers read · ${inFlight} items in flight · ${logs} log entries`);
console.log(
  `${agents.length} agents (${agents.filter((a) => a.department).length} department, ` +
  `${agents.filter((a) => !a.department).length} shared)`
);
if (Object.keys(index).length) {
  console.log(`index: ${stats.documents} documents · ${stats.passages} passages · ${stats.sessions} sessions`);
  console.log(`${docs.length} document titles baked in for offline search`);
  if (brain) {
    console.log(
      `link graph: ${brain.wikilinks} wikilinks, ${brain.resolved} resolved · ` +
      `${brain.folders} folders across ${brain.vaults} vaults`
    );
  }
  if (related) {
    console.log(
      `related: ${related.edges.toLocaleString()} edges, ` +
      `${related.crossing.toLocaleString()} crossing a department`
    );
  }
  if (links) {
    console.log(
      `unresolved: ${links.cold} point at cold storage, ${links.missing} at notes never written` +
      (links.orphaned ? `, ${c.yellow}${links.orphaned} orphaned by the resolver${c.off}` : "")
    );
  }
} else {
  console.log(`${c.yellow}index counts omitted${c.off}`);
}
if (missingLedgers.length) console.log(`${c.yellow}no ledger file${c.off}: ${missingLedgers.join(", ")}`);
