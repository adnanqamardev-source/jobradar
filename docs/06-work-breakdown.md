# 06 — Work Breakdown: Front-End, Back-End & Design Sequencing

**Last reviewed:** 2026-10-04


**Product:** JobRadar · **Version:** 1.0 — MVP
**Source & Spec Reference:** [05 Feature Ticket List](./05-feature-ticket-list.md)
**Architecture Reference:** [02 Technical Architecture](./02-technical-architecture.md) · [03 Security & Access](./03-security-and-access.md) · [04 Frontend Spec](./04-frontend-specification.md)
**Last updated:** 2026-10-03

---

## 1. Guiding Principle: "Engine First, Form Last"

**Last reviewed:** 2026-10-04


To ensure rapid, verifiable progress and eliminate rework, we strictly decouple application logic from visual styling:

1. **Back-End First:** Build the core database, connectors, ingestion pipelines, deduplication, scoring algorithms, queue consumers, and typed Server Actions / Route Handlers. Test everything using automated test suites and fixtures without touching CSS.
2. **Front-End Functional Second:** Build screens, forms, routing, client state, and data fetching with pure semantic HTML and barebones functional UI (unstyled or minimal utility frames). The app must be 100% interactive and feature-complete before visual design begins.
3. **Design & Polish Done Last:** Apply the "Signal" design tokens (`src/styles/tokens.css`), custom typography (Instrument Serif, Inter Tight, JetBrains Mono), custom component styles, animations, responsive breakpoints, WCAG contrast verification, and empty-state illustrations as a final, focused aesthetic pass.

```
┌────────────────────────────────────────────────────────┐
│ PHASE 0: SHARED FOUNDATION                             │
│ Scaffold, TypeScript configs, Supabase DB & RLS       │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ PHASE 1: BACK-END (Track BE)                           │
│ Schema, Connectors, Ingest, Scorer, Queue, Auth/APIs   │
│ (Verified via Unit & Integration Tests, no UI)         │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ PHASE 2: FRONT-END FUNCTIONAL (Track FE)               │
│ Routes, State, Forms, Server Actions, Kanban Logic     │
│ (Verified via E2E Happy Paths with unstyled/raw UI)    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ PHASE 3: DESIGN SYSTEM & POLISH (Track DS — LAST)      │
│ "Signal" palette, Instrument Serif type, ScoreMeter,   │
│ card styling, animations, responsive polish, a11y      │
└────────────────────────────────────────────────────────┘
```

---

## 2. The Seam Contract (Type Safety Across the Boundary)

**Last reviewed:** 2026-10-04


Before Phase 1 and Phase 2 split, the contract between Back-End and Front-End is defined in `src/types/`:
- **`src/types/canonical-job.ts`**: The canonical job data shape.
- **`src/types/db.ts`**: Supabase table row and enum types.
- **`src/types/api.ts`**: Zod schemas for all Server Action payloads and API responses.

The Back-End exposes typed Server Actions in `src/app/api/actions/` and Route Handlers in `src/app/api/`. The Front-End imports these typed functions directly with zero schema drift.

---

## 3. Phase 0 — Shared Foundation

**Last reviewed:** 2026-10-04


These tickets must be completed before Track BE branches off.

| ID | Title | Origin Ticket | Priority | Deliverable |
|---|---|---|---|---|
| **FND-001** | Repo Scaffold & Strict Tooling | `ENG-001` | MUST | Project structure, TypeScript strict configs, linting, Vitest & Playwright configs. **Completed 2026-10-03:** root `app/layout.tsx` + `(marketing)/page.tsx` render `/`; Tailwind 4 CSS-first wiring via `postcss.config.mjs` + `@tailwindcss/postcss`; `eslint-config-next` pinned; secret scanner (`gitleaks`) installed and pre-commit hooked. Verified complete — `pnpm dev` boots, `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass. |
| **FND-002** | Core Database Schema & Migrations | `ENG-003` | MUST | `supabase/migrations/0001_init.sql` containing all 13 enums, 19 tables, pgvector, pg_cron, and seed data. Must include the `halfvec` expression index on `jobs.embedding` ([02](./02-technical-architecture.md) §5.4) and an index on every foreign key in §5.10. **Completed 2026-10-03:** Migration created and applied successfully to local Postgres with pgvector/pg_cron. All 19 tables, 13 enums, views, functions, HNSW indexes, and RLS enablement verified. Seed data inserted. **Claim primitive added 2026-10-06:** `0009_claim_task_queue.sql` closes the `claim-primitive` gap named in [02b §6.4](./02b-subsystems.md) — `public.claim_tasks(p_worker_id, p_limit, p_kind, p_lease_seconds)` does `FOR UPDATE SKIP LOCKED`, reaps expired leases to `pending`, and grants EXECUTE to `service_role` only. `supabase db reset` applies all nine migrations cleanly; two overlapping transactions were verified to claim 4 distinct tasks with zero overlap. |
| **FND-003** | Row-Level Security (RLS) & Policies | `ENG-004` | MUST | RLS policies on all tables using the `(select auth.uid())` wrapper, `force row level security` on every table, `is_admin()` helper, security integration tests. See [03](./03-security-and-access.md) §4.1 and §4.1a. **Completed 2026-10-04:** RLS enabled on all 19 tables with `force row level security`; 26 policies created matching docs/03 §4.2 (owner access, admin read, authenticated read for shared corpus); `is_admin()` helper with `(select auth.jwt())` wrapper for performance. Verified with `pg_policies`. |
| **FND-004** | Structured Logger, Errors & Sentry | `ENG-005` | MUST | `lib/logger.ts` with secret redaction, `lib/errors/` error taxonomy, Sentry init. **Completed 2026-10-04:** `lib/logger.ts` with JSON structured logging, requestId/runId correlation, secret redaction for all key formats (Supabase, OpenRouter, Stripe, generic); `lib/errors/codes.ts` with 22 error codes matching docs/03 §5.1; `lib/errors/AppError.ts` base class with code/httpStatus/requestId/userId; `lib/sentry.ts` with 20% trace sampling, sendDefaultPii: false, beforeSend hook attaching error_code/request_id/user_id; global error.tsx and not-found.tsx with friendly copy and requestId display. |
| **FND-005** | CI Pipeline & Client Secret Scanner | `ENG-006` | MUST | GitHub Actions workflow for lint, test, build, and client bundle secret grep. **Completed 2026-10-04 (first push), corrected five times on 2026-10-04 (pushes 2–6).** The first version was committed as "Completed" while 3 of its 7 jobs failed on the very first push — a green claim with a red run behind it. Corrections: (1) **secret-scan** — the grep `(supabase\|sk-\|whsec_\|rk_live\|sb_secret_\|sb_publishable_)` matched *names*, not credential *values*, so it failed on every build (`supabase` is the library name, in every chunk) while matching a real leak no better. Replaced with `scripts/scan-bundle-secrets.ts`: 9 credential **shapes** each requiring 20+ chars of key material, plus exact-value matching against live env secrets, plus a `SUPABASE_SERVICE_ROLE_KEY` reference check. Verified in both directions — a planted `sb_secret_<40 chars>` fails it, ordinary minified code containing `supabase`/`sk-`/bare `sb_publishable_` passes. Written in TypeScript rather than `.mjs` so `pnpm typecheck` covers the gate itself: a typo in a path or regex must fail the build, not silently disable the check. Exits 2 when `.next/` is missing, so a skipped build cannot read as a passing scan. (2) **audit** — `pnpm audit --level=high` is not a pnpm flag; pnpm exits 2 with `unexpected argument '--level'`, which reads as a CVE failure but is a typo. Corrected to `--audit-level=high`, which then surfaced 4 real advisories in `postcss@8.4.31` (pulled in transitively by `next@15.5.27`, 2 high). Fixed with `overrides: postcss 8.5.28` in `pnpm-workspace.yaml`; `pnpm audit --prod --audit-level=high` now exits 0 and `pnpm build` is unchanged. **Round 4 — `auth/callback` env contract (commit `2aede77`) and its CI consequence.** The route read `process.env.NEXT_PUBLIC_SUPABASE_URL!`; the `!` asserted a value nothing checked, so the first production deploy returned an opaque `500` — `Error: Your project's URL and Key are required to create a Supabase client!` — naming none of the missing variables. Rewritten to import `env` from `@/lib/env`. That change then broke CI's Build job (`Failed to collect page data for /auth/callback`), because `next build` evaluates route modules and the five required vars are absent in CI. Fixed with **placeholder** values in workflow-level `env` — fake by design (the schema checks shape, not function; AGENTS.md forbids live API calls in CI) and shaped to match no credential pattern, since `secret-scan` runs in the same workflow. `tests/unit/ci-placeholders.test.ts` (4 tests) is the oracle: **CI cannot test its own environment**, so a unit test is the only available check. **Two false claims corrected.** I twice asserted — once in a code comment, once in a commit message — that `next build` *succeeds* without env vars because "Next does not evaluate dynamic route modules at build time." It does, and it does fail. The test behind both claims was invalid: `process.env` was cleared but `.env.local` was left in place, and Next auto-loads it, satisfying the schema from under the experiment. The failure then appeared in CI for precisely the reason I had denied. Now a hard rule in `notes.md`: move `.env.local` aside to test an env-dependent failure, and never write an unexecuted timing claim. **Round 5 — invalid workflow YAML.** A revert-edit left two `secret-scan:` job blocks in `ci.yml`. GitHub rejects duplicate mapping keys at parse time, so the run completed in **0 seconds with zero jobs and no log** — and nothing in the repo caught it: lint does not read YAML, typecheck does not, and `python -c "yaml.safe_load(...)"` **passed**, because PyYAML's default loader silently keeps the last value for a duplicate key. Fixed, and permanently gated by `tests/unit/workflow-yaml.test.ts` (5 tests): a hand-rolled duplicate-rejecting YAML loader asserting no duplicate keys at any depth, the exact 7-job set FND-005 requires, the documented `needs` ordering, single-source Node pinning, and the five required env vars. The duplicate-key assertion was proven by re-introducing the duplicate and watching it fail — a config gate is only a gate once you have seen it reject. (3) **e2e** — failed with `Error: No tests found` because `tests/e2e/` held only `.gitkeep`; the job reported failure while proving nothing. Added `tests/e2e/smoke.spec.ts` covering the 4 routes Phase 0 actually created (marketing, login, 404, CTA navigation, mobile overflow, bundle-leak check) across all 3 browser projects — 18 tests, green. Scope note: this is **not** the Phase 2 E2E suite; docs/06 gates that on "onboarding → feed → apply → stage move", and those flows do not exist yet. **Second e2e bug, found on the CI run that verified the first fix (run 37193601701):** all 18 tests then failed with `page.goto: Protocol error (Playwright.navigate): Cannot navigate to invalid URL`. Cause: CI passes `${{ vars.PLAYWRIGHT_TEST_BASE_URL }}`, and GitHub expands an unset repository variable to `""`, *not* `undefined` — so the `??` chain did not fall through, `baseURL` resolved to `""`, the localhost test failed, `webServer` was omitted, and no dev server was ever started. Same blank-vs-undefined trap that broke the env schema (see `notes.md`, 2026-10-03). Fixed with a `firstNonEmpty()` helper; verified by running the suite with the variable set to `""` (18 pass) and against an external URL (correctly boots no dev server). (4) **deploy** — `.github/workflows/deploy.yml` used `amondnet/vercel-action` with `secrets.VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`; none were set and no Vercel project existed, so the job died on `Input required and not supplied: vercel-token`. Its `deploy-preview` job was also dead on arrival — it was gated on `github.event_name == 'pull_request'` inside a workflow triggered only by `push`. **Removed in favour of Vercel's Git integration**, per docs/07 §Step 4 ("zero YAML"), which needs no token in the repo and gives per-PR previews for free. Vercel project `jobradar` (`prj_zy6swdFl6D8QXjzU6zqWIzPv5Rmw`, team `team_w5vI8yJvavpu6bvvW5Zngmk0`) created with Node 20.x and `pnpm install --frozen-lockfile`. Remaining step is a one-time dashboard action: connect the GitHub repo to the project. |

---

## 4. Phase 1 — Back-End Track (`BE`)

**Last reviewed:** 2026-10-04


No styling or UI components are built here. Work is completed when automated unit and integration tests pass with recorded fixtures.

### 4.1 Ingestion & Connectors (Subsystem)

**Last reviewed:** 2026-10-04

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **BE-101** | Connector Interface & Registry | `ING-001` | MUST | `SourceConnector` interface, `RawJob` schema, and dynamic registry. **Completed 2026-10-05:** `src/lib/connectors/{types,http,registry,index}.ts` � `kind` + `costClass` + async-iterable `fetch(cfg, ctx)`; `fetch`/clock/sleep injected on `RunCtx` so contract tests never hit the network; `fetchJson` carries the docs/04 �5.9 policy (30s timeout, `AbortSignal`, retry �3 with `2^n` backoff, typed error mapping); unknown kind throws naming the kind. `RawJob` re-exported from `src/types/canonical-job.ts` rather than redefined. 17 tests. |
| **BE-102** | Tier 1 ATS Connectors (GH, Lever, Ashby) | `ING-002` | MUST | Public API clients parsing boards into `RawJob`. |
| **BE-103** | Remote & Federal Connectors (Remotive, Arbeitnow, USAJOBS) | `ING-003` | MUST | Throttled API clients, USAJOBS custom auth headers. |
| **BE-104** | Aggregator Connector (Adzuna) | `ING-004` | MUST | Country search, salary extraction, quota accounting. |
| **BE-105** | Firecrawl Generic Scraper & Discovery | `ING-005` | MUST | JSON schema-driven extraction via `/v2/scrape`, `/v2/search`, `/v2/map`. |
| **BE-106** | Normalisation Pipeline | `ING-006` | MUST | Salary parser, seniority extractor, regex skill matcher against canonical skills. |
| **BE-107** | Deduplication Engine (Exact + Trigram) | `ING-007` | MUST | SHA-256 dedupe hash upsert + pg_trgm fuzzy similarity merger. |
| **BE-108** | Task Queue Engine & Leases | `ING-008` | MUST | `FOR UPDATE SKIP LOCKED` claim logic, 5-minute leases, exponential backoff. |
| **BE-109** | Cron Ingress Handlers | `ING-009` | MUST | Constant-time `CRON_SECRET` validation on `/api/cron/*` routes. |
| **BE-110** | Freshness & Expiry Lifecycle | `ING-010` | MUST | Status decay (`active` → `stale` → `expired`) & freshness sub-score decay. |
| **BE-111** | Run Logging & Observability | `ING-011` | MUST | `scrape_runs` metrics recorder, duration, error capture, API call attribution. |
| **BE-112** | Manual Trigger Server Action | `ING-012` | SHOULD | `runNow` action with rate-limiting and quota verification. |
| **BE-317** | India / International Remote Scope | `ING-013` | MUST | `remote_scope` enum + `jobs.remote_scope`, remote-scope and salary normalisation (India lakh/crore, `3-2-3` grouping), country/scope feed filter. **Added 2026-10-04. Delivered:** `0003_remote_scope.sql`, `src/lib/ingest/normalize.ts`, [02b �6.6](./02b-subsystems.md#66-normalisation-rawjob--canonicaljob). |

### 4.2 Matching & Scoring (Subsystem)

**Last reviewed:** 2026-10-04

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **BE-201** | Hard Gate Filters | `SCR-001` | MUST | **DONE** — `gates.ts`: 5 gates, machine-readable reasons, never fires on missing data. + shared `utils/company-slug.ts` |
| **BE-202** | Deterministic Rule-Based Scorer | `SCR-002` | MUST | **DONE** — `weights.ts` + `rules.ts`: 6 components, unknown-is-never-0, breakdown always present. SCR-007 flag override deferred |
| **BE-203** | pgvector Embedding Pipeline | `SCR-003` | MUST | **DONE (client half)** — `scoring/semantic.ts`: batched OpenRouter embeddings, index-reordering guard, non-fatal failures. Nothing writes `jobs.embedding` yet (E3), so the pipeline half is open |
| **BE-204** | Score Composition & Persistence | `SCR-004` | MUST | **DONE** — `scoring/index.ts`: pure `composeScore` + service-role `persistScore` upsert on `(user_id,job_id)`; gated jobs written at 0 with reasons. Feed query (BE-306) still open |
| **BE-205** | Batch Profile Rescorer | `SCR-005` | MUST | **DONE** — `queue/handlers/rescore-profile.ts`: bounded 100-job batches, re-enqueues itself when incomplete, concurrency-safe via the `(user_id,job_id)` upsert. FE indicator is Phase 2 |
| **BE-206** | LLM Rationale Generator | `SCR-006` | SHOULD | Structured prompt against an OpenRouter `:free` chat model generating 2-sentence fit + gaps rationale. |
| **BE-207** | Dynamic Weight Flags | `SCR-007` | NICE | Flag-overridable weights without code deployments. |

### 4.3 Auth, User Data & Server Actions

**Last reviewed:** 2026-10-04

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **BE-301** | Magic Link & OAuth Auth Endpoints | `AUT-001`, `AUT-002` | MUST | Server-side auth handlers, PKCE callback, cookie manager (`httpOnly`). **Completed 2026-10-05:** `POST /api/auth/magic-link`, `POST /api/auth/google`, PKCE callback, shared `createAuthServerClient()`. 5 route tests. OTP rate-limiting still with BE-303. |
| **BE-302** | Session Helpers & Route Guards | `AUT-003`, `AUT-004` | MUST | `requireUser()`, `requireAdmin()`, admin bootstrap script via `ADMIN_EMAILS`. **Completed 2026-10-05:** `requireUser()`/`requireAdmin()` in `src/lib/auth/require-user.ts` (lazy env import, fails closed, role from `app_metadata.role`), `createUserClient()` in `src/lib/db/user-client.ts` (anon key + caller JWT). Tests in `tests/unit/auth-guard.test.ts` (8 cases). |
| **BE-303** | OTP Verification Backend | `AUT-005` | SHOULD | 6-digit code verification endpoint with rate-limiting. |
| **BE-304** | Profile & Preferences Mutations | `ONB-002..005`, `ONB-006` | MUST | Server Actions for updating titles, skills, logistics, dealbreakers. **Partially delivered 2026-10-05:** the *creation* half � `0005_handle_new_user.sql` creates the `profiles` row from `auth.users` on signup, one trigger for every auth method (magic link, Google, OTP). Verified locally both ways: metadata `role:"admin"` is ignored (row is `user`), and a null-email signup gets an id-derived placeholder rather than colliding on the unique index. **Mutation half delivered 2026-10-06** (`f8d367e`, fixes in the commit that follows): `updateProfile` (titles/seniority/years/headline/name), `updateLogistics` (work modes, hybrid cap, location, salary, visa), `updateDealbreakers` (blocked/preferred companies, excluded keywords), `updateSkills` (`profile_skills` replace). Each resolves `requireUser()` then writes through the RLS-scoped `createUserClient()`; 21 tests. **Follow-up 2026-10-06:** the three `profiles` actions now share one write path, `lib/db/profile-update.ts` � which is where the `updated_at` optimistic-concurrency check ([03 �5.2](./03-security-and-access.md), new `edit_conflict` 409 code) and `revalidatePath` ([02:183](./02-technical-architecture.md)) live, so both apply to all three instead of needing three edits. The guard was inert at first � `profiles` had no `updated_at` trigger � fixed by `0006_profiles_updated_at.sql`, applied locally and to production. **ONB-006 BE done 2026-10-06:** every successful save enqueues a `rescore_profile` task via `enqueue_rescore_profile()` - a SECURITY DEFINER, argument-free function (migrations `0007`/`0008`), because `task_queue` is RLS-forced with no policies and a user action cannot INSERT. `kind` is fixed, `profile_id` is forced to `auth.uid()`, EXECUTE goes to `authenticated` only, and repeated saves coalesce into one pending task. **Still open:** the `onboarding_completed` write (ONB-005 Finish), rate limiting ([03 S-07](./03-security-and-access.md)), title normalisation/dedupe + `.min(1)`, currency allowlist, company slug helper shared with E3, and free-text pending skills. ONB-007 notification prefs stay unimplemented � `digest_enabled` / `digest_channel` / `high_match_alerts` are not columns in `docs/02a-schema.md` or any migration, so the action would have invented schema. |
| **BE-305** | Feed Actions Backend | `FED-002` | MUST | Server Actions for Save, Dismiss, and Mark Applied (idempotent). |
| **BE-306** | Feed Query & Filtering Engine | `FED-003` | MUST | High-performance PostgREST query on `v_ranked_jobs` with full-text search. |
| **BE-307** | Application Tracker Backend | `TRK-001`, `TRK-002` | MUST | `move_application()` SQL function, application creation, snapshotting, events log. |
| **BE-308** | Saved Searches Engine | `SEA-001` | MUST | Saved search CRUD, filter validation, and preview count query. |
| **BE-309** | Daily Digest Email Pipeline | `SEA-002`, `SEA-003` | MUST | Cron worker selecting top matches, Resend client, timezone scheduling. |
| **BE-310** | High-Match Alert Worker | `SEA-004` | SHOULD | Threshold-triggered immediate email worker with 1/hour rate-limit. |
| **BE-311** | Stripe Billing & Webhook Engine | `BIL-001..003` | SHOULD | Checkout session creation, raw body webhook signature verification, entitlement sync. |
| **BE-312** | Admin Ops Queries | `ADM-002`, `ADM-003`, `ADM-004` | MUST | Ops data fetchers for run logs, queue status, source pausing, task retry. |
| **BE-313** | Account Data Export & Deletion | `ADM-005` | SHOULD | Streamed JSON export and cascading user account purge. |
| **BE-314** | R�sum� Upload, Storage & RLS | `ONB-008` | MUST | Private `resumes` bucket, `resumes` table, owner-only RLS on table **and** `storage.objects`. **Added 2026-10-04. Partially delivered:** `0002_resumes.sql` + `src/lib/storage/resumes.ts` + `src/lib/db/user-client.ts` complete. **`supabase db reset` never run � unverified.** |
| **BE-315** | R�sum� Parsing & Extraction | `ONB-009` | MUST | PDF/DOCX ? text ? `ExtractedProfile`, rule-based default, LLM fallback opt-in and queue-only. **Added 2026-10-04. Partially delivered:** `src/lib/resume/*` complete and unit-tested (176 tests). **PDF/DOCX text extraction is untested** � no fixtures, and `pdfjs-dist` bundling in a server action is unproven. |
| **BE-316** | Profile Bootstrap from R�sum� | `ONB-010` | MUST | Map `ExtractedProfile` ? onboarding prefill; review-before-apply, never auto-save. **Added 2026-10-04. Partially delivered:** `src/lib/resume/bootstrap.ts` (pure, tested) + the three Server Actions. **Actions are blocked at `requireUser()` until BE-302 exists** � they throw rather than fall back to the service role. See [03 �4.2a](./03-security-and-access.md#42a-uploaded-rsum-files--why-this-table-gets-extra-scrutiny). **Unblocked 2026-10-05:** BE-302 landed (`requireUser()`/`requireAdmin()`/`createUserClient()`); the three actions now resolve the caller's JWT and run under RLS. Still unverified end-to-end until a live auth session exists (BE-301). |

---

## 5. Phase 2 — Front-End Functional Track (`FE`)

**Last reviewed:** 2026-10-04


Built using plain semantic HTML, unstyled Radix UI primitives, or basic grid scaffolding. All screens, interactions, and state must work before any design tokens or custom aesthetics are added.

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **FE-101** | Auth Screens & Routing | `AUT-001`, `AUT-002` | MUST | `/login` form, magic link submit, Google button, `/auth/callback` redirector. |
| **FE-102** | Onboarding Multi-Step Wizard Flow | `ONB-001..005` | MUST | 4-step wizard container, step persistence, chip picker, form validation. |
| **FE-103** | Onboarding Real Progress Interstitial | `ONB-005` | MUST | Live polling screen showing genuine background ingestion progress. |
| **FE-104** | App Shell & Navigation Wireframe | `(app)/layout` | MUST | Basic sidebar + topbar layout, active navigation states, mobile menu toggle. |
| **FE-105** | Ranked Job Feed & List View | `FED-001` | MUST | Server Component feed list rendering job cards, empty states, pagination. |
| **FE-106** | Feed Filter Bar & Search Input | `FED-003` | MUST | URL-synced search input, dropdown filter selectors, active filter pills. |
| **FE-107** | Job Card Interactive Actions | `FED-002` | MUST | Save, Dismiss, Apply action handlers with optimistic updates and rollbacks. |
| **FE-108** | Job Detail Page & Content Rendering | `JOB-001` | MUST | `/jobs/[id]` layout, sanitised HTML description, external links. |
| **FE-109** | Score Breakdown Disclosure | `JOB-002` | MUST | Accessible expandable widget displaying points per category. |
| **FE-110** | Mark-as-Applied Dialog Form | `JOB-003` | MUST | Modal collecting applied date, notes, resume version, next action date. |
| **FE-111** | Application Tracker Kanban Board | `TRK-003` | MUST | Multi-column drag-and-drop / keyboard-accessible stage columns. |
| **FE-112** | Application Detail Drawer & Timeline | `TRK-004` | MUST | Slide-over drawer with stage history events and editable notes. |
| **FE-113** | Tracker Metric Stats Cards | `TRK-005` | MUST | Numerical summary cards (Total, Response Rate, Active Interviews). |
| **FE-114** | Follow-Up "Needs Attention" Panel | `TRK-006` | SHOULD | Overdue and upcoming action items widget. |
| **FE-115** | Saved Searches UI & Modal | `SEA-001` | MUST | Create, view, and delete saved searches with result count badges. |
| **FE-116** | User Settings & Profile Editor | `ONB-006`, `ONB-007` | MUST | Edit profile, skills, logistics, dealbreakers, and notification prefs. |
| **FE-117** | Inline Upgrade & Paywall Prompts | `BIL-004` | SHOULD | Non-blocking inline limit notices with Stripe checkout redirect. |
| **FE-118** | Admin Dashboard Interface | `ADM-001..003` | MUST | Tables for sources, scrape runs, queue monitoring, and retry buttons. |
| **FE-119** | R�sum� Upload & Prefill Review | `ONB-008`, `ONB-010` | MUST | Upload step before the wizard, extracted-field review/edit, apply-prefill. **Added 2026-10-04. Not started � Phase 2.** Blocked on BE-302 and on BE-314/316 being unblocked. |
| **FE-120** | Feed Filters: Country & Remote Scope | `ING-013` | MUST | `Country` (All/India/Other) + `Remote Scope` (Any / Remote�India / International), URL-synced. **Added 2026-10-04. Not started � Phase 2.** |

---

## 6. Phase 3 — Design System & Visual Polish (`DS` — DONE LAST)

**Last reviewed:** 2026-10-04


This is the final phase. Visual design, brand aesthetics, typography, micro-interactions, responsive refinements, and accessibility compliance are implemented across the entire working application.

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **DS-001** | Token Architecture & Theme Setup | `ENG-002` | MUST | Activate `src/styles/tokens.css` across Tailwind 4, warm paper background (`#F6F4EF`), ink text (`#14161A`). |
| **DS-002** | Editorial Typography Integration | `ENG-002`, `QUA-002` | MUST | Load Instrument Serif, Inter Tight, and JetBrains Mono with zero layout shift; set optical line-heights and tabular numbers. |
| **DS-003** | Core Component System Visuals | `ENG-002` | MUST | High-craft styling for buttons (primary electric blue `#2440F5`, secondary, ghost), inputs, selects, dialogs, toasts. |
| **DS-004** | Job Card & ScoreMeter Visual Styling | `ENG-002`, `FED-001` | MUST | Distinctive card styling, source badges, hover lifts, acid lime (`#C6F24E`) for scores ≥85, tabular score badges. |
| **DS-005** | Feed & Detail Visual Polish | `FED-001`, `JOB-001` | MUST | Editorial layout, clean typography hierarchy, read-more gradient fades, formatted salary tags, company logo fallbacks. |
| **DS-006** | Kanban Tracker Aesthetic Treatment | `TRK-003` | MUST | Column tints, stage pill badges, clean card grab states, smooth drop transitions, empty column states. |
| **DS-007** | Custom Empty States & Illustrations | `QUA-006` | SHOULD | Editorial typography empty states with subtle line illustrations (never bare "No data"). |
| **DS-008** | Loading Skeleton Shapes & Shimmers | `ENG-002`, `QUA-006` | MUST | Shape-matched skeletons mimicking actual job cards and kanban columns (no spinner-only views). |
| **DS-009** | Micro-Interactions & Motion Budget | `04 §4.4` | MUST | Card dismiss animations (fade + slide out), tab underlines, drawer entrance transitions, `prefers-reduced-motion` compliance. |
| **DS-010** | Responsive Polish (Mobile to Ultrawide) | `QUA-004` | MUST | Bottom navigation rail for mobile, bottom-sheet dialogs, touch targets ≥44px, seamless desktop multi-column rails. |
| **DS-011** | WCAG 2.1 AA Accessibility & Contrast Pass | `QUA-003` | MUST | Verified 4.5:1 contrast ratios, non-color-only score indicators, keyboard focus rings (`2px brand outline`), screen reader audit. |
| **DS-012** | Performance & Lighthouse 90+ Tuning | `QUA-002` | MUST | Image optimisation, CSS bundle tree-shaking, SSR streaming verification, sub-2.0s LCP guarantee. |

---

## 7. Master Traceability Matrix

**Last reviewed:** 2026-10-04


Every single ticket from [05 Feature Ticket List](./05-feature-ticket-list.md) maps into this front-end / back-end / design structure:

| Original 05 Ticket | Phase | Track Ticket(s) | Description / Notes |
|---|---|---|---|
| **ENG-001** | Phase 0 | `FND-001` | Scaffold & tooling |
| **ENG-002** | Phase 3 | `DS-001`, `DS-002`, `DS-003`, `DS-004`, `DS-008` | Component library & design tokens (done last) |
| **ENG-003** | Phase 0 | `FND-002` | Database schema & migrations |
| **ENG-004** | Phase 0 | `FND-003` | Row-Level Security policies |
| **ENG-005** | Phase 0 | `FND-004` | Logging, errors, Sentry |
| **ENG-006** | Phase 0 | `FND-005` | CI pipeline & secret scanner |
| **AUT-001** | Split | `BE-301`, `FE-101` | Magic link auth: BE API + FE form |
| **AUT-002** | Split | `BE-301`, `FE-101` | Google OAuth: BE handler + FE button |
| **AUT-003** | Phase 1 | `BE-302` | Session management & route guards |
| **AUT-004** | Split | `BE-302`, `FE-118` | Admin bootstrap & role gates |
| **AUT-005** | Split | `BE-303`, `FE-101` | OTP fallback: BE handler + FE input |
| **ONB-001** | Phase 2 | `FE-102` | Onboarding wizard shell |
| **ONB-002** | Split | `BE-304`, `FE-102` | Step 1: Titles & seniority (BE mutation + FE step) |
| **ONB-003** | Split | `BE-304`, `FE-102` | Step 2: Skills picker (BE mutation + FE step) |
| **ONB-004** | Split | `BE-304`, `FE-102` | Step 3: Logistics (BE mutation + FE step) |
| **ONB-005** | Split | `BE-304`, `FE-102`, `FE-103` | Step 4: Dealbreakers & interstitial flow |
| **ONB-006** | Split | `BE-304`, `FE-116` | Profile editing & rescore trigger |
| **ONB-007** | Split | `BE-304`, `FE-116` | Notification preferences |
| **ONB-008** | Split | `BE-314`, `FE-119` | R�sum� upload ? private storage + RLS (BE) / upload UI (FE) |
| **ONB-009** | Split | `BE-315`, `FE-119` | R�sum� parsing & extraction ? review screen (FE) |
| **ONB-010** | Split | `BE-316`, `FE-119` | Bootstrap prefill (BE) / apply-prefill in wizard (FE) |
| **ONB-011** | Phase 1 | `BE-315` | Rule-based deterministic extraction as the default (no LLM in the request path) |
| **ING-001** | Phase 1 | `BE-101` | Connector interface & registry |
| **ING-002** | Phase 1 | `BE-102` | Greenhouse, Lever, Ashby connectors |
| **ING-003** | Phase 1 | `BE-103` | Remotive, Arbeitnow, USAJOBS connectors |
| **ING-004** | Phase 1 | `BE-104` | Adzuna aggregator connector |
| **ING-005** | Phase 1 | `BE-105` | Firecrawl scraper & search connector |
| **ING-006** | Phase 1 | `BE-106` | Normalisation & skill extraction |
| **ING-007** | Phase 1 | `BE-107` | Exact & fuzzy deduplication |
| **ING-008** | Phase 1 | `BE-108` | Durable task queue & worker pool |
| **ING-009** | Phase 1 | `BE-109` | Cron ingress & scheduling |
| **ING-010** | Phase 1 | `BE-110` | Freshness decay & expiry |
| **ING-011** | Phase 1 | `BE-111` | Scrape run logging & metrics |
| **ING-012** | Split | `BE-112`, `FE-105` | Manual "run now" action & trigger |
| **ING-013** | Split | `BE-317`, `FE-120` | India vs international remote scope � enum + normalisation (BE) / country & scope filters (FE) |
| **SCR-001** | Phase 1 | `BE-201` | Hard gates (knockout filters) |
| **SCR-002** | Phase 1 | `BE-202` | Deterministic rule-based scoring |
| **SCR-003** | Phase 1 | `BE-203` | OpenRouter pgvector embedding |
| **SCR-004** | Phase 1 | `BE-204` | Score composition & `v_ranked_jobs` |
| **SCR-005** | Phase 1 | `BE-205` | Batch profile rescoring worker |
| **SCR-006** | Phase 1 | `BE-206` | LLM fit rationale |
| **SCR-007** | Phase 1 | `BE-207` | Score weight feature flags |
| **FED-001** | Split | `FE-105`, `DS-004`, `DS-005` | Feed: FE functional list → DS styling |
| **FED-002** | Split | `BE-305`, `FE-107` | Feed actions: BE mutations + FE buttons |
| **FED-003** | Split | `BE-306`, `FE-106` | Filters & search: BE query + FE controls |
| **FED-004** | Phase 2 | `FE-105` | "New since last visit" toggle & filter |
| **FED-005** | Split | `BE-107`, `FE-107` | Duplicate cluster handling |
| **FED-006** | Phase 2 | `FE-105` | Keyboard navigation (`j`/`k`/`s`/`x`/`a`) |
| **JOB-001** | Split | `FE-108`, `DS-005` | Job detail: FE layout → DS styling |
| **JOB-002** | Split | `FE-109`, `DS-004` | Score breakdown disclosure |
| **JOB-003** | Split | `BE-307`, `FE-110` | Mark applied: BE mutation + FE modal |
| **JOB-004** | Phase 2 | `FE-108` | Related sightings list |
| **TRK-001** | Phase 1 | `BE-307` | Application record creation & snapshots |
| **TRK-002** | Phase 1 | `BE-307` | Stage pipeline validation & history events |
| **TRK-003** | Split | `FE-111`, `DS-006` | Kanban board: FE drag-and-drop → DS styling |
| **TRK-004** | Phase 2 | `FE-112` | Application drawer detail |
| **TRK-005** | Split | `BE-307`, `FE-113` | Tracker stats: BE calculation + FE cards |
| **TRK-006** | Split | `BE-307`, `FE-114` | Follow-up reminders panel |
| **TRK-007** | Phase 1 | `BE-307` | CSV application import |
| **SEA-001** | Split | `BE-308`, `FE-115` | Saved searches CRUD |
| **SEA-002** | Phase 1 | `BE-309` | Daily digest email worker & React Email |
| **SEA-003** | Phase 1 | `BE-309` | Timezone scheduling worker |
| **SEA-004** | Phase 1 | `BE-310` | High-match instant alert |
| **SEA-005** | Phase 1 | `BE-309` | Slack digest poster |
| **BIL-001** | Phase 1 | `BE-311` | Plan definitions & usage counters |
| **BIL-002** | Split | `BE-311`, `FE-117` | Stripe checkout session creation |
| **BIL-003** | Phase 1 | `BE-311` | Stripe webhook signature & entitlement sync |
| **BIL-004** | Phase 2 | `FE-117` | Inline paywall notices |
| **BIL-005** | Phase 1 | `BE-311` | Dunning & grace period worker |
| **ADM-001** | Phase 2 | `FE-118` | Admin shell navigation & route guards |
| **ADM-002** | Split | `BE-312`, `FE-118` | Source health & run log viewer |
| **ADM-003** | Split | `BE-312`, `FE-118` | Queue monitor & task retry |
| **ADM-004** | Split | `BE-312`, `FE-118` | User account lookup |
| **ADM-005** | Split | `BE-313`, `FE-116` | Account export & delete flow |
| **QUA-001** | Cross | Phase 1 + 2 | Playwright E2E automation suite |
| **QUA-002** | Phase 3 | `DS-012` | Performance & Lighthouse 90+ tuning |
| **QUA-003** | Phase 3 | `DS-011` | Full WCAG 2.1 AA accessibility audit |
| **QUA-004** | Phase 3 | `DS-010` | Responsive cross-device layout pass |
| **QUA-005** | Cross | Launch | Pre-launch checklist & security sign-off |
| **QUA-006** | Phase 3 | `DS-007`, `DS-008` | Empty & loading state polish |
| **BKG-001..012** | Backlog | — | Phase 2 / Backlog items |

---

## 8. Execution Playbook

**Last reviewed:** 2026-10-04


How to run the three phases without the plan rotting. Generic advice (small commits, write tests) is omitted — only the rules specific to an engine-first / design-last split are here.

### 8.1 Freeze the seam before Phase 1 starts

**Last reviewed:** 2026-10-04


The back-end finishes before the front-end exists, so the contract *is* the product.

- **Zod is the source of truth; TypeScript is derived.** Define each schema once in `src/types/api.ts` and export `z.infer<typeof X>`. Never hand-write a parallel interface — two definitions drift.
- **Contract-first by ticket, not by phase.** A BE ticket that changes an API shape updates the type file **in the same commit**. A FE ticket opened against a stale type is a blocked ticket.
- **Nothing bypasses the seam.** Components never call PostgREST directly — only `lib/db/queries/` and Server Actions. One direct call inside a component and the boundary is gone.

### 8.2 Phase gates are tests, not opinions

**Last reviewed:** 2026-10-04


Each phase ends with an objective, automatable gate. No "looks done."

| Gate | Passes when |
|---|---|
| **P0 → P1** | `supabase db reset` from empty succeeds · RLS policy tests green · CI green with zero features |
| **P1 → P2** | All BE tests green with **no live API calls** · `lib/scoring` + `lib/ingest` ≥85% · scorer proven deterministic (same input → same score) |
| **P2 → P3** | Playwright E2E green against **unstyled** UI: onboarding → feed → apply → stage move |
| **P3 → Ship** | axe zero violations · AA contrast · Lighthouse ≥90 · `prefers-reduced-motion` honoured |

The **P2 gate is the one people skip.** If the flow doesn't work in plain HTML, styling it won't fix it — you'd just be debugging logic through CSS.

### 8.3 Split accessibility across phases

**Last reviewed:** 2026-10-04


The most common failure of "design last" is lumping all a11y into the design phase.

| Phase owns | Covers |
|---|---|
| **Phase 2 — structure** | Semantic elements · real `<button>` not `<div onClick>` · label/control association · heading order · focus order · live regions · `aria-expanded` |
| **Phase 3 — presentation** | Contrast ratios · focus-ring visibility · non-colour-only signalling · touch-target size |

If structure slips to Phase 3, the design pass becomes a rewrite. Hence `DS-011` is a contrast and screen-reader *audit*, not markup work.

### 8.4 "Unstyled" must not become "unstructured"

**Last reviewed:** 2026-10-04


Use **Radix primitives unstyled from Day 1 of Phase 2.** Behaviour (focus trap, keyboard nav, drag-and-drop) is Phase 2; visuals are Phase 3.

- `Dialog`, `Dropdown`, `Tabs` → Radix with **no CSS** in P2.
- `Button` → a thin wrapper around a native `<button>`.

Hand-rolling a modal out of `<div>`s in P2 means Phase 3 rewrites it instead of restyling it.

### 8.5 Test the back-end without the world

**Last reviewed:** 2026-10-04


- **Fixtures, never live APIs, in CI** — recorded JSON per connector in `tests/integration/fixtures/sources/`. Live calls burn quota, go flaky, and block unrelated PRs when a source rate-limits.
- **Testcontainers Postgres** for RLS and queue tests — `FOR UPDATE SKIP LOCKED` concurrency can't be validated on SQLite or a mock.
- **Inject the clock.** Freshness decay, digest timezones and retry backoff become deterministic with a fake clock instead of a `sleep`.
- **Prove idempotency explicitly:** run each queue handler twice, assert one row. This is what makes the retry/backoff design actually safe.

### 8.6 Rules for AI-assisted execution

**Last reviewed:** 2026-10-04


The tickets in [05](./05-feature-ticket-list.md) were written prompt-sized on purpose. Two rules make that work:

1. **Give the agent the ticket *and* its doc sections** — e.g. *"implement `BE-107`; schema in 02 §6.2, RLS in 03 §4.2."* Tickets alone invite invention.
2. **Require evidence before "done":** run `pnpm typecheck && pnpm test` and paste the output before claiming completion. A green checkmark from a model with no output behind it is worthless.

Plus the anti-invention rule from the README: **if the agent needs something the docs don't specify — a table, an env var, a colour, an endpoint — it updates the doc first, then builds.** That keeps docs 01–06 the source of truth instead of a description of what the code happened to become.

### 8.7 Three anti-patterns to block explicitly

**Last reviewed:** 2026-10-04


| Anti-pattern | Why it hurts |
|---|---|
| A "temporary" hex value or inline style in Phase 2 | It becomes de-facto design and contradicts `tokens.css`. Turn on the CI grep at the **start of P2**, not P3. |
| Schema changes after P1 without a migration + doc 02 update | The traceability matrix in §7 rots silently otherwise. |
| Scope creep into design during P1 | "Just quickly style this admin table" costs more than it saves and produces a third visual system. |

---

## 9. Immediate Next Step: Phase 0 & Phase 1 Execution

**Last reviewed:** 2026-10-04


Now that the boundary and sequencing are locked in:
1. Complete **Phase 0 Foundation** (`FND-001` through `FND-005`).
2. Implement **Phase 1 Back-End** starting with the Database Migrations (`FND-002`) and Ingestion Connectors (`BE-101`..`BE-105`).
3. Validate the entire backend with automated tests before writing any front-end UI.

