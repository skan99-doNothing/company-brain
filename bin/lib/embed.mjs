/**
 * Voyage embeddings, rate limited.
 *
 * Voyage throttles accounts with no payment method to 3 requests and 10,000
 * tokens per minute, and returns that as a 429 with an explanation rather than
 * as a documented limit you can discover in advance. The limiter below is a
 * sliding one-minute window over both requests and tokens, so the same code
 * works on a throttled account (slowly) and a normal one (quickly).
 *
 *   EMBED_RPM / EMBED_TPM   override the limits
 *   --slow                  the throttled free-tier profile
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

export const FREE_TIER = { rpm: 3, tpm: 10_000 };
export const PAID_TIER = { rpm: 300, tpm: 1_000_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding one-minute window over requests and tokens, deliberately pessimistic.
 *
 * Three things went wrong with the naive version, all of them found the hard way
 * on a real run that died after 20 files:
 *
 *   - It sized requests at 90% of the per-minute token budget, so a single
 *     request nearly exhausted the window on its own. Our token count is
 *     chars/4, which is an estimate, not Voyage's tokenizer, so "90%" could
 *     easily be over 100% in reality.
 *   - It left a 250ms margin at the window edge. Clocks and network latency
 *     make that margin meaningless.
 *   - It counted only successful requests. A rejected 429 still spends the
 *     request allowance, so retrying made the throttling worse.
 *
 * The window now tracks every attempt, successful or not, keeps a spacing floor
 * between requests, and tightens itself each time the server pushes back.
 */
function limiter({ rpm, tpm, safety = 0.6 }) {
  const events = [];        // { at, tokens } for every attempt
  let penalty = 1;          // grows on each 429, shrinking the effective budget
  let lastAt = 0;

  const budget = () => Math.floor(tpm * safety / penalty);
  const minGap = () => (60_000 / rpm) * 1.1 * penalty;

  async function reserve(tokens) {
    if (tokens > budget()) {
      throw new Error(
        `a single request needs ${tokens} tokens but the working budget is ` +
        `${budget()}/min. A chunk is too large; check the chunker's maxTokens.`
      );
    }
    for (;;) {
      const now = Date.now();
      while (events.length && now - events[0].at > 60_000) events.shift();

      const used = events.reduce((n, e) => n + e.tokens, 0);
      const sinceLast = now - lastAt;

      if (events.length < rpm && used + tokens <= budget() && sinceLast >= minGap()) {
        events.push({ at: now, tokens });
        lastAt = now;
        return;
      }

      const waits = [1000];
      if (sinceLast < minGap()) waits.push(minGap() - sinceLast);
      if (events.length) waits.push(60_000 - (now - events[0].at) + 2000);
      await sleep(Math.max(...waits));
    }
  }

  /** Called on a 429: assume our accounting is optimistic and tighten it. */
  reserve.penalise = () => { penalty = Math.min(penalty * 1.5, 6); return penalty; };
  reserve.state = () => ({ penalty, budget: budget(), minGap: Math.round(minGap()) });

  return reserve;
}

export function embedder({
  apiKey = process.env.VOYAGE_API_KEY,
  model = process.env.EMBEDDING_MODEL || "voyage-4-large",
  dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 1024),
  slow = false,
  onThrottle = null,
} = {}) {
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");

  const tier = slow ? FREE_TIER : PAID_TIER;
  const rpm = Number(process.env.EMBED_RPM || tier.rpm);
  const tpm = Number(process.env.EMBED_TPM || tier.tpm);
  const reserve = limiter({ rpm, tpm });

  // Half the per-minute allowance, not most of it. chars/4 is an estimate of
  // Voyage's tokenizer, not a match for it, so headroom is not optional.
  const maxBatchTokens = Math.max(1000, Math.floor(tpm * 0.45));
  const maxBatchCount = slow ? 16 : 96;

  let tokensUsed = 0;

  async function call(texts, inputType, attempt = 0) {
    const estimate = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    await reserve(estimate);

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts, model, input_type: inputType, output_dimension: dimensions }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      if (attempt < 5) { await sleep(2000 * 2 ** attempt); return call(texts, inputType, attempt + 1); }
      throw new Error(`voyage request failed after retries: ${e.message}`);
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 12) {
      await res.text().catch(() => {});
      // A 429 means our accounting was wrong, not merely unlucky, so tighten the
      // limiter before sleeping. Wait past a full window: with 3 requests per
      // minute there is nothing to gain from trying again sooner.
      if (res.status === 429) reserve.penalise();
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000 + 2000
        : Math.min(120_000, 65_000 + 5000 * attempt);
      onThrottle?.({ attempt: attempt + 1, waitMs: wait, ...reserve.state() });
      await sleep(wait);
      return call(texts, inputType, attempt + 1);
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`voyage HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);

    tokensUsed += body.usage?.total_tokens ?? 0;
    const out = new Array(texts.length);
    for (const d of body.data) out[d.index] = d.embedding;   // trust the index, not the order
    return out;
  }

  async function embedAll(texts, { inputType = "document", onProgress } = {}) {
    const results = [];
    let batch = [];
    let batchTokens = 0;

    const flush = async () => {
      if (!batch.length) return;
      results.push(...(await call(batch, inputType)));
      onProgress?.(results.length, texts.length);
      batch = [];
      batchTokens = 0;
    };

    for (const t of texts) {
      const tk = Math.ceil(t.length / 4);
      if (batch.length >= maxBatchCount || (batch.length && batchTokens + tk > maxBatchTokens)) await flush();
      batch.push(t);
      batchTokens += tk;
    }
    await flush();
    return results;
  }

  const embedQuery = async (text) => (await call([text], "query"))[0];

  return {
    embedAll, embedQuery, model, dimensions, rpm, tpm, maxBatchTokens,
    get tokensUsed() { return tokensUsed; },
  };
}
