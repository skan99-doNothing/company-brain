#!/usr/bin/env node
/**
 * preflight.mjs — is it worth starting the nightly at all.
 *
 *   node bin/preflight.mjs                 wait for the dependencies, then exit 0
 *   node bin/preflight.mjs --tries 10      how many attempts before giving up
 *   node bin/preflight.mjs --wait 20       seconds between attempts
 *   node bin/preflight.mjs --quiet         print only the verdict
 *
 * Exits 0 when everything the nightly needs is answering, 1 when it is not.
 *
 * Why this exists. On 9 September at 3:19am the nightly ran while the machine
 * had no DNS. Every step that needs Supabase failed in turn: index, codex,
 * entities, eval, four separate stack traces for one cause, and the log read as
 * four unrelated bugs. One of them, the codex step, then stayed broken for a
 * different reason and that was invisible underneath the noise.
 *
 * store.mjs already retries the transport four times with backoff, which covers
 * a blip of a few seconds. It cannot cover a network that is simply not up yet,
 * and a scheduled task at 3am is exactly when that happens: the box may have
 * just woken, or resumed, or still be bringing an interface up.
 *
 * Two dependencies, both hard:
 *
 *   Supabase   every step but the map reads or writes it.
 *   Ollama     the index embeds new chunks locally, and a query embeds itself
 *              with the same model, so retrieval needs it too. A missing Ollama
 *              turns the index step into a failure halfway through a run.
 *
 * The map step is the only one that needs neither, so a failed preflight still
 * leaves yesterday's map in place rather than a broken one.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

try { process.loadEnvFile(resolve(ROOT, ".env")); }
catch { console.error("preflight: no .env at the org root"); process.exit(1); }

const argv = process.argv.slice(2);
const num = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : Number(argv[i + 1]); };
const QUIET = argv.includes("--quiet");

const TRIES = num("--tries", 10);
const WAIT = num("--wait", 20) * 1000;
const TIMEOUT = num("--timeout", 10) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => { if (!QUIET) console.log(s); };

/**
 * fetch with a deadline that is cleaned up afterwards.
 *
 * AbortSignal.timeout() leaves its timer armed once the request has settled, and
 * this process then calls process.exit while that handle is still closing, which
 * trips a libuv assertion on Windows: "!(handle->flags & UV_HANDLE_CLOSING)",
 * src\win\async.c line 76, and the exit code comes back 127 after a clean run.
 * An explicit controller lets the timer be cleared the moment the answer
 * arrives, so there is nothing left to tear down.
 */
async function fetchWithin(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const MODEL = process.env.LOCAL_EMBEDDING_MODEL || "mxbai-embed-large";
const LOCAL = (process.env.EMBEDDING_PROVIDER || "local") === "local";

/**
 * Reachable, not merely resolvable.
 *
 * A HEAD against the REST root answers without touching a table and without the
 * key, which is all this needs: the question is whether the host is there, not
 * whether the credentials are right. Any HTTP answer at all, including a 401,
 * means the network is up and the run can proceed. Only a thrown error counts as
 * down, which is what a DNS failure, a refused connection or a timeout produce.
 */
async function supabaseUp() {
  if (!SUPABASE_URL) return "SUPABASE_URL is not set";
  try {
    await fetchWithin(SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/", { method: "HEAD" });
    return null;
  } catch (e) {
    return e.cause?.code ? `${e.cause.code} ${e.cause.hostname ?? ""}`.trim() : e.message.slice(0, 80);
  }
}

/**
 * Ollama is running and still has the model pulled.
 *
 * Checking the process is not enough. A model can be removed while the service
 * keeps answering, and the index would then fail one file in, so the tag list is
 * the thing worth asserting.
 */
async function ollamaUp() {
  if (!LOCAL) return null;                       // a hosted provider needs no daemon
  try {
    const res = await fetchWithin(`${OLLAMA.replace(/\/+$/, "")}/api/tags`);
    if (!res.ok) return `HTTP ${res.status} from ${OLLAMA}`;
    const names = (await res.json()).models?.map((m) => m.name) ?? [];
    // Ollama reports "mxbai-embed-large:latest" for a bare pull.
    if (!names.some((n) => n === MODEL || n.startsWith(`${MODEL}:`))) {
      return `${MODEL} is not pulled (ollama pull ${MODEL})`;
    }
    return null;
  } catch (e) {
    return e.cause?.code ? `${e.cause.code} at ${OLLAMA}` : e.message.slice(0, 80);
  }
}

/**
 * Sets process.exitCode and falls off the end rather than calling process.exit.
 *
 * This is the one script here whose last act is an HTTPS request, and on node
 * v24.12.0 for Windows calling process.exit() while undici is still tearing down
 * a TLS socket aborts the process: the same libuv assertion as above, printed
 * after a completely successful run, and the shell sees 127. nightly.cmd tests
 * errorlevel, so that turns a healthy preflight into a skipped nightly.
 *
 * Measured rather than assumed: the event loop drains on its own 587 ms after
 * the last response, which is nothing against a job that runs for minutes. Every
 * other script here already survives process.exit only because it does minutes
 * of work between its last request and its exit.
 */
for (let attempt = 1; attempt <= TRIES; attempt++) {
  const [supabase, ollama] = await Promise.all([supabaseUp(), ollamaUp()]);
  if (!supabase && !ollama) {
    say(`preflight ok${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
    process.exitCode = 0;
    break;
  }

  const why = [supabase && `supabase: ${supabase}`, ollama && `ollama: ${ollama}`].filter(Boolean).join("; ");
  if (attempt === TRIES) {
    console.error(`preflight failed after ${TRIES} attempts over ${Math.round((TRIES - 1) * WAIT / 60000)} minutes. ${why}`);
    console.error("nothing was run. The index, codex, entities and eval steps all need Supabase, and");
    console.error("the index needs Ollama, so running them now would produce one cause and four stack traces.");
    process.exitCode = 1;
    break;
  }
  say(`preflight attempt ${attempt}/${TRIES}: ${why}`);
  await sleep(WAIT);
}
