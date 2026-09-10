-- Chat transcripts rank below the notes that concluded them.
--
-- The index took 1,673 exported ChatGPT and Claude conversations in September
-- 2026, going back to December 2022. They are the largest single body of text
-- in the corpus and they are working-out, not conclusions: the answer usually
-- got written down properly somewhere else afterwards. Without a weight they
-- take the top slots on almost every query by sheer volume, which is the exact
-- outcome the vault's .ignore was protecting ripgrep from.
--
-- 0.85 is deliberately gentle. A session still wins when it is the only record
-- of something, and loses a tie to the note that settled it.

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
language sql
stable
as $fn$
with q as (
  select query_embedding as e,
         websearch_to_tsquery('english', coalesce(query_text, '')) as t,
         coalesce(query_text, '') as raw
),
vec as (
  select c.id, (row_number() over (order by c.embedding <=> (select e from q)))::int as rank
  from chunks c
  join documents d on d.id = c.document_id
  where dept is null or d.department = dept
  order by c.embedding <=> (select e from q)
  limit candidates
),
lex as (
  select c.id, (row_number() over (order by ts_rank(c.fts, (select t from q)) desc))::int as rank
  from chunks c
  join documents d on d.id = c.document_id
  where c.fts @@ (select t from q)
    and (dept is null or d.department = dept)
  limit candidates
),
-- Literal tokens, not a similarity threshold.
--
-- Two earlier attempts failed. Computing word_similarity in the WHERE clause
-- scanned every chunk and hit the statement timeout. The indexable <% operator
-- compares against pg_trgm.word_similarity_threshold, a GUC that defaults to
-- 0.6 and that Supabase will not let a function set, so the arm ran, matched
-- nothing, and contributed no signal without raising anything.
--
-- ILIKE on the distinctive words of the query is index-accelerated by the same
-- GIN trigram index, needs no GUC, and is what actually finds a proper noun:
-- ranking by how many of the query's own words a chunk literally contains.
-- Words shorter than five characters are dropped as too common to discriminate.
toks as (
  select distinct t
  from unnest(regexp_split_to_array(lower(coalesce((select raw from q), '')), '[^a-z0-9]+')) as t
  where length(t) >= 5
),
-- How many chunks contain each word. Counting matched words alone ranked a
-- generic SECURITY.md first for "Web2Print security review", because it held
-- two common words while the chunk naming the actual client held one rare one.
-- Weighting by inverse document frequency is what makes a rare word decisive.
tok_df as (
  select k.t, count(*)::numeric as df
  from toks k
  join chunks c on c.search_text ilike '%' || k.t || '%'
  group by k.t
),
trg as (
  select c.id,
         (row_number() over (order by sum(1.0 / ln(2 + f.df)) desc, min(length(c.content)) asc))::int as rank
  from toks k
  join tok_df f    on f.t = k.t
  join chunks c    on c.search_text ilike '%' || k.t || '%'
  join documents d on d.id = c.document_id
  where dept is null or d.department = dept
  group by c.id
  order by sum(1.0 / ln(2 + f.df)) desc
  limit candidates
),
fused as (
  select coalesce(vec.id, lex.id, trg.id) as id,
         vec.rank as vec_rank,
         lex.rank as lex_rank,
         trg.rank as trg_rank,
         coalesce(1.0/(60+vec.rank), 0)
       + coalesce(1.0/(60+lex.rank), 0)
       + coalesce(1.0/(60+trg.rank), 0) as base
  from vec
  full outer join lex on vec.id = lex.id
  full outer join trg on coalesce(vec.id, lex.id) = trg.id
),
-- Documents the strongest hits link to. Deliberately drawn from the top slice
-- only: expanding from every candidate would boost half the vault.
seed as (
  select distinct c.document_id
  from fused f join chunks c on c.id = f.id
  order by 1
  limit 15
),
graph as (
  select l.dst_id as document_id, count(*)::int as hits
  from links l
  where l.dst_id is not null
    and l.src_id in (select document_id from seed)
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
           -- thing, because a decision or a ledger line states what is current
           -- and a note may only state what was once true.
           * case d.doc_type
               when 'decision' then 1.40
               when 'ledger'   then 1.30
               when 'brief'    then 1.25
               when 'readme'   then 1.05
               -- 1,673 exported ChatGPT and Claude conversations went into the
               -- index in September 2026, and they are transcripts: the thing
               -- was worked out there and then written down properly somewhere
               -- else. They should surface when they are the only record, and
               -- lose a tie to the note that concluded them.
               when 'session'  then 0.85
               else 1.00
             end
           -- Gentle recency. Enough to break a tie toward the fresher copy of
           -- duplicated material, not enough to bury something old and correct.
           * (1.0 + 0.15 * exp(-greatest(extract(epoch from (now() - d.mtime)), 0) / 31557600.0))
           -- Graph support, capped so a hub note cannot dominate.
           * (1.0 + least(coalesce(g.hits, 0), 5) * 0.03)
         )::numeric as score
  from fused f
  join chunks c    on c.id = f.id
  join documents d on d.id = c.document_id
  left join graph g on g.document_id = c.document_id
)
select id, document_id, title, department, doc_type, source_path,
       heading_path, content, mtime,
       vec_rank, lex_rank, trg_rank, graph_hits,
       round(score, 8)
from scored
order by score desc, vec_rank nulls last
limit k
$fn$;

comment on function search_chunks is
  'Hybrid retrieval over chunks: vector, full text, trigram and link-graph signals fused by reciprocal rank, then weighted by document type, recency and graph support. Tune the weights against bin/eval-embeddings.mjs, not by feel.';
