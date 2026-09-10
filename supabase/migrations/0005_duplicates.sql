-- Duplicate detection belongs in the database.
--
-- The first version fetched every document row and grouped them by hash in the
-- client. At 926 documents that is a large response for a question Postgres can
-- answer with one GROUP BY, and on a shared-CPU instance it was enough to make a
-- concurrent search hit the statement timeout.

create or replace function duplicate_documents(k int default 20)
returns table (
  content_hash text,
  copies       int,
  bytes        int,
  wasted_bytes bigint,
  paths        text[]
)
language sql
stable
as $fn$
  select d.content_hash,
         count(*)::int as copies,
         min(d.bytes)::int as bytes,
         (sum(d.bytes) - min(d.bytes))::bigint as wasted_bytes,
         array_agg(d.source_path order by d.source_path) as paths
  from documents d
  group by d.content_hash
  having count(*) > 1
  order by (sum(d.bytes) - min(d.bytes)) desc
  limit k
$fn$;

comment on function duplicate_documents is
  'Byte-identical documents grouped by content hash, worst waste first. Cheap because the hash is already stored for incremental indexing.';
