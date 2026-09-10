-- Documents that are about the same thing, found by meaning rather than by
-- somebody having typed a wikilink.
--
-- The link graph only knows what was written down by hand, which is why 1,927
-- links cover 1,367 documents unevenly and 163 of them point at nothing. The
-- embeddings already know far more than that: a CRM note in one department, the
-- service that sends for it and the repo it was built in are the same
-- subject under three names in three departments, and nothing in the vault says
-- so. This is the edge the corpus already contains and could not express.
--
-- Similarity is between whole documents, not chunks. A chunk-level match fires
-- on one shared paragraph of boilerplate; a centroid asks whether the notes are
-- about the same thing overall, which is the question worth answering.

-- ------------------------------------------------------------- centroids --
-- Materialised because it is read once per document during a rebuild and the
-- average over 13,000 chunks is not something to recompute per query.

drop materialized view if exists doc_vectors cascade;

create materialized view doc_vectors as
select
  c.document_id,
  (avg(c.embedding))::vector(1024) as embedding,
  count(*)::int                    as chunks
from chunks c
where c.embedding is not null
group by c.document_id;

create unique index doc_vectors_pk on doc_vectors (document_id);
create index doc_vectors_hnsw on doc_vectors using hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------- edges --

create table if not exists related (
  src_id      bigint not null references documents (id) on delete cascade,
  dst_id      bigint not null references documents (id) on delete cascade,
  similarity  real   not null,
  primary key (src_id, dst_id)
);

create index if not exists related_src_idx on related (src_id, similarity desc);

alter table related enable row level security;

-- --------------------------------------------------------------- rebuild --
--
-- Top k neighbours per document, bounded at both ends. The floor keeps out
-- everything that merely shares a vocabulary. The ceiling keeps out copies: a
-- pair above it is the same file living in two places, which is the duplicates
-- tool's job to report and not a relationship worth showing.

create or replace function rebuild_related(
  k        int  default 8,
  min_sim  real default 0.55,
  max_sim  real default 0.985
) returns int
language plpgsql
as $$
declare
  n int;
begin
  refresh materialized view doc_vectors;
  delete from related;

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
  where nb.sim >= min_sim and nb.sim <= max_sim;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------- report --
--
-- The pairs worth looking at are the ones that cross a department boundary.
-- Two notes in the same folder being similar is what a folder is for; the same
-- subject showing up in Capital and in Labs is context nobody had.

create or replace function related_stats()
returns jsonb
language sql
stable
as $$
  with edges as (
    select
      r.similarity,
      ds.department as src_dept,
      dd.department as dst_dept,
      ds.title      as src_title,
      dd.title      as dst_title,
      ds.source_path as src_path,
      dd.source_path as dst_path
    from related r
    join documents ds on ds.id = r.src_id
    join documents dd on dd.id = r.dst_id
  ),
  crossing as (
    -- One row per unordered pair, so a mutual match is not counted twice.
    select distinct on (least(src_path, dst_path), greatest(src_path, dst_path))
      similarity, src_dept, dst_dept, src_title, dst_title, src_path, dst_path
    from edges
    where src_dept is distinct from dst_dept
    order by least(src_path, dst_path), greatest(src_path, dst_path), similarity desc
  )
  select jsonb_build_object(
    'edges',      (select count(*)::int from related),
    'documents',  (select count(distinct src_id)::int from related),
    'crossing',   (select count(*)::int from crossing),
    'pairs',      (select coalesce(jsonb_agg(x order by similarity desc), '[]'::jsonb)
                   from (
                     select jsonb_build_object(
                       'sim',  round(similarity::numeric, 3),
                       'a',    src_title, 'aDept', src_dept, 'aPath', src_path,
                       'b',    dst_title, 'bDept', dst_dept, 'bPath', dst_path
                     ) as x, similarity
                     from crossing
                     order by similarity desc
                     limit 40
                   ) t),
    'byPair',     (select coalesce(jsonb_agg(y order by n desc), '[]'::jsonb)
                   from (
                     select jsonb_build_object(
                       'a', least(src_dept, dst_dept),
                       'b', greatest(src_dept, dst_dept),
                       'n', count(*)::int
                     ) as y, count(*) as n
                     from crossing
                     group by least(src_dept, dst_dept), greatest(src_dept, dst_dept)
                     order by count(*) desc
                     limit 20
                   ) u)
  );
$$;

-- Read by the same roles that read the rest of the index.
grant select on related to service_role;
grant execute on function rebuild_related(int, real, real) to service_role;
grant execute on function related_stats() to service_role, authenticated, anon;
