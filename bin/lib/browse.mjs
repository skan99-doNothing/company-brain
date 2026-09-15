/**
 * Walking the disk from the dashboard, and handing a file to Windows.
 *
 * The sidebar in the Agents panel is a file tree, so it needs to list a folder,
 * read a small text file, and get out of the way when he wants the real thing:
 * open it in whatever program owns it, or show it sitting in Explorer.
 *
 * Everything here is read-only apart from `open`, which hands the path to the
 * shell and does not care what happens next. Nothing writes, renames or
 * deletes, which is deliberate: the vaults are his real folders and a browser
 * tab is the wrong place to be able to destroy one by misclicking.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname, resolve, extname, basename, sep } from "node:path";

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const WIN = process.platform === "win32";

/*
 * A path is browsable if it sits under his home folder.
 *
 * That is wide on purpose: the repo, the vaults, the desktop and every cloned
 * project are all under it, and a narrower rule would keep the sidebar from
 * opening the folder the agent just named. It is still a boundary, and it
 * still stops a crafted path from walking into Windows itself.
 */
function within(root, p) {
  const a = resolve(root) + sep;
  const b = resolve(p);
  return b === resolve(root) || b.startsWith(a);
}

export function allowed(p) {
  if (!p) return false;
  try {
    return within(HOME, p);
  } catch {
    return false;
  }
}

/* The noise that makes a tree unreadable. Hidden dotfiles stay visible: he has
   .claude and .env in places that matter. */
const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "dist", ".next"]);

const TEXT = new Set([
  ".md", ".txt", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".yml", ".yaml",
  ".css", ".html", ".py", ".sh", ".ps1", ".sql", ".toml", ".ini", ".env", ".csv", ".log",
]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

export function kindOf(name, isDir) {
  if (isDir) return "dir";
  const ext = extname(name).toLowerCase();
  if (IMAGE.has(ext)) return "image";
  if (TEXT.has(ext)) return "text";
  return "file";
}

/**
 * One folder, folders first then files, both alphabetical.
 *
 * Not recursive. The sidebar expands one level at a time, which keeps a click
 * on a folder with forty thousand descendants from being a mistake you cannot
 * take back.
 */
export async function listDir(path) {
  if (!allowed(path)) throw new Error("that path is outside your home folder");
  const names = await readdir(path, { withFileTypes: true });
  const out = [];
  for (const d of names) {
    if (SKIP.has(d.name)) continue;
    const full = join(path, d.name);
    let size = 0;
    let modified = null;
    try {
      const s = await stat(full);
      size = s.size;
      modified = s.mtime.toISOString();
    } catch {
      continue;   // a junction to somewhere that is gone, or a locked file
    }
    out.push({
      name: d.name,
      path: full,
      dir: d.isDirectory(),
      kind: kindOf(d.name, d.isDirectory()),
      size,
      modified,
    });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = dirname(path);
  return {
    path,
    name: basename(path) || path,
    parent: parent !== path && allowed(parent) ? parent : null,
    entries: out,
  };
}

/** The first slice of a text file, for the preview pane. */
export async function peek(path, max = 80_000) {
  if (!allowed(path)) throw new Error("that path is outside your home folder");
  const s = await stat(path);
  if (s.isDirectory()) throw new Error("that is a folder");
  const kind = kindOf(path, false);
  if (kind !== "text") return { path, kind, size: s.size, text: null };
  const buf = await readFile(path);
  return {
    path,
    kind,
    size: s.size,
    truncated: buf.length > max,
    text: buf.subarray(0, max).toString("utf8"),
  };
}

/**
 * Hand it to Windows.
 *
 * `reveal` opens Explorer with the file already selected, which is the answer
 * to "where is it". `open` hands it to whatever program owns the extension.
 *
 * Explorer is spawned rather than `cmd /c start` because start is a shell
 * builtin and would mean a shell, and `/select,` has to arrive as one
 * unquoted argument or Explorer opens the user's Documents folder instead.
 * Explorer also exits non-zero on success, so the exit code is ignored.
 */
export function reveal(path, { select = true } = {}) {
  if (!allowed(path)) throw new Error("that path is outside your home folder");
  if (!WIN) throw new Error("this only knows how to do it on Windows");
  const args = select ? [`/select,${path}`] : [path];
  const p = spawn("explorer.exe", args, {
    windowsVerbatimArguments: true,
    windowsHide: false,
    detached: true,
    stdio: "ignore",
  });
  p.unref();
  return { path, folder: select ? dirname(path) : path };
}
