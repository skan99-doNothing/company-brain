/**
 * Loads org.config.json and answers the question the indexer keeps asking:
 * given a file path, which department owns it and which vault is it in?
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Normalise to forward slashes and lowercase, so prefix tests are stable on Windows. */
export function norm(p) {
  return p.split(sep).join("/").replace(/\/+$/, "").toLowerCase();
}

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "org.config.json"), "utf8"));

  // Longest path first, so a nested claim beats the broad one. Memory owns
  // vaults/context; Capital owns vaults/context/Projects/Trading. Capital wins
  // inside its own subtree.
  const claims = [];
  for (const d of cfg.departments ?? []) {
    for (const p of d.paths ?? []) {
      claims.push({ department: d.id, rel: norm(p), abs: norm(resolve(ROOT, p)) });
    }
  }
  claims.sort((a, b) => b.abs.length - a.abs.length);

  return { cfg, claims };
}

/**
 * Which department owns this absolute path. Null when nothing claims it, which
 * is normal: plenty of the vault belongs to no department yet.
 */
export function departmentFor(absPath, claims) {
  const p = norm(absPath);
  for (const c of claims) {
    if (p === c.abs || p.startsWith(c.abs + "/")) return c.department;
  }
  return null;
}

/**
 * Which vault a path sits in: context, content, code, org, or a loose folder
 * named after its junction. Used to keep namespaces separate at query time.
 */
export function vaultFor(absPath) {
  const p = norm(absPath);
  const root = norm(ROOT);
  if (!p.startsWith(root + "/")) return "external";
  const rel = p.slice(root.length + 1);
  if (!rel.startsWith("vaults/")) return "org";
  const parts = rel.split("/");
  if (parts[1] === "loose") return "loose/" + (parts[2] ?? "");
  return parts[1] ?? "org";
}

/** Coarse type, used for filtering and for deciding how a hit is presented. */
export function docTypeFor(absPath) {
  const p = norm(absPath);
  const root = norm(ROOT);
  const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
  const base = rel.split("/").pop() ?? "";

  if (rel.startsWith("state/")) return "ledger";
  if (rel.startsWith("departments/")) return "brief";
  if (base === "decisions.md") return "decision";
  if (base === "readme.md") return "readme";
  if (base === "claude.md") return "readme";
  if (rel.includes("/chats/")) return "session";
  return "note";
}
