# 02a — Database Schema

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [02 Technical Architecture](./02-technical-architecture.md) §5
**Last reviewed:** 2026-10-04

---

## 5. Database Schema

Conventions: `uuid` PKs (`gen_random_uuid()`), `timestamptz` everywhere, `created_at default now()`, snake_case. Enum-like fields use Postgres `ENUM` types where the set is stable, `text` + CHECK where it may grow. Every table with a `user_id` gets an RLS policy (see [03](./03-security-and-access.md)).

**Every foreign key gets an index — added 2026-10-03.** Postgres does *not* create an index
on a foreign key automatically. Only the primary key is indexed for free.

This is not a tidy-up item. The RLS policies in `docs/03` §4.2 check ownership by following
the chain — for example `application_events` is allowed only if the matching row in
`applications` belongs to you. Each hop in that chain is a lookup. Without an index on the
foreign key, every hop is a full scan of the table, and the policy runs that scan once per
row the query touches.

The full list of foreign keys that need an index is in §5.10 below. Ticket FND-002 must
create every one of them.

### 5.1 Entity relationship overview

```
auth.users ──1:1── profiles ──1:N── saved_searches
                    │  │  └─1:N── resume_versions
                    │  ├─1:N── resumes   (uploaded → parsed → onboarding prefill)
                    │  └─1:N── applications ──N:1── jobs ──N:1── sources
                    │             │                    │  └─N:M── job_skills ── skills
                    │             └─1:N── application_events        ▲
                    └─1:N── job_scores ─────────────────────────────┘
                                                   jobs ──N:1── companies
subscriptions 1:1 profiles · task_queue (standalone) · scrape_runs N:1 sources
usage_events N:1 profiles · audit_logs N:1 profiles
```

### 5.2 Enums

```sql
create type user_role        as enum ('user','admin');
create type job_status       as enum ('active','stale','expired','removed');
create type work_mode       as enum ('remote','hybrid','onsite','unknown');
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
create type remote_scope     as enum ('india','global','unknown');
```

**`remote_scope` — added 2026-10-04 (ING-013 / BE-317).** `work_mode` answers *remote or not*;
this answers *which* remote, which is a different question. `"Remote - India"` and
`"Remote - Worldwide"` are both `work_mode = 'remote'` and are not interchangeable for an Indian
candidate, so `work_mode` alone cannot filter between them. `unknown` is the default because a
source that never says "India" or "worldwide" is the common case, not an error.

### 5.3 Core account tables

**`profiles`** — 1:1 with `auth.users`. The user's identity + scoring inputs.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `references auth.users(id) on delete cascade` |
| `email` | `text` unique not null | denormalised from auth for digests/admin |
| `full_name` | `text` | |
| `avatar_url` | `text` | |
| `role` | `user_role` default `'user'` | admin gate (03 §3) |
| `plan` | `plan_tier` default `'free'` | mirrored from Stripe webhook |
| `target_titles` | `text[]` not null default `{}` | PRD A2 step 1 |
| `seniority` | `seniority` default `'unknown'` | |
| `years_experience` | `numeric(4,1)` | |
| `headline` | `text` | |
| `country_code` | `char(2)` | |
| `city` | `text` | |
| `time_zone` | `text` e.g. `Asia/Kolkata` | digest scheduling |
| `work_modes` | `work_mode[]` default `{}` | acceptable modes |
| `hybrid_days_max` | `smallint` | max on-site days/week |
| `min_salary` | `numeric(12,0)` | NULL = no floor |
| `salary_currency` | `char(3)` default `'USD'` | |
| `salary_period` | `text check in ('year','month','hour')` | |
| `visa_required` | `boolean` | |
| `blocked_companies` | `text[]` default `{}` | normalised slugs |
| `excluded_keywords` | `text[]` default `{}` | |
| `preferred_companies` | `text[]` default `{}` | +10 score weight |
| `profile_embedding` | `vector(2048)` | aggregate profile vector |
| `onboarding_completed` | `boolean default false` | |
| `onboarding_step` | `smallint default 1` | resume abandoned wizard |
| `last_digest_at` | `timestamptz` | |
| `last_seen_feed_at` | `timestamptz` | "new since last visit" (D7) |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: `gin(target_titles)`, `gin(blocked_companies)`, `gin(excluded_keywords)`, HNSW on `profile_embedding`.

**`profile_skills`**

| Column | Type |
|---|---|
| `profile_id` | `uuid` FK → profiles, cascade |
| `skill_id` | `uuid` FK → skills, cascade |
| `level` | `prof_level` default `'proficient'` |
| `years` | `smallint` |
| `is_primary` | `boolean default false` |
| PK | `(profile_id, skill_id)` |

**`skills`** — canonical vocabulary (seeded, ~600 rows).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `name` | `text` unique | `React`, `Project Management` |
| `slug` | `text` unique | |
| `aliases` | `text[]` | `["React.js","ReactJS"]` — matched during extraction |
| `category` | `text` | `language`, `framework`, `tool`, `soft` |

**`resume_versions`** *(S — phase 1.5)*

| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `user_id` | `uuid` FK → profiles cascade |
| `label` | `text` e.g. `Backend – 2026` |
| `storage_path` | `text` in private `resumes` bucket |
| `is_default` | `boolean default false` |
| `size_bytes` | `integer` |
| `created_at` | `timestamptz` |

**`resumes`** *(ONB-008 / BE-314, migration `0002_resumes.sql` — added 2026-10-04)*

The **uploaded résumé used to prefill onboarding**, which is a different thing from
`resume_versions` above: one file per user, parsed into a profile, deleted with the account.
`resume_versions` is the multi-version library for attaching a CV to an application (BKG-001).
Separate tables because the lifecycles differ — a user may parse one résumé to fill in their
profile and still keep five versions to attach to applications.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → profiles cascade | owner; the subject of every RLS policy |
| `file_path` | `text` not null | `{user_id}/{resume_id}.{pdf\|docx}` in the private `resumes` bucket |
| `mime_type` | `text` | `CHECK` limited to PDF + DOCX |
| `size_bytes` | `integer` | `CHECK > 0`; the app rejects > 10 MB |
| `parsed_json` | `jsonb` | the `ExtractedProfile` — see §5.11 |
| `status` | `text` | `CHECK in ('pending','processing','completed','failed')` |
| `confidence` | `numeric(3,2)` | 0–1 extraction quality |
| `extracted_at` | `timestamptz` | |
| `error` | `text` | why parsing failed |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` maintained by trigger |

Indexes: `user_id` (which also discharges the §5.10 FK obligation), `status`, `created_at desc`.

**Why `status` is `text` + CHECK here rather than an enum**, when §5.2 uses enums throughout: an
enum would add a fifth member to an existing family for the use of one table, and this state
machine is still settling. Promote it when a second table needs the same five states.

**`subscriptions`** *(S)* — 1:1 with profiles.

| Column | Type |
|---|---|
| `user_id` | `uuid` PK FK → profiles cascade |
| `stripe_customer_id` | `text` unique |
| `stripe_subscription_id` | `text` unique |
| `status` | `text` (`active`,`trialing`,`past_due`,`canceled`,`incomplete`) |
| `price_id` | `text` |
| `current_period_end` | `timestamptz` |
| `cancel_at_period_end` | `boolean default false` |
| `updated_at` | `timestamptz` |

### 5.4 Job corpus tables

**`companies`** — dedup target for the same employer across sources.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `name` | `text` not null | |
| `slug` | `text` unique | normalised, used by blocklists |
| `domain` | `text` unique | `acme.com` — key for dedupe + ATS discovery |
| `logo_url` | `text` | |
| `industry` | `text` | |
| `headcount` | `text` | |
| `ats_kind` | `text` | `greenhouse`/`lever`/`ashby`/`other` |
| `ats_slug` | `text` | e.g. Greenhouse board slug |
| `watchers_count` | `integer default 0` | denormalised |
| `created_at` | `timestamptz` |

**`sources`** — one row per configured ingestion source.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `name` | `text` unique | `Greenhouse – Stripe` |
| `kind` | `source_kind` | picks the connector in `registry.ts` |
| `config` | `jsonb` not null default `{}` | `{ "slug": "stripe", "country": "us", "query": "react" }` |
| `enabled` | `boolean default true` | |
| `is_default` | `boolean default true` | included for every new user |
| `cadence_minutes` | `integer default 360` | 6h default (PRD B3) |
| `next_run_at` | `timestamptz` | scheduler scans this |
| `consecutive_failures` | `integer default 0` | circuit breaker at 5 (B10) |
| `last_success_at` | `timestamptz` | |
| `last_error` | `text` | |
| `rate_limit_per_day` | `integer` | quota guard |
| `created_at` / `updated_at` | `timestamptz` | |

**`scrape_runs`** — one row per execution (PRD B7).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `source_id` | `uuid` FK → sources, cascade | |
| `task_id` | `uuid` FK → task_queue, set null | |
| `status` | `run_status` | |
| `started_at` / `finished_at` | `timestamptz` | |
| `duration_ms` | `integer` | |
| `found` / `inserted` / `duplicates` / `failed` | `integer default 0` | |
| `api_calls` | `integer default 0` | cost attribution |
| `error` | `text` | |
| `log` | `jsonb` | parsed-row diagnostics |

**`jobs`** — the canonical posting. Shared corpus, read by all authenticated users.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK → companies, set null | |
| `source_id` | `uuid` FK → sources, set null | origin source |
| `external_id` | `text` | source's own ID |
| `source_url` | `text` not null | canonical "View original" link |
| `apply_url` | `text` | when distinct |
| `dedupe_hash` | `text` not null unique | **§6.2** — the upsert key |
| `title` | `text` not null | |
| `title_norm` | `text` | lowercased/depunctuated, for fuzzy |
| `company_name` | `text` not null | pre-normalisation fallback |
| `company_domain` | `text` | |
| `location_raw` | `text` | as published |
| `city` / `region` / `country_code` | `text` | parsed |
| `work_mode` | `work_mode` default `'unknown'` | |
| `remote_scope` | `remote_scope` default `'unknown'` | **ING-013** — `india` / `global` / `unknown`; see §5.2 |
| `salary_min` / `salary_max` | `numeric(12,0)` | NULL when undisclosed |
| `salary_currency` | `char(3)` | |
| `salary_period` | `text` | |
| `salary_raw` | `text` | original string, shown in UI |
| `seniority` | `seniority` default `'unknown'` | parsed from title |
| `employment_type` | `employment_type` default `'unknown'` | |
| `description_text` | `text` | cleaned plain text, source of embeddings |
| `description_html` | `text` | sanitised for detail view |
| `skills` | `text[]` | matched skill slugs (denorm of `job_skills`) |
| `posted_at` | `timestamptz` | publisher's date |
| `first_seen_at` | `timestamptz default now()` | |
| `last_seen_at` | `timestamptz default now()` | freshness (B6) |
| `sighting_count` | `integer default 1` | how many sources/observations |
| `status` | `job_status default 'active'` | |
| `confidence` | `numeric(3,2) default 1.0` | parse quality (C7) |
| `embedding` | `vector(2048)` | 2048-dim to match `nvidia/nemotron-3-embed-1b:free` (§2) |
| `raw` | `jsonb` | untouched source payload, debugging |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: **unique** on `dedupe_hash`; `gin(status, last_seen_at)`; btree `(status, posted_at desc)`; `gin(skills)`; `gin(to_tsvector('english', title || ' ' || coalesce(description_text,'')))` for keyword search; trigram on `title_norm` + `company_domain` for fuzzy dedupe; partial `(work_mode, remote_scope) where status = 'active'` for the country/scope feed filter (ING-013).

**The `remote_scope` index leads with `work_mode`, deliberately.** An index on `remote_scope`
alone would not narrow anything, because the overwhelming majority of rows are already
`work_mode = 'remote'` — so a query filtering `remote_scope = 'india'` would read most of the
table either way. The real query shape is
`where work_mode = 'remote' and remote_scope = 'india' and status = 'active'`, and that is what
the composite index is ordered for.

**Similarity index on `embedding` — read this before writing the migration.**

A plain `vector` index cannot be used here. `embedding` is `vector(2048)`, and pgvector
refuses to build an HNSW or IVFFlat index on a `vector` column wider than **2000**
dimensions. Verified against the live database on 2026-10-03:

```sql
create table _probe_dims (id int, v vector(2048));
create index _probe_hnsw on _probe_dims using hnsw (v vector_cosine_ops);
-- ERROR 54000: column cannot have more than 2000 dimensions for hnsw index
```

`halfvec` (half-precision) is allowed up to 4000 dimensions, and this form was verified to
build successfully:

```sql
create index on jobs using hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops);
```

So the decision, settled 2026-10-03:

- The **column stays `vector(2048)`** — full precision is kept on disk.
- The **index is an expression index** that casts to `halfvec` while building. Only the index
  is half-precision, so search results can be re-scored against the full-precision column
  for the final top results. That re-scoring is the reason we keep `vector` and not `halfvec`.
- **The query must use the identical expression** `(embedding::halfvec(2048))`, written exactly
  like that, or Postgres will not use the index and will fall back to a slow full scan. Any
  change to the cast or the dimension silently disables it.

The 2048-dim width comes from the free embedding model chosen in `docs/02` §2
(`nvidia/nemotron-3-embed-1b:free`). It is a consequence of that choice, not a preference.

**`job_skills`** — normalised many-to-many (the `skills` array on `jobs` is the denormalised read path).

| Column | Type |
|---|---|
| `job_id` | `uuid` FK → jobs cascade |
| `skill_id` | `uuid` FK → skills cascade |
| `weight` | `numeric(3,2) default 1.0` | mentioned in requirements vs nice-to-have |
| PK | `(job_id, skill_id)` |

### 5.5 Matching tables

**`job_scores`** — one row per (user, job). Written by the scorer, read by the feed.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → profiles cascade | |
| `job_id` | `uuid` FK → jobs cascade | |
| `final_score` | `numeric(5,2) not null` | 0–100 |
| `rule_score` | `numeric(5,2)` | |
| `semantic_score` | `numeric(5,2)` | `(1 - cosine_distance) * 100` |
| `gate_result` | `jsonb` | `{ "passed": false, "reasons": ["salary_below_floor"] }` |
| `breakdown` | `jsonb` | **required** — `[{ "key":"skills","weight":35,"raw":0.71,"points":24.9}, …]` (C3) |
| `explanation` | `text` | LLM rationale, Pro (C5) |
| `scored_at` | `timestamptz` | |
| `model_version` | `text` | e.g. `rules-v1+e3-small` |
| PK / unique | `(user_id, job_id)` | |

Indexes: `(user_id, final_score desc)` where `final_score >= 60`; `(job_id)`.

**`job_events`** *(derived, optional)* — implicit feedback for C6.

| Column | Type |
|---|---|
| `user_id` / `job_id` | FKs |
| `event` | `text check in ('view','save','dismiss','apply')` |
| `at` | `timestamptz` |

### 5.6 Tracker tables

**`applications`**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → profiles cascade | |
| `job_id` | `uuid` FK → jobs cascade | unique per user |
| `stage` | `app_stage default 'applied'` | |
| `applied_at` | `timestamptz default now()` | |
| `resume_version_id` | `uuid` FK → resume_versions, set null | |
| `cover_letter_path` | `text` | |
| `source` | `text` | `in_app`,`manual`,`csv_import` |
| `notes` | `text` | |
| `next_action_at` | `timestamptz` | follow-up (E5) |
| `job_snapshot` | `jsonb` | title/company/salary at apply time — survives source deletion |
| `created_at` / `updated_at` | `timestamptz` | |
| unique | `(user_id, job_id)` | prevents duplicate applications |

**`application_events`**

| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `application_id` | `uuid` FK → applications cascade |
| `from_stage` / `to_stage` | `app_stage` (from_stage null on create) |
| `note` | `text` |
| `occurred_at` | `timestamptz default now()` |

### 5.7 Search & notification tables

**`saved_searches`**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → profiles cascade | |
| `name` | `text` | |
| `query` | `text` | free-text |
| `filters` | `jsonb` | `{ workModes:[], minSalary, seniority[], sources[], postedWithinDays, skills[] }` |
| `is_active` | `boolean default true` | |
| `notify` | `boolean default true` | include in digest |
| `last_run_at` | `timestamptz` | |
| `result_count_cache` | `integer` | preview count |
| `created_at` / `updated_at` | `timestamptz` | |

**`digests`** — send log (one row per intended send).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → profiles cascade | |
| `channel` | `digest_channel default 'email'` | |
| `scheduled_for` | `timestamptz` | user's local send time |
| `sent_at` | `timestamptz` | NULL = skipped (nothing new) |
| `status` | `text check in ('queued','sent','skipped','failed')` | |
| `job_count` | `integer` | |
| `top_score` | `numeric(5,2)` | |
| `message_id` | `text` | Resend ID |
| `error` | `text` | |

**`usage_events`** — metering for plan limits (G2).

| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `user_id` | `uuid` FK → profiles cascade |
| `metric` | `text` e.g. `jobs_scored`,`saved_searches`,`llm_rationale` |
| `quantity` | `integer default 1` |
| `period` | `char(7)` e.g. `2026-10` |
| `at` | `timestamptz default now()` |

Index: `(user_id, metric, period)`.

### 5.8 Operations tables

**`task_queue`** — the durable job queue.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `kind` | `task_kind` | |
| `payload` | `jsonb` | `{ "sourceId": "…" }` / `{ "userIds": [...] }` |
| `status` | `task_status default 'pending'` | |
| `priority` | `smallint default 100` | lower runs first |
| `run_after` | `timestamptz default now()` | backoff scheduling |
| `attempts` | `smallint default 0` | max 3 |
| `max_attempts` | `smallint default 3` | |
| `locked_at` / `locked_by` | `timestamptz` / `text` | worker lease (5 min) |
| `last_error` | `text` | |
| `created_at` / `updated_at` | `timestamptz` | |

Index: partial `(status, run_after, priority)` where `status = 'pending'`. Claim statement:

```sql
select * from task_queue
 where status = 'pending' and run_after <= now()
 order by priority, run_after
 limit $n
   for update skip locked;
```

**`audit_logs`**

| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `actor_id` | `uuid` (null for system) |
| `action` | `text` e.g. `profile.deleted`, `source.disabled`, `plan.changed` |
| `target_type` / `target_id` | `text` |
| `meta` | `jsonb` (no secrets, no résumé content) |
| `ip` | `inet` |
| `at` | `timestamptz default now()` |

### 5.9 Views & functions

```sql
-- Feed read path (single query for the dashboard)
-- Fixed 2026-10-03 — the original version had three separate problems. See the note below.
-- 0003 added remote_scope; see 0003's comment for why that needed DROP + CREATE.
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
```

**A new column on `jobs` does not reach this view automatically, and that is the point.** The
view lists its columns one by one on purpose — `select j.*` was one of the three bugs fixed on
2026-10-03 (it drags `raw` and a 2048-float `embedding` into every feed query). The cost of that
fix is that adding a column is now a two-step change: the column *and* the view. Miss the second
step and the UI offers a country filter that silently returns nothing, which is why
`tests/unit/migration-drift.test.ts` asserts the view exposes `remote_scope`.

**Why this view was rewritten — three bugs, all fixed by the version above.**

1. **It leaked the wrong columns.** The old query was `select j.*`, which drags in *every*
   column on `jobs` — including `raw` (the untouched copy of what the source sent us) and
   `embedding` (2048 numbers). `docs/02` §7.2 rule 4 forbids secrets in `jobs.raw`, so `raw`
   must never reach a browser. Sending 2048 floats to render a list is also pure waste. The
   columns are now written out one by one.

2. **It showed the wrong jobs.** The old query used `join`, which in SQL means *inner* join —
   keep only rows where a match exists on both sides. `job_scores` is scoped per user by RLS,
   so an inner join returns **only jobs this user has already scored**. A brand-new user would
   get an empty feed and no error. Changed to `left join`, which keeps every active job and
   leaves the score columns empty when the user has not scored it yet.

3. **It ignored the security rules.** By default a Postgres view runs with the privileges of
   whoever *created* it, not the person querying it. So the old view quietly stepped around the
   row-level security policies on `jobs` and `job_scores`. `security_invoker = true` makes the
   view run as the caller, so RLS applies. This one is not optional.

-- Create the profiles row for a new auth user (BE-304, migration 0005).
--
-- One trigger rather than one code path per auth method: magic link, Google and OTP would
-- otherwise each have to remember to create the row, and a user without one is invisible to the
-- scorer, the feed and every owner-scoped policy.
--
-- SECURITY DEFINER because the trigger fires inside the auth service's insert, where the caller
-- is not yet an authenticated principal, and `profiles` carries FORCE ROW LEVEL SECURITY — so the
-- insert needs the definer's bypass role. `set search_path = ''` is the privilege-escalation
-- guard: with a mutable search_path, any caller able to create a schema could shadow `auth` or
-- `public` and execute as the definer. Every name is therefore fully qualified.
--
-- `role` is deliberately NOT read from `raw_user_meta_data`: that field is user-writable through
-- the client SDK, so honouring a `role` key there would be admin self-assignment (docs/03 §3.2).
--
-- Bare `on conflict do nothing`, not `on conflict (id)`: an arbiter clause covers only the
-- constraint it names, and `email` is unique too. A duplicate address would raise
-- `unique_violation` inside this AFTER INSERT trigger, aborting the `auth.users` insert and
-- denying the user a session. Two arbiter clauses is a syntax error.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- `profiles.email` is NOT NULL UNIQUE; the placeholder is derived from the id so two
  -- phone-only signups cannot collide on it.
  v_email text := coalesce(new.email, new.id::text || '@no-email.invalid');
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    v_email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Used by the "new since last visit" badge
create function recent_for_user(uid uuid, since timestamptz)
returns setof uuid …;

-- Transactional stage move writes history in one shot
create function move_application(app_id uuid, to_stage app_stage, note text default null)
returns void …;  -- also inserts application_events, raises on invalid transition

-- Sync profiles.role → auth.users.raw_app_meta_data.role so is_admin() reads the JWT claim
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
```

**Skill extraction (SQL-side, avoids an LLM call per job):** `job_skills` is populated with a `regexp` + `alias` join against `skills.aliases` over `description_text`; low-confidence matches land below `weight 0.5` and don't count toward the skills sub-score.

### 5.10 Foreign keys that need an index

**Added 2026-10-03.** Postgres indexes primary keys automatically and nothing else. Each row
below is a foreign key column with **no index**, found by reading §5.3–5.8 against the index
lists those sections give. FND-002 must create an index for every one.

| Table | Column | Points at | Why a policy needs it |
|---|---|---|---|
| `job_scores` | `job_id` | `jobs` | feed joins scores → jobs |
| `applications` | `job_id` | `jobs` | job detail page lists applications |
| `applications` | `resume_version_id` | `resume_versions` | application detail |
| `application_events` | `application_id` | `applications` | **RLS chain** — ownership is checked through this hop |
| `scrape_runs` | `source_id` | `sources` | source health view |
| `jobs` | `company_id` | `companies` | dedupe on company |
| `jobs` | `source_id` | `sources` | dedupe on source |
| `resume_versions` | `user_id` | `profiles` | **RLS** — owner lookup |
| `profile_skills` | `skill_id` | `skills` | skill vocabulary join |
| `job_skills` | `skill_id` | `skills` | skill vocabulary join |
| `resumes` | `user_id` | `profiles` | **RLS** — owner lookup (ONB-008, added 2026-10-04) |

**`jobs.remote_scope` is deliberately absent from this table.** It is an enum column, not a
foreign key, so §5.10 does not apply. Noted explicitly because this section is the checklist
people scan when hunting for a missing index.

The rows marked **RLS** are the ones that matter most: they sit directly inside a
row-level-security predicate, so a missing index there makes every policy check slow on
every row. **Three, not two** — `resumes.user_id` joined them on 2026-10-04.

### 5.11 `ExtractedProfile` — the résumé parse result

**Added 2026-10-04 (ONB-009 / BE-315).** This is the shape stored in `resumes.parsed_json`,
defined once in `src/types/resume.ts` as a Zod schema with the TypeScript type derived from it.
It is the contract between the parser and the onboarding wizard.

| Field | Type | Notes |
|---|---|---|
| `fullName` / `email` / `phone` | `string \| null` | `email` is `.email()`-validated |
| `location.city` / `.region` / `.countryCode` | `string \| null` | `countryCode` is ISO 3166-1 alpha-2 |
| `titles` | `string[]` | max 10 after mapping |
| `seniority` | `seniority \| null` | §5.2 vocabulary, never a free string |
| `yearsExperience` | `number \| null` | 0–60 |
| `skills` | `string[]` | canonical names, max 30 after mapping |
| `workModes` | `("remote"\|"hybrid"\|"onsite")[]` | preference, not a job fact |
| `minSalary` / `salaryCurrency` / `salaryPeriod` | | Indian grouping and `L`/`Cr` notation resolved to an absolute figure |
| `education` | `{degree, institution, year}[]` | `institution` is best-effort |
| `summary` | `string \| null` | truncated |
| `confidence` | `number` 0–1 | weighted across the fields above |
| `needsReview` | `boolean` | `true` when `confidence < 0.6`, or email/titles missing |

**`needsReview` is a safety property, not a nicety.** The extracted values prefill the onboarding
wizard, so a wrong guess silently becomes a scoring input and therefore a wrong ranked feed.
Below the threshold the wizard must show the fields for confirmation rather than applying them.

**Two rules the parser holds itself to:**

1. **Rule-based extraction is the default and the only synchronous path.** It is deterministic and
   offline, so the same résumé always yields the same profile.
2. **The LLM fallback is opt-in and must run in a queue worker, never in a request.** [02 §1.2](./02-technical-architecture.md)
   forbids an HTTP request blocking on a third party, and the free OpenRouter tier returns 429
   under load (`notes.md`). `extractProfile()` therefore takes `allowLlmFallback`, defaulting to
   `false`, and only BE-108's `parse_resume` task sets it.

---
