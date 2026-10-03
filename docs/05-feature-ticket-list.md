# 05 — Feature Ticket List

**Product:** JobRadar · **Version:** 1.0 — MVP
**Source:** [01 PRD](./01-prd.md) · **Constraints:** [02 Architecture](./02-technical-architecture.md), [03 Security](./03-security-and-access.md), [04 Frontend Spec](./04-frontend-specification.md)
**Last updated:** 2026-10-03

**How to use this doc:** each ticket is written so it can be pasted directly into an AI coding tool as a single prompt. One ticket = one unit of work that an agent can complete and that you can verify without reading the rest of the codebase.

**Priority:** `MUST` = required for MVP launch · `SHOULD` = within 6 weeks of launch · `NICE` = backlog
**Tags:** `[SEC]` security · `[DATA]` data/pipeline · `[UI]` interface · `[OPS]` operations

### Reading a ticket

| Field | Meaning |
|---|---|
| **ID** | Stable reference. Never reuse. |
| **Depends on** | Must be merged and verified first. Work only in dependency order. |
| **Done when** | Acceptance criteria. Every box must be checked before the ticket closes. Nothing is "done" at 90%. |
| **Reference** | The spec section that defines the details — read it before writing code. |

### Build order (epics)

```
E0 Foundation ─▶ E1 Auth ─▶ E2 Onboarding ─▶ E3 Ingestion ─▶ E4 Scoring ─▶ E5 Feed
                                          └──────────────▶ E6 Job Detail & Actions ─▶ E7 Tracker
                                          └──────────────▶ E8 Searches & Digest
        E9 Billing & Gating (after E2)   E10 Ops (parallel from E3)   E11 Polish (last)
```

---

## E0 — Foundation

### ENG-001 — Project scaffold & tooling
**[DATA] [UI]** · **Priority:** MUST · **Depends on:** —

Initialise the Next.js (App Router) + TypeScript + Tailwind project with the folder structure in [02 §4](./02-technical-architecture.md). Enable `strict` TS, ESLint with `eslint-config-next`, Prettier, and path alias `@/* → src/*`. Add `vitest` and `playwright` configs. Commit `.env.example` listing every variable from [02 §7.1](./02-technical-architecture.md) with empty values and a comment each.

**Done when:**
- [ ] `pnpm dev` boots at `localhost:3000` with a placeholder page
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass on an empty suite
- [ ] Folder tree matches [02 §4](./02-technical-architecture.md) exactly (including empty dirs with `.gitkeep`)
- [ ] `.env.example` contains every variable from [02 §7.1](./02-technical-architecture.md), none with real values
- [ ] `.gitignore` excludes `.env.local`; `gitleaks` pre-commit hook installed
- [ ] ESLint rule blocks imports of `src/lib/db/admin.ts` outside `lib/queue/**`, `api/cron/**`, `api/webhooks/**`

---

### ENG-002 — Design tokens & component primitives
**[UI]** · **Priority:** MUST · **Depends on:** ENG-001

Create `src/styles/tokens.css` with **every** colour, type, spacing, motion, and shadow token from [04 §1–4](./04-frontend-specification.md). Wire them into Tailwind as utilities. Build the primitives in `src/components/ui/`: `Button`, `Input`, `Textarea`, `Checkbox`, `Select/Combobox`, `Chip`, `Badge`, `Card`, `Dialog`, `Dropdown`, `Toast`, `Tabs`, `Tooltip`, `ScoreMeter`, `EmptyState`, `Skeleton`. Load fonts via `next/font`.

**Done when:**
- [ ] No hex literal appears anywhere outside `tokens.css` (CI grep enforces)
- [ ] Every primitive has default / hover / focus-visible / active / disabled / loading states
- [ ] Focus ring is `2px solid --color-brand`, `2px` offset, on every interactive element
- [ ] `ScoreMeter` exposes `role="progressbar"` with `aria-valuenow/min/max` and the label text from [04 §1.3](./04-frontend-specification.md)
- [ ] Component gallery route renders every state; `vitest-axe` passes with zero violations
- [ ] Contrast check passes AA for all text-on-fill pairs in [04 §1.4](./04-frontend-specification.md)

---

### ENG-003 — Supabase project, migrations & seed
**[DATA] [SEC]** · **Priority:** MUST · **Depends on:** ENG-001

Stand up the Supabase project and write migration `0001_init.sql` implementing **every** enum, table, index, view, and function from [02 §5](./02-technical-architecture.md). Enable `pgvector` and `pg_cron`. Seed `skills` (~600 rows with aliases) and the default `sources` rows. Write `seed.sql` for local dev.

**Done when:**
- [ ] All tables from [02 §5.3–5.8](./02-technical-architecture.md) exist with correct columns, types, FKs, and cascades
- [ ] `jobs.dedupe_hash` is `unique`; HNSW indexes exist on `jobs.embedding` and `profiles.profile_embedding`
- [ ] Partial index on `task_queue(status, run_after, priority) where status='pending'`
- [ ] Full-text GIN index on `jobs` title+description; trigram on `title_norm`/`company_domain`
- [ ] `v_ranked_jobs` view and `move_application()` function work as specified
- [ ] `supabase db reset` on a clean machine yields a working schema + seed
- [ ] All migrations are idempotent / forward-only (no hand edits to applied migrations)

---

### ENG-004 — RLS policies on every table
**[SEC]** · **Priority:** MUST · **Depends on:** ENG-003

Implement the policy table from [03 §4.2](./03-security-and-access.md): RLS **enabled** on every table with default deny, plus `is_admin()` helper. Write integration tests that prove each policy.

**Done when:**
- [ ] `select * from pg_tables` shows RLS enabled for every app table
- [ ] Test: user A cannot `select`/`update`/`delete` user B's `profiles`, `job_scores`, `applications`, `saved_searches`, `resume_versions`, `digests`
- [ ] Test: authenticated user can `select` `jobs`/`skills`/`companies`/`sources` but `insert` fails
- [ ] Test: `task_queue`, `scrape_runs`, `audit_logs` return nothing for a normal authenticated role
- [ ] Test: `subscriptions.plan` `update` as a normal user **fails**
- [ ] Test: `job_scores` `insert` as a normal user **fails** (scorer is service-role only)
- [ ] Test: admin can `select` `scrape_runs` and `sources`, but **cannot** `select` another user's `applications`

---

### ENG-005 — Structured logging, error taxonomy & Sentry
**[OPS] [SEC]** · **Priority:** MUST · **Depends on:** ENG-001

Create `lib/logger.ts` (JSON with `requestId`/`runId`, `redact()` on `*_KEY`, `*_SECRET`, `authorization`, `cookie`) and `lib/errors/` with `AppError` + the code→copy map from [03 §5.1](./03-security-and-access.md). Wire Sentry with `sendDefaultPii: false`. Build the 404, 500, and error boundary pages showing a copyable `requestId` and **never** a stack trace.

**Done when:**
- [ ] Every code in [03 §5.1](./03-security-and-access.md) exists with its exact user-facing copy
- [ ] Test: a logger call containing a fake `OPENROUTER_API_KEY` outputs `***`
- [ ] 500 page shows friendly copy + `requestId`, no stack trace, no env values
- [ ] 404 for a not-yours resource is byte-identical to a genuinely missing resource
- [ ] Sentry receives the error with `{code, requestId, userId}` and `sendDefaultPii:false`
- [ ] Every error response carries the correct status (401/403/404/422/429/500)

---

### ENG-006 — CI pipeline
**[OPS]** · **Priority:** MUST · **Depends on:** ENG-001

`.github/workflows/ci.yml`: install → lint → typecheck → unit → integration (Testcontainers Postgres) → build → Playwright e2e → **secret-scan the built client bundle** → `pnpm audit` (high/critical fail). PR previews deploy to Vercel; merge to `main` deploys production.

**Done when:**
- [ ] CI fails on lint error, type error, failing test, or high/critical CVE
- [ ] Bundle scan fails the build if `supabase|sk-|whsec_|rk_live` appears in client output
- [ ] Playwright runs against the preview deployment, not just localhost
- [ ] Required status checks block merging to `main`

---

## E1 — Authentication & Accounts

### AUT-001 — Magic-link sign-in
**[SEC] [UI]** · **Priority:** MUST · **Depends on:** ENG-003, ENG-004

Build `/login` with the email magic-link flow ([03 §2.1](./03-security-and-access.md)) and the `/auth/callback` route exchanging the code for session cookies. Route new users to `/onboarding`, returning users to `/dashboard`.

**Done when:**
- [ ] Entering an email sends a link; clicking it establishes a session and routes correctly
- [ ] Expired/reused link → *"This link has expired. Request a new one."* with one-click resend
- [ ] Rate limit: 3 links / 10 min per email, 5 attempts / 15 min per IP → `too_many_attempts`
- [ ] Response is identical whether or not the email exists (no enumeration) — verified by test
- [ ] Cookie is `httpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefixed
- [ ] `?next=` only accepts same-origin paths starting with `/`; anything else → `/dashboard`

---

### AUT-002 — Google OAuth sign-in
**[SEC] [UI]** · **Priority:** MUST · **Depends on:** ENG-003

Add "Continue with Google" via Supabase `signInWithOAuth` with PKCE + `state`/`nonce` validation.

**Done when:**
- [ ] Google consent → session established → correct route (new vs returning)
- [ ] Mismatched/missing `state` → `auth_failed` error page, not a crash
- [ ] Unverified provider email is rejected with a clear message
- [ ] Both paths in AUT-001 and this ticket land in the same `(app)` shell

---

### AUT-003 — Session management & route guards
**[SEC]** · **Priority:** MUST · **Depends on:** AUT-001

Implement `lib/auth/session.ts` (`getServerSession`, `requireUser`, `requireAdmin`), `(app)/layout.tsx` guard, and session cookie rotation with 1h access / 30d refresh ([03 §2.2](./03-security-and-access.md)).

**Done when:**
- [ ] Unauthenticated hit on any `(app)` route → `/login?next=…`, then restored after sign-in
- [ ] Access token refreshes silently; an expired refresh token → clean `/login` with return path
- [ ] Logout clears cookies **and** invalidates the refresh token server-side
- [ ] `/admin` as a non-admin → redirect to `/dashboard` with the neutral message (never a 403 wall)
- [ ] Role change is picked up without waiting for token expiry (test: demoted admin bounces off `/admin`)

---

### AUT-004 — Admin bootstrap & role gate
**[SEC] [OPS]** · **Priority:** MUST · **Depends on:** AUT-003

One-time migration grants `role='admin'` to `ADMIN_EMAILS`. Build `requireAdmin()` used by the `(app)/admin` layout **and** re-checked inside every admin Server Action ([03 §3.2](./03-security-and-access.md)).

**Done when:**
- [ ] Only emails in `ADMIN_EMAILS` receive admin at bootstrap; self-assignment via the app is impossible
- [ ] Every admin Server Action independently re-verifies `is_admin()` server-side
- [ ] Admin mutations write `audit_logs` rows with actor, action, target
- [ ] Test: a non-admin calling an admin action directly gets `forbidden`, not a silent success

---

### AUT-005 — OTP code fallback
**[SEC] [UI]** · **Priority:** SHOULD · **Depends on:** AUT-001

Add 6-digit email OTP as a fallback for clients that break magic links ([03 §2.1](./03-security-and-access.md)).

**Done when:**
- [ ] 6-digit code, 10-minute expiry, 5 attempts max then `account_locked` with cooldown copy
- [ ] Wrong code → *"That code didn't match. Try again."*, attempt counter shown
- [ ] Identical rate limits and enumeration-resistance as magic link

---

## E2 — Onboarding & Profile

### ONB-001 — Onboarding wizard shell
**[UI]** · **Priority:** MUST · **Depends on:** ENG-002, AUT-003

Build the 4-step wizard with progress rail, `Back`/`Continue`, per-step Zod validation, and `onboarding_step` persisted on every step so an abandoned wizard resumes ([01 §5 Flow 1](./01-prd.md)).

**Done when:**
- [ ] Steps render in order: role & seniority → skills → logistics → dealbreakers
- [ ] Progress persists server-side on each step; abandoning at step 2 resumes at step 2 next login
- [ ] Unfinished profile shows a resume banner; `onboarding_completed` stays `false`
- [ ] `Continue` disabled until the step's minimum is met; a `Skip for now` path exists on step 1
- [ ] Wizard is keyboard-navigable; focus moves to the step heading on change
- [ ] Mobile: single column, 16px gutters, no horizontal scroll at 360px

---

### ONB-002 — Step 1: target roles & seniority
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-001

Multi-select target titles (free text allowed), seniority enum, years of experience → `profiles.target_titles`, `seniority`, `years_experience`.

**Done when:**
- [ ] At least one title required to continue; entered titles persist as chips with remove
- [ ] Free-text titles are accepted and normalised (trim, dedupe, case preserved for display)
- [ ] Saves to the DB and is readable by the scorer in E4
- [ ] Validation error renders inline under the field, not as a toast

---

### ONB-003 — Step 2: skills picker
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-002

Searchable chip picker over `skills` (with `aliases`) + free-text add, per-skill level → `profile_skills`.

**Done when:**
- [ ] Search matches `name` and `aliases`, debounced ≤200ms
- [ ] Minimum 3 skills to continue; each has a level (`familiar`/`proficient`/`expert`)
- [ ] Free-text adds create a pending skill entry handled without breaking the FK contract
- [ ] Skills drive the `profile_embedding` recompute job
- [ ] Selecting and deselecting is undoable within the session

---

### ONB-004 — Step 3: logistics
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-002

Country, remote preference, hybrid days, minimum compensation + currency + period, visa requirement → the matching inputs in `profiles`.

**Done when:**
- [ ] Remote preference writes `work_modes[]`; hybrid days only shown when hybrid selected
- [ ] Salary accepts value + currency + period; empty salary = no floor (`NULL`), not `0`
- [ ] Currency list is a fixed allowlist; period ∈ `year|month|hour`
- [ ] Values are exactly what `gates.ts` reads (verified by the unit tests in SCR-001)

---

### ONB-005 — Step 4: dealbreakers & completion
**[UI] [DATA] [SEC]** · **Priority:** MUST · **Depends on:** ONB-003, ONB-004

Blocked companies (typeahead), excluded keywords, preferred companies → `profiles.blocked_companies`, `excluded_keywords`, `preferred_companies`. `Finish` sets `onboarding_completed = true`.

**Done when:**
- [ ] Company typeahead normalises to `slug` (shared helper with dedupe in E3)
- [ ] Keywords are normalised (lowercase, trimmed, deduped) and capped at a sane limit
- [ ] Finish sets `onboarding_completed`, fires `onboarding_completed` analytics event with `duration_s`
- [ ] Finish enqueues the first ingestion run **and** shows the real progress interstitial (no fake loader)
- [ ] Interstitial polls actual counters: sources scanned / jobs found / jobs scored

---

### ONB-006 — Profile editing & rescore
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-005

Settings pages to edit every onboarding field; saving triggers a `rescore_profile` task (never synchronous — C4).

**Done when:**
- [ ] Every onboarding field is editable post-setup from `/settings`
- [ ] Save enqueues `rescore_profile`; the UI shows "Rescoring your feed…" then a toast on completion
- [ ] Concurrent edit from two tabs → optimistic-concurrency message from [03 §5.2](./03-security-and-access.md)
- [ ] Changes are reflected in new scores; historical scores are replaced, not duplicated

---

### ONB-007 — Notification preferences
**[UI]** · **Priority:** SHOULD · **Depends on:** ONB-005

Per-channel, per-cadence digest controls: send time (IANA time zone), weekdays, max items, high-match threshold, mute.

**Done when:**
- [ ] User can set time + weekdays + item cap; resolved local time is previewed ("Every day at 8:00 AM (Asia/Kolkata)")
- [ ] Mute stops all email; unsubscribe link works without a session
- [ ] DST correctness verified with a test around a transition date ([03 §6.1 X-17](./03-security-and-access.md))

---

## E3 — Ingestion & Sources

### ING-001 — Connector interface & registry
**[DATA]** · **Priority:** MUST · **Depends on:** ENG-003

Implement `SourceConnector`, `RawJob`, and `registry.ts` exactly as specified in [02 §6.1](./02-technical-architecture.md), with a Zod schema per connector output.

**Done when:**
- [ ] `types.ts` matches the interface in [02 §6.1](./02-technical-architecture.md)
- [ ] `registry` maps `source_kind` → connector; unknown kind fails loudly
- [ ] Every connector validates its response through Zod before returning
- [ ] Contract tests run against recorded fixtures — **no live API calls in CI**
- [ ] Each connector sets timeout, `AbortSignal`, and retry per [04 §5.9](./04-frontend-specification.md)

---

### ING-002 — Tier 1 API connectors (Greenhouse, Lever, Ashby)
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement the three public ATS connectors per the field-mapping table in [04 §5.2](./04-frontend-specification.md).

**Done when:**
- [ ] Each maps to `RawJob` with `externalId`, `sourceUrl`, `title`, `companyName`, `postedAt`, `descriptionHtml` populated
- [ ] HTML content is preserved (not stripped) for `description_html`
- [ ] Fixtures for each connector pass the contract test
- [ ] Pagination / large boards handled without truncation
- [ ] Failure returns a typed error → `upstream_error`, never an unhandled throw

---

### ING-003 — Tier 1 connectors (Remotive, Arbeitnow, USAJOBS)
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement per [04 §5.2](./04-frontend-specification.md). USAJOBS requires `Host`, `Authorization-Key`, **and** a `User-Agent` header.

**Done when:**
- [ ] Remotive respects ≤1 request / 1.5s (throttled in the pipeline)
- [ ] USAJOBS sends all three required headers; missing key fails fast with a clear ops message
- [ ] Arbeitnow `is_remote` maps to `work_mode`
- [ ] All three pass fixture contract tests

---

### ING-004 — Adzuna aggregator connector
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement Adzuna search with country/`what`/`where` params and salary extraction (`salary_min`/`salary_max` → `salaryRaw` fallback).

**Done when:**
- [ ] Credentials read from env only; missing creds fail fast
- [ ] Salary fields map into `salary_min`/`salary_max`/`salary_currency` when present
- [ ] `descriptionHtml` handled (Adzuna returns HTML)
- [ ] Fixture contract test passes; `api_calls` counted for cost attribution

---

### ING-005 — Firecrawl generic connector
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement `firecrawl.ts` using `/scrape` (JSON-schema extraction), `/search`, and `/map` exactly as specified in [04 §5.1](./04-frontend-specification.md).

**Done when:**
- [ ] `/scrape` sends `formats:["json"]`, `onlyMainContent:true`, `maxAge` 12h, 30s timeout
- [ ] Extraction schema matches `RawJob`
- [ ] Output validated by Zod; a bad parse → `scrape_parse_failed`, run `partial`, no user-facing error
- [ ] URL validation rejects non-`https`, localhost, and private IP ranges ([03 §6.2 S-05](./03-security-and-access.md))
- [ ] Daily Firecrawl call count is recorded and capped per plan

---

### ING-006 — Normalisation pipeline
**[DATA]** · **Priority:** MUST · **Depends on:** ING-002, ING-003, ING-004, ING-005

`lib/ingest/normalize.ts`: `RawJob` → `CanonicalJob`. Parse salary strings, seniority from title, employment type, location, remote/hybrid signals, and extract skills into `job_skills`.

**Done when:**
- [ ] Salary parser handles `$160k–$190k`, `160000-190000 USD`, `€70.000/Jahr`, hourly rates, and returns `unknown` (never a guess) when ambiguous
- [ ] Seniority parser maps title → enum, `unknown` when unclear
- [ ] Work-mode detection matches keywords (`remote`, `hybrid`, `on-site`, `in office`)
- [ ] Skill extraction uses `skills.aliases` with regex, low-confidence matches weighted `< 0.5`
- [ ] Unit tests cover ≥20 real-world title/salary/description samples
- [ ] Nothing unparseable throws — it lands with `confidence < 1`

---

### ING-007 — Deduplication
**[DATA]** · **Priority:** MUST · **Depends on:** ING-006

Two-pass dedupe per [02 §6.2](./02-technical-architecture.md): exact `dedupe_hash` upsert + trigram fuzzy merge.

**Done when:**
- [ ] Hash = `sha256(norm_title | norm_company_domain | norm_city | work_mode)` with legal suffixes stripped
- [ ] `on conflict (dedupe_hash)` updates `last_seen_at` and increments `sighting_count`, **does not** duplicate
- [ ] Fuzzy pass merges `similarity > 0.85` + matching domain, keeping the richer description
- [ ] Test: the same posting from 3 sources yields **one** `jobs` row with `sighting_count = 3`
- [ ] Test: two genuinely different roles at the same company are **not** merged

---

### ING-008 — Task queue
**[OPS] [DATA]** · **Priority:** MUST · **Depends on:** ENG-003

Implement `task_queue` claim/run/retry with `FOR UPDATE SKIP LOCKED`, 5-minute leases, exponential backoff, `max_attempts = 3` ([02 §6.4](./02-technical-architecture.md)).

**Done when:**
- [ ] Claim statement matches [02 §6.4](./02-technical-architecture.md); concurrent workers never double-claim
- [ ] Lease expiry returns orphaned tasks to `pending`
- [ ] Backoff at 30s / 2m / 8m; at `max_attempts` → `failed` + `audit_logs` + admin visibility
- [ ] Handlers are idempotent (test: run twice, same end state)
- [ ] Batch size respects Vercel function timeout; incomplete work re-enqueues itself

---

### ING-009 — Cron ingress & scheduler
**[OPS] [SEC]** · **Priority:** MUST · **Depends on:** ING-008

`/api/cron/enqueue`, `/api/cron/process`, `/api/cron/digest` guarded by `CRON_SECRET` (constant-time compare), plus the `pg_cron` schedule.

**Done when:**
- [ ] Missing/incorrect `CRON_SECRET` → 401, constant-time comparison, no timing side channel
- [ ] `pg_cron` enqueues on the documented cadence ([01 PRD B3](./01-prd.md): APIs 6h, Firecrawl-heavy daily)
- [ ] Sources with `next_run_at <= now()` are enqueued exactly once per cycle
- [ ] `/api/cron/process` drains a batch and re-enqueues if work remains
- [ ] A failing source cannot stall other sources (isolation test)

---

### ING-010 — Freshness & expiry
**[DATA]** · **Priority:** MUST · **Depends on:** ING-007

Age-based status transitions: `active → stale` at 14 days unseen, `stale → expired` at 28 ([02 §6.3](./02-technical-architecture.md)).

**Done when:**
- [ ] Cron flips statuses on schedule; `expired` jobs leave the default feed
- [ ] `last_seen_at` refreshes when a job is re-sighted
- [ ] Freshness sub-score decays with age (unit-tested at day 1, 7, 14, 28)
- [ ] Old jobs remain reachable via an "Older" filter, never deleted

---

### ING-011 — Scrape run observability
**[OPS]** · **Priority:** MUST · **Depends on:** ING-009

Write a `scrape_runs` row per execution with status, duration, counts, `api_calls`, and error ([02 §5.4](./02-technical-architecture.md)).

**Done when:**
- [ ] Every run records `found`/`inserted`/`duplicates`/`failed` and `duration_ms`
- [ ] Partial parses set `status='partial'` with parse diagnostics in `log`
- [ ] `api_calls` is populated for cost tracking
- [ ] No `scrape_runs` access from the client (RLS test from ENG-004 holds)

---

### ING-012 — Manual "run now"
**[SEC] [UI]** · **Priority:** SHOULD · **Depends on:** ING-009, BIL-001

User-triggered immediate run for a source or saved search, rate-limited per plan (3/day free, 30/day pro).

**Done when:**
- [ ] Button enqueues a task and shows live status until the run completes
- [ ] Exceeding the plan limit returns `quota_exceeded` with the inline upgrade prompt
- [ ] Rate limit is enforced server-side (cannot be bypassed by direct action call)
- [ ] `usage_events` records the attempt

---

## E4 — Matching & Scoring

### SCR-001 — Scoring gates (hard filters)
**[DATA] [SEC]** · **Priority:** MUST · **Depends on:** ONB-005, ING-006

`lib/scoring/gates.ts` implementing the five gates from [02 §6.3](./02-technical-architecture.md): blocked company, excluded keyword, work mode, salary floor, seniority over-band.

**Done when:**
- [ ] Each gate returns a machine-readable reason in `gate_result.reasons`
- [ ] Any hit → `final_score = 0` **and** the job is excluded from the feed (not shown at 0)
- [ ] Salary gate only fires when salary is disclosed; undisclosed never triggers it ([03 §6.1 X-09](./03-security-and-access.md))
- [ ] Blocked company still allows an existing application to display ([03 §6.1 X-12](./03-security-and-access.md))
- [ ] Unit tests: one passing case + one failing case per gate

---

### SCR-002 — Rule-based fit score
**[DATA]** · **Priority:** MUST · **Depends on:** SCR-001

`lib/scoring/rules.ts` producing a 0–100 score with the weights from [02 §6.3](./02-technical-architecture.md): skills 35, seniority 15, compensation 15, location/work-mode 15, recency 10, company preference 10. Weights come from `weights.ts` (flag-overridable).

**Done when:**
- [ ] Sum of weights is 100 and configurable without a code change path
- [ ] Skills sub-score uses `job_skills.weight` so weak mentions count less
- [ ] Compensation sub-score returns **neutral**, not 0, when salary is undisclosed
- [ ] Recency decays monotonically (unit-tested)
- [ ] Output includes a `breakdown` array in the exact shape rendered by [04 §3.4](./04-frontend-specification.md)
- [ ] Same inputs → same score (pure function, deterministic test)

---

### SCR-003 — Embeddings & semantic score
**[DATA]** · **Priority:** MUST · **Depends on:** SCR-002, ING-006

`lib/scoring/semantic.ts`: batch-embed job descriptions and the aggregate profile; cosine similarity → 0–100.

**Done when:**
- [ ] Batches ≤100 inputs; embeddings written only when `description_text` changes
- [ ] `semantic_score = (1 - cosine_distance) * 100`, clamped 0–100
- [ ] Profile embedding rebuilt on profile save
- [ ] Embedding failure retries and does **not** block the feed ([04 §5.9](./04-frontend-specification.md))
- [ ] Test: semantically similar role with no keyword overlap still scores materially above an unrelated role

---

### SCR-004 — Final score composition & persistence
**[DATA]** · **Priority:** MUST · **Depends on:** SCR-002, SCR-003

Compose `final = 0.5·rule + 0.5·semantic`, write `job_scores` with `breakdown`, `model_version`, `scored_at`.

**Done when:**
- [ ] Unique `(user_id, job_id)`; re-scoring upserts rather than duplicating
- [ ] Gated jobs get `final_score = 0` with `gate_result` populated
- [ ] `breakdown` always present — the UI never shows a bare number (C3 / [04 §3.4](./04-frontend-specification.md))
- [ ] `v_ranked_jobs` returns these rows for the feed query
- [ ] Coverage: ≥98% of active jobs have a score for an active profile

---

### SCR-005 — Batch rescoring on profile change
**[OPS] [DATA]** · **Priority:** MUST · **Depends on:** SCR-004, ING-008

`rescore_profile` task handler requeueing affected jobs asynchronously (C4).

**Done when:**
- [ ] Profile save enqueues `rescore_profile`, never blocks the request
- [ ] Handler processes in batches and is safe to run concurrently
- [ ] UI shows a "Rescoring your feed…" indicator that clears on completion
- [ ] New scores replace old rows; no unbounded growth of `job_scores`

---

### SCR-006 — LLM fit rationale
**[DATA] [SEC]** · **Priority:** SHOULD · **Depends on:** SCR-004, BIL-001

`lib/scoring/rationale.ts` using `OPENROUTER_CHAT_MODEL` (a `:free` model) per [04 §5.3](./04-frontend-specification.md), gated to Pro and jobs scoring ≥70, metered via `usage_events`.

**Done when:**
- [ ] Prompt returns `{fit, summary, gaps}` JSON, ≤45 words, temperature 0.2
- [ ] Free users see the breakdown but no rationale (with an inline Pro prompt)
- [ ] Rationale failure leaves `explanation = null` and the score still renders
- [ ] Every call writes a `usage_events` row and respects the plan cap
- [ ] No hallucinated requirements: prompt instructs to use only stated facts (spot-check test)

---

### SCR-007 — Score weight feature flags
**[OPS]** · **Priority:** NICE · **Depends on:** SCR-004

Flag-driven scoring weights so tuning doesn't require a deploy (H5).

**Done when:**
- [ ] Weights overridable per flag with a safe default
- [ ] `model_version` records which weight set produced each score
- [ ] Reverting a flag triggers a rescore

---

## E5 — Discovery & Feed

### FED-001 — Ranked job feed
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** SCR-004, ENG-002

Dashboard rendering the ranked feed as a Server Component using `v_ranked_jobs` ([04 §5.4](./04-frontend-specification.md)), with the job card from [04 §3.3](./04-frontend-specification.md).

**Done when:**
- [ ] Sorted by `final_score` desc, score-band grouping with newest-first inside each band
- [ ] Server-rendered — no client-side fetch waterfall; LCP p95 < 2.0s
- [ ] Cards show company, score badge, title, meta row, skill chips, `ScoreMeter`, action row
- [ ] Empty state uses `display-l` copy and a real next step (never "No data")
- [ ] Gated/zero-score jobs do not appear
- [ ] Shape-matched skeletons render while loading (no spinner-only page)

---

### FED-002 — Feed actions: save / dismiss / mark applied
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** FED-001

Server Actions for the three actions, with optimistic UI and rollback ([03 §5.3](./03-security-and-access.md)).

**Done when:**
- [ ] Each action is a Server Action with Zod validation + `requireUser`
- [ ] Optimistic update with rollback and a toast on failure
- [ ] Dismissed jobs never resurface (and are excluded from scoring surfaced sets)
- [ ] Double-click "Mark applied" creates exactly one application (idempotent)
- [ ] All three fire the corresponding analytics events with `job_id` and `score`

---

### FED-003 — Filters, sort & search
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** FED-001

Filter by score band, work mode, location, salary, seniority, employment type, source, posted-since; sort by score / date / salary; keyword search via full-text index.

**Done when:**
- [ ] Filters are server-driven (URL-searchParams so state is shareable and back/forward works)
- [ ] Keyword search uses `websearch_to_tsquery` with escaped input (no string-concat SQL — [03 §6.2 S-01](./03-security-and-access.md))
- [ ] Filter state reflected in the URL and restorable on reload
- [ ] Query p95 < 120ms on a seeded corpus of 50k jobs
- [ ] Selected filters render as removable chips per [04 §3.6](./04-frontend-specification.md)

---

### FED-004 — "New since last visit" view
**[UI]** · **Priority:** SHOULD · **Depends on:** FED-001

Diff against `profiles.last_seen_feed_at` (D7).

**Done when:**
- [ ] Returning users see a "N new since yesterday" pill using the count-pill style
- [ ] Toggling the view shows only unseen jobs; viewing updates `last_seen_feed_at`
- [ ] Count is accurate after pagination and filter changes

---

### FED-005 — Duplicate cluster handling
**[UI] [DATA]** · **Priority:** SHOULD · **Depends on:** ING-007, FED-002

Show a "Seen on N sources" chip; dismissing the cluster dismisses all occurrences (D5).

**Done when:**
- [ ] `sighting_count > 1` renders the chip and lists sources in the detail view
- [ ] "Hide all of these" dismisses the whole cluster in one action
- [ ] Partial-source failures never hide a job that is still active elsewhere

---

### FED-006 — Keyboard navigation
**[UI]** · **Priority:** NICE · **Depends on:** FED-001

`j`/`k` move, `s` save, `x` dismiss, `o` open, `a` apply (D6).

**Done when:**
- [ ] All five shortcuts work with a visible focus indicator on the active card
- [ ] Shortcuts don't fire while typing in inputs
- [ ] A discoverable cheat-sheet exists (e.g. `?`) and the actions work without the keyboard too
- [ ] Screen-reader announcement on action

---

## E6 — Job Detail & Actions

### JOB-001 — Job detail page
**[UI]** · **Priority:** MUST · **Depends on:** FED-001

`/jobs/[id]` with description, source badge, canonical link, salary, dates, company block, and score breakdown ([01 PRD Flow 2](./01-prd.md)).

**Done when:**
- [ ] All fields from [04 §3.3](./04-frontend-specification.md) render, including `last_seen_at`
- [ ] "View original" opens `source_url` with `rel="noopener noreferrer"`
- [ ] Description HTML is sanitised to the allowlist in [03 §6.2 S-02](./03-security-and-access.md)
- [ ] Long descriptions collapse with `Read more`
- [ ] 404 for another user's unseen/nonexistent ID, byte-identical to a real miss

---

### JOB-002 — Score breakdown disclosure
**[UI]** · **Priority:** MUST · **Depends on:** JOB-001, SCR-004

Expandable breakdown rendering `job_scores.breakdown` exactly as specified in [04 §3.4](./04-frontend-specification.md) (C3).

**Done when:**
- [ ] Each component shows name, points, and mini bar; sums visibly to `final_score`
- [ ] Semantic blend line shown separately
- [ ] Gated jobs explain *why* they were filtered out in plain English
- [ ] Fires `score_breakdown_opened` on open
- [ ] Fully keyboard operable with correct `aria-expanded`

---

### JOB-003 — Mark-as-applied modal
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** FED-002, TRK-001

Apply modal: applied date, résumé version, notes, follow-up date → creates the application (PRD Flow 2 step 12).

**Done when:**
- [ ] Defaults to today; accepts future follow-up date
- [ ] Résumé picker lists `resume_versions` (empty state if none, non-blocking)
- [ ] Submit creates an application in `applied` stage + a `application_events` row
- [ ] Idempotent on `(user_id, job_id)` — double submit creates one record
- [ ] Success toast + feed card moves to applied state

---

### JOB-004 — Related & duplicate sightings
**[UI]** · **Priority:** NICE · **Depends on:** JOB-001, FED-005

Show alternate sightings of the same role with their source links.

**Done when:**
- [ ] Lists each sighting's source and URL
- [ ] Original/best-preserved description is used for the main body
- [ ] Selecting an alternate updates which URL "View original" uses

---

## E7 — Application Tracker

### TRK-001 — Application record creation
**[DATA]** · **Priority:** MUST · **Depends on:** ENG-003

`applications` insert path with `job_snapshot`, `applied_at`, `resume_version_id`, `notes`, `next_action_at`, plus an initial `application_events` row (use the `move_application()` semantics from [02 §5.9](./02-technical-architecture.md)).

**Done when:**
- [ ] Unique `(user_id, job_id)` enforced — duplicates rejected at the DB level
- [ ] `job_snapshot` captures title/company/salary so history survives source deletion ([03 §5.2 X-16](./03-security-and-access.md))
- [ ] Initial `application_events` row has `from_stage = null`
- [ ] `manual` and `csv_import` sources supported in the schema from day one

---

### TRK-002 — Stage pipeline & history
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** TRK-001

Stage transitions `discovered → saved → applied → screening → interview → offer / rejected / withdrawn` via drag or button, each writing an event.

**Done when:**
- [ ] Invalid transitions are rejected server-side by `move_application()`
- [ ] Every move writes an `application_events` row (append-only — no UPDATE policy)
- [ ] Timeline on the detail drawer shows each transition with timestamps
- [ ] Drag-and-drop has an equal keyboard path (arrow keys + Enter)
- [ ] Analytics event fires with `from`/`to`

---

### TRK-003 — Kanban board view
**[UI]** · **Priority:** MUST · **Depends on:** TRK-002

Columns per stage with counts, drag targets, and WIP badges ([01 PRD Flow 3](./01-prd.md)).

**Done when:**
- [ ] One column per stage with live counts and `stage-badge` styling
- [ ] Drag between columns triggers the stage move with optimistic update + rollback
- [ ] Mobile: columns become stacked stage lists ([04 §4.3](./04-frontend-specification.md))
- [ ] Empty columns show a muted placeholder, not a blank gap
- [ ] Fully keyboard operable; `aria` announcements on move

---

### TRK-004 — Application drawer detail
**[UI]** · **Priority:** MUST · **Depends on:** TRK-002

Drawer with timeline, notes, follow-up date, résumé link, and original posting link.

**Done when:**
- [ ] Shows stage history in reverse-chronological order
- [ ] Notes and `next_action_at` editable inline with autosave + error toast
- [ ] Deep-links to the job detail; handles a deleted job via `job_snapshot`
- [ ] Focus trapped in drawer; `Escape` closes and returns focus to the card

---

### TRK-005 — Tracker stats dashboard
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** TRK-002

Counts by stage, applications this week, response rate, average days-in-stage (PRD E4).

**Done when:**
- [ ] All four metrics render as stat cards per [04 §3.3](./04-frontend-specification.md)
- [ ] Response rate = applications reaching `screening`+ ÷ total applied (documented formula)
- [ ] Zero-data states are explicit ("No applications yet"), not `0%` implying failure
- [ ] Numbers use `mono` with `tabular-nums`

---

### TRK-006 — Follow-up reminders
**[UI]** · **Priority:** SHOULD · **Depends on:** TRK-004

"Needs attention" panel surfacing `next_action_at <= today` ([03 §6.1 X-15](./03-security-and-access.md)).

**Done when:**
- [ ] Due and overdue items appear with distinct overdue styling
- [ ] Past dates are allowed and shown as overdue
- [ ] Completing a follow-up clears it and logs an event
- [ ] Panel appears on the dashboard and the tracker

---

### TRK-007 — CSV import
**[DATA]** · **Priority:** NICE · **Depends on:** TRK-001

Import an existing spreadsheet (company, title, url, stage, date) (PRD E6).

**Done when:**
- [ ] Maps columns, previews 10 rows, reports invalid rows before commit
- [ ] Imported rows get `source='csv_import'` and `job_snapshot`
- [ ] Malformed file → `validation_failed` with row-level errors, partial import never silently applied
- [ ] 5 MB / 1000-row cap

---

## E8 — Searches, Digests & Alerts

### SEA-001 — Saved searches CRUD
**[UI] [DATA] [SEC]** · **Priority:** MUST · **Depends on:** FED-003

Named search with `query` + `filters` JSONB, plus live preview count (PRD F2).

**Done when:**
- [ ] Create/read/update/delete scoped to the owner (RLS verified)
- [ ] Preview shows result count + top 5 with scores before saving
- [ ] Quota enforced: max 3 (free) / 25 (pro), server-side
- [ ] `filters` validated by Zod on write — no arbitrary JSON accepted
- [ ] `notify` toggle controls digest inclusion

---

### SEA-002 — Daily digest email
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ENG-003, SCR-004, ONB-007

Digest selection + React Email template + Resend send per [02 §6.5](./02-technical-architecture.md) / [04 §5.5](./04-frontend-specification.md) (PRD F1).

**Done when:**
- [ ] Selects top 10 by score since `last_digest_at`, excluding dismissed/applied
- [ ] **Zero results → `status='skipped'`, no email sent**
- [ ] Each item: score, one-line rationale, deep link with `digest_id`/`job_id` params
- [ ] Send is idempotent on `(user_id, scheduled_for)` — double cron never double-sends
- [ ] Failure retries once then marks `failed` and surfaces to admin
- [ ] One-click unsubscribe works **without a session**
- [ ] Renders correctly in Gmail, Apple Mail, Outlook (checked, not assumed)

---

### SEA-003 — Digest scheduling by timezone
**[OPS]** · **Priority:** SHOULD · **Depends on:** SEA-002, ONB-007

`pg_cron` + `send_digest` tasks partitioned by IANA timezone ([02 §6.5](./02-technical-architecture.md)).

**Done when:**
- [ ] Each user receives at their configured local time
- [ ] DST transitions verified with a test ([03 §6.1 X-17](./03-security-and-access.md))
- [ ] `digests.scheduled_for` is the idempotency key
- [ ] Missing timezone falls back safely (no duplicate or skipped sends)

---

### SEA-004 — High-match instant alert
**[DATA]** · **Priority:** SHOULD · **Depends on:** SEA-002

Email when a job scores above the user's threshold (default 90), rate-limited to one per hour (PRD F4).

**Done when:**
- [ ] Threshold configurable in notification settings
- [ ] Max one alert per hour; multiple matches batch into one email
- [ ] Pro-only; free users see the inline prompt instead
- [ ] Alert emails never duplicate an item already in that day's digest

---

### SEA-005 — Slack digest
**[DATA]** · **Priority:** NICE · **Depends on:** SEA-002

Post the digest to `SLACK_WEBHOOK_URL` (PRD F5).

**Done when:**
- [ ] Message blocks render title, score, and link per job
- [ ] Webhook absent → feature hidden, not an error
- [ ] Skipped when nothing new (same rule as email)

---

## E9 — Billing & Gating

### BIL-001 — Plan definitions & usage metering
**[DATA] [SEC]** · **Priority:** SHOULD · **Depends on:** ONB-005

`lib/billing/plans.ts` as the single source of truth for limits from [03 §3.2](./03-security-and-access.md), plus `usage_events` counters (G1, G2).

**Done when:**
- [ ] Every limit in the [03 §3.2](./03-security-and-access.md) matrix exists in one typed constant
- [ ] Counters incremented per billing period with an idempotent helper
- [ ] A `requirePlan()`/`requireQuota()` guard returns `quota_exceeded` with the exact inline copy
- [ ] Quota enforced **both** in the Server Action and by a DB-level check where applicable
- [ ] Usage widget shows current vs limit with the meter style from [04 §3.6](./04-frontend-specification.md)

---

### BIL-002 — Stripe checkout & customer portal
**[UI] [DATA]** · **Priority:** SHOULD · **Depends on:** BIL-001

Checkout session creation and portal session creation per [04 §5.6](./04-frontend-specification.md) (G3).

**Done when:**
- [ ] `client_reference_id` ties the session to the user; `success_url` returns to the **originally attempted action**
- [ ] Portal supports plan change and cancel
- [ ] Keys read from env only; publishable key is the only client-visible one
- [ ] Price ID from `STRIPE_PRICE_ID_PRO`, never hardcoded

---

### BIL-003 — Stripe webhooks & entitlement sync
**[DATA] [SEC]** · **Priority:** SHOULD · **Depends on:** BIL-002

`/api/webhooks/stripe` handling the four events from [04 §5.6](./04-frontend-specification.md), signature-verified, service-role writes (G3).

**Done when:**
- [ ] Signature verified against the **raw** body with `STRIPE_WEBHOOK_SECRET`
- [ ] `checkout.session.completed` → `plan='pro'`; `subscription.deleted` → `plan='free'`
- [ ] `payment_failed` → `past_due` **without** downgrading entitlements
- [ ] Replayed `event.id` is a no-op
- [ ] `profiles.plan` cannot be changed by any client path (test from ENG-004 holds)
- [ ] Reconciliation job self-heals a missed webhook within an hour

---

### BIL-004 — Inline paywall prompts
**[UI] [SEC]** · **Priority:** SHOULD · **Depends on:** BIL-001

G4: inline, non-blocking limit notices explaining what Pro unlocks — **never a modal** (PRD Flow 6).

**Done when:**
- [ ] Limit notice renders inline at the point of the blocked action
- [ ] Copy states current usage, the limit, and what Pro adds
- [ ] No page block, no forced redirect, no countdown/urgency patterns
- [ ] Fires `paywall_viewed` with the `limit` property
- [ ] After upgrade, the originally attempted action completes automatically

---

### BIL-005 — Dunning & grace handling
**[DATA]** · **Priority:** SHOULD · **Depends on:** BIL-003

`past_due` banner, 7-day grace, dunning emails at day 1/3/7 ([03 §5.2](./03-security-and-access.md)).

**Done when:**
- [ ] `past_due` shows an update-card banner with a portal link
- [ ] Grace period holds `pro` entitlements for 7 days, then `free`
- [ ] Dunning emails sent on schedule and stop on recovery
- [ ] No user-visible error if Stripe is unreachable — banner degrades gracefully

---

## E10 — Operations & Admin

### ADM-001 — Admin shell & role gate
**[UI] [SEC]** · **Priority:** MUST · **Depends on:** AUT-004

`/admin` layout with server-side `requireAdmin()`, nav (Sources, Runs, Queue, Users), and per-action re-checks.

**Done when:**
- [ ] Non-admin redirect to `/dashboard` with the neutral message
- [ ] Every admin Server Action re-verifies `is_admin()` server-side
- [ ] All mutations write `audit_logs`
- [ ] Admin route not linked in the user-facing sidebar

---

### ADM-002 — Source health & run log
**[OPS] [UI]** · **Priority:** MUST · **Depends on:** ING-011, ADM-001

Source tiles (green/amber/red by `consecutive_failures`) and a last-50-runs table with filters (PRD H2).

**Done when:**
- [ ] Tile shows status, `last_success_at`, `next_run_at`, and failure count
- [ ] Run table: status, duration, counts, `api_calls`, expandable error
- [ ] Amber at 3 failures, red/paused at 5
- [ ] Data read with the service key server-side; no `scrape_runs` client access
- [ ] List refreshes without a full page reload

---

### ADM-003 — Queue monitor & retry
**[OPS]** · **Priority:** MUST · **Depends on:** ING-008, ADM-001

Queue depth by status/kind, failed-task list with manual retry (PRD H2).

**Done when:**
- [ ] Depth chart: pending / running / failed / oldest pending age
- [ ] Failed tasks list `attempts`, `last_error`, and kind
- [ ] Retry re-enqueues with attempts reset and writes an audit row
- [ ] Alert fires when `consecutive_failures >= 3` or pending depth exceeds threshold

---

### ADM-004 — User lookup (no content access)
**[SEC] [UI]** · **Priority:** SHOULD · **Depends on:** ADM-001

Find an account by email showing plan, status, and counts — **not** profile or application content ([03 §3.2](./03-security-and-access.md)).

**Done when:**
- [ ] Search returns account metadata only: plan, created_at, counts of applications/scores
- [ ] Viewing any profile *content* requires an explicit audited action
- [ ] Every lookup writes `audit_logs` (`action='admin.lookup_user'`)
- [ ] Test confirms admin cannot fetch another user's `applications` via RLS

---

### ADM-005 — Account export & deletion
**[SEC] [DATA]** · **Priority:** SHOULD · **Depends on:** ENG-004

User-triggered JSON export and full account deletion (PRD H4, [03 §6.1 X-21](./03-security-and-access.md)).

**Done when:**
- [ ] Export produces valid JSON containing profile, scores, applications, events, digests
- [ ] Export excludes secrets and other users' data; streamed, not buffered in memory
- [ ] Deletion cascades all user rows **and** Storage objects; shared `jobs` retained
- [ ] Confirmation copy lists exactly what is removed
- [ ] Post-deletion, the refresh token is invalid and the account cannot be re-authenticated

---

## E11 — Polish, Quality & Launch

### QUA-001 — End-to-end test suite
**[OPS]** · **Priority:** MUST · **Depends on:** TRK-003

Playwright covering: onboarding → feed → apply → stage move → stats; paywall → checkout; admin retry; error paths.

**Done when:**
- [ ] Happy path from signup to a moved application passes headless
- [ ] Abandoned-onboarding resume path covered
- [ ] Rate-limit and quota paths assert the exact copy from [03 §5.1](./03-security-and-access.md)
- [ ] 404-not-yours and 500-with-requestId assertions pass
- [ ] Suite runs in CI and is green three consecutive runs (no flakes)

---

### QUA-002 — Performance pass
**[OPS] [UI]** · **Priority:** MUST · **Depends on:** FED-001, JOB-001

Hit the budgets in [02 §8](./02-technical-architecture.md).

**Done when:**
- [ ] Feed LCP p95 < 2.0s; job detail SSR < 400ms; feed query p95 < 120ms on 50k jobs
- [ ] No client-side fetch waterfall on the feed (Server Component verified)
- [ ] Images/fonts self-hosted with `next/font`, zero layout shift
- [ ] Lighthouse performance ≥ 90 on `/dashboard` and `/jobs/[id]`

---

### QUA-003 — Accessibility audit
**[UI] [SEC]** · **Priority:** MUST · **Depends on:** FED-001, TRK-003

Full WCAG 2.1 AA pass ([04 §4.6](./04-frontend-specification.md)).

**Done when:**
- [ ] `vitest-axe` green on the component gallery and all five main routes
- [ ] Score conveyed by text + value, never colour alone ([03 §6.1 X-23](./03-security-and-access.md))
- [ ] Kanban fully keyboard-operable with announcements
- [ ] Visible focus everywhere; `Skip to content` link; correct heading order
- [ ] `prefers-reduced-motion` disables all but opacity transitions
- [ ] Screen-reader spot-check (VoiceOver or NVDA) on onboarding, feed, tracker

---

### QUA-004 — Responsive pass
**[UI]** · **Priority:** MUST · **Depends on:** FED-001, TRK-003

Breakpoint behaviour from [04 §4.3](./04-frontend-specification.md).

**Done when:**
- [ ] 360px: no horizontal scroll on any route; bottom tab bar active
- [ ] 640–1023px: icon rail + 2-column card grid
- [ ] ≥1024px: full sidebar; ≥1280px right rail with `Needs attention`
- [ ] Modals become bottom sheets on mobile with safe-area padding
- [ ] Touch targets ≥44×44px

---

### QUA-005 — Launch readiness & legal
**[OPS] [SEC]** · **Priority:** MUST · **Depends on:** all MUST tickets

Complete the pre-launch checklist in [03 §7](./03-security-and-access.md) plus legal and support assets.

**Done when:**
- [ ] Every box in [03 §7](./03-security-and-access.md) is checked
- [ ] Privacy policy + terms published (covering scraping sources, résumé storage, deletion)
- [ ] Source inventory reviewed for ToS compliance — **no LinkedIn/Indeed direct scraping** (PRD R2)
- [ ] `ADMIN_EMAILS` set; admin can reach the console
- [ ] Monitoring dashboards live: source health, queue depth, error rate, cost/MAU
- [ ] Rollback procedure documented and tested on a preview deploy
- [ ] PostHog funnel events verified end-to-end against the PRD §7 metric tree

---

### QUA-006 — A11y & copy review of empty/error states
**[UI]** · **Priority:** SHOULD · **Depends on:** ENG-005

Every empty, loading, and error state matches [04 §3.7](./04-frontend-specification.md) and the copy map in [03 §5.1](./03-security-and-access.md).

**Done when:**
- [ ] No route ever renders "No data" or a bare spinner
- [ ] Every error shows curated copy + a next action; no raw messages anywhere
- [ ] Loading skeletons are shape-matched to final content
- [ ] Zero-data states offer a real action (add skills, run a search, view a sample)

---

## SHOULD / NICE backlog (not in MVP build order)

| ID | Ticket | Priority |
|---|---|---|
| BKG-001 | Résumé version upload, default selection, attachment to applications (PRD A6) | SHOULD |
| BKG-002 | Company profiles + ATS detection for direct GH/Lever/Ashby pulls (PRD B8) | SHOULD |
| BKG-003 | User-defined source scope & company watchlists (PRD B8) | SHOULD |
| BKG-004 | `gates`… **Learning feedback loop** from save/dismiss/apply adjusting weights (PRD C6) | NICE |
| BKG-005 | Data-quality confidence flag surfaced in the UI (PRD C7) | SHOULD |
| BKG-006 | Source circuit-breaker auto-disable with admin notification (PRD B10) | NICE |
| BKG-007 | Browser bookmarklet for manual posting capture (PRD §8) | NICE |
| BKG-008 | `job_events`-driven personalisation of implicit preference weights | NICE |
| BKG-009 | Feature-flag driven scoring weights (ENG/SCR-007) | NICE |
| BKG-010 | AI résumé tailoring / cover-letter generation — **Phase 2** | NICE |
| BKG-011 | Auto-apply / form filling — **Phase 3, explicitly out of MVP** (PRD §6) | NICE |
| BKG-012 | Native mobile apps, team/coach seats, calendar sync, multi-language — **out of scope** (PRD §6) | NICE |

---

## Ticket index

| Epic | Tickets | Count |
|---|---|---|
| E0 Foundation | ENG-001…006 | 6 |
| E1 Auth | AUT-001…005 | 5 |
| E2 Onboarding | ONB-001…007 | 7 |
| E3 Ingestion | ING-001…012 | 12 |
| E4 Scoring | SCR-001…007 | 7 |
| E5 Feed | FED-001…006 | 6 |
| E6 Job Detail | JOB-001…004 | 4 |
| E7 Tracker | TRK-001…007 | 7 |
| E8 Digests | SEA-001…005 | 5 |
| E9 Billing | BIL-001…005 | 5 |
| E10 Admin | ADM-001…005 | 5 |
| E11 Polish | QUA-001…006 | 6 |
| Backlog | BKG-001…012 | 12 |
| **Buildable (E0–E11)** | | **75** |
| Backlog | BKG-001…012 | 12 |
| **Total** | | **87** |

**Priority split**

| Priority | Buildable | Backlog | Total |
|---|---|---|---|
| **MUST** | 53 | 0 | **53** |
| **SHOULD** | 17 | 4 | **21** |
| **NICE** | 5 | 8 | **13** |

**MVP = every ticket marked MUST** — 53 tickets, executed in the epic order at the top of this document. `SHOULD` tickets target the first 6 weeks after launch; `NICE` and all of `BKG-*` stay in the backlog.
