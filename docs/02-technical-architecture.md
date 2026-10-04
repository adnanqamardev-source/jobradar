# 02 — Technical Architecture Document

**Product:** JobRadar · **Version:** 1.0 — MVP
**Feeds from:** [01 PRD](./01-prd.md) · **Consumed by:** [03 Security & Access](./03-security-and-access.md), [04 Frontend Specification](./04-frontend-specification.md), [05 Feature Tickets](./05-feature-ticket-list.md)
**Last reviewed:** 2026-10-04

> **How to read this doc:** Section 2 is the tool list — never introduce a tool that isn't here without updating this document. Section 4 is the folder map — put every new file where the map says. The schema is in [02a-schema.md](./02a-schema.md) — never create a table that isn't defined there. The config contract is in [02c-config.md](./02c-config.md) — never hardcode anything listed there.

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
| **Runtime** | **Node.js** | **24** (pinned in `.nvmrc` + `engines`) | Raised from 20 on 2026-10-04: Vercel has ended support for Node 20, so a build on it fails outright. Pinned in one place and read by CI so the runtime under test is the runtime that deploys — a green run on a different Node proves nothing about the production build. |
| **Framework** | **Next.js (App Router)** | 15.x (pin latest stable at scaffold) | One codebase for marketing site, app, and API routes. Server Components keep the feed fast; Route Handlers host cron endpoints. Replaces: separate Express/FastAPI backend + React SPA. |
| **Language** | **TypeScript** | 5.x strict | Zod + Prisma-or-not type safety across queue payloads and connector outputs. `strict: true`, `noUncheckedIndexedAccess: true`. |
| **UI** | **React** | 19.x | Server Components by default; client components only where there's real interactivity (filters, kanban, wizard). |
| **Styling** | **Tailwind CSS** | 4.x (pinned exact) | Design tokens from [04 Frontend Spec](./04-frontend-specification.md) become CSS variables consumed as utilities. Replaces: component-library lock-in (we want a non-generic look). **Tailwind 4 is CSS-first — there is no `tailwind.config.ts`.** See §4.1. |
| **Component primitives** | **Radix UI** (unstyled) | latest | Accessibility-correct dialogs, menus, popovers, tabs — behaviour only, we own all visuals. |
| **Validation** | **Zod** | 3.x | One schema per entity, shared by API input, DB row, and form. |
| **Database** | **PostgreSQL** via **Supabase** | 17 (Supabase-managed) | Relational data + `pgvector` + RLS in one place. Replaces: Firebase (no SQL/ranking), plain Postgres (no auth/storage/dashboard). |
| **Vector search** | **pgvector** | 0.8.x | `vector(2048)` column + HNSW index. Replaces: Pinecone/Weaviate — an extra vendor and sync layer for a corpus that fits comfortably in Postgres. |
| **Auth** | **Supabase Auth** | — | Magic link + Google OAuth, JWTs that RLS understands natively. Replaces: NextAuth (weaker RLS fit), Clerk (extra cost/vendor). |
| **File storage** | **Supabase Storage** | — | Résumé PDFs, logos. Private buckets + signed URLs. |
| **Web scraping** | **Firecrawl** | v2 API | `scrape` (JS-rendered pages, JSON-schema extraction), `search` (discover postings), `map` (find careers pages). Replaces: self-hosted Playwright farm (ops burden) + raw `fetch` (breaks on JS sites). |
| **Job data APIs** | Greenhouse, Lever, Ashby, Remotive, Arbeitnow, USAJOBS, Adzuna | — | Structured, documented, ToS-friendly. **Used before Firecrawl wherever an API exists** (see §6.1). |
| **Embeddings** | **OpenRouter** `nvidia/nemotron-3-embed-1b:free` | **2048-dim** | OpenAI-compatible `/embeddings` router. Chosen because it is **free** (`pricing.prompt = 0`) and 32k-token context, so long descriptions are not truncated. Batching in chunks of 100. Dimensions are fixed at 2048 — the API rejects any `dimensions` value other than 2048. |
| **LLM rationale** | **OpenRouter** free chat model (`:free`) | — | 2–3 sentence fit rationale + description cleanup. Short output → small model. Gated behind Pro (C5). Model id is configurable via `OPENROUTER_CHAT_MODEL`; must be a `:free` id while the cost envelope holds. |
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
                    │  Greenhouse/Lever/ │  │  OpenRouter embeddings│
                    │  Ashby/Remotive/   │  │  OpenRouter free chat│
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
├── postcss.config.mjs               # Tailwind 4 entry point — see the note below
├── eslint.config.mjs
├── .gitattributes
├── .prettierrc
├── .env.example                     # every var, empty values, documented
├── .gitignore
├── .nvmrc                           # Node 24 — Vercel dropped Node 20; see §2
├── playwright.config.ts
├── vitest.config.mts                # .mts, not .ts — a .ts config loads as CJS and breaks
├── pnpm-workspace.yaml              # pnpm 12 settings + dependency `overrides`, not in package.json
├── .gitleaks.toml                   # secret-scan rules — see §4.2
├── .simple-git-hooks.json           # declares the pre-commit hook
│
├── tools/                           # gitignored — local binaries, see §4.2
│   └── gitleaks/gitleaks.exe        #   fetched by `pnpm secret:install`
│
├── scripts/
│   ├── queue-drain.ts               # local queue worker (replaces Vercel cron)
│   └── scan-bundle-secrets.ts       #   FND-005 CI gate — credential *values* in build output
│
├── docs/                            # ← the seven source documents live here
│   ├── 01-prd.md
│   ├── 02-technical-architecture.md
│   ├── 03-security-and-access.md
│   ├── 04-frontend-specification.md
│   ├── 05-feature-ticket-list.md
│   ├── 06-work-breakdown.md
│   └── 07-session-log.md           # Session log (not authority)
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
│   │   │   ├── plan.ts  constants.ts # ★ §6.4 PROTOCOL: the seam both executors cross
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
│   ├── queue-drain.ts               #   local queue drain — replaces Vercel cron (`pnpm queue:drain --once`)
│   └── scan-bundle-secrets.ts       #   credential-value scan of `.next/` (FND-005 CI gate)
│
├── tests/
│   ├── unit/                        #   scoring, dedupe, normalise, salary parse
│   ├── integration/                 #   connectors vs recorded fixtures, RLS tests
│   │   └── fixtures/sources/        #   *.json per connector (no live calls in CI)
│   └── e2e/                         #   playwright: onboarding, apply flow, tracker
│
└── .github/workflows/
    ├── ci.yml                       #   lint → typecheck → unit → integration → e2e
    └── (no deploy.yml)              #   deploys run via Vercel's Git integration — see below
```

### Deployment — Vercel Git integration, zero YAML

**There is deliberately no `deploy.yml`.** Deployments are driven by Vercel's own Git
integration: the `jobradar` project is connected to `adnanqamardev-source/jobradar`, and every
push to a branch gets a preview, every merge to `main` a production deploy.

This replaced a `.github/workflows/deploy.yml` that ran `amondnet/vercel-action@v25` with
`secrets.VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`. Two reasons it went:

1. **It could not work as written.** None of those three secrets were set, and no Vercel
   project existed, so every push died on `Input required and not supplied: vercel-token`. Its
   `deploy-preview` job was dead on arrival besides — gated on `github.event_name ==
   'pull_request'` inside a workflow triggered only by `push`.
2. **A long-lived account token in repo secrets is a liability.** The service-role key is the
   secret this repo must never leak (`§4` rule 1); storing a Vercel account token next to it
   in GitHub Actions widens the blast radius for no benefit. The Git integration needs no
   token in the repo at all — Vercel holds its own installation grant.

**One-time setup, in the Vercel dashboard:** connect the GitHub repository to the `jobradar`
project. Until that is done, pushes build in CI but produce no deployment.

**What CI still owns.** `ci.yml` keeps every gate — lint, typecheck, test, build, e2e,
secret-scan, audit. Deploy is Vercel's job; correctness is CI's. The e2e job reads
`PLAYWRIGHT_TEST_BASE_URL` from **repository variables**, not secrets, and is deliberately
unset: pointing it at the production URL would test whatever is currently deployed rather than
the commit under review, so a green run would prove nothing about the change.

### Rules that keep this structure healthy

| Rule | Reason |
|---|---|
| `app/**/page.tsx` files contain **no business logic** — they call `lib/` and render. | Keeps routes swappable and testable. |
| A connector knows **only** how to fetch. Normalisation and dedup live in `lib/ingest/`. | New source = 1 file, no duplicated logic. |
| `lib/db/admin.ts` may only be imported from `lib/queue/**`, `api/cron/**`, `api/webhooks/**` (plus `scripts/**` and `tests/**` — neither is client-reachable, and the integration suite must be able to drive the handlers it tests). Enforced by an ESLint `no-restricted-imports` rule. | Prevents the service-role key leaking into client paths. |
| Every user-facing mutation is a Server Action in `api/actions/`, never a raw PostgREST call from a component. | Auth, Zod validation, rate limit, and audit log in one place. |
| Design tokens only in `styles/tokens.css`; no hex values in components. | [04 Frontend Spec](./04-frontend-specification.md) stays enforceable. |
| One Zod schema per entity in `types/`, reused for API input, DB mapping, and forms. | Three definitions drift; one cannot. |

### 4.1 Tailwind 4 is CSS-first — there is no `tailwind.config.ts`

**Changed 2026-10-03.** This section did not exist and the old file tree required
`tailwind.config.ts`. That was wrong for the version we actually pin.

Tailwind 4 reads its settings from **CSS**, not from a JavaScript config file. An old
`tailwind.config.ts` is simply ignored — no error, no warning, the classes just never get
generated. That is why styling appeared to do nothing.

Three things are required, and all three must exist or Tailwind stays inert:

| Piece | Where | What it does |
|---|---|---|
| `@import "tailwindcss";` | top of `src/app/globals.css` | loads Tailwind |
| `postcss.config.mjs` naming the plugin `@tailwindcss/postcss` | repo root | lets Next's build run Tailwind |
| `@tailwindcss/postcss` in `devDependencies` | `package.json` | the plugin itself |

**Token values are not set here.** The colours and sizes from
[04 Frontend Spec](./04-frontend-specification.md) go into an `@theme { … }` block inside
`globals.css`. That work belongs to ticket **ENG-002** (design tokens), not to project setup.

Current state, verified 2026-10-03: `postcss 8.5.28` is installed, but
`@tailwindcss/postcss` is **not**, and no `postcss.config.mjs` exists. Tailwind is inert until
ENG-001 closes this gap.

### 4.2 Secret scanning — local tool, not an npm package

**Changed 2026-10-03.** The setup used to be a `gitleaks` npm dependency plus a
`gitleaks detect` script. **That never worked.** The npm package named `gitleaks` contains only
a `.gitleaks.toml` and a README — no executable, and an empty `bin` field. There is no npm
package that ships the gitleaks binary; it is a Go program distributed as a release download.

How it works now:

| Piece | Where | Role |
|---|---|---|
| `tools/gitleaks/gitleaks.exe` | gitignored | the real binary, pinned to **8.30.1**, checksum-verified on download |
| `pnpm secret:install` | `package.json` | fetches that exact version |
| `pnpm secret:scan` | `package.json` | `gitleaks git --staged` — **staged files only** |
| `pnpm secret:scan:history` | `package.json` | full git history, run manually |
| `.simple-git-hooks.json` | repo root | wires `secret:scan` to `pre-commit` |
| `.gitleaks.toml` | repo root | project rules, on top of the built-in set |

**Why `--staged` and not the working tree.** The real `OPENROUTER_API_KEY` sits in the
gitignored `.env.local`. A whole-directory scan would read it and block every commit. Staged
files only means the hook sees exactly what is about to be committed.

**Why `.gitleaks.toml` is not optional.** Gitleaks' built-in rules have **no rule for any
Supabase key format.** Verified against 8.30.1: `sb_secret_…`, `sb_publishable_…`, and legacy
service-role JWTs all scan clean and exit 0. That is the worst gap for this repo, because the
service-role key bypasses RLS entirely — leaking one hands over the whole database.

One caveat found the hard way: gitleaks allowlists low-entropy placeholders, so
`sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789` is **not** flagged while a realistic random
value is. Test the scanner with realistic shapes, not with `aaaa1111`.

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
