-- One identity for a thing across every department that mentions it.
--
-- The obvious build is GraphRAG: an LLM pass over every chunk extracting
-- entities and relationships. Measured on this machine, gemma4 takes 200
-- seconds per document warm, so a full pass over 1,368 documents is 76 hours
-- and has to re-run as the corpus moves. That is not a pipeline, it is a
-- monument.
--
-- The cheaper route is that the vault already declares its entities. A note that
-- writes [[People/A Collaborator]] or [[Projects/Some Product]] names the kind in
-- the namespace, and that namespace
-- in front of the slash is the kind, stated by the person who knows. 40 links
-- name 8 people, 19 name 3 projects, and org.config.json names 46 units. That
-- seed costs nothing and is more trustworthy than extraction, because a human
-- declared it.
--
-- What the seed cannot do is find a name that was never linked. That is what
-- mentions are for: once an entity has a name, finding every document that says
-- it is one index scan, and the departments those documents sit in are the
-- cross-department identity that nothing else in this system could produce.

create table if not exists entities (
  id          bigserial primary key,
  name        text not null unique,
  kind        text not null,
  -- Where the name came from, so a bad seed can be dropped without touching
  -- anything a person wrote by hand.
  source      text not null default 'wikilink',
  aliases     text[] not null default '{}',
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists entities_kind_idx on entities (kind, name);

create table if not exists entity_mentions (
  entity_id   bigint not null references entities (id) on delete cascade,
  document_id bigint not null references documents (id) on delete cascade,
  hits        int not null default 1,
  primary key (entity_id, document_id)
);

create index if not exists entity_mentions_doc_idx on entity_mentions (document_id);

alter table entities enable row level security;
alter table entity_mentions enable row level security;

-- ---------------------------------------------------------------- rebuild --
--
-- Word boundaries matter more than they look. Without \m and \M an entity
-- called "Career" matches "careers", "Careerist" and every URL containing the
-- letters, and the resulting mention counts are noise wearing a number's
-- clothes. Metacharacters in a name are escaped, because a project legitimately
-- called "GEX (v2)" would otherwise be an invalid regex and take the whole
-- rebuild down.

create or replace function rebuild_entity_mentions()
returns int
language plpgsql
as $fn$
declare n int;
begin
  set local statement_timeout = '10min';
  -- truncate, not delete. PostgREST runs with pg_safeupdate, which refuses an
  -- unqualified DELETE, so the same function works over direct SQL and fails
  -- over the API. rebuild_related learned this a week ago and this repeated it.
  truncate table entity_mentions;

  -- Two stages, and the order is the whole performance story. The regex alone
  -- is a nested loop: 66 entities across 13,401 chunks is 22 MB of text scanned
  -- 66 times, which ran past a ten minute timeout. phraseto_tsquery hits the
  -- GIN index on fts and narrows to a handful of chunks per entity first, and
  -- only those get the exact check.
  --
  -- Both stages are needed. FTS stems, so "Career" would also match "careers",
  -- and the word-boundary regex is what makes the count mean what it says.
  insert into entity_mentions (entity_id, document_id, hits)
  select e.id, c.document_id, count(*)::int
  from entities e
  join chunks c
    on c.fts @@ phraseto_tsquery('english', e.name)
   and c.search_text ~* ('\m' || regexp_replace(e.name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M')
  -- A one or two character name matches everything and means nothing.
  where length(e.name) >= 3
  group by e.id, c.document_id;

  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- ----------------------------------------------------------------- report --
--
-- An entity that shows up in one department is a note. An entity that shows up
-- in four is a thread running through the business that nobody has drawn.

create or replace function entity_reach(min_depts int default 1, k int default 40)
returns table (
  name        text,
  kind        text,
  note        text,
  documents   int,
  departments int,
  depts       text[]
)
language sql
stable
as $$
  select
    e.name,
    e.kind,
    e.note,
    count(distinct m.document_id)::int as documents,
    count(distinct d.department)::int  as departments,
    array_agg(distinct d.department) filter (where d.department is not null) as depts
  from entities e
  join entity_mentions m on m.entity_id = e.id
  join documents d       on d.id = m.document_id
  group by e.id, e.name, e.kind, e.note
  having count(distinct d.department) >= min_depts
  order by count(distinct d.department) desc, count(distinct m.document_id) desc
  limit greatest(k, 1);
$$;

-- Where one entity actually lives, for the tool that answers "who is this".
--
-- Capped per department, not globally. Ranking a flat list by hit count buries
-- the answer: "crm" is mentioned in six departments, but eight near-identical
-- course slides in Growth say it seventeen times each, so a global top ten is
-- ten rows from one folder and the cross-department reach, which is the entire
-- reason this table exists, disappears.
create or replace function entity_documents(
  entity_name text,
  k           int default 30,
  per_dept    int default 4
)
returns table (
  title       text,
  department  text,
  doc_type    text,
  source_path text,
  hits        int
)
language sql
stable
as $$
  select r.title, r.department, r.doc_type, r.source_path, r.hits
  from (
    select
      d.title, d.department, d.doc_type, d.source_path, m.hits,
      row_number() over (
        partition by coalesce(d.department, '(unrouted)')
        order by m.hits desc, d.mtime desc
      ) as rn
    from entities e
    join entity_mentions m on m.entity_id = e.id
    join documents d       on d.id = m.document_id
    where lower(e.name) = lower(entity_name)
       or lower(entity_name) = any (select lower(a) from unnest(e.aliases) a)
  ) r
  where r.rn <= greatest(per_dept, 1)
  order by r.hits desc, r.department
  limit greatest(k, 1);
$$;

grant select on entities, entity_mentions to service_role;
grant execute on function rebuild_entity_mentions() to service_role;
grant execute on function entity_reach(int, int) to service_role, authenticated;
grant execute on function entity_documents(text, int) to service_role, authenticated;
