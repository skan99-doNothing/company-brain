-- Centroids as a table filled in slices, not a view refreshed all at once.
--
-- doc_vectors was a materialized view, and `refresh materialized view` is one
-- statement: average every chunk vector into one centroid per document and
-- rebuild an HNSW index over the result, inside a single request. Over 13,546
-- chunks that fit. Over 37,922 it exceeds the statement timeout, and nothing
-- can be done about that from inside the function, because raising
-- statement_timeout mid-statement does not re-arm a timer already running.
-- That is why the SET LOCAL in the first attempt changed nothing.
--
-- A plain table with a ranged upsert can be filled a few hundred documents at a
-- time, each call comfortably inside any timeout, and the walk can report how
-- far it got. It is also incremental: a nightly run touching forty documents no
-- longer recomputes five thousand centroids.
--
-- rebuild_related takes the same range, for the same reason. The whole-corpus
-- version was roughly 24.7 million distance comparisons in one statement.

drop function if exists refresh_doc_vectors();
drop function if exists rebuild_related(int, real, real);
drop function if exists rebuild_related(int, real, real, bigint, bigint, boolean);
drop materialized view if exists doc_vectors cascade;

create table if not exists doc_vectors (
  document_id bigint primary key references documents (id) on delete cascade,
  embedding   vector(1024) not null,
  chunks      int not null
);

create index if not exists doc_vectors_hnsw
  on doc_vectors using hnsw (embedding vector_cosine_ops);

alter table doc_vectors enable row level security;

-- Centroids for one slice of document ids. Null bounds mean the whole corpus,
-- which is only safe on a small one.
create or replace function refresh_doc_vectors(
  src_from bigint default null,
  src_to   bigint default null
) returns int
language plpgsql
as $$
declare n int;
begin
  insert into doc_vectors (document_id, embedding, chunks)
  select c.document_id,
         (avg(c.embedding))::vector(1024),
         count(*)::int
  from chunks c
  where c.embedding is not null
    and c.document_id >= coalesce(src_from, c.document_id)
    and c.document_id <  coalesce(src_to, c.document_id + 1)
  group by c.document_id
  on conflict (document_id) do update
    set embedding = excluded.embedding,
        chunks    = excluded.chunks;

  get diagnostics n = row_count;

  -- A document whose chunks have all gone leaves a centroid pointing at
  -- nothing, and that centroid would still be returned as somebody's nearest
  -- neighbour. Only ever within the slice being rebuilt.
  delete from doc_vectors v
  where v.document_id >= coalesce(src_from, v.document_id)
    and v.document_id <  coalesce(src_to, v.document_id + 1)
    and not exists (select 1 from chunks c where c.document_id = v.document_id);

  return n;
end;
$$;

comment on function refresh_doc_vectors is
  'Upsert document centroids for a slice of document ids. Walk the corpus in slices; the whole corpus in one call will exceed the statement timeout.';

create or replace function rebuild_related(
  k        int  default 8,
  min_sim  real default 0.55,
  max_sim  real default 0.985,
  src_from bigint default null,
  src_to   bigint default null
) returns int
language plpgsql
as $$
declare n int;
begin
  delete from related r
  where r.src_id >= coalesce(src_from, r.src_id)
    and r.src_id <  coalesce(src_to, r.src_id + 1);

  insert into related (src_id, dst_id, similarity)
  select a.document_id, nb.document_id, nb.sim
  from doc_vectors a
  cross join lateral (
    select b.document_id, (1 - (a.embedding <=> b.embedding))::real as sim
    from doc_vectors b
    where b.document_id <> a.document_id
    order by a.embedding <=> b.embedding
    limit k
  ) nb
  where nb.sim >= min_sim and nb.sim <= max_sim
    and a.document_id >= coalesce(src_from, a.document_id)
    and a.document_id <  coalesce(src_to, a.document_id + 1)
  on conflict (src_id, dst_id) do update set similarity = excluded.similarity;

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function rebuild_related is
  'Top k nearest documents per document within a slice of document ids, bounded at both ends. Call refresh_doc_vectors over the same slices first.';
