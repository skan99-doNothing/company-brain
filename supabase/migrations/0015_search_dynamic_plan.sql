-- Search stopped answering, and the query was never the problem.
--
-- The corpus went from 1,390 documents and 13,546 chunks to 4,967 and 37,922 in
-- September 2026, and search_chunks began returning 57014 on ordinary questions
-- inside the two minute statement timeout.
--
-- Three things were measured before anything was changed, and two of the three
-- first guesses were wrong. Worth writing down in that order.
--
-- 1. The trigram arm was genuinely expensive. It counted every match of every
--    query word across the whole table, twice, once for the document frequency
--    and once for the hits. Merging those into one scan and capping them helped
--    and was still 43 seconds.
--
-- 2. The real cost inside that arm was not the trigram index but the recheck it
--    forces: ILIKE has to compare the pattern against search_text, which is
--    TOASTed out of a 769 MB table, at roughly seven seconds a word. Letting the
--    GIN tsvector index choose the candidates and using ILIKE only to confirm
--    took that arm to 301 ms. This is the same fix that rescued
--    rebuild_entity_mentions from a ten minute timeout, and it was already
--    written down in the Labs ledger.
--
--    What it gives up: a word buried inside a larger token. Postgres lexes
--    `myproduct.cloud` as one host token, so `myproduct` no longer reaches it
--    through this arm. The vector arm still does.
--
-- 3. None of that was the main cost. Inlined with literals the whole body
--    answered in 770 ms while the function took 41 seconds, and the difference
--    was plan caching. `candidates` and `k` arrive as parameters, so the planner
--    has no LIMIT to reason about when deciding whether the HNSW index is worth
--    using, and `dept is null or d.department = dept` cannot be folded away when
--    dept is a parameter, so a filter matching every row still looks selective.
--    After five calls PostgreSQL settles on a generic plan built from those
--    unknowns and keeps it.
--
--    Building the statement as text puts the limits back as literals and drops
--    the department clause entirely when there is no department, so every call
--    is planned against what it actually asked for. The embedding and the query
--    text stay real parameters: they change the answer, never the plan.
--
-- Result: 41 seconds to 1.6. Retrieval over 101 questions went from 85 percent
-- recall@1 on the old corpus to 80 percent on a corpus 3.6 times the size,
-- recall@3 from 94 to 92. Lowering the session weight from 0.85 to 0.70 was
-- tried against the same questions and moved MRR by 0.001, so it was left alone.

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
    )
    select id, document_id, title, department, doc_type, source_path,
           heading_path, content, mtime,
           vec_rank, lex_rank, trg_rank, graph_hits, round(score, 8)
    from scored
    order by score desc, vec_rank nulls last
    limit %3$s
  $sql$, filter_d, greatest(candidates, 1), greatest(k, 1));

  return query execute sql using query_embedding, query_text;
end;
$fn$;

comment on function search_chunks is
  'Hybrid retrieval over chunks: vector, full text, word-literal and link-graph signals fused by reciprocal rank, then weighted by document type, recency and graph support. Built as dynamic SQL so the limits and the department filter are literals at plan time; as a plain SQL function the generic plan ignored the HNSW index and took 41 seconds.';
