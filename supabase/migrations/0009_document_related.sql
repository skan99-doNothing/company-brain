-- Read access to the correlation edges.
--
-- 0008 built the edges and nothing could ask for them. 8,741 of them, 1,572
-- crossing a department boundary, sitting in a table that no tool touched, which
-- is the same failure as an empty ledger: the knowledge existed and could not be
-- reached at the moment it was needed.
--
-- Two questions worth answering, so two functions. What is this note related to,
-- asked while looking at one note. And what does the corpus think belongs
-- together that nobody has linked, asked when you do not have a note in hand.

-- ------------------------------------------------ what is this related to --

create or replace function document_related(doc_id bigint, k int default 8)
returns table (
  title       text,
  department  text,
  doc_type    text,
  source_path text,
  similarity  real,
  crossing    boolean
)
language sql
stable
as $$
  select
    d.title,
    d.department,
    d.doc_type,
    d.source_path,
    r.similarity,
    -- Crossing is the interesting flag. Two notes in the same folder being
    -- similar is what a folder is for; the same subject in Capital and in Labs
    -- is context nobody had.
    (d.department is not null
     and src.department is not null
     and d.department <> src.department) as crossing
  from related r
  join documents d   on d.id = r.dst_id
  join documents src on src.id = r.src_id
  where r.src_id = doc_id
  order by r.similarity desc
  limit greatest(k, 1);
$$;

-- ------------------------------------- what belongs together across the org --
--
-- One row per unordered pair, so a mutual match is not reported twice, and only
-- pairs where both sides carry a department.
--
-- Both sides matters. 19 documents are deliberately unrouted: HOME.md,
-- CLAUDE.md, decisions.md and the 16 briefs and ledgers, which belong to the org
-- rather than to any one department. Letting those count as a crossing filled
-- the whole report with "labs ledger resembles the org's own front page", which
-- is true and worth nothing.
--
-- The distinct-on has to sit in a subquery. Postgres requires the outer ORDER BY
-- of a DISTINCT ON query to lead with the distinct key, so ordering by
-- similarity at that level is not allowed and the rows come back in path order.
-- The first version of this shipped that way and returned 0.950, 0.775, 0.852:
-- correct rows, meaningless sequence, and easy to miss because every individual
-- row looked right.

create or replace function related_crossing(k int default 20, dept text default null)
returns table (
  a_title    text,
  a_dept     text,
  a_path     text,
  b_title    text,
  b_dept     text,
  b_path     text,
  similarity real
)
language sql
stable
as $$
  select p.a_title, p.a_dept, p.a_path, p.b_title, p.b_dept, p.b_path, p.similarity
  from (
    select distinct on (least(ds.source_path, dd.source_path), greatest(ds.source_path, dd.source_path))
      ds.title       as a_title,
      ds.department  as a_dept,
      ds.source_path as a_path,
      dd.title       as b_title,
      dd.department  as b_dept,
      dd.source_path as b_path,
      r.similarity   as similarity
    from related r
    join documents ds on ds.id = r.src_id
    join documents dd on dd.id = r.dst_id
    where ds.department is not null
      and dd.department is not null
      and ds.department <> dd.department
      and (dept is null or ds.department = dept or dd.department = dept)
      -- A pair of byte-identical files is a copy, not a connection. The
      -- duplicates tool reports those and this one should not repeat it.
      and ds.content_hash is distinct from dd.content_hash
    order by
      least(ds.source_path, dd.source_path),
      greatest(ds.source_path, dd.source_path),
      r.similarity desc
  ) p
  order by p.similarity desc
  limit greatest(k, 1);
$$;

grant execute on function document_related(bigint, int) to service_role, authenticated;
grant execute on function related_crossing(int, text) to service_role, authenticated;
