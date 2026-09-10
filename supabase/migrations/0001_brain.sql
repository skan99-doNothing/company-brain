-- Phase 1 schema for the company brain.
--
-- Everything here is derived. Markdown on disk is the source of truth, and this
-- whole schema can be dropped and rebuilt by re-running the indexer. Nothing is
-- stored here that does not exist as a file somewhere.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- documents --
-- One row per file. content_hash is what makes re-indexing cheap: an unchanged
-- file is skipped without reading or embedding it again.

create table if not exists documents (
  id            bigint generated always as identity primary key,
  source_path   text        not null unique,   -- absolute path on this machine
  vault         text        not null,          -- context | content | hiddengems | code | org
  department    text,                          -- growth | product | ... | null if unowned
  doc_type      text        not null,          -- note | brief | ledger | decision | readme | session
  title         text,
  frontmatter   jsonb       not null default '{}'::jsonb,
  mtime         timestamptz not null,
  content_hash  text        not null,
  bytes         integer     not null default 0,
  indexed_at    timestamptz not null default now()
);

create index if not exists documents_department_idx on documents (department);
create index if not exists documents_vault_idx      on documents (vault);
create index if not exists documents_doc_type_idx   on documents (doc_type);

-- ------------------------------------------------------------------- chunks --
-- heading_path keeps the document's structure attached to the chunk, so a hit
-- can be cited as "file > section > subsection" instead of a naked paragraph.
--
-- fts is generated rather than maintained, so the lexical index can never drift
-- out of step with the text it indexes.

create table if not exists chunks (
  id            bigint generated always as identity primary key,
  document_id   bigint      not null references documents (id) on delete cascade,
  ord           integer     not null,
  content       text        not null,
  heading_path  text,
  token_count   integer     not null default 0,
  embedding     vector(1024),
  fts           tsvector generated always as (to_tsvector('english', content)) stored,
  unique (document_id, ord)
);

create index if not exists chunks_fts_idx on chunks using gin (fts);

-- HNSW rather than IVFFlat: better recall at this size, no training step, and
-- no need to pick a list count before knowing the data. Build cost is trivial
-- at a few thousand rows.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- -------------------------------------------------------------------- links --
-- The Obsidian graph as edges. Unresolved links are kept deliberately: a link
-- to a note that does not exist is a statement of intent worth searching for.

create table if not exists links (
  id          bigint generated always as identity primary key,
  src_id      bigint not null references documents (id) on delete cascade,
  dst_id      bigint          references documents (id) on delete set null,
  link_text   text   not null,
  resolved    boolean not null default false,
  unique (src_id, link_text)
);

create index if not exists links_dst_idx on links (dst_id);

-- ----------------------------------------------------------------- sessions --
-- One row per Claude Code session, written by the Stop hook. transcript_path
-- points back at the markdown note in the vault; this table holds the structure
-- extracted from it, never the raw transcript.

create table if not exists sessions (
  id               bigint generated always as identity primary key,
  session_id       text        not null unique,
  started_at       timestamptz not null,
  department       text,
  cwd              text,
  summary          text        not null,
  files_touched    jsonb       not null default '[]'::jsonb,
  decisions        jsonb       not null default '[]'::jsonb,
  open_threads     jsonb       not null default '[]'::jsonb,
  friction         jsonb       not null default '[]'::jsonb,
  transcript_path  text,
  embedding        vector(1024),
  fts              tsvector generated always as (to_tsvector('english', summary)) stored
);

create index if not exists sessions_department_idx on sessions (department);
create index if not exists sessions_started_idx    on sessions (started_at desc);
create index if not exists sessions_fts_idx        on sessions using gin (fts);
create index if not exists sessions_embedding_idx
  on sessions using hnsw (embedding vector_cosine_ops);

-- --------------------------------------------------------------------- rls --
-- Row level security on with no policies at all. The indexer and mcp-brain use
-- the secret key, which bypasses RLS. Anything holding only the publishable key
-- therefore reads nothing, which is the correct default for a personal brain.

alter table documents enable row level security;
alter table chunks    enable row level security;
alter table links     enable row level security;
alter table sessions  enable row level security;
