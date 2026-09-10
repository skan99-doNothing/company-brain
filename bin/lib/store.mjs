/**
 * Supabase storage over PostgREST, with no npm dependency.
 *
 * The secret key bypasses row level security, which is why it never leaves this
 * machine. Vectors are sent as their text form ("[0.1,0.2,...]"): pgvector's
 * input function parses that, and it keeps the payload smaller than a JSON
 * array of numbers would be.
 */

const CHUNK_INSERT_BATCH = 40;   // ~400 KB per request at 1024 dimensions
const PAGE = 1000;               // PostgREST's default ceiling

export function store({
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
} = {}) {
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");

  const base = url.replace(/\/+$/, "") + "/rest/v1";
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Retry the transport, never the verdict.
   *
   * A two hour index run died twice on a single request: once when Ollama
   * stalled, once here on an ECONNRESET from Supabase after 28 files. A dropped
   * TCP connection is not an answer, and treating it as one threw away an hour
   * of embedding that had already been paid for.
   *
   * Only the transport is retried. A dropped socket, a timeout, or a 5xx from
   * the gateway can all be tried again, because the server never spoke. A 4xx
   * is the server speaking: it read the request, understood it, and refused.
   * Retrying that would turn a conflict or a bad payload into four identical
   * failures and a longer wait for the same error. Not idempotent in theory,
   * but every write here is an upsert keyed on a natural key, so a retry after
   * a reset that did land writes the same row twice to the same place.
   */
  async function rest(path, { method = "GET", body, prefer } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let last;

    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(base + path, {
          method,
          headers: prefer ? { ...headers, Prefer: prefer } : headers,
          body: payload,
          signal: AbortSignal.timeout(120_000 * (attempt + 1)),
        });
      } catch (err) {
        last = err;                                   // reset, timeout, DNS
        if (attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
        throw err;
      }

      const text = await res.text();
      if (res.ok) {
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      }

      last = new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
      if (res.status < 500 || attempt === 3) throw last;
      await sleep(1500 * 2 ** attempt);
    }
    throw last;
  }

  const vec = (v) => (v ? "[" + v.join(",") + "]" : null);

  /** Every indexed document, keyed by source_path, for the incremental check. */
  async function documentIndex() {
    const out = new Map();
    for (let offset = 0; ; offset += PAGE) {
      const rows = await rest(
        `/documents?select=id,source_path,content_hash&order=id&limit=${PAGE}&offset=${offset}`
      );
      for (const r of rows) out.set(r.source_path, { id: r.id, hash: r.content_hash });
      if (rows.length < PAGE) break;
    }
    return out;
  }

  /** Insert or update by source_path; returns the row id either way. */
  async function upsertDocument(doc) {
    const rows = await rest("/documents?on_conflict=source_path", {
      method: "POST",
      body: [doc],
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return rows[0].id;
  }

  const deleteChunks = (documentId) => rest(`/chunks?document_id=eq.${documentId}`, { method: "DELETE" });
  const deleteLinks = (documentId) => rest(`/links?src_id=eq.${documentId}`, { method: "DELETE" });

  async function insertChunks(documentId, chunks) {
    for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
      const slice = chunks.slice(i, i + CHUNK_INSERT_BATCH).map((c) => ({
        document_id: documentId,
        ord: c.ord,
        content: c.content,
        heading_path: c.heading_path || null,
        token_count: c.token_count,
        embedding: vec(c.embedding),
      }));
      await rest("/chunks", { method: "POST", body: slice, prefer: "return=minimal" });
    }
  }

  async function insertLinks(documentId, targets) {
    if (targets.length === 0) return;
    const rows = targets.map((t) => ({ src_id: documentId, link_text: t, resolved: false }));
    await rest("/links?on_conflict=src_id,link_text", {
      method: "POST",
      body: rows,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }

  /** Remove documents whose file is gone. Chunks and links cascade. */
  async function deleteDocuments(ids) {
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      await rest(`/documents?id=in.(${slice.join(",")})`, { method: "DELETE" });
    }
  }

  const truncateAll = async () => {
    await rest("/links?id=gt.0", { method: "DELETE" });
    await rest("/chunks?id=gt.0", { method: "DELETE" });
    await rest("/documents?id=gt.0", { method: "DELETE" });
  };

  async function counts() {
    const one = async (table) => {
      const res = await fetch(`${base}/${table}?select=id&limit=1`, {
        headers: { ...headers, Prefer: "count=exact" },
      });
      const range = res.headers.get("content-range") || "";
      await res.text();
      return Number(range.split("/")[1] ?? 0);
    };
    return {
      documents: await one("documents"),
      chunks: await one("chunks"),
      links: await one("links"),
    };
  }

  return {
    rest, documentIndex, upsertDocument, deleteChunks, deleteLinks,
    insertChunks, insertLinks, deleteDocuments, truncateAll, counts,
  };
}
