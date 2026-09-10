#!/usr/bin/env node
/**
 * relate.mjs — find the documents that are about the same thing.
 *
 *   npm run relate                 rebuild with the defaults
 *   npm run relate -- --k 12       more neighbours per document
 *   npm run relate -- --min 0.62   stricter floor
 *
 * The wikilink graph only knows what somebody typed. This asks the embeddings
 * that are already in the index, which know that the CRM notes in Product, the
 * service that sends for a CRM and the email sequences in another department are one
 * subject wearing three names in three departments.
 *
 * Run it after `npm run index`. It refreshes the document centroids first, so
 * running it on a stale index would compare vectors that no longer exist.
 *
 * The walk is in slices. One statement covering every document was fine at
 * 1,368 and died on the statement timeout at 4,967, where the work is roughly
 * 24.7 million distance comparisons. Slicing by document id keeps each
 * statement small enough to finish, and turns a run that either worked or lost
 * everything into one that reports how far it got.
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(join(ROOT, ".env"));
const { store } = await import("./lib/store.mjs");
const db = store();

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : Number(argv[i + 1]);
};

const k = arg("k", 8);
const min = arg("min", 0.55);
const max = arg("max", 0.985);

const c = { dim: "\x1b[2m", green: "\x1b[32m", off: "\x1b[0m" };

console.log(`${c.dim}k=${k}  floor=${min}  ceiling=${max}${c.off}`);
const started = Date.now();

const one = (r) => (Array.isArray(r) ? Object.values(r[0] ?? {})[0] : r);

const ids = [];
for (let offset = 0; ; offset += 1000) {
  const part = await db.rest(`/documents?select=id&order=id&limit=1000&offset=${offset}`);
  ids.push(...part.map((r) => r.id));
  if (part.length < 1000) break;
}

/** Walk the corpus in id slices, calling one function on each. */
async function walk(label, slice, fn) {
  let total = 0;
  const started = Date.now();
  for (let i = 0; i < ids.length; i += slice) {
    const from = ids[i];
    const to = ids[Math.min(i + slice, ids.length - 1)] + 1;
    total += (await fn(from, to)) ?? 0;
    process.stdout.write(
      `\r  ${label} ${Math.min(i + slice, ids.length).toLocaleString()}/` +
      `${ids.length.toLocaleString()}  ${total.toLocaleString()} rows  ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s     `
    );
  }
  console.log();
  return total;
}

// Every centroid before any neighbour lookup. A document compared against a
// half-built table gets the nearest of whatever happened to be there already.
await walk("centroids ", 500, (from, to) =>
  db.rest("/rpc/refresh_doc_vectors", { method: "POST", body: { src_from: from, src_to: to } })
    .then(one));

// Qualified DELETE on purpose: pg_safeupdate refuses a bare one, and has done
// twice before in this repo. Done here rather than inside the function because
// every call below is ranged and must not clear the slices already written.
await db.rest("/related?src_id=gte.0", { method: "DELETE", prefer: "return=minimal" });

const edges = await walk("neighbours", 250, (from, to) =>
  db.rest("/rpc/rebuild_related", {
    method: "POST",
    body: { k, min_sim: min, max_sim: max, src_from: from, src_to: to },
  }).then(one));

const s = await db.rest("/rpc/related_stats", { method: "POST", body: {} });

console.log(
  `${c.green}related${c.off}  ${s.edges.toLocaleString()} edges over ` +
  `${s.documents.toLocaleString()} documents in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
console.log(`         ${s.crossing.toLocaleString()} of them cross a department boundary\n`);

for (const p of s.byPair.slice(0, 12)) {
  console.log(String(p.n).padStart(6) + "  " + p.a + " · " + p.b);
}

console.log("\nclosest pairs that nobody linked by hand:");
for (const p of s.pairs.slice(0, 8)) {
  console.log(
    "  " + p.sim + "  " +
    (p.aDept + "/" + String(p.a || "").slice(0, 40)).padEnd(52) +
    "  " + p.bDept + "/" + String(p.b || "").slice(0, 40)
  );
}
