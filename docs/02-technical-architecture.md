# 02 — Technical Architecture Document

**Product:** JobRadar · **Version:** 1.0 — MVP
**Feeds from:** [01 PRD](./01-prd.md) · **Consumed by:** [03 Security & Access](./03-security-and-access.md), [04 Frontend Specification](./04-frontend-specification.md), [05 Feature Tickets](./05-feature-ticket-list.md)
**Last updated:** 2026-10-03

> **How to read this doc:** Section 2 is the tool list — never introduce a tool that isn't here without updating this document. Section 4 is the folder map — put every new file where the map says. Section 5 is the schema — never create a table that isn't defined here. Section 7 is the config contract — never hardcode anything listed there.

---

## 1. Guiding Principles

1. **One runtime, one database.** Next.js + Supabase only. No separate backend service, no message broker, no container orchestration for MVP. Fewer moving parts = fewer things that break at 2am.
2. **Queue everything slow.** Any work that calls a third-party API (scrape, embed, LLM, email) goes through the database-backed queue. HTTP requests must never block on the outside world.
3. **Connectors are plugins.** Every source implements the same `SourceConnector` interface. Adding a source is a new file, not a new architecture.
4. **Postgres does the heavy lifting.** Dedup, ranking, and filtering happen in SQL with indexes and `pgvector`. The app layer assembles, it does not compute over 50k rows.
5. **The service-role key never crosses the client boundary.** All user-facing reads/writes go through Supabase Row-Level Security with the anon key. Service role is for queue workers and cron only.
6. **Deterministic first, model second.** The score must be reproducible without an LLM. Models add rationale and semantic recall, never the sole basis of a ranking.

---

## 2. Tech Stack

| Layer | Choice | Version | Why this, and what it replaces |
|---|---|---|---|
| **Framework** | **Next.js (App Router)** | 15.x (pin latest stable at scaffold) | One codebase for marketing site, app, and API routes. Server Components keep the feed fast; Route Handlers host cron endpoints. Replaces: separate Express/FastAPI backend + React SPA. |
| **Language** | **TypeScript** | 5.x strict | Zod + Prisma-or-not type safety across queue payloads and connector outputs. `strict: true`, `noUncheckedIndexedAccess: true`. |
| **UI** | **React** | 19.x | Server Components by default; client components only where there's real interactivity (filters, kanban, wizard). |
| **Styling** | **Tailwind CSS** | 4.x | Design tokens from [04 Frontend Spec](./04-frontend-specification.md) become CSS variables consumed as utilities. Replaces: component-library lock-in (we want a non-generic look). |
| **Component primitives** | **Radix UI** (unstyled) | latest | Accessibility-correct dialogs, menus, popovers, tabs — behaviour only, we own all visuals. |
| **Validation** | **Zod** | 3.x | One schema per entity, shared by API input, DB row, and form. |
| **Database** | **PostgreSQL** via **Supabase** | 17 (Supabase-managed) | Relational data + `pgvector` + RLS in one place. Replaces: Firebase (no SQL/ranking), plain Postgres (no auth/storage/dashboard). |
| **Vector search** | **pgvector** | 0.8.x | `vector(1536)` column + HNSW index. Replaces: Pinecone/Weaviate — an extra vendor and sync layer for a corpus that fits comfortably in Postgres. |
| **Auth** | **Supabase Auth** | — | Magic link + Google OAuth, JWTs that RLS understands natively. Replaces: NextAuth (weaker RLS fit), Clerk (extra cost/vendor). |
| **File storage** | **Supabase Storage** | — | Résumé PDFs, logos. Private buckets + signed URLs. |
| **Web scraping** | **Firecrawl** | v2 API | `scrape` (JS-rendered pages, JSON-schema extraction), `search` (discover postings), `map` (find careers pages). Replaces: self-hosted Playwright farm (ops burden) + raw `fetch` (breaks on JS sites). |
| **Job data APIs** | Greenhouse, Lever, Ashby, Remotive, Arbeitnow, USAJOBS, Adzuna | — | Structured, documented, ToS-friendly. **Used before Firecrawl wherever an API exists** (see §6.1). |
| **Embeddings** | **OpenAI** `text-embedding-3-small` | 1536-dim | Cheap, fast, good enough for job/profile similarity. Batching in chunks of 100. |
| **LLM rationale** | **OpenAI** `gpt-4o-mini` | — | 2–3 sentence fit rationale + description cleanup. Short output → small model. Gated behind Pro (C5). |
| **Email** | **Resend** + **React Email** | — | HTML email as typed React components; good deliverability; simple API. |
| **Payments** | **Stripe** | API 2025-x | Checkout + webhooks + customer portal. G1–G4. |
| **Queue / scheduling** | **Postgres table + `pg_cron`** | — | `task_queue` table, `pg_cron` enqueues on schedule, Route Handlers process. Replaces: Redis/BullMQ (another store), Inngest (another vendor) — at MVP volume a table with `FOR UPDATE SKIP LOCKED` is ample. |
| **Cron ingress** | **Vercel Cron** → Route Handler | — | Hits `/api/cron/*` with a signed secret; handler enqueues work. |
| **Analytics** | **PostHog** | latest | Funnels + feature flags + session replay for the metric tree in §7 of the PRD. |
| **Error tracking** | **Sentry** | latest | Next.js SDK, source maps, traces sampled at 20%. |
| **Hosting** | **Vercel** | — | Next.js-native, cron, preview deploys. |
| **Testing** | **Vitest** + **Playwright** + **Testcontainers Postgres** | — | Unit/integration/e2e. Connector contract tests run against recorded fixtures, not live APIs. Config is `vitest.config.mts`; serial execution via top-level `fileParallelism: false` (Vitest 4+ removed `poolOptions`). |
| **Lint / format** | **ESLint** + **Prettier** | latest | Flat config (`eslint.config.mjs`). `next lint` is removed in Next 16 — lint via `eslint .`. Includes the service-role import guard and a no-hex-literals rule. |

### What we are explicitly *not* using (and why)

- **Redis / BullMQ** — a second datastore for a queue that peaks at a few hundred jobs an hour.
- **Prisma / Drizzle** — hand-written SQL in a `data/` layer keeps RLS policies and query plans visible; we need neither ORM codegen nor migrations beyond Supabase's.
- **Separate microservices** — one deployable unit until there's a real scaling reason.
- **Playwright in production** — Firecrawl owns browser rendering; we don't run headless browsers ourselves.
- **Direct LinkedIn / Indeed scraping** — ToS risk (PRD R2). Not in the connector list, not to be added without legal review.

---

## 3. High-Level Architecture

```
                                ┌──────────────────────────────────────────┐
                                │                VERCEL                    │
  Browser ── HTTPS ────────────▶│  Next.js App Router                      │
                                │  ├─ Marketing (RSC)                      │
                                │  ├─ App UI (RSC + Client islands)        │
                                │  └─ Route Handlers                      │
                                │      /api/cron/*   (cron ingress)        │
                                │      /api/actions/* (user mutations)     │
                                │      /api/webhooks/* (stripe)            │
                                └───────┬───────────────────┬──────────────┘
                                        │ anon key + RLS    │ service-role key
                                        │ (user requests)   │ (workers only)
                                        ▼                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                          SUPABASE                                    │
   │  Postgres 17  ── profiles · jobs · job_scores · applications …       │
   │  pgvector     ── jobs.embedding, profile_embedding                   │
   │  pg_cron      ── every 15m: enqueue scrape/score/digest tasks        │
   │  Storage      ── private: resumes/, logos/                           │
   │  Auth         ── magic link + Google OAuth                           │
   └──────────────────────────────────────────────────────────────────────┘
          ▲                                        │
          │ reads/writes (service role)            │ enqueue / claim
          │                                        ▼
   ┌──────────────────┐   ┌───────────────────────────────────────────────┐
   │  TASK QUEUE      │◀──│  WORKERS (Route Handlers, batched, retry)    │
   │  task_queue      │   │  ├─ ingest_source   → connectors → jobs       │
   │  status/attempts │   │  ├─ score_jobs      → rules + embeddings      │
   └──────────────────┘   │  ├─ send_digest     → Resend                  │
                          │  └─ account_export / cleanup                 │
                          └───────┬───────────────────┬───────────────────┘
                                  │                   │
                    ┌─────────────▼──────┐  ┌─────────▼──────────┐
                    │  JOB SOURCES       │  │  MODELS / EMAIL    │
                    │  Greenhouse/Lever/ │  │  OpenAI embeddings │
                    │  Ashby/Remotive/   │  │  OpenAI gpt-4o-mini│
                    │  Arbeitnow/USAJOBS/│  │  Resend            │
                    │  Adzuna/Firecrawl  │  └────────────────────┘
                    └────────────────────┘
```

### 3.1 Primary data flow — "posting published → ranked on someone's feed"

1. `pg_cron` fires every 15 min → calls `POST /api/cron/enqueue` with `CRON_SECRET`.
2. Handler inserts `ingest_source` tasks for each enabled source whose `next_run_at <= now()`.
3. Worker claims up to N tasks with `SELECT … FOR UPDATE SKIP LOCKED`, marks `running`.
4. For the task's source: **connector** calls the job API (or Firecrawl) → returns `RawJob[]`.
5. **Normaliser** maps `RawJob` → `CanonicalJob` (Zod-validated) → writes to `jobs` (upsert on dedupe hash).
6. New/changed jobs get an embedding (batched) and enqueue `score_jobs` for active profiles.
7. **Scorer** computes rule score + cosine similarity → writes `job_scores` rows.
8. Feed reads `jobs ⋈ job_scores` for the user, ordered by score — a single indexed query.
9. `pg_cron` daily → `send_digest` tasks for users whose local send time has passed.

**Target end-to-end latency:** job published → ranked on feed: **< 6 hours** (PRD §7 ⑦). Poll cadence, not webhook-based, is a deliberate MVP trade-off.

---

## 4. File & Folder Structure

```
jobradar/
├── README.md                        # setup, env, scripts
├── package.json
├── tsconfig.json                    # strict, paths: @/* -> src/*
├── next.config.ts
├── tailwind.config.ts               # tokens imported from src/styles/tokens.css
├── eslint.config.mjs
├── .gitattributes
├── tailwind.config.ts
├── eslint.config.mjs
├── .prettierrc
├── .env.example                     # every var, empty values, documented
├── .gitignore
├── playwright.config.ts
├── vitest.config.ts
│
├── scripts/
│   └── queue-drain.ts               # local queue worker (replaces Vercel cron)
│
├── docs/                            # ← the six source documents live here
│   ├── 01-prd.md
│   ├── 02-technical-architecture.md
│   ├── 03-security-and-access.md
│   ├── 04-frontend-specification.md
│   ├── 05-feature-ticket-list.md
│   └── 06-work-breakdown.md
│
├── public/                          # static assets only (favicon, og-image)
│
├── src/
│   ├── app/                         # NEXT.JS APP ROUTER — routes only, no logic
│   │   ├── (marketing)/             #   public, unauthenticated
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx             #   landing
│   │   │   ├── pricing/page.tsx
│   │   │   └── demo/page.tsx        #   read-only sample feed (PRD Flow 0)
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── auth/callback/route.ts
│   │   ├── (app)/                  #   authenticated shell: sidebar + topbar
│   │   │   ├── layout.tsx           #   guards session, renders AppShell
│   │   │   ├── onboarding/page.tsx  #   4-step wizard
│   │   │   ├── dashboard/page.tsx   #   ranked feed (home)
│   │   │   ├── jobs/[id]/page.tsx   #   job detail
│   │   │   ├── applications/page.tsx#   kanban + stats
│   │   │   ├── saved-searches/page.tsx
│   │   │   ├── settings/            #   profile, preferences, billing, notifications
│   │   │   └── admin/               #   role-gated: sources, runs, queue, users
│   │   ├── api/
│   │   │   ├── cron/
│   │   │   │   ├── enqueue/route.ts      # pg_cron ingress → enqueue tasks
│   │   │   │   ├── process/route.ts      # drain the queue (batched)
│   │   │   │   └── digest/route.ts       # enqueue send_digest tasks
│   │   │   ├── actions/                  # server actions: mutations w/ revalidate
│   │   │   │   ├── jobs.ts               #   save / dismiss / mark-applied
│   │   │   │   ├── applications.ts       #   stage moves, notes, follow-ups
│   │   │   │   ├── profile.ts            #   onboarding + settings saves
│   │   │   │   └── searches.ts           #   saved search CRUD
│   │   │   └── webhooks/
│   │   │       └── stripe/route.ts
│   │   ├── og/…  error.tsx  not-found.tsx  loading.tsx
│   │   └── layout.tsx  globals.css
│   │
│   ├── components/
│   │   ├── ui/                      #   design-system primitives (see 04)
│   │   │   ├── button.tsx  input.tsx  badge.tsx  card.tsx
│   │   │   ├── dialog.tsx  dropdown.tsx  toast.tsx  tabs.tsx
│   │   │   ├── score-meter.tsx  chip.tsx  empty-state.tsx  skeleton.tsx
│   │   │   └── …
│   │   ├── feed/                    #   job-card, feed-toolbar, filter-panel
│   │   ├── job/                     #   score-breakdown, description, source-badge
│   │   ├── tracker/                 #   kanban, stage-badge, timeline, stats-cards
│   │   ├── onboarding/              #   wizard, step-1…step-4, progress-rail
│   │   ├── admin/                   #   run-table, source-tiles, queue-panel
│   │   └── layout/                  #   app-shell, sidebar, topbar, mobile-nav
│   │
│   ├── lib/
│   │   ├── db/
│   │   │   ├── client.ts            #   browser client (anon key, RLS applies)
│   │   │   ├── server.ts            #   server client (anon + user JWT)
│   │   │   ├── admin.ts             #   service-role client — SERVER ONLY
│   │   │   └── queries/             #   one file per read: jobs.ts, apps.ts…
│   │   ├── auth/
│   │   │   ├── session.ts           #   getServerSession(), requireUser()
│   │   │   ├── guards.ts            #   requireAdmin(), requirePlan()
│   │   │   └── callback.ts
│   │   ├── env.ts                   #   Zod env schema — single source of truth
│   │   ├── connectors/              # ★ PLUG-IN POINT (see §6.1)
│   │   │   ├── types.ts             #   SourceConnector interface + RawJob
│   │   │   ├── registry.ts          #   name → connector map
│   │   │   ├── greenhouse.ts  lever.ts  ashby.ts
│   │   │   ├── remotive.ts   arbeitnow.ts  usajobs.ts  adzuna.ts
│   │   │   └── firecrawl.ts         #   generic scrape/search/map connector
│   │   ├── ingest/
│   │   │   ├── normalize.ts         #   RawJob → CanonicalJob (Zod)
│   │   │   ├── dedupe.ts            #   canonical hash + fuzzy merge
│   │   │   ├── freshness.ts         #   stale / expired transitions
│   │   │   └── pipeline.ts          #   orchestrates one ingest run
│   │   ├── scoring/
│   │   │   ├── weights.ts           #   weights from DB config / feature flags
│   │   │   ├── rules.ts             #   deterministic score + breakdown
│   │   │   ├── semantic.ts          #   embedding + cosine
│   │   │   ├── rationale.ts         #   LLM 2–3 sentences (Pro)
│   │   │   ├── gates.ts             #   hard filters → score 0 + reason
│   │   │   └── index.ts             #   compose final score, write job_scores
│   │   ├── queue/
│   │   │   ├── enqueue.ts  claim.ts  run.ts  retry.ts
│   │   │   └── handlers/            #   ingest_source.ts, score_jobs.ts, send_digest.ts
│   │   ├── email/
│   │   │   ├── resend.ts            #   thin client
│   │   │   └── templates/           #   React Email: digest.tsx, welcome.tsx, alert.tsx
│   │   ├── billing/
│   │   │   ├── plans.ts             #   PLAN_LIMITS constant (single source of truth)
│   │   │   ├── stripe.ts  entitlements.ts  usage.ts
│   │   ├── analytics/               #   posthog server+client wrappers, event names
│   │   ├── errors/                  #   AppError, error codes → user copy map
│   │   ├── ratelimit.ts             #   per-user action limits
│   │   ├── logger.ts                #   structured JSON w/ runId/requestId
│   │   └── utils/                   #   salary parse, seniority parse, slugify…
│   │
│   ├── types/
│   │   ├── db.ts                    #   DB row types
│   │   ├── canonical-job.ts
│   │   └── api.ts                   #   Zod-inferred request/response types
│   │
│   └── styles/
│       └── tokens.css               #   ALL color/typography/spacing tokens (04)
│
├── supabase/
│   ├── migrations/                  #   numbered SQL: 0001_init.sql, 0002_….sql
│   ├── seed.sql                     #   dev data: skills list, demo sources
│   ├── functions/                   #   (reserved; none in MVP)
│   └── config.toml
│
├── emails/                          #   (alias → src/lib/email/templates)
│
├── scripts/
│   └── queue-drain.ts               #   local queue drain — replaces Vercel cron (`pnpm queue:drain --once`)
│
├── tests/
│   ├── unit/                        #   scoring, dedupe, normalise, salary parse
│   ├── integration/                 #   connectors vs recorded fixtures, RLS tests
│   │   └── fixtures/sources/        #   *.json per connector (no live calls in CI)
│   └── e2e/                         #   playwright: onboarding, apply flow, tracker
│
└── .github/workflows/
    ├── ci.yml                       #   lint → typecheck → unit → integration → e2e
    └── deploy.yml                   #   preview on PR, prod on main
```

### Rules that keep this structure healthy

| Rule | Reason |
|---|---|
| `app/**/page.tsx` files contain **no business logic** — they call `lib/` and render. | Keeps routes swappable and testable. |
| A connector knows **only** how to fetch. Normalisation and dedup live in `lib/ingest/`. | New source = 1 file, no duplicated logic. |
| `lib/db/admin.ts` may only be imported from `lib/queue/**`, `api/cron/**`, `api/webhooks/**`. Enforced by an ESLint `no-restricted-imports` rule. | Prevents the service-role key leaking into client paths. |
| Every user-facing mutation is a Server Action in `api/actions/`, never a raw PostgREST call from a component. | Auth, Zod validation, rate limit, and audit log in one place. |
| Design tokens only in `styles/tokens.css`; no hex values in components. | [04 Frontend Spec](./04-frontend-specification.md) stays enforceable. |
| One Zod schema per entity in `types/`, reused for API input, DB mapping, and forms. | Three definitions drift; one cannot. |

---

## 5. Database Schema

Conventions: `uuid` PKs (`gen_random_uuid()`), `timestamptz` everywhere, `created_at default now()`, snake_case. Enum-like fields use Postgres `ENUM` types where the set is stable, `text` + CHECK where it may grow. Every table with a `user_id` gets an RLS policy (see [03](./03-security-and-access.md)).

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
| `profile_embedding` | `vector(1536)` | aggregate profile vector |
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
| `embedding` | `vector(1536)` | |
| `raw` | `jsonb` | untouched source payload, debugging |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: **unique** on `dedupe_hash`; `gin(status, last_seen_at)`; btree `(status, posted_at desc)`; HNSW on `embedding` (`vector_cosine_ops`); `gin(skills)`; `gin(to_tsvector('english', title || ' ' || coalesce(description_text,'')))` for keyword search; trigram on `title_norm` + `company_domain` for fuzzy dedupe.

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
create view v_ranked_jobs as
select j.*, s.final_score, s.breakdown, s.explanation, s.scored_at
  from jobs j
  join job_scores s on s.job_id = j.id
 where j.status = 'active';

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

---

## 6. Key Subsystems

### 6.1 Connector interface (the plug-in point)

```ts
// src/lib/connectors/types.ts
export interface SourceConnector {
  readonly kind: SourceKind;              // matches sources.kind
  fetch(cfg: SourceConfig, ctx: RunCtx): AsyncIterable<RawJob>;
  readonly costClass: 'free' | 'metered' | 'firecrawl';
}

export interface RawJob {
  externalId: string;
  sourceUrl: string;
  applyUrl?: string;
  title: string;
  companyName: string;
  location?: string;
  salaryRaw?: string;
  postedAt?: string;      // ISO
  descriptionHtml?: string;
  descriptionText?: string;
  raw: unknown;           // untouched payload → jobs.raw
}
```

**Source priority order (PRD R2):**

| Tier | Sources | Basis |
|---|---|---|
| **1 — Official APIs** (use first) | Greenhouse Board, Lever Postings, Ashby Job Board, Remotive, Arbeitnow, USAJOBS | Public, documented, stable |
| **2 — Aggregators w/ keys** | Adzuna (salary-enriched), optional JSearch via RapidAPI | Rate-limited, quota-tracked |
| **3 — Firecrawl** | Career pages with no API; `firecrawl_search` discovery; `firecrawl_map` for sitemap discovery | Metered — reserve for Tier 1/2 gaps |

Firecrawl usage rules: always `formats: ["json"]` with an explicit extraction schema matching `RawJob`; `onlyMainContent: true`; per-source `maxAge` caching to avoid re-crawling unchanged pages; hard daily cap per plan.

**Connector contract tests** run against `tests/integration/fixtures/sources/{kind}.json` — CI never hits live APIs.

### 6.2 Deduplication (two passes)

1. **Exact — `dedupe_hash`**
   `sha256(norm_title | norm_company_domain | norm_city | work_mode)` where `norm_*` lowercases, strips punctuation/legal suffixes (`Inc`, `Ltd`, `GmbH`) and collapses whitespace.
   Unique index → `insert … on conflict (dedupe_hash) do update set last_seen_at = now(), sighting_count = jobs.sighting_count + 1`.
2. **Fuzzy — trigram** (runs on newly inserted rows only)
   `similarity(title_norm, $t) > 0.85 AND company_domain = $d` → merge: keep the row with the richer `description_text`, increment `sighting_count`, record the loser's URL as an alternate sighting.

Same job from three sources = **one** feed card, with a "seen on N sources" chip (D5).

### 6.3 Scoring pipeline

```
gates (hard filters)      →  any hit?  final_score = 0, gate_result.reasons, HIDE from feed
                                    ↓ pass
rule score 0–100          →  skills 35 · seniority 15 · compensation 15
                             location/work-mode 15 · recency 10 · company pref 10
semantic score 0–100      →  cosine(job.embedding, profile.embedding)
final = 0.5·rule + 0.5·semantic     (weights from lib/scoring/weights.ts, flag-overridable)
                                    ↓
breakdown JSON            →  stored, rendered as the labelled bar in the UI (C3)
                                    ↓ (Pro, separate task)
LLM rationale 2–3 sentences →  job_scores.explanation
```

- **Gates** (`lib/scoring/gates.ts`): blocked company · excluded keyword in title/description · work-mode not in `profile.work_modes` · `salary_max < min_salary` when disclosed · seniority above `target` by >1 band.
- **Triggers:** profile save → `rescore_profile` task (requeue, never synchronous — C4); new/updated job → `score_jobs` task batched per profile.
- **Freshness:** cron flips `active → stale` at 14 days unseen, `stale → expired` at 28 (B6).

### 6.4 Queue execution model

- Vercel Cron hits `/api/cron/process` every minute with `CRON_SECRET`.
- Worker claims ≤ 25 tasks (`FOR UPDATE SKIP LOCKED`), runs each in a try/catch with a 5-minute lease.
- Failure → `attempts += 1`, `run_after = now() + 2^n seconds` (n = attempts), status back to `pending`; at `max_attempts` → `failed` + `audit_logs` entry + admin surface.
- Idempotency: every handler is safe to re-run (upserts keyed by unique constraints, digests keyed by `digests.scheduled_for`).
- Vercel function timeouts are respected by **batch size, not long-running loops** — if a batch is incomplete, the handler re-enqueues itself.

### 6.5 Digest

Daily `pg_cron` → `send_digest` tasks partitioned by `time_zone` → handler selects `job_scores` for that user where `final_score >= alert_threshold`, `job_id` not dismissed/applied, `scored_at > last_digest_at`, ordered by score, limit 10 → renders React Email → Resend → writes `digests` row. **Zero results → `status = 'skipped'`, no email.**

---

## 7. Environment & Config

### 7.1 Variable reference (`.env.example` mirrors this exactly)

| Variable | Scope | Purpose | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL | safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | public key, RLS applies | safe to expose |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | bypass RLS for workers | **never** prefixed `NEXT_PUBLIC_`; import restricted by ESLint rule |
| `NEXT_PUBLIC_APP_URL` | client + server | canonical origin | `http://localhost:3000` in dev |
| `CRON_SECRET` | server | bearer token for `/api/cron/*` | verified constant-time |
| `FIRECRAWL_API_KEY` | server | scraping/search/map | metered — budget-guarded |
| `OPENAI_API_KEY` | server | embeddings + rationale | |
| `OPENAI_EMBEDDING_MODEL` | server | default `text-embedding-3-small` | change → full reindex |
| `OPENAI_CHAT_MODEL` | server | default `gpt-4o-mini` | |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | server | aggregator | |
| `USAJOBS_API_KEY` / `USAJOBS_AUTHORIZATION_KEY` | server | federal jobs | |
| `RAPIDAPI_KEY` | server | optional JSearch | may be blank |
| `RESEND_API_KEY` | server | transactional email | |
| `EMAIL_FROM` | server | e.g. `JobRadar <hi@jobradar.app>` | |
| `STRIPE_SECRET_KEY` | server | billing | |
| `STRIPE_WEBHOOK_SECRET` | server | signature verification | |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | client | checkout | |
| `STRIPE_PRICE_ID_PRO` | server | Pro price | |
| `POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_KEY` | server/client | analytics | |
| `POSTHOG_HOST` | client | default EU or US host | |
| `SENTRY_DSN` | server + client | errors | |
| `NEXT_PUBLIC_SENTRY_DSN` | client | errors | |
| `SLACK_WEBHOOK_URL` | server | optional Slack digest (F5) | may be blank |
| `ADMIN_EMAILS` | server | bootstrap admin allowlist | comma-separated |
| `RATE_LIMIT_*` | server | per-action ceilings | |

### 7.2 Configuration rules

1. **Never hardcode** any value from §7.1, plus: API base URLs, plan limits, scoring weights, feature flags.
2. `.env.example` is committed with empty values and a one-line comment per variable. Real `.env.local` is gitignored; production vars live in Vercel + Supabase dashboards only.
3. **Validation at boot:** a Zod `envSchema` in `src/lib/env.ts` throws on missing vars so misconfiguration fails at deploy, not at first user request.
4. **Secrets hygiene:** no secrets in logs, `audit_logs.meta`, Sentry breadcrumbs, or `jobs.raw`. A `redact()` helper strips `*_KEY`, `*_SECRET`, `authorization`, `cookie` before any serialisation.
5. **Plan limits and scoring weights** live in code (`lib/billing/plans.ts`, `lib/scoring/weights.ts`) behind feature flags — not in env vars — so they're reviewed and versioned.
6. **Rotation:** rotate `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `FIRECRAWL_API_KEY`, `STRIPE_WEBHOOK_SECRET` on any suspected exposure; document rotation date in `docs/`.
7. **Per-request scoping:** Server Actions and Route Handlers take the user-scoped client (user JWT → RLS enforced). Service-role client is created lazily and only inside queue handlers.

### 7.3 Local development

```bash
cp .env.example .env.local      # fill from Supabase / Firecrawl / OpenAI dashboards
supabase start                  # local stack
supabase db reset               # migrations + seed
pnpm dev                        # http://localhost:3000
pnpm queue:drain --once         # process one queue batch locally (no Vercel cron)
```

Standalone scripts under `scripts/` load env through Node's built-in `--env-file=.env.local`
flag, wired into the npm script. There is **no `dotenv` dependency** — adding one is a
regression, not a fix.

**Against a remote project:** `supabase link --project-ref <ref>` then `supabase db push`.
A `db push` reporting "up to date" when `supabase/migrations/` is empty means nothing was
applied, not that the schema is current. Confirm via the Supabase MCP `list_migrations`.

---

## 8. Non-Functional Requirements

| Area | Requirement |
|---|---|
| **Performance** | Feed LCP p95 < 2.0s; feed query p95 < 120ms (scored index); job detail SSR < 400ms. Feed is a Server Component — no client fetch waterfall. |
| **Scale assumptions** | 10k MAU · ~2M job rows · ~5M `job_scores` rows at 12 months. Postgres handles this with the indexes in §5; revisit partitioning `job_scores` by month beyond 20M rows. |
| **Cost envelope** | Firecrawl ~$0.003–0.01/page with caching + caps; embeddings ~$0.02 per 1M tokens; rationale only for Pro on jobs ≥ 70. Target **< $1.50/MAU free tier, ≥ 70% gross margin on Pro** (PRD §7 ⑥). Admin dashboard shows spend by `scrape_runs.api_calls`. |
| **Observability** | Structured JSON logs with `requestId` + `runId`; Sentry for exceptions and traces (20% sample); PostHog for funnels; `scrape_runs` + `task_queue` depth as admin tiles; alert when source `consecutive_failures >= 3`. |
| **Reliability** | Queue retries ×3 with exponential backoff; circuit breaker pauses a source at 5 consecutive failures; no cron work blocks a user request; digest idempotent on `(user_id, scheduled_for)`. |
| **Testing** | Unit: scoring, dedupe, normalisation, salary/seniority parsing (target ≥85% on `lib/scoring` + `lib/ingest`). Integration: connector fixtures, RLS policies (`tests/integration/rls`), queue retry. E2E: onboarding → apply → stage move; paywall → checkout. CI blocks merge on any failure. |
| **Accessibility** | WCAG 2.1 AA: focus rings on all controls, `aria-label` on icon-only actions, score communicated by text not colour alone, keyboard paths for feed and kanban. |
| **Data lifecycle** | Account export = JSON bundle (H4). Account delete = cascade delete of all `user_id` rows + Storage objects; `jobs` corpus retained (shared). Documented in the privacy policy. |
| **Browser support** | Last 2 versions of Chrome/Edge/Firefox/Safari; ≥360px viewport. |

---

## 9. Decision Log

| # | Decision | Alternatives considered | Status |
|---|---|---|---|
| D1 | Supabase over separate backend + Clerk/Redis | FastAPI + Postgres + BullMQ | **Accepted** — RLS gives multi-tenant isolation without middleware in every route. |
| D2 | Table-backed queue over Redis/BullMQ/Inngest | BullMQ, Inngest, SQS | **Accepted for MVP** — volume is low; revisit if queue depth > 10k or p95 task latency > 60s. |
| D3 | Poll-based ingestion over source webhooks | RSS/webhooks per source | **Accepted** — no source offers universal webhooks; <6h latency is within target. |
| D4 | Deterministic + embedding score; LLM only for prose | LLM-scores-everything | **Accepted** — reproducibility, cost, and explainability (PRD R4). |
| D5 | No direct LinkedIn/Indeed scraping | Playwright automation | **Rejected** — ToS and legal risk (PRD R2). |
| D6 | Shared global job corpus, per-user scoring | Per-user scraped copies | **Accepted** — one scrape serves all users; cost and freshness both improve. |
| D7 | Hand-written SQL over ORM | Prisma, Drizzle | **Accepted** — RLS policies and query plans stay explicit; schema churn is low. |
| D8 | Firecrawl for rendering, not self-hosted Playwright | Playwright farm on a VM | **Accepted** — no headless-browser ops burden. |

**Review triggers:** revisit D2 and D6 when the job corpus exceeds 10M rows or queue p95 latency exceeds 60s.

---

*Security rules for every table above are specified in [03 Security & Access](./03-security-and-access.md). Design tokens and the integration contract live in [04 Frontend Specification](./04-frontend-specification.md). Build order in [05 Feature Tickets](./05-feature-ticket-list.md).*
