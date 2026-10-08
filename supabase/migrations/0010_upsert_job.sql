-- 0010_upsert_job.sql — the dedupe upsert, with the sighting increment that PostgREST cannot express (BE-107)
--
-- ## Why this migration exists
--
-- Running `tests/integration/dedupe.db.test.ts` against a real Postgres for the first time
-- (2026-10-09) failed the headline acceptance criterion:
--
--   three upserts of one posting -> sighting_count = 1, not 3
--
-- The cause is not a bug in `computeDedupeHash` and not a bug in `upsertCanonicalJob`. It is
-- that **`supabase-js`'s `.upsert()` cannot express the increment.** PostgREST renders
-- `on conflict (dedupe_hash) do update set <col> = <value>` from the JSON payload, where every
-- value is a *literal*. `docs/02b` §6.2 requires:
--
--   do update set last_seen_at = now(), sighting_count = jobs.sighting_count + 1
--
-- `jobs.sighting_count + 1` is an expression over the existing row, not a literal, so there
-- is nothing to send. The previous code sent no `sighting_count` at all, which left the
-- column at its `default 1` on insert and untouched on conflict. The job count was right and
-- the sighting count was silently wrong — and because `sighting_count` drives the "seen on N
-- sources" chip, that is a user-visible lie rather than a cosmetic one.
--
-- The alternative that avoids a migration — upsert, then a second `update` that increments —
-- is rejected deliberately: it is two round trips, and two workers re-sighting the same
-- posting concurrently can both read `1` and both write `2`. The unique index still prevents
-- a duplicate row, so the corpus stays correct, but the count under-reports. A single
-- `insert ... on conflict do update` is one atomic statement, so the read-modify-write happens
-- under the row lock with nothing to race.
--
-- ## What this function does NOT do
--
-- Same rule as `0009_claim_task_queue.sql`: the *decisions* live in TypeScript
-- (`src/lib/ingest/dedupe.ts` — hash, fuzzy threshold, merge choice). This function performs
-- the one write those decisions imply.
--
-- On conflict it touches **only** the sighting bookkeeping:
--
--   - `sighting_count = t.sighting_count + 1`  — the increment
--   - `last_seen_at   = now()`                 — the re-sighting time
--   - `first_seen_at  = t.first_seen_at`       — NEVER reset
--
-- `first_seen_at` is the important one. It is set on insert and then preserved, because a job
-- re-listed daily would otherwise look brand new forever and never decay to `stale`
-- (ING-010). Resetting it is exactly the bug the integration test caught on its first run.
--
-- The payload columns are deliberately **not** updated on conflict. The first sighting is the
-- one whose `source_id` and `raw` the rest of the pipeline attributes, and letting a later
-- sighting overwrite them would repoint an already-scored row at a different source. Merging
-- a *richer* description is the fuzzy pass's job (`docs/02b` §6.2), not this function's.
--
-- ## Not decided here: does a re-sighting revive an `expired` job?
--
-- A re-sighted job arguably should go back to `active`, but `status` is not in the update
-- clause above, so a re-sighting does **not** currently revive a `stale`/`expired` row. That
-- is a policy question for ING-010 (freshness lifecycle), and answering it here would encode
-- a decision this ticket does not own. Recorded as an open item rather than guessed.
--
-- ## Security
--
-- `security definer`, because `jobs` has RLS enabled *and forced* (`0001_init.sql`), so the
-- owner role would be filtered by its own policies.
--
-- The grants follow the lesson proven in `0008_restrict_rescore_to_authenticated.sql`: Supabase
-- sets `ALTER DEFAULT PRIVILEGES` granting EXECUTE to `anon`/`authenticated`/`service_role`
-- **per role**, so revoking from `PUBLIC` alone removes a grant that was never there and
-- changes nothing. Each role is revoked explicitly, and the ACL is asserted in
-- `tests/integration/queue-rpc-privileges.test.ts` via `has_function_privilege` — never by
-- re-reading the GRANT, which is the mistake 0008 documents.

create or replace function public.upsert_job(p_row jsonb)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
  v_out public.jobs;
begin
  -- Type-check the payload in one shot: an unknown key or a wrongly-typed value raises here
  -- rather than as an opaque cast failure on a column further down.
  v_row := jsonb_populate_record(null::public.jobs, p_row);

  -- `returning … into v_out` rather than `return query`: this function returns a single
  -- `public.jobs` row, and `return query` is only legal in a SETOF function (SQLSTATE 42804,
  -- which is what the first application of this migration failed with).
  insert into public.jobs as t (
    dedupe_hash,
    title,
    title_norm,
    company_name,
    company_domain,
    location_raw,
    city,
    region,
    country_code,
    work_mode,
    employment_type,
    seniority,
    salary_min,
    salary_max,
    salary_currency,
    salary_period,
    salary_raw,
    description_text,
    description_html,
    skills,
    posted_at,
    source_url,
    apply_url,
    status,
    confidence,
    raw
  ) values (
    v_row.dedupe_hash,
    v_row.title,
    v_row.title_norm,
    v_row.company_name,
    v_row.company_domain,
    v_row.location_raw,
    v_row.city,
    v_row.region,
    v_row.country_code,
    v_row.work_mode,
    v_row.employment_type,
    v_row.seniority,
    v_row.salary_min,
    v_row.salary_max,
    v_row.salary_currency,
    v_row.salary_period,
    v_row.salary_raw,
    v_row.description_text,
    v_row.description_html,
    v_row.skills,
    v_row.posted_at,
    v_row.source_url,
    v_row.apply_url,
    coalesce(v_row.status, 'active'),
    coalesce(v_row.confidence, 1.0),
    v_row.raw
  )
  on conflict (dedupe_hash) do update set
    sighting_count = t.sighting_count + 1,
    last_seen_at   = now(),
    first_seen_at  = t.first_seen_at,
    updated_at      = now()
  returning t.* into v_out;

  return v_out;
end;
$$;

comment on function public.upsert_job(jsonb) is
  'Insert or re-sight one canonical job keyed on dedupe_hash. On conflict increments sighting_count by 1, refreshes last_seen_at, and preserves first_seen_at. Exists because PostgREST upsert cannot express sighting_count = sighting_count + 1: it renders do-update values as literals, so the increment needs SQL. The hash and merge decisions live in src/lib/ingest/dedupe.ts. Does not revive a stale/expired job - that is ING-010.';

-- Reclaim from the explicit default-privilege grants (see 0008's header for the proof that a
-- PUBLIC-only revoke is a no-op here) and grant only to the worker role.
revoke execute on function public.upsert_job(jsonb) from anon;
revoke execute on function public.upsert_job(jsonb) from authenticated;
revoke execute on function public.upsert_job(jsonb) from public;

grant execute on function public.upsert_job(jsonb) to service_role;
