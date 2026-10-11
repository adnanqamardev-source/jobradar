-- 0011_feed_search.sql — feed read path: full-text search + per-user state (BE-306)
-- Depends on: 0003_remote_scope.sql (which last replaced v_ranked_jobs)
-- Forward-only: 0003 is already applied, so the view is dropped and recreated here,
-- exactly as 0003 did to 0001. Never edit an applied migration.

-- ===================================================================
-- Full-text search column on jobs
-- ===================================================================
-- FED-003 requires keyword search via `websearch_to_tsquery` — never string-
-- concatenated SQL (docs/03 §6.2 S-01). PostgREST's `wfts` textSearch operator
-- maps to websearch_to_tsquery, but it needs a tsvector column to target.
--
-- A GENERATED ALWAYS ... STORED column rather than a trigger-maintained one:
-- the vector can never drift from the source columns, and it is written on
-- insert/update by Postgres itself. 'english' config matches the corpus
-- (English-language postings) and the docs/02a §5.9 search-path decision.
--
-- description_text is included because it is the sanitised plain text
-- (src/lib/ingest/sanitize.ts output) — searching description_html would
-- match markup, and the plain text is what the user reads anyway.

alter table jobs add column if not exists search_vector tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' ||
      coalesce(company_name, '') || ' ' ||
      coalesce(description_text, '')
    )
  ) stored;

-- GIN, not GiST: the feed is read-heavy with no write-time penalty concern,
-- and GIN lookup is faster for a static-ish corpus (docs/02a §5.9).
create index if not exists idx_jobs_search_vector
  on jobs using gin (search_vector);

-- ===================================================================
-- v_ranked_jobs — extended for the feed
-- ===================================================================
-- The 0003 column list was the minimum for scoring. The feed (FED-001) needs
-- company identity, salary, location, the score breakdown (JOB-002), sighting
-- count (FED-005), first_seen_at (FED-004), and the caller's own saved /
-- dismissed / applied state (FED-002 flags).
--
-- Per-user state uses EXISTS subqueries against auth.uid(), NOT a join:
--   * the view is security_invoker, so the subqueries run as the caller and
--     RLS on job_events / applications applies to them exactly as it would to
--     a direct query — the caller sees only their own rows;
--   * a join would multiply rows (one per event) and require DISTINCT, which
--     breaks cursor pagination.
--
-- user_id is exposed from job_scores so the feed query can assert the score
-- row belongs to the caller (defence in depth on top of RLS).

drop view if exists v_ranked_jobs;

create view v_ranked_jobs with (security_invoker = true) as
select
  j.id,
  j.title,
  j.company_name,
  j.company_domain,
  j.location_raw as location,
  j.city,
  j.region,
  j.country_code,
  j.work_mode,
  j.remote_scope,
  j.employment_type,
  j.seniority,
  j.salary_min,
  j.salary_max,
  j.salary_currency,
  j.salary_period,
  j.posted_at,
  j.first_seen_at,
  j.last_seen_at,
  j.status,
  j.skills,
  j.sighting_count,
  j.search_vector,
  s.user_id,
  s.final_score,
  s.rule_score,
  s.semantic_score,
  s.breakdown,
  s.explanation,
  s.scored_at,
  exists (
    select 1 from job_events e
    where e.job_id = j.id and e.user_id = auth.uid() and e.event = 'save'
  ) as saved,
  exists (
    select 1 from job_events e
    where e.job_id = j.id and e.user_id = auth.uid() and e.event = 'dismiss'
  ) as dismissed,
  exists (
    select 1 from applications a
    where a.job_id = j.id and a.user_id = auth.uid()
  ) as applied
  from jobs j
  left join job_scores s on s.job_id = j.id
  where j.status = 'active';
