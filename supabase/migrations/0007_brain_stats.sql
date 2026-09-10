-- The shape of the vault, for the panel behind the index core.
--
-- Two things the department counts do not show. The link graph: how many
-- wikilinks exist and how many of them point at a document that is not in the
-- index, which is the honest count of broken links rather than a guess. And
-- where the documents actually sit on disk, which is a different cut from
-- which department claims them: one folder can feed two departments and a
-- department can own six folders.
--
-- Paths are absolute on disk, so they are normalised here rather than in five
-- callers. The repo root cannot be known from inside the database and must not be
-- hardcoded, so the relative path is cut at the `vaults/` segment instead, which
-- every linked root sits under. Segment 2 is then the vault and segment 3 the
-- folder directly beneath it, which is the level a person actually thinks in.
-- A document above `vaults/`, such as a ledger or decisions.md, has no vault and
-- is dropped rather than having its path segments counted as folder names.

create or replace function public.brain_stats()
returns jsonb
language sql
stable
as $function$
  with slashed as (
    select replace(source_path, '\', '/') as p from documents
  ),
  norm as (
    select case
             when strpos(p, '/vaults/') > 0
               then substr(p, strpos(p, '/vaults/') + 1)
           end as rel
    from slashed
  ),
  folders as (
    select split_part(rel, '/', 2) as vault,
           split_part(rel, '/', 3) as folder,
           count(*)::int           as documents
    from norm
    where rel is not null and split_part(rel, '/', 3) <> ''
    group by 1, 2
  )
  select jsonb_build_object(
    'documents',  (select count(*)::int from documents),
    'passages',   (select count(*)::int from chunks),
    'sessions',   (select count(*)::int from sessions),
    'wikilinks',  (select count(*)::int from links),
    'resolved',   (select count(*)::int from links where dst_id is not null),
    'broken',     (select count(*)::int from links where dst_id is null),
    'vaults',     (select count(distinct vault)::int from folders),
    'folders',    (select count(*)::int from folders),
    'newest',     (select max(mtime)::date from documents),
    -- Ordered by the numeric column, not by the json text. A text sort puts
    -- "95" above "167", which quietly mis-ranks the whole list.
    'byFolder',   (select coalesce(jsonb_agg(x order by documents desc), '[]'::jsonb)
                   from (
                     select jsonb_build_object('vault', vault, 'folder', folder, 'documents', documents) as x,
                            documents
                     from folders
                     where documents >= 5
                     order by documents desc
                     limit 24
                   ) t)
  )
$function$;
