/**
 * Local embeddings through Ollama.
 *
 * Same shape as the Voyage embedder in embed.mjs, so the indexer and mcp-brain
 * can take either without knowing which. No rate limits, no key, no network
 * beyond localhost. The trade is retrieval quality and a dependency on the
 * Ollama service being up whenever a search runs, because a query has to be
 * embedded by the same model that embedded the corpus.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

export function localEmbedder({
  host = DEFAULT_HOST,
  // Its own variable on purpose. EMBEDDING_MODEL names the remote model, and
  // defaulting to it here asked Ollama for "voyage-4-large".
  model = process.env.LOCAL_EMBEDDING_MODEL || "mxbai-embed-large",
  batch = 16,
} = {}) {
  let tokensUsed = 0;      // Ollama reports no token usage; kept for interface parity
  let dimensions = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function once(texts, ms) {
    const res = await fetch(`${host.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(ms),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${text.slice(0, 300)}`);

    const body = JSON.parse(text);
    const vectors = body.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error(`ollama returned ${vectors?.length} vectors for ${texts.length} inputs`);
    }
    return vectors;
  }

  /**
   * Retry, because a long run must not die on one slow request.
   *
   * A 3,576 file index reached 849 files and 6,494 chunks, then a single batch
   * timed out and took the whole process with it. Ollama is a local service
   * competing with everything else on the machine, so an occasional stall is
   * normal, not a failure. Losing an hour of embedding to one of them is the
   * failure.
   *
   * Four attempts with a widening timeout and a short pause between. If it
   * still will not answer, the batch is split: a single oversized chunk that
   * always times out at sixteen at a time will usually go through on its own,
   * and if it genuinely cannot be embedded the error names one chunk instead
   * of killing the run.
   */
  async function call(texts, depth = 0) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const vectors = await once(texts, 300_000 * (attempt + 1));
        dimensions ??= vectors[0].length;
        tokensUsed += texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
        return vectors;
      } catch (err) {
        last = err;
        if (attempt < 3) await sleep(2000 * (attempt + 1));
      }
    }

    if (texts.length > 1 && depth < 5) {
      const mid = Math.ceil(texts.length / 2);
      const a = await call(texts.slice(0, mid), depth + 1);
      const b = await call(texts.slice(mid), depth + 1);
      return [...a, ...b];
    }
    throw last;
  }

  async function embedAll(texts, { onProgress } = {}) {
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      out.push(...(await call(texts.slice(i, i + batch))));
      onProgress?.(out.length, texts.length);
    }
    return out;
  }

  const embedQuery = async (text) => (await call([text]))[0];

  /** Confirm the service is up and report the model's dimension. */
  async function probe() {
    const v = await call(["dimension probe"]);
    return { ok: true, model, dimensions: v[0].length };
  }

  return {
    embedAll, embedQuery, probe, model,
    // The indexer sizes its write-checkpoint waves off this. Without it,
    // Math.min(undefined, 50000) is NaN, every size comparison is false, and the
    // whole corpus accumulates into a single wave that writes nothing until the
    // very end. No rate limit applies locally, so the value only controls how
    // often progress is checkpointed.
    maxBatchTokens: 40_000,
    get dimensions() { return dimensions; },
    get tokensUsed() { return tokensUsed; },
  };
}
