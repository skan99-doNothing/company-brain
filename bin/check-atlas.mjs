#!/usr/bin/env node
/**
 * Guards the atlas against the ways it silently breaks.
 *
 * Top-level await needs a module script, and the whole page is one script block, so
 * dropping the type attribute turns the map into a blank canvas with no error anyone
 * would notice in review.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const html = await readFile(join(ROOT, "atlas", "index.html"), "utf8");

const checks = [
  ['<script type="module">', "script tag is a module, so top-level await works"],
  ['grab("../org.config.json")', "reads the live config"],
  ['grab("../state/inventory.json")', "reads the generated inventory"],
  ["const FALLBACK=", "has demo data for the file:// case"],
  ["const DEPTS=cfg.departments.map", "maps config shape onto the engine"],
  ['id="sky"', "canvas is present"],
  ['id="drawer"', "profile drawer is present"],
];

let bad = 0;
for (const [needle, why] of checks) {
  if (html.includes(needle)) console.log(`ok   ${why}`);
  else { console.error(`FAIL ${why}  (missing: ${needle})`); bad++; }
}

// A stray hardcoded department array would mean the loader was bypassed.
if (/^const DEPTS=\[/m.test(html)) { console.error("FAIL atlas still has a hardcoded DEPTS array"); bad++; }
else console.log("ok   no hardcoded department data");

const open = (html.match(/<script/g) || []).length;
const close = (html.match(/<\/script>/g) || []).length;
if (open !== close) { console.error(`FAIL ${open} <script> vs ${close} </script>`); bad++; }
else console.log(`ok   script tags balanced (${open})`);

console.log(bad ? `\n${bad} check(s) failed` : "\natlas ok");
process.exit(bad ? 1 : 0);
