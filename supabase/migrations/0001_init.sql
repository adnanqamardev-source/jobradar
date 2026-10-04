-- 0001_init.sql — JobRadar core schema (docs/02 §5)
-- Run via: supabase db reset

-- Enable required extensions
create extension if not exists vector;
create extension if not exists pg_cron;
create extension if not exists pg_trgm;

-- Create auth schema for Supabase compatibility (foreign keys reference auth.users)
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- -------------------------------------------------------------------
-- Local development only: mock auth.* functions
-- The real Supabase stack provides auth.uid(), auth.jwt(), auth.role().
-- For local Postgres (docker-compose.local.yml), run mock-auth.sql manually:
--   docker exec -i jobradar-db psql -U postgres -d postgres < mock-auth.sql
-- This enables RLS policies to function in local development.
-- -------------------------------------------------------------------

-- ===================================================================
-- 5.2 Enums
-- ===================================================================
create type user_role        as enum ('user','admin');
create type job_status       as enum ('active','stale','expired','removed');
create type work_mode        as enum ('remote','hybrid','onsite','unknown');
create type seniority        as enum ('intern','junior','mid','senior','lead','staff','principal','director','exec','unknown');
create type employment_type  as enum ('full_time','part_time','contract','internship','temporary','unknown');
create type prof_level       as enum ('familiar','proficient','expert');
create type app_stage        as enum ('discovered','saved','applied','screening','interview','offer','rejected','withdrawn');
create type task_status      as enum ('pending','running','done','failed','cancelled');
create type task_kind        as enum ('ingest_source','score_jobs','send_digest','rescore_profile','account_export','cleanup');
create type run_status       as enum ('running','success','partial','failed');
create type source_kind      as enum ('api_greenhouse','api_lever','api_ashby','api_remotive','api_arbeitnow','api_usajobs','api_adzuna','firecrawl_scrape','firecrawl_search');
create type plan_tier        as enum ('free','pro');
create type digest_channel   as enum ('email','slack');

-- ===================================================================
-- 5.3 Core account tables
-- ===================================================================

-- profiles — 1:1 with auth.users
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  avatar_url text,
  role user_role default 'user',
  plan plan_tier default 'free',
  target_titles text[] not null default '{}',
  seniority seniority default 'unknown',
  years_experience numeric(4,1),
  headline text,
  country_code char(2),
  city text,
  time_zone text,
  work_modes work_mode[] default '{}',
  hybrid_days_max smallint,
  min_salary numeric(12,0),
  salary_currency char(3) default 'USD',
  salary_period text check (salary_period in ('year','month','hour')),
  visa_required boolean,
  blocked_companies text[] default '{}',
  excluded_keywords text[] default '{}',
  preferred_companies text[] default '{}',
  profile_embedding vector(2048),
  onboarding_completed boolean default false,
  onboarding_step smallint default 1,
  last_digest_at timestamptz,
  last_seen_feed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for profiles
create index idx_profiles_target_titles on profiles using gin (target_titles);
create index idx_profiles_blocked_companies on profiles using gin (blocked_companies);
create index idx_profiles_excluded_keywords on profiles using gin (excluded_keywords);
create index idx_profiles_profile_embedding on profiles using hnsw ((profile_embedding::halfvec(2048)) halfvec_cosine_ops);

-- skills — canonical vocabulary (must be before profile_skills)
create table skills (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  slug text unique not null,
  aliases text[],
  category text
);

create index idx_skills_category on skills (category);
create index idx_skills_slug on skills (slug);

-- profile_skills
create table profile_skills (
  profile_id uuid not null references profiles(id) on delete cascade,
  skill_id uuid not null references skills(id) on delete cascade,
  level prof_level default 'proficient',
  years smallint,
  is_primary boolean default false,
  primary key (profile_id, skill_id)
);

create index idx_profile_skills_skill_id on profile_skills (skill_id);

-- resume_versions
create table resume_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  label text not null,
  storage_path text not null,
  is_default boolean default false,
  size_bytes integer,
  created_at timestamptz default now()
);

create index idx_resume_versions_user_id on resume_versions (user_id);

-- subscriptions — 1:1 with profiles
create table subscriptions (
  user_id uuid primary key references profiles(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text check (status in ('active','trialing','past_due','canceled','incomplete')),
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  updated_at timestamptz default now()
);

-- ===================================================================
-- 5.4 Job corpus tables
-- ===================================================================

-- companies
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  domain text unique,
  logo_url text,
  industry text,
  headcount text,
  ats_kind text,
  ats_slug text,
  watchers_count integer default 0,
  created_at timestamptz default now()
);

create index idx_companies_domain on companies (domain);
create index idx_companies_slug on companies (slug);

-- sources
create table sources (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  kind source_kind not null,
  config jsonb not null default '{}',
  enabled boolean default true,
  is_default boolean default true,
  cadence_minutes integer default 360,
  next_run_at timestamptz,
  consecutive_failures integer default 0,
  last_success_at timestamptz,
  last_error text,
  rate_limit_per_day integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- task_queue (must be before scrape_runs which references it)
create table task_queue (
  id uuid primary key default gen_random_uuid(),
  kind task_kind not null,
  payload jsonb not null default '{}',
  status task_status default 'pending',
  priority smallint default 100,
  run_after timestamptz default now(),
  attempts smallint default 0,
  max_attempts smallint default 3,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_task_queue_pending on task_queue (status, run_after, priority) where status = 'pending';

-- scrape_runs
create table scrape_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  task_id uuid references task_queue(id) on delete set null,
  status run_status not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,
  found integer default 0,
  inserted integer default 0,
  duplicates integer default 0,
  failed integer default 0,
  api_calls integer default 0,
  error text,
  log jsonb
);

create index idx_scrape_runs_source_id on scrape_runs (source_id);
create index idx_scrape_runs_task_id on scrape_runs (task_id);

-- jobs — the canonical posting
create table jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete set null,
  source_id uuid references sources(id) on delete set null,
  external_id text,
  source_url text not null,
  apply_url text,
  dedupe_hash text not null unique,
  title text not null,
  title_norm text,
  company_name text not null,
  company_domain text,
  location_raw text,
  city text,
  region text,
  country_code text,
  work_mode work_mode default 'unknown',
  salary_min numeric(12,0),
  salary_max numeric(12,0),
  salary_currency char(3),
  salary_period text,
  salary_raw text,
  seniority seniority default 'unknown',
  employment_type employment_type default 'unknown',
  description_text text,
  description_html text,
  skills text[],
  posted_at timestamptz,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  sighting_count integer default 1,
  status job_status default 'active',
  confidence numeric(3,2) default 1.0,
  embedding vector(2048),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for jobs
create unique index idx_jobs_dedupe_hash on jobs (dedupe_hash);
create index idx_jobs_status_last_seen on jobs (status, last_seen_at desc);
create index idx_jobs_status_posted on jobs (status, posted_at desc);
create index idx_jobs_skills on jobs using gin (skills);
create index idx_jobs_fts on jobs using gin (to_tsvector('english', title || ' ' || coalesce(description_text,'')));
create index idx_jobs_title_norm_trgm on jobs using gin (title_norm gin_trgm_ops);
create index idx_jobs_company_domain_trgm on jobs using gin (company_domain gin_trgm_ops);
create index idx_jobs_company_id on jobs (company_id);
create index idx_jobs_source_id on jobs (source_id);

-- Half-precision HNSW index on embedding (2048-dim exceeds pgvector 2000 limit for hnsw)
create index idx_jobs_embedding_hnsw on jobs using hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops);

-- job_skills — normalised many-to-many
create table job_skills (
  job_id uuid not null references jobs(id) on delete cascade,
  skill_id uuid not null references skills(id) on delete cascade,
  weight numeric(3,2) default 1.0,
  primary key (job_id, skill_id)
);

create index idx_job_skills_skill_id on job_skills (skill_id);

-- ===================================================================
-- 5.5 Matching tables
-- ===================================================================

-- job_scores
create table job_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  final_score numeric(5,2) not null,
  rule_score numeric(5,2),
  semantic_score numeric(5,2),
  gate_result jsonb,
  breakdown jsonb not null,
  explanation text,
  scored_at timestamptz default now(),
  model_version text,
  unique (user_id, job_id)
);

create index idx_job_scores_user_final on job_scores (user_id, final_score desc) where final_score >= 60;
create index idx_job_scores_job_id on job_scores (job_id);

-- job_events (derived, optional)
create table job_events (
  user_id uuid not null references profiles(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  event text check (event in ('view','save','dismiss','apply')),
  at timestamptz default now(),
  primary key (user_id, job_id, event, at)
);

-- ===================================================================
-- 5.6 Tracker tables
-- ===================================================================

-- applications
create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  stage app_stage default 'applied',
  applied_at timestamptz default now(),
  resume_version_id uuid references resume_versions(id) on delete set null,
  cover_letter_path text,
  source text,
  notes text,
  next_action_at timestamptz,
  job_snapshot jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, job_id)
);

create index idx_applications_job_id on applications (job_id);
create index idx_applications_resume_version_id on applications (resume_version_id);

-- application_events
create table application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  from_stage app_stage,
  to_stage app_stage not null,
  note text,
  occurred_at timestamptz default now()
);

create index idx_application_events_application_id on application_events (application_id);

-- ===================================================================
-- 5.7 Search & notification tables
-- ===================================================================

-- saved_searches
create table saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  query text,
  filters jsonb not null default '{}',
  is_active boolean default true,
  notify boolean default true,
  last_run_at timestamptz,
  result_count_cache integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- digests
create table digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  channel digest_channel default 'email',
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  status text check (status in ('queued','sent','skipped','failed')),
  job_count integer,
  top_score numeric(5,2),
  message_id text,
  error text
);

create index idx_digests_user_scheduled on digests (user_id, scheduled_for);

-- usage_events
create table usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  metric text not null,
  quantity integer default 1,
  period char(7) not null,
  at timestamptz default now()
);

create index idx_usage_events_user_metric_period on usage_events (user_id, metric, period);

-- ===================================================================
-- 5.8 Operations tables
-- ===================================================================

-- audit_logs
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb,
  ip inet,
  at timestamptz default now()
);

-- ===================================================================
-- 5.9 Views & functions
-- ===================================================================

-- v_ranked_jobs — feed read path (single query for the dashboard)
create view v_ranked_jobs with (security_invoker = true) as
select
  j.id,
  j.title,
  j.company_name,
  j.location_raw as location,
  j.work_mode,
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

-- recent_for_user — used by "new since last visit" badge
create or replace function recent_for_user(uid uuid, since timestamptz)
returns setof uuid
language sql stable as $$
  select j.id
  from jobs j
  join job_scores s on s.job_id = j.id
  where s.user_id = uid
    and s.scored_at >= since
    and j.status = 'active';
$$;

-- move_application — transactional stage move writes history in one shot
create or replace function move_application(app_id uuid, to_stage app_stage, note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_app applications%rowtype;
  v_from app_stage;
begin
  -- Lock the application row
  select * into v_app
  from applications
  where id = app_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  v_from := v_app.stage;

  -- Validate transition
  if v_from = to_stage then
    raise exception 'Already in target stage';
  end if;

  -- Define valid transitions
  if v_from = 'discovered' and to_stage not in ('saved') then
    raise exception 'Invalid transition from discovered';
  end if;
  if v_from = 'saved' and to_stage not in ('applied','discovered') then
    raise exception 'Invalid transition from saved';
  end if;
  if v_from = 'applied' and to_stage not in ('screening','rejected','withdrawn') then
    raise exception 'Invalid transition from applied';
  end if;
  if v_from = 'screening' and to_stage not in ('interview','rejected','withdrawn') then
    raise exception 'Invalid transition from screening';
  end if;
  if v_from = 'interview' and to_stage not in ('offer','rejected','withdrawn') then
    raise exception 'Invalid transition from interview';
  end if;
  if v_from = 'offer' and to_stage not in ('rejected','withdrawn') then
    raise exception 'Invalid transition from offer';
  end if;
  if v_from in ('rejected','withdrawn') then
    raise exception 'Cannot transition from terminal stage';
  end if;

  -- Update application
  update applications
  set stage = to_stage,
      updated_at = now(),
      next_action_at = case when to_stage = 'applied' then null else next_action_at end
  where id = app_id;

  -- Insert event
  insert into application_events (application_id, from_stage, to_stage, note)
  values (app_id, v_from, to_stage, note);
end;
$$;

-- sync_profile_role_to_jwt — sync profiles.role → auth.users.raw_app_meta_data.role
create or replace function sync_profile_role_to_jwt()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role is distinct from new.role then
    perform auth.update_user(new.id, '{"role": new.role}'::jsonb);
  end if;
  return new;
end;
$$;

create trigger trg_sync_profile_role
after update of role on profiles
for each row execute function sync_profile_role_to_jwt();

-- ===================================================================
-- RLS enablement — must happen after all tables are created
-- ===================================================================

-- Profiles
alter table profiles enable row level security;
alter table profiles force row level security;

-- Profile skills
alter table profile_skills enable row level security;
alter table profile_skills force row level security;

-- Resume versions
alter table resume_versions enable row level security;
alter table resume_versions force row level security;

-- Saved searches
alter table saved_searches enable row level security;
alter table saved_searches force row level security;

-- Job scores
alter table job_scores enable row level security;
alter table job_scores force row level security;

-- Applications
alter table applications enable row level security;
alter table applications force row level security;

-- Application events
alter table application_events enable row level security;
alter table application_events force row level security;

-- Jobs (shared corpus, read-only to clients)
alter table jobs enable row level security;
alter table jobs force row level security;

-- Job skills
alter table job_skills enable row level security;
alter table job_skills force row level security;

-- Skills
alter table skills enable row level security;
alter table skills force row level security;

-- Companies
alter table companies enable row level security;
alter table companies force row level security;

-- Sources
alter table sources enable row level security;
alter table sources force row level security;

-- Scrape runs
alter table scrape_runs enable row level security;
alter table scrape_runs force row level security;

-- Subscriptions
alter table subscriptions enable row level security;
alter table subscriptions force row level security;

-- Usage events
alter table usage_events enable row level security;
alter table usage_events force row level security;

-- Task queue (service-role only)
alter table task_queue enable row level security;
alter table task_queue force row level security;

-- Audit logs
alter table audit_logs enable row level security;
alter table audit_logs force row level security;

-- Digests
alter table digests enable row level security;
alter table digests force row level security;

-- Job events
alter table job_events enable row level security;
alter table job_events force row level security;

-- ===================================================================
-- RLS Policies (docs/03 §4.2)
-- ===================================================================

-- Helper function for admin check (wrapped in select for performance)
create or replace function is_admin() returns boolean
language sql stable as $$
  select coalesce((select auth.jwt()) ->> 'role', 'user') = 'admin'
$$;

-- Profiles: owner full access, admin read-only
create policy profiles_owner_select on profiles for select using ((select auth.uid()) = id);
create policy profiles_owner_insert on profiles for insert with check ((select auth.uid()) = id);
create policy profiles_owner_update on profiles for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy profiles_admin_select on profiles for select using (is_admin());

-- Profile skills: owner full access via profiles ownership
create policy profile_skills_owner_all on profile_skills for all using (
  exists(select 1 from profiles where id = profile_id and (select auth.uid()) = id)
);

-- Resume versions: owner full access
create policy resume_versions_owner_all on resume_versions for all using (
  exists(select 1 from profiles where id = user_id and (select auth.uid()) = id)
);

-- Saved searches: owner full access + insert-time quota check
create policy saved_searches_owner_all on saved_searches for all using (
  exists(select 1 from profiles where id = user_id and (select auth.uid()) = id)
);

-- Job scores: owner read-only, write path is service-role only
create policy job_scores_owner_select on job_scores for select using ((select auth.uid()) = user_id);

-- Applications: owner full access
create policy applications_owner_all on applications for all using ((select auth.uid()) = user_id);

-- Application events: owner read/append via applications ownership
create policy application_events_owner_select on application_events for select using (
  exists(select 1 from applications where id = application_id and (select auth.uid()) = user_id)
);
create policy application_events_owner_insert on application_events for insert with check (
  exists(select 1 from applications where id = application_id and (select auth.uid()) = user_id)
);

-- Jobs: authenticated read-only, all writes via service key
create policy jobs_authenticated_read on jobs for select using (auth.role() = 'authenticated');

-- Job skills: authenticated read-only
create policy job_skills_authenticated_read on job_skills for select using (auth.role() = 'authenticated');

-- Skills: authenticated read-only
create policy skills_authenticated_read on skills for select using (auth.role() = 'authenticated');

-- Companies: authenticated read-only
create policy companies_authenticated_read on companies for select using (auth.role() = 'authenticated');

-- Sources: authenticated read, admin write
create policy sources_authenticated_read on sources for select using (auth.role() = 'authenticated');
create policy sources_admin_write on sources for all using (is_admin());

-- Scrape runs: no client access, admin read-only
create policy scrape_runs_admin_read on scrape_runs for select using (is_admin());

-- Subscriptions: owner read-only, writes from Stripe webhook (service key)
create policy subscriptions_owner_select on subscriptions for select using ((select auth.uid()) = user_id);

-- Usage events: owner read-only, service key writes
create policy usage_events_owner_select on usage_events for select using ((select auth.uid()) = user_id);

-- Task queue: service-role only, no client policies

-- Audit logs: admin read-only
create policy audit_logs_admin_read on audit_logs for select using (is_admin());

-- Digests: owner read-only
create policy digests_owner_select on digests for select using ((select auth.uid()) = user_id);

-- Job events: owner read/insert
create policy job_events_owner_select on job_events for select using ((select auth.uid()) = user_id);
create policy job_events_owner_insert on job_events for insert with check ((select auth.uid()) = user_id);