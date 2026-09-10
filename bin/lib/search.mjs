/**
 * The query path: embed a question, ask Postgres, get ranked passages.
 *
 * Ranking lives in the database (see supabase/migrations/0002_search.sql) so
 * there is one implementation rather than one per caller, and so the model never
 * writes SQL against the corpus. This module is the thin client both bin/search.mjs
 * and bin/mcp-brain.mjs use.
 */

import { store } from "./store.mjs";
import { localEmbedder } from "./embed-local.mjs";
import { embedder } from "./embed.mjs";

/** Whichever embedder produced the corpus must also embed the query. */
export function queryEmbedder() {
  const provider = (process.env.EMBEDDING_PROVIDER || "voyage").toLowerCase();
  return provider === "local" ? localEmbedder() : embedder({ slow: true });
}

export function brain({ db = store(), embed = queryEmbedder() } = {}) {
  const vec = (v) => "[" + v.join(",") + "]";

  async function search(query, { department = null, k = 8, candidates = 60 } = {}) {
    const text = String(query ?? "").trim();
    if (!text) return [];

    const embedding = await embed.embedQuery(text);
    return db.rest("/rpc/search_chunks", {
      method: "POST",
      body: {
        query_embedding: vec(embedding),
        query_text: text,
        dept: department,
        k,
        candidates,
      },
    });
  }

  const neighbours = (documentId, k = 20) =>
    db.rest("/rpc/document_neighbours", {
      method: "POST",
      body: { doc_id: documentId, k },
    });

  /**
   * Recent sessions, newest first, from either agent.
   *
   * Claude Code fills this through its Stop hook; Codex sessions are read out of
   * ~/.codex/sessions by bin/ingest-codex.mjs. Both land in one table on purpose,
   * because "what was I doing on this" is a question about the work and not
   * about which tool happened to be open.
   */
  const recentSessions = (department = null, limit = 10, source = null) => {
    const filter =
      (department ? `&department=eq.${encodeURIComponent(department)}` : "") +
      (source ? `&source=eq.${encodeURIComponent(source)}` : "");
    return db.rest(
      `/sessions?select=session_id,started_at,department,cwd,summary,source,files_touched,open_threads` +
      `${filter}&order=started_at.desc&limit=${limit}`
    );
  };

  /**
   * Documents matching a path fragment.
   *
   * Paths are stored as Windows absolute paths with backslashes, but every
   * caller thinks in forward slashes, so both separators become the ilike
   * wildcard. "departments/memory.md" then matches the stored absolute path
   * whichever separator it was written with.
   */
  const documentsUnder = (fragment, limit = 50) => {
    const pattern = String(fragment).replace(/[\\/]+/g, "*");
    return db.rest(
      `/documents?select=id,title,department,doc_type,source_path,mtime` +
      `&source_path=ilike.*${encodeURIComponent(pattern)}*&order=mtime.desc&limit=${limit}`
    );
  };

  /**
   * Byte-identical documents, grouped, worst waste first.
   *
   * Grouped in Postgres rather than by pulling every row and grouping here. The
   * client-side version transferred all 926 documents to answer a question one
   * GROUP BY answers, and on a shared-CPU instance that was enough to push a
   * concurrent search into the statement timeout.
   */
  const duplicates = (limit = 20) =>
    db.rest("/rpc/duplicate_documents", { method: "POST", body: { k: limit } });

  /**
   * Documents about the same thing, by meaning rather than by a typed link.
   *
   * neighbours() walks the wikilink graph, which only knows what somebody wrote
   * down. This reads the correlation edges built from document centroids, which
   * is how a CRM note in one department, a service on a server and a repo under
   * turn out to be one subject under three names in three departments.
   */
  const related = (documentId, k = 8) =>
    db.rest("/rpc/document_related", { method: "POST", body: { doc_id: documentId, k } });

  /** The strongest connections nobody recorded, across the whole org. */
  const relatedCrossing = (k = 20, department = null) =>
    db.rest("/rpc/related_crossing", { method: "POST", body: { k, dept: department } });

  /**
   * Every document a department owns, newest first, as a manifest.
   *
   * Deliberately no content: the caller reads the files. Chunks would give back
   * the document cut up and overlapped for retrieval, which is the wrong shape
   * when the point is to stop retrieving and read the whole thing.
   */
  const departmentDocuments = async (department, limit = 500) => {
    const out = [];
    for (let offset = 0; offset < limit; offset += 1000) {
      const part = await db.rest(
        `/documents?department=eq.${encodeURIComponent(department)}` +
        `&select=title,source_path,doc_type,bytes,mtime&order=mtime.desc` +
        `&limit=${Math.min(1000, limit - offset)}&offset=${offset}`
      );
      out.push(...part);
      if (part.length < 1000) break;
    }
    return out;
  };

  /** Where one named thing shows up, ordered by how often a document says it. */
  const entityDocuments = (name, k = 30) =>
    db.rest("/rpc/entity_documents", { method: "POST", body: { entity_name: name, k } });

  /** Named things that show up in more than one department. */
  const entityReach = (minDepts = 2, k = 40) =>
    db.rest("/rpc/entity_reach", { method: "POST", body: { min_depts: minDepts, k } });

  return {
    search, neighbours, recentSessions, documentsUnder, duplicates,
    related, relatedCrossing, departmentDocuments,
    entityDocuments, entityReach, embed,
    // The store itself, for callers that need a query this module does not
    // wrap. serve-brain-map uses it to list every indexed path, which is the
    // whitelist its file API checks against.
    db,
  };
}
