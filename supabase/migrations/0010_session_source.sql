-- Where a session came from.
--
-- The sessions table was written for Claude Code, whose Stop hook fills it in.
-- Codex keeps its own record at ~/.codex/sessions in the same shape, 130 files
-- and 1.3 GB of it, and nothing read them, so half the work done on this machine
-- was invisible to the brain that is supposed to remember it.
--
-- Existing rows are all Claude Code, so the default backfills them correctly and
-- no update is needed.

alter table sessions add column if not exists source text not null default 'claude-code';

create index if not exists sessions_source_idx on sessions (source, started_at desc);

comment on column sessions.source is
  'claude-code | codex. Which agent produced the session, so recent_sessions can '
  'report on either or both.';
