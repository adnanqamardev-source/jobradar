-- 0003_remote_scope.sql — distinguish India-remote from international-remote (BE-317)
-- Depends on: 0001_init.sql
-- Forward-only: 0001 is already applied, so this change is additive. Never edit 0001.

-- ===================================================================
-- Enum
-- ===================================================================
-- Why an enum and not `text` + CHECK: the set is stable and closed — a
-- "remote_scope" that means something else is a bug, not a new requirement.
-- Same convention as work_mode / seniority / employment_type (docs/02a §5.2).

create type remote_scope as enum ('india', 'global', 'unknown');

-- ===================================================================
-- Column on jobs
-- ===================================================================
-- `work_mode` answers "remote or not". This answers *which* remote, which is a
-- different question: "Remote - India" and "Remote - Worldwide" are both `remote`
-- and are not interchangeable for an Indian candidate. Filtering on `work_mode`
-- alone cannot tell them apart, and a full-text match on the location string
-- cannot do it reliably either.

alter table jobs add column if not exists remote_scope remote_scope default 'unknown';

-- ===================================================================
-- Index
-- ===================================================================
-- The feed filters on country + remote scope, and `work_mode` is almost always
-- 'remote' for the rows that matter, so an index on remote_scope alone would not
-- narrow anything. Leading with work_mode matches the real query shape:
--   where work_mode = 'remote' and remote_scope = 'india' and status = 'active'

create index if not exists idx_jobs_work_mode_remote_scope
  on jobs (work_mode, remote_scope)
  where status = 'active';

-- ===================================================================
-- No foreign key, so no index owed
-- ===================================================================
-- `remote_scope` is an enum, not an FK. It is deliberately absent from the
-- docs/02a §5.10 FK-index checklist; noted here because that section is the
-- checklist people read.

-- ===================================================================
-- v_ranked_jobs must expose it
-- ===================================================================
-- The feed reads through this view, and the view lists its columns one by one on
-- purpose (docs/02a §5.9 — `select j.*` was one of the three bugs fixed there).
-- A new column therefore does NOT appear automatically. Left alone, the UI would
-- offer an "India only" filter that silently returns nothing.

-- DROP + CREATE, not CREATE OR REPLACE: Postgres refuses to insert a column
-- before existing ones, and this one belongs next to work_mode. The column list
-- below is copied from 0001 verbatim (including `location_raw as location`) so the
-- only difference is the added remote_scope.
drop view if exists v_ranked_jobs;

create view v_ranked_jobs with (security_invoker = true) as
select
  j.id,
  j.title,
  j.company_name,
  j.location_raw as location,
  j.work_mode,
  j.remote_scope,
  j.employment_type,
  j.seniority,
  j.posted_at,
  j.last_seen_at,
  j.status,
  j.skills,
  s.final_score,
  s.breakdown,
  s.explanation,
  s.scored_at
  from jobs j
  left join job_scores s on s.job_id = j.id
 where j.status = 'active';