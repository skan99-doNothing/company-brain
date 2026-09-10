/**
 * Walks the declared paths and yields the prose worth indexing.
 *
 * The index and ripgrep no longer share a scope, and that separation is the
 * whole point of this file.
 *
 * `.ignore` is a search-speed decision: it keeps an interactive `rg` out of
 * 2,574 chat logs that would drown every other result. Applying it to the
 * index too was a category error. The index is built once and queried by
 * meaning, so cold storage costs disk and a one-off embed, not query time, and
 * excluding it meant the brain could not recall a single one of the 1,673
 * ChatGPT and Claude conversations sitting on this disk since 2022. The whole
 * claim of the system is that it remembers; it was refusing to read the
 * largest record of what actually happened.
 *
 * So: directory names that are always machinery (node_modules, .git) are still
 * skipped, because those are not anyone's writing. Everything else the index
 * withholds now has to be named in org.config.json's `index.exclude`, where a
 * person can see it. `.ignore` keeps meaning what it meant, for ripgrep.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { ROOT, norm } from "./config.mjs";

/**
 * The directories that are machinery, plus whatever org.config.json withholds.
 *
 * `.ignore` still contributes its bare directory names, because `node_modules`
 * and `.venv` are noise for any reader. Its path prefixes are deliberately not
 * read: those are ripgrep's scope, and the index has its own, which lives in
 * `index.exclude` where it can be seen and argued with.
 */
export function loadIgnore(extraPrefixes = []) {
  let text = "";
  try { text = readFileSync(resolve(ROOT, ".ignore"), "utf8"); } catch { /* none is fine */ }

  const dirNames = new Set();
  const pathPrefixes = [];

  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const clean = line.replace(/\/+$/, "");
    if (clean.startsWith("*") || clean.includes("*")) continue;   // extension globs: no prose hits
    if (clean.includes("/")) continue;                            // ripgrep's scope, not the index's
    dirNames.add(clean.toLowerCase());
  }

  // Never useful, never listed, always present.
  //
  // .claude is here because those trees are vendored plugin and skill
  // definitions written by other people, not notes. One copy of the superpowers
  // plugin inside the content vault contributed 118 documents to the index and
  // took the top result on a real question about a client. The org's own
  // .claude lives above vaults/ and is never walked, and the deliberately
  // vendored skills the Labs brief cares about are under .agents, not .claude.
  for (const d of [".git", "node_modules", ".obsidian", "__pycache__", ".venv", "venv", ".claude"]) {
    dirNames.add(d);
  }
  for (const p of extraPrefixes) pathPrefixes.push(norm(resolve(ROOT, p)));

  return { dirNames, pathPrefixes };
}

/**
 * What counts as prose.
 *
 * .txt earns its place on the evidence: 553 of them in the context vault, and
 * the ChatGPT and Claude exports are markdown beside plain text from the same
 * runs. Excluding the extension excluded half of some conversations.
 */
const PROSE = /\.(md|markdown|txt)$/i;

function isIgnored(absPath, ignore) {
  const p = norm(absPath);
  return ignore.pathPrefixes.some((pre) => p === pre || p.startsWith(pre + "/"));
}

/**
 * Under vaults/code, take the prose and leave the source.
 *
 * This used to mean top-level markdown, a docs/ folder, and README or CLAUDE
 * anywhere: 123 documents out of 752 markdown files across 44 repositories.
 * The rest is not source, it is notes, specs, plans and deploy write-ups
 * written in markdown and filed one directory deeper than the rule reached.
 * Machinery directories are already gone by the time this runs, so every
 * markdown file that survives to here is something a person wrote.
 */
function codeDocsOnly(absPath, codeRoot) {
  const rel = norm(absPath).slice(codeRoot.length + 1);
  const parts = rel.split("/");
  // A file loose at the vault root is not in a repository at all.
  if (parts.length < 2) return false;
  // Changelogs generated per dependency, and licence text, are not writing.
  const base = parts[parts.length - 1].toLowerCase();
  return !/^(license|licence|changelog|code_of_conduct|contributing)\.(md|markdown)$/.test(base);
}

/** Recursively collect .md files under one root. */
function walkDir(dir, ignore, out, opts) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const e of entries) {
    const full = join(dir, e.name);
    // vaults/loose holds junctions, which readdir reports as symlinks and not
    // as directories, so testing isDirectory alone walked past every one.
    if (e.isDirectory() || e.isSymbolicLink()) {
      if (ignore.dirNames.has(e.name.toLowerCase())) continue;
      if (isIgnored(full, ignore)) continue;
      let real;
      try { real = statSync(full); } catch { continue; }
      if (!real.isDirectory()) continue;
      walkDir(full, ignore, out, opts);
      continue;
    }
    if (!e.isFile()) continue;
    if (!PROSE.test(e.name)) continue;
    if (isIgnored(full, ignore)) continue;
    if (opts.codeRoot && norm(full).startsWith(opts.codeRoot + "/") && !codeDocsOnly(full, opts.codeRoot)) continue;
    out.push(full);
  }
}

/**
 * Collect every markdown file under the given roots, deduplicated. Roots overlap
 * on purpose (Memory claims vaults/context, Capital claims a folder inside it),
 * so the same file is reached more than once and must only be indexed once.
 */
export function collectFiles(roots, ignore) {
  const codeRoot = norm(resolve(ROOT, "vaults/code"));
  const seen = new Set();
  const files = [];

  for (const root of roots) {
    const abs = resolve(ROOT, root);
    let st;
    try { st = statSync(abs); } catch { continue; }      // a path a brief claims that is gone

    const found = [];
    if (st.isDirectory()) walkDir(abs, ignore, found, { codeRoot });
    else if (PROSE.test(abs)) found.push(abs);

    for (const f of found) {
      const key = norm(f);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(f);
    }
  }
  return files;
}

/** Paths declared in the config that no longer exist. Doctor and the log want these. */
export function missingRoots(roots) {
  return roots.filter((r) => {
    try { statSync(resolve(ROOT, r)); return false; } catch { return true; }
  });
}

export { basename };
