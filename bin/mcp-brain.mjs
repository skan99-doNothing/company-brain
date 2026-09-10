#!/usr/bin/env node
/**
 * mcp-brain.mjs — the org's memory, exposed to every session as MCP tools.
 *
 * Registered in .mcp.json, so any session opened at the org root and any
 * department subagent gets these without shelling out to a script and without
 * anyone remembering to. That is the whole reason this is a server rather than
 * a skill: retrieval that depends on being remembered is retrieval that does not
 * happen, which is the same failure that left eight ledgers empty for 18 days.
 *
 * JSON-RPC 2.0 over stdio, hand-rolled. The protocol is small enough that a
 * dependency would cost more than it saves, and this repo has none anywhere else.
 *
 * The model never writes SQL. It calls a tool with a question, and the ranking
 * lives in search_chunks in the database where it can be tuned against
 * bin/eval-search.mjs.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

import { ROOT, loadConfig } from "./lib/config.mjs";
import { brain } from "./lib/search.mjs";

try { process.loadEnvFile(resolve(ROOT, ".env")); } catch { /* reported on first call */ }

const { cfg } = loadConfig();
const departmentIds = (cfg.departments ?? []).map((d) => d.id);

let b = null;
const getBrain = () => (b ??= brain());

// stderr only: stdout is the protocol channel and anything stray there breaks it.
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// ------------------------------------------------------------------- tools --

const TOOLS = [
  {
    name: "search",
    description:
      "Search the org's notes, briefs, ledgers and decisions by meaning. Use this instead of guessing a file path or running ripgrep across the vaults. Returns ranked passages with their source file, so cite the path. Filter by department when the question clearly belongs to one.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A question or topic in natural language." },
        department: { type: "string", enum: departmentIds, description: "Restrict to one department." },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      required: ["query"],
    },
  },
  {
    name: "department_state",
    description:
      "Read a department's brief and its ledger: what it owns, where its files are, what is in flight, what friction it has hit, and its log. Read this before doing substantive work in a department.",
    inputSchema: {
      type: "object",
      properties: { department: { type: "string", enum: departmentIds } },
      required: ["department"],
    },
  },
  {
    name: "neighbours",
    description:
      "Given a note's path, list the notes it links to and the notes that link to it, using the Obsidian link graph. Use to explore around a result that is nearly right.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", description: "Full or partial path of an indexed note." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["source_path"],
    },
  },
  {
    name: "department_corpus",
    description:
      "Everything a department holds, in full, rather than the passages a search returns. " +
      "Use when the question is about a department as a whole (what do we know, what is " +
      "missing, what contradicts what) rather than about one fact. Five of the eight " +
      "departments fit whole; the three large ones come back partial and say so, and " +
      "search is the right tool for those.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", enum: departmentIds },
        budget: {
          type: "integer", minimum: 5000, maximum: 200000, default: 60000,
          description: "Rough token budget. Documents are added newest first until it is spent.",
        },
      },
      required: ["department"],
    },
  },
  {
    name: "related",
    description:
      "Given a note's path, list the documents that are about the same thing, found by " +
      "meaning rather than by a typed link. Use when a note is nearly right and you want " +
      "the rest of the material on that subject, especially in other departments. This " +
      "finds connections nobody wrote down, which neighbours cannot.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", description: "Full or partial path of an indexed note." },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      required: ["source_path"],
    },
  },
  {
    name: "crossing",
    description:
      "The strongest subject overlaps between departments that nobody linked by hand. " +
      "Use when planning, auditing a department, or asking what this org knows that it " +
      "has not connected. Optionally narrowed to one department.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", enum: departmentIds },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 15 },
      },
    },
  },
  {
    name: "entity",
    description:
      "Everywhere one named thing shows up: a person, a project, a product, a tool. " +
      "Use when the question is about a thing rather than a topic, and especially when " +
      "it may go by more than one name in different departments. With no name, lists the " +
      "things this org talks about in more than one department.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A person, project, product or tool. Omit to list all." },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 20 },
      },
    },
  },
  {
    name: "recent_sessions",
    description:
      "What recent sessions did, from Claude Code and from Codex both: what changed, " +
      "what was decided, what is still open. Use at the start of work to avoid repeating " +
      "something already done, or to pick up work started in the other agent.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", enum: departmentIds },
        source: { type: "string", enum: ["claude-code", "codex"] },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
    },
  },
  {
    name: "attention",
    description:
      "What has stopped moving and what nobody wrote down: stalled in-flight items, " +
      "departments with no recent entry, in-flight items naming things the org has since " +
      "removed, and subjects spanning three departments that no ledger connects. Read this " +
      "at the start of a planning session, or when asked what needs doing.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", enum: departmentIds },
      },
    },
  },
  {
    name: "duplicates",
    description:
      "Byte-identical documents in the index, grouped. Use when deciding where something should live, or to find material copied between vaults.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
    },
  },
];

const rel = (p) => String(p).replace(/^.*[\\/]Org[\\/]/, "").replace(/\\/g, "/");
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Arguments arrive from a model, and inputSchema is a contract the client is
 * asked to honour, not one this server can assume was enforced. Both helpers
 * below re-check on arrival.
 */

/** A department id must be one this org declares. Never build a path from raw input. */
function requireDepartment(value) {
  const id = String(value ?? "");
  if (!departmentIds.includes(id)) {
    throw new Error(`unknown department "${id}". Known: ${departmentIds.join(", ")}`);
  }
  return id;
}

/** Numbers reach PostgREST inside a query string, so coerce and clamp them. */
function clampInt(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function callTool(name, args = {}) {
  const brainApi = getBrain();

  if (name === "search") {
    const rows = await brainApi.search(args.query, {
      department: args.department == null ? null : requireDepartment(args.department),
      k: clampInt(args.limit, 8, 1, 25),
    });
    if (!rows.length) return `No matches for: ${args.query}`;
    return rows
      .map((r, i) =>
        `${i + 1}. ${r.title}  [${r.department ?? "org"} · ${r.doc_type}]\n` +
        (r.heading_path ? `   ${r.heading_path}\n` : "") +
        `   ${flat(r.content).slice(0, 600)}\n` +
        `   ${rel(r.source_path)}`
      )
      .join("\n\n");
  }

  if (name === "department_state") {
    // Validated against the declared list, never interpolated raw: an id of
    // "../../.env" would otherwise read a file outside the org and return it.
    const id = requireDepartment(args.department);
    const brief = join(ROOT, "departments", `${id}.md`);
    const ledger = join(ROOT, "state", `${id}.md`);
    const parts = [];
    for (const [label, path] of [["BRIEF", brief], ["LEDGER", ledger]]) {
      if (!existsSync(path)) { parts.push(`${label}: missing at ${rel(path)}`); continue; }
      parts.push(`===== ${label}: ${rel(path)} =====\n${readFileSync(path, "utf8")}`);
    }
    return parts.join("\n\n");
  }

  if (name === "neighbours") {
    const docs = await brainApi.documentsUnder(args.source_path, 5);
    if (!docs.length) return `No indexed document matching: ${args.source_path}`;
    const doc = docs[0];
    const rows = await brainApi.neighbours(doc.id, clampInt(args.limit, 20, 1, 50));
    if (!rows.length) return `${rel(doc.source_path)} has no links in either direction.`;
    const out = rows.map((r) =>
      `${r.direction === "inbound" ? "<-" : "->"} ${r.title}  [[${r.link_text}]]\n   ${rel(r.source_path)}`
    );
    return `Neighbours of ${rel(doc.source_path)}:\n\n${out.join("\n")}`;
  }

  if (name === "department_corpus") {
    const id = requireDepartment(args.department);
    const budget = clampInt(args.budget, 60000, 5000, 200000);
    const docs = await brainApi.departmentDocuments(id);
    if (!docs.length) return `${id} owns no indexed documents.`;

    // Four characters to the token is the usual rough conversion and it only
    // has to be close: the point of the budget is to refuse to return three
    // megabytes, not to land on an exact count.
    const perToken = 4;
    const parts = [];
    let spent = 0, included = 0, missing = 0;

    for (const d of docs) {
      if (spent >= budget) break;
      if (!existsSync(d.source_path)) { missing++; continue; }
      let text;
      try { text = readFileSync(d.source_path, "utf8"); }
      catch { missing++; continue; }

      const cost = Math.ceil(text.length / perToken);
      // A single document larger than the whole budget would otherwise be
      // skipped forever while smaller ones behind it fill the space, so the
      // first document is always allowed through whatever it costs.
      if (spent && spent + cost > budget) break;

      parts.push(`===== ${d.title ?? "(untitled)"}  [${d.doc_type}]  ${rel(d.source_path)} =====\n${text}`);
      spent += cost;
      included++;
    }

    const omitted = docs.length - included - missing;
    const head =
      `${id}: ${included} of ${docs.length} documents in full, about ${spent.toLocaleString()} tokens.` +
      (omitted > 0 ? ` ${omitted} left out for space, so this is a partial read: use search for anything not here.` : " This is everything the department owns.") +
      (missing ? ` ${missing} indexed files no longer exist on disk.` : "");

    return `${head}\n\n${parts.join("\n\n")}`;
  }

  if (name === "related") {
    const docs = await brainApi.documentsUnder(args.source_path, 5);
    if (!docs.length) return `No indexed document matching: ${args.source_path}`;
    const doc = docs[0];
    const rows = await brainApi.related(doc.id, clampInt(args.limit, 8, 1, 25));
    if (!rows.length) {
      return `${rel(doc.source_path)} has no correlated documents above the similarity floor.`;
    }
    const out = rows.map((r) =>
      `${r.similarity.toFixed(3)}  ${r.crossing ? "[crosses] " : ""}${r.title}  ` +
      `[${r.department ?? "unrouted"} · ${r.doc_type}]\n   ${rel(r.source_path)}`
    );
    return `Related to ${rel(doc.source_path)}, by meaning:\n\n${out.join("\n")}`;
  }

  if (name === "crossing") {
    const rows = await brainApi.relatedCrossing(
      clampInt(args.limit, 15, 1, 40),
      args.department == null ? null : requireDepartment(args.department)
    );
    if (!rows.length) return "No cross-department correlations. Run npm run relate.";
    const out = rows.map((r) =>
      `${r.similarity.toFixed(3)}  ${r.a_dept} · ${flat(r.a_title)}\n` +
      `         ${r.b_dept} · ${flat(r.b_title)}\n` +
      `         ${rel(r.a_path)}\n         ${rel(r.b_path)}`
    );
    return `Subjects two departments hold and nobody linked:\n\n${out.join("\n\n")}`;
  }

  if (name === "entity") {
    const k = clampInt(args.limit, 20, 1, 40);

    if (!args.name) {
      const rows = await brainApi.entityReach(2, k);
      if (!rows.length) return "No entity spans two departments. Run npm run entities.";
      return "Named things this org talks about in more than one department:\n\n" +
        rows.map((r) =>
          `${r.name}  [${r.kind}]  ${r.documents} documents across ${r.departments}: ` +
          `${(r.depts ?? []).join(", ")}` + (r.note ? `\n   ${flat(r.note)}` : "")
        ).join("\n");
    }

    const rows = await brainApi.entityDocuments(String(args.name), k);
    if (!rows.length) {
      return `Nothing indexed mentions "${args.name}". It may not be a name this org uses, ` +
        `or the entity list may need rebuilding with npm run entities.`;
    }
    const byDept = {};
    for (const r of rows) (byDept[r.department ?? "unrouted"] ??= []).push(r);
    const out = Object.entries(byDept)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([dept, list]) =>
        `${dept} (${list.length})\n` +
        list.map((r) => `   ${String(r.hits).padStart(3)}x  ${r.title}\n        ${rel(r.source_path)}`).join("\n")
      );
    return `"${args.name}" appears in ${rows.length} documents across ` +
      `${Object.keys(byDept).length} departments:\n\n${out.join("\n\n")}`;
  }

  if (name === "recent_sessions") {
    const rows = await brainApi.recentSessions(
      args.department == null ? null : requireDepartment(args.department),
      clampInt(args.limit, 10, 1, 25),
      ["claude-code", "codex"].includes(args.source) ? args.source : null
    );
    if (!rows.length) return "No sessions match that filter.";
    return rows
      .map((s) =>
        `${String(s.started_at).slice(0, 16).replace("T", " ")}  ` +
        `[${s.department ?? "-"} \u00b7 ${s.source ?? "claude-code"}]\n  ${flat(s.summary)}\n` +
        (s.open_threads?.length ? `  open: ${s.open_threads.join("; ")}\n` : "")
      )
      .join("\n");
  }

  if (name === "attention") {
    // Shelled out rather than imported: the supervisor reads git history and
    // the filesystem as well as the database, and running it as its own process
    // keeps that work out of a long-lived server that is meant to answer fast.
    let out;
    try {
      out = execFileSync(process.execPath, [join(ROOT, "bin", "supervise.mjs"), "--json"], {
        cwd: ROOT, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return `Could not run the supervisor: ${String(err.message).slice(0, 200)}`;
    }

    let findings;
    try { findings = JSON.parse(out).findings ?? []; }
    catch { return "The supervisor returned something that was not JSON."; }

    const only = args.department == null ? null : requireDepartment(args.department);
    const rows = only ? findings.filter((f) => f.department === only) : findings;
    if (!rows.length) return only
      ? `Nothing is stalled or unrecorded in ${only}.`
      : "Nothing is stalled and nothing is unrecorded.";

    const warns = rows.filter((f) => f.level === "warn");
    return `${rows.length} things want attention${warns.length ? `, ${warns.length} of them now` : ""}:\n\n` +
      rows.map((f) =>
        `[${f.level}] ${f.check}${f.department ? ` · ${f.department}` : ""}\n  ${f.headline}` +
        (f.detail ? `\n  ${flat(f.detail)}` : "")
      ).join("\n\n");
  }

  if (name === "duplicates") {
    const groups = await brainApi.duplicates(clampInt(args.limit, 20, 1, 100));
    if (!groups.length) return "No byte-identical duplicates in the index.";
    return groups
      .map((g) => `${g.copies} copies, ${g.bytes} bytes each (${g.wasted_bytes} wasted):\n` +
        g.paths.map((p) => `   ${rel(p)}`).join("\n"))
      .join("\n\n");
  }

  throw new Error(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------- protocol --

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return ok(id, {
        // Echo the client's version rather than pinning one, so a newer client
        // is not refused by a server that only speaks tools.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-brain", version: "1.0.0" },
      });

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      try {
        const text = await callTool(name, params?.arguments ?? {});
        return ok(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Report tool failure inside the result, not as a protocol error: the
        // model can read it and adjust, where a JSON-RPC error just aborts.
        return ok(id, { content: [{ type: "text", text: `${name} failed: ${e.message}` }], isError: true });
      }
    }

    case "ping":
      return ok(id, {});

    default:
      if (id === undefined) return;                  // a notification; nothing to answer
      return err(id, -32601, `method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); }
  catch { return log("mcp-brain: unparseable line ignored"); }
  try { await handle(msg); }
  catch (e) {
    log(`mcp-brain: ${e.stack ?? e.message}`);
    if (msg?.id !== undefined) err(msg.id, -32603, e.message);
  }
});

log(`mcp-brain ready, ${TOOLS.length} tools, departments: ${departmentIds.join(", ")}`);
