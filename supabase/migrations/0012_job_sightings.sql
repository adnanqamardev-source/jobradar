-- 0012_job_sightings.sql — per-source sightings for a canonical job (FED-005)
--
-- ## Why this migration exists
--
-- `jobs.dedupe_hash` is UNIQUE, so a "duplicate cluster" is **one row**: ingestion collapses
-- every sighting of a posting onto it and records only `jobs.sighting_count`, an integer.
-- That integer is enough for the "Seen on N sources" chip, and it is why FED-005's first
-- done-when ("dismissing the cluster dismisses all occurrences") was already satisfied by
-- `dismissJob` with no extra work.
--
-- FED-005's other done-when — "lists sources in the detail view" — had **nothing to read**.
-- The count cannot tell you *which* sources, and no table stored the individual sightings.
-- This migration adds that record.
--
-- ## Shape
--
-- One row per (job, source posting URL). The URL rather than `source_id` is the natural key:
-- the same source can list two genuinely different roles, and the URL is what identifies a
-- posting within it. `source_id` is kept alongside for the "which provider" grouping and is
-- `on delete set null`, so deactivating a source does not delete the evidence that a posting
-- was once seen there.
--
-- `first_seen_at` is set on insert and preserved on conflict, for the same reason
-- `jobs.first_seen_at` is (`0010_upsert_job.sql`): a posting re-listed daily must not look
-- brand new forever or never decay to `stale` (ING-010).
--
-- `sighting_count` is per-source: the same posting arriving from one source every hour is
-- three sightings of that source, but still one canonical job with one cluster.
--
-- ## Security
--
-- This is shared corpus data, exactly like `jobs` itself — not user data. The read policy
-- mirrors `jobs_authenticated_read` (`0001_init.sql:666`), and writes only ever happen inside
-- `upsert_job`, which is `security definer` and granted to `service_role` alone. There is no
-- policy an end user could use to fabricate a sighting.
--
-- Grants follow the 0008/0010 lesson: Supabase sets `ALTER DEFAULT PRIVILEGES` per role, so
-- revoking from PUBLIC alone is a no-op. Every role is revoked explicitly.

-- ===================================================================
-- Table
-- ===================================================================

create table job_sightings (
  job_id uuid not null references jobs(id) on delete cascade,
  source_id uuid references sources(id) on delete set null,
  source_url text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sighting_count integer not null default 1,
  primary key (job_id, source_url)
);

-- The primary key leads with job_id, so the detail view's "sources for this job" lookup is
-- already covered. This index serves the inverse question ("which postings did this source
-- contribute"), which is what the admin source-health view (ADM-002) will ask.
create index idx_job_sightings_source_id on job_sightings (source_id);

-- Corpus data: readable by any authenticated user, writable only by the ingestion worker.
alter table job_sightings enable row level security;
alter table job_sightings force row level security;

create policy job_sightings_authenticated_read on job_sightings
  for select using (auth.role() = 'authenticated');

-- No insert/update/delete policies exist for anon or authenticated. Under RLS a table with
-- no matching policy denies the operation outright, so "no policy" is the restriction here --
-- there is nothing to grant and therefore nothing to revoke. (This is the difference from the
-- `revoke` lesson in 0008: that was about *function* default privileges, which Supabase grants
-- per role whether or not a policy exists. Table writes are gated by policy, not by ACL.)

comment on table job_sightings is
  'One row per (job, source posting URL): where each sighting of a canonical job was seen. jobs.sighting_count is the cluster total; this is the per-source breakdown FED-005 lists. Written only by upsert_job (service_role).';

-- ===================================================================
-- upsert_job — record the sighting
-- ===================================================================
--
-- `create or replace`, same signature and same return type as 0010, so no call site changes.
-- The sighting insert is deliberately **not** exception-safe-by-omission: if it fails, the
-- whole function fails and the caller records the posting as failed rather than writing a job
-- whose cluster count claims sources that were never recorded. A sighting count that silently
-- disagrees with the sighting table is worse than a failed write that retries.

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
  -- which is what the first application of migration 0010 failed with).
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
    source_id,
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
    v_row.source_id,
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

  -- The per-source sighting. `on conflict do update` on the same (job, source_url) so a
  -- re-listing from one provider bumps that provider's count instead of adding a row.
  --
  -- `source_id` is written on insert only: the first sighting is the one the rest of the
  -- pipeline attributes, matching how `upsert_job` treats `jobs.source_id` (see 0010).
  insert into public.job_sightings (job_id, source_id, source_url)
  values (v_out.id, v_row.source_id, v_row.source_url)
  on conflict (job_id, source_url) do update set
    sighting_count = job_sightings.sighting_count + 1,
    last_seen_at   = now(),
    first_seen_at  = job_sightings.first_seen_at;

  return v_out;
end;
$$;

comment on function public.upsert_job(jsonb) is
  'Insert or re-sight one canonical job keyed on dedupe_hash, and record the sighting in job_sightings. On conflict increments sighting_count by 1, refreshes last_seen_at, and preserves first_seen_at. Exists because PostgREST upsert cannot express sighting_count = sighting_count + 1: it renders do-update values as literals, so the increment needs SQL. The hash and merge decisions live in src/lib/ingest/dedupe.ts. Does not revive a stale/expired job - that is ING-010.';

-- Reclaim from the explicit default-privilege grants (see 0008's header for the proof that a
-- PUBLIC-only revoke is a no-op here) and grant only to the worker role.
revoke execute on function public.upsert_job(jsonb) from anon;
revoke execute on function public.upsert_job(jsonb) from authenticated;
revoke execute on function public.upsert_job(jsonb) from public;

grant execute on function public.upsert_job(jsonb) to service_role;