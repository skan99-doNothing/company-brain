-- What the index actually holds, per department.
--
-- The map used to carry these numbers as literals pasted in by hand, which is
-- the same failure the config was built to stop: a second copy of a fact that
-- drifts from the first. This is the one query behind them, so the generator
-- reads the database instead of remembering it.
--
-- Documents with no department are real and are reported as '(unrouted)'
-- rather than dropped: 19 documents and 241 backfilled sessions land there,
-- and hiding them would make the totals on the map disagree with the totals in
-- the table.

create or replace function public.department_stats()
returns table (
  department text,
  documents  int,
  passages   int,
  sessions   int,
  newest     date
)
language sql
stable
as $function$
  with doc as (
    select coalesce(d.department, '(unrouted)') as dept,
           count(distinct d.id)::int            as documents,
           count(c.id)::int                     as passages,
           max(d.mtime)::date                   as newest
    from documents d
    left join chunks c on c.document_id = d.id
    group by 1
  ),
  ses as (
    select coalesce(s.department, '(unrouted)') as dept,
           count(*)::int                        as sessions
    from sessions s
    group by 1
  )
  select doc.dept,
         doc.documents,
         doc.passages,
         coalesce(ses.sessions, 0),
         doc.newest
  from doc
  left join ses on ses.dept = doc.dept
  order by doc.documents desc
$function$;
