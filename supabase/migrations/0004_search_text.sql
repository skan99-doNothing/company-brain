-- The lexical arms were searching less text than the vector arm.
--
-- At index time a chunk is embedded as "heading path + content", so the vector
-- knows about the heading. But the generated tsvector column and the trigram
-- index were both built from `content` alone. A chunk whose heading reads
-- "3 · robots@web2print-it.example" and whose body never repeats the address was
-- therefore invisible to full text and to the literal-token arm, while being
-- perfectly findable by vector. Searching for a client by name ranked a generic
-- SECURITY.md above the email thread about that client.
--
-- search_text is what all three arms now agree on: the same text the embedding
-- saw. It is generated, so it can never drift from its inputs.

alter table chunks
  add column if not exists search_text text
  generated always as (coalesce(heading_path, '') || ' ' || content) stored;

-- fts has to be rebuilt against the new column. Dropping a generated column and
-- recreating it is cheap here; nothing depends on its identity.
drop index if exists chunks_fts_idx;
alter table chunks drop column if exists fts;

-- Note: adding this column takes long enough that the Management API gives up
-- waiting, but Postgres finishes the work regardless. An API timeout here is not
-- a failed statement; check information_schema before assuming anything.
alter table chunks
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(heading_path, '') || ' ' || content)) stored;

create index if not exists chunks_fts_idx on chunks using gin (fts);

-- Trigram index moves to the same text, for the same reason.
create index if not exists chunks_search_trgm_idx
  on chunks using gin (search_text gin_trgm_ops);

drop index if exists chunks_content_trgm_idx;
