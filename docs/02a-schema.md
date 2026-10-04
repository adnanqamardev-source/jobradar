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
```

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

Indexes: **unique** on `dedupe_hash`; `gin(status, last_seen_at)`; btree `(status, posted_at desc)`; `gin(skills)`; `gin(to_tsvector('english', title || ' ' || coalesce(description_text,'')))` for keyword search; trigram on `title_norm` + `company_domain` for fuzzy dedupe.

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
create view v_ranked_jobs with (security_invoker = true) as
select j.id, j.title, j.company_name, j.location, j.work_mode, j.employment_type,
       j.seniority, j.posted_at, j.last_seen_at, j.status, j.skills,
       s.final_score, s.breakdown, s.explanation, s.scored_at
  from jobs j
  left join job_scores s on s.job_id = j.id
 where j.status = 'active';
```

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

The two marked **RLS** are the ones that matter most: they sit directly inside a
row-level-security predicate, so a missing index there makes every policy check slow on
every row.

---
