#!/usr/bin/env node
/**
 * db.mjs — run SQL against the org's Supabase project.
 *
 * Uses the Management API with SUPABASE_ACCESS_TOKEN, so no Postgres connection
 * string or database password is needed.
 *
 *   node bin/db.mjs apply supabase/migrations/0001_brain.sql
 *   node bin/db.mjs apply <file> --dry     print the split, send nothing
 *   node bin/db.mjs query "select count(*) from chunks"
 *   node bin/db.mjs tables
 *
 * Statements are sent one per request. Sending a whole migration as a single
 * payload made the endpoint hang rather than fail, and one-per-request also means
 * a failure names the statement that broke instead of the file. Migrations here
 * use `if not exists`, so re-running after a partial failure is safe.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  console.error("no .env at the org root, or it could not be parsed");
  process.exit(1);
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN || !REF) {
  console.error("SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF must both be set in .env");
  process.exit(1);
}

const TIMEOUT_MS = 60_000;

async function run(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" ? (body.message ?? JSON.stringify(body)) : body;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

/**
 * Split a script into statements on semicolons, while respecting single-quoted
 * strings, line comments, block comments and dollar-quoted bodies. The last one
 * matters from Phase 2 on, where the search functions are written as $$ ... $$.
 */
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, end); i = end; continue;
    }
    if (rest.startsWith("/*")) {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      buf += sql.slice(i, end); i = end; continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      buf += sql.slice(i, j); i = j; continue;
    }
    const dollar = rest.match(/^\$([A-Za-z_]\w*)?\$/);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      buf += sql.slice(i, end); i = end; continue;
    }
    if (sql[i] === ";") { out.push(buf); buf = ""; i++; continue; }
    buf += sql[i]; i++;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s && !isBlank(s));
}

/**
 * True when a fragment is only comments and whitespace.
 *
 * Done with two linear passes rather than one combined pattern. The obvious
 * one-liner, /^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/, backtracks catastrophically
 * on any input that fails to match, because every alternative can consume
 * whitespace. It hung on this very migration.
 */
function isBlank(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim() === "";
}

/** First meaningful line, for progress output. */
function label(stmt) {
  const line = stmt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("--")) ?? stmt.slice(0, 60);
  return line.length > 68 ? line.slice(0, 65) + "..." : line;
}

const args = process.argv.slice(2);
const cmd = args[0];
const arg = args[1];
const DRY = args.includes("--dry");

if (cmd === "apply") {
  if (!arg) { console.error("usage: node bin/db.mjs apply <file.sql> [--dry]"); process.exit(1); }
  const statements = splitStatements(readFileSync(resolve(ROOT, arg), "utf8"));
  console.log(`${arg}  ${statements.length} statements${DRY ? "  (dry run)" : ""}\n`);
  let n = 0;
  for (const stmt of statements) {
    n++;
    const tag = `${String(n).padStart(2)}/${statements.length}  ${label(stmt)}`;
    if (DRY) { console.log(`   ${tag}`); continue; }
    try {
      await run(stmt);
      console.log(` ok ${tag}`);
    } catch (e) {
      console.error(`FAIL ${tag}\n     ${e.message}`);
      process.exit(1);
    }
  }
  if (!DRY) {
    // PostgREST serves RPC from a cached copy of the schema, so a function
    // created here is a 404 through the REST API until that cache reloads on
    // its own. Migration 0007 was applied cleanly and then was not callable,
    // which reads as a bug in the function rather than a stale cache. One
    // NOTIFY closes the gap, and it is harmless when nothing was added.
    try {
      await run("notify pgrst, 'reload schema'");
      console.log("\napplied · PostgREST schema reloaded");
    } catch (e) {
      console.log("\napplied");
      console.error(`could not reload the PostgREST cache: ${e.message.slice(0, 120)}`);
      console.error("a new function may 404 over REST for a minute or so");
    }
  }
} else if (cmd === "query") {
  if (!arg) { console.error('usage: node bin/db.mjs query "<sql>"'); process.exit(1); }
  console.log(JSON.stringify(await run(arg), null, 2));
} else if (cmd === "tables") {
  const rows = await run(`
    select c.relname as table,
           (select count(*) from pg_index i where i.indrelid = c.oid) as indexes,
           c.relrowsecurity as rls,
           coalesce(s.n_live_tup, 0) as rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`);
  console.table(rows);
} else {
  console.error('commands: apply <file.sql> [--dry] | query "<sql>" | tables');
  process.exit(1);
}
