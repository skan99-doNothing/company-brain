-- One piece of content may occupy one result slot.
--
-- Found by the eval, and only after a different bug stopped hiding it. A question
-- about a decision recorded in decisions.md was scoring a correct rank 1 against a
-- second copy of decisions.md that had been vendored in under vaults/. Excluding
-- that copy turned the question into a miss, which is what it had been all along:
-- the real file was rank 4, and ranks 1, 2 and 3 were three byte-identical copies
-- of one note, same content_hash, filed under two different directory schemes.
--
-- This is not rare. 199 content_hash groups in this corpus hold more than one
-- document, covering 530 of 4,666, so 11 percent of the index is an exact copy
-- of something else in it. Course material filed under two directory schemes,
-- a repo vendored inside another repo, a note saved twice while reorganising.
-- Every one of those groups can take k slots and return one answer.
--
-- Excluding the trees by hand was the alternative and it does not generalise:
-- it needs a judgement per tree about which copy is canonical, it has to be
-- redone whenever something is filed twice again, and exclusion also removes the
-- copy from search entirely when the honest answer is that the content should
-- appear exactly once.
--
-- So dedupe at the end of retrieval, on the chunk text itself. Identical text is
-- a redundant result whatever file it came from. Ordering by score inside the
-- partition means the copy that survives is the one the existing weighting
-- already prefers, which is how the org's own decision or ledger wins over the
-- same words sitting in a vendored copy. document_id breaks a remaining tie so a
-- given query returns the same row every run rather than alternating.
--
-- Deliberately exact, not fuzzy. A similarity threshold here would need a
-- distance computation over the candidate set and a number nobody can defend,
-- and it would start merging documents that genuinely differ. Exact duplicates
-- are the measured problem and md5 over at most three times `candidates` rows is
-- free, so this adds no plan risk to the function 0015 spent its whole length
-- making fast.
--
-- Chunks from the same document are untouched unless their text is identical,
-- which keeps the existing behaviour of returning two passages from one long
-- note.

create or replace function search_chunks(
  query_embedding vector(1024),
  query_text      text,
  dept            text default null,
  k               int  default 8,
  candidates      int  default 60
)
returns table (
  chunk_id     bigint,
  document_id  bigint,
  title        text,
  department   text,
  doc_type     text,
  source_path  text,
  heading_path text,
  content      text,
  mtime        timestamptz,
  vec_rank     int,
  lex_rank     int,
  trg_rank     int,
  graph_hits   int,
  score        numeric
)
language plpgsql
stable
as $fn$
declare
  filter_d text := case when dept is null then '' else format(' and d.department = %L', dept) end;
  sql      text;
begin
  sql := format($sql$
    with q as (
      select $1::vector(1024) as e,
             websearch_to_tsquery('english', coalesce($2, '')) as t,
             coalesce($2, '') as raw
    ),
    vec as (
      select c.id, (row_number() over (order by c.embedding <=> (select e from q)))::int as rank
      from chunks c
      join documents d on d.id = c.document_id
      where true %1$s
      order by c.embedding <=> (select e from q)
      limit %2$s
    ),
    lex as (
      select c.id, (row_number() over (order by ts_rank(c.fts, (select t from q)) desc))::int as rank
      from chunks c
      join documents d on d.id = c.document_id
      where c.fts @@ (select t from q) %1$s
      limit %2$s
    ),
    -- The word arm: which of the question's own words a chunk literally holds,
    -- weighted so a rare word decides and a common one barely counts. Eight
    -- words at most, longest first, because length is a free proxy for rarity
    -- and the rare word decides the ranking anyway.
    toks as (
      select t from (
        select distinct t
        from unnest(regexp_split_to_array(lower((select raw from q)), '[^a-z0-9]+')) as t
        where length(t) >= 5
      ) d order by length(t) desc, t limit 8
    ),
    -- One scan per word, feeding both the frequency and the hits. These were
    -- two CTEs running the same scan, so every word was paid for twice.
    hits as (
      select k.t, h.id, h.len
      from toks k
      cross join lateral (
        select c.id, length(c.content) as len
        from chunks c
        join documents d on d.id = c.document_id
        where c.fts @@ plainto_tsquery('english', k.t)
          and c.search_text ilike '%%' || k.t || '%%'
          %1$s
        limit 600
      ) h
    ),
    tok_df as (select t, greatest(count(*), 1)::numeric as df from hits group by t),
    trg as (
      select h.id,
             (row_number() over (order by sum(1.0 / ln(2 + f.df)) desc, min(h.len) asc))::int as rank
      from hits h join tok_df f on f.t = h.t
      group by h.id
      order by sum(1.0 / ln(2 + f.df)) desc
      limit %2$s
    ),
    fused as (
      select coalesce(vec.id, lex.id, trg.id) as id,
             vec.rank as vec_rank, lex.rank as lex_rank, trg.rank as trg_rank,
             coalesce(1.0/(60+vec.rank), 0)
           + coalesce(1.0/(60+lex.rank), 0)
           + coalesce(1.0/(60+trg.rank), 0) as base
      from vec
      full outer join lex on vec.id = lex.id
      full outer join trg on coalesce(vec.id, lex.id) = trg.id
    ),
    seed as (
      select distinct c.document_id from fused f join chunks c on c.id = f.id order by 1 limit 15
    ),
    graph as (
      select l.dst_id as document_id, count(*)::int as hits
      from links l
      where l.dst_id is not null and l.src_id in (select document_id from seed)
      group by l.dst_id
    ),
    scored as (
      select f.id, f.vec_rank, f.lex_rank, f.trg_rank,
             coalesce(g.hits, 0) as graph_hits,
             c.document_id, c.heading_path, c.content,
             d.title, d.department, d.doc_type, d.source_path, d.mtime,
             (
               f.base
               -- The org's own memory outranks an ordinary note saying the same
               -- thing, and a chat transcript ranks under both: the thing was
               -- worked out there and written down properly somewhere else.
               * case d.doc_type
                   when 'decision' then 1.40
                   when 'ledger'   then 1.30
                   when 'brief'    then 1.25
                   when 'readme'   then 1.05
                   when 'session'  then 0.85
                   else 1.00
                 end
               * (1.0 + 0.15 * exp(-greatest(extract(epoch from (now() - d.mtime)), 0) / 31557600.0))
               * (1.0 + least(coalesce(g.hits, 0), 5) * 0.03)
             )::numeric as score
      from fused f
      join chunks c    on c.id = f.id
      join documents d on d.id = c.document_id
      left join graph g on g.document_id = c.document_id
    ),
    -- Identical text collapses to its best-scoring copy. See the header: 11
    -- percent of this corpus is an exact duplicate of something else in it, and
    -- three copies of one note were taking the whole top three.
    deduped as (
      select *,
             row_number() over (
               partition by md5(content)
               order by score desc, document_id
             ) as copy_rank
      from scored
    )
    select id, document_id, title, department, doc_type, source_path,
           heading_path, content, mtime,
           vec_rank, lex_rank, trg_rank, graph_hits, round(score, 8)
    from deduped
    where copy_rank = 1
    order by score desc, vec_rank nulls last
    limit %3$s
  $sql$, filter_d, greatest(candidates, 1), greatest(k, 1));

  return query execute sql using query_embedding, query_text;
end;
$fn$;

comment on function search_chunks is
  'Hybrid retrieval over chunks: vector, full text, word-literal and link-graph signals fused by reciprocal rank, weighted by document type, recency and graph support, then deduplicated so identical chunk text occupies one slot. Built as dynamic SQL so the limits and the department filter are literals at plan time; as a plain SQL function the generic plan ignored the HNSW index and took 41 seconds.';
