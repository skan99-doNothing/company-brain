-- Capturing search tuning that only ever existed inside the database.
--
-- The live search_chunks did not match this repo. It weights sessions at 0.60
-- where 0016 says 0.85, and its toks arm carries a stopword and rarity filter
-- that exists in no migration on any branch. The deployed body even points at
-- "the header on 0022", a migration this repo has never had. The database's own
-- migration log ends 2026-09-09 with an entry called restore_session_weight_085
-- that the deployed function already contradicts, and it holds no entry for the
-- dedupe block that 0016 added and that the deployed function also has.
--
-- So the function below is not written from 0016. It is the deployed definition,
-- read back out of pg_get_functiondef. If the tuning in it looks unfamiliar,
-- trust it over the older files: it is what has actually been answering queries.
--
-- This file began as a plan to shrink a Supabase project sitting at 947 MB
-- against a 500 MB ceiling. That reason is gone. Since 2026-09-18 the brain runs
-- on Postgres on the VPS, where no such ceiling applies. The halfvec conversion
-- that plan called for was never applied: both embedding columns are still
-- vector(1024) in the deployed database, verified before this file was written,
-- so none of it is in here. What is left is the part that is real, which is the
-- tuning above and the index below.
--
-- The trigram index was 79 MB and was making search slower rather than faster.
-- The planner preferred it for the ilike arm and then rechecked every row it
-- returned, while the full text index sitting in the same AND reaches the same
-- rows directly. Measured warm on one real term: 562 ms with the index against
-- 328 ms without, 8122 buffers against 5340. The ilike stays, as a heap filter
-- behind the fts match, which is the only job it was doing that was worth
-- anything. The drop is already live and survived the move to the VPS. This
-- records why, so nobody adds it back on the assumption that it was an
-- oversight.
--
-- Run bin/eval-search.mjs after this. Recall is measurable in this repo, so it
-- should be measured rather than assumed.

drop index if exists chunks_search_trgm_idx;

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
      ) d
      -- Words full text already reaches are dropped before the scan, not
      -- downweighted after it. numnode() rejects stopwords, which compile to an
      -- empty tsquery, match nothing, and would otherwise read as maximally rare.
      -- The count runs on the tsvector index alone and stops at the ceiling, so
      -- the test costs about 30 ms and never touches the heap.
      where numnode(plainto_tsquery('english', d.t)) > 0
        and (select count(*) from (
              select 1 from chunks c
              where c.fts @@ plainto_tsquery('english', d.t)
              limit 150) g) < 150
      order by length(t) desc, t limit 8
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
               -- 0.85 was not enough. See the header on 0022.
               * case d.doc_type
                   when 'decision' then 1.40
                   when 'ledger'   then 1.30
                   when 'brief'    then 1.25
                   when 'readme'   then 1.05
                   when 'session'  then 0.60
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
