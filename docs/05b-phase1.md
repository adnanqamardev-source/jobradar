# 05b — Phase 1 Back-End Tickets

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [05 Feature Ticket List](./05-feature-ticket-list.md)
**Last reviewed:** 2026-10-04

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
- [x] Logout clears cookies **and** invalidates the refresh token server-side — implemented 2026-10-06: `POST /api/auth/logout` calls `supabase.auth.signOut()` (server-side revocation + SSR cookie clear), form post → 303 `/login?signed_out=1`, JSON → `{ok:true}`. 4 tests.
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

> **BE half landed 2026-10-06** — `updateProfile` action (`f8d367e`). Writes the four columns through the RLS-scoped client. **Open on the BE side:** titles are stored verbatim (no trim/dedupe), and the schema has no `.min(1)` so a save with zero titles is accepted. The FE bullets below stay unticked.

**Done when:**
- [ ] At least one title required to continue; entered titles persist as chips with remove
- [ ] Free-text titles are accepted and normalised (trim, dedupe, case preserved for display) — **BE gap: no normalisation yet**
- [x] Saves to the DB and is readable by the scorer in E4 — **BE done** (`updateProfile`, 2026-10-06)
- [ ] Validation error renders inline under the field, not as a toast

---

### ONB-003 — Step 2: skills picker
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-002

Searchable chip picker over `skills` (with `aliases`) + free-text add, per-skill level → `profile_skills`.

> **BE half landed 2026-10-06** — `updateSkills` action (`f8d367e`). Enforces the 3-skill minimum and a `familiar`/`proficient`/`expert` level per entry, verifies every `skill_id` against `skills` before writing, rejects duplicate ids against the `(profile_id, skill_id)` PK, and compensates the delete-then-insert with a snapshot/restore so a failed insert cannot wipe a user's skills. **Open on the BE side:** no free-text pending-skill path (unknown ids are rejected outright) and no `profile_embedding` recompute job.

**Done when:**
- [ ] Search matches `name` and `aliases`, debounced ≤200ms
- [x] Minimum 3 skills to continue; each has a level (`familiar`/`proficient`/`expert`) — **BE done** (`updateSkills`, 2026-10-06); the chip UI is still open
- [ ] Free-text adds create a pending skill entry handled without breaking the FK contract — **BE gap: no pending path**
- [ ] Skills drive the `profile_embedding` recompute job — **BE gap: no job enqueued**
- [ ] Selecting and deselecting is undoable within the session

---

### ONB-004 — Step 3: logistics
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-002

Country, remote preference, hybrid days, minimum compensation + currency + period, visa requirement → the matching inputs in `profiles`.

> **BE half landed 2026-10-06** — `updateLogistics` action (`f8d367e`), with the empty-salary rule fixed the same day: `minSalary: null` now writes `NULL` (clear the floor) where an earlier guard silently dropped it. **Open on the BE side:** `salaryCurrency` is only length-checked (3 chars), not allowlisted, and there is no SCR-001 parity test against `gates.ts`.

**Done when:**
- [ ] Remote preference writes `work_modes[]`; hybrid days only shown when hybrid selected — **BE write done**; the conditional display is FE
- [x] Salary accepts value + currency + period; empty salary = no floor (`NULL`), not `0` — **BE done** (`updateLogistics`, 2026-10-06; `null` clears, omitted leaves untouched, `0` rejected by `.positive()`)
- [ ] Currency list is a fixed allowlist; period ∈ `year|month|hour`
- [ ] Values are exactly what `gates.ts` reads (verified by the unit tests in SCR-001)

---

### ONB-005 — Step 4: dealbreakers & completion
**[UI] [DATA] [SEC]** · **Priority:** MUST · **Depends on:** ONB-003, ONB-004

Blocked companies (typeahead), excluded keywords, preferred companies → `profiles.blocked_companies`, `excluded_keywords`, `preferred_companies`. `Finish` sets `onboarding_completed = true`.

> **Partial BE half landed 2026-10-06** — `updateDealbreakers` action (`f8d367e`) writes all three arrays with lowercase/trim/dedupe normalisation and the 50-item schema cap. **Open on the BE side:** normalisation is not a slug and is not shared with E3, and nothing writes `onboarding_completed` — the `Finish` action does not exist yet.

**Done when:**
- [ ] Company typeahead normalises to `slug` (shared helper with dedupe in E3) — **BE gap: lowercased, not slugified, no shared helper**
- [x] Keywords are normalised (lowercase, trimmed, deduped) and capped at a sane limit — **BE done** (`updateDealbreakers`, 2026-10-06; cap is `.max(50)`)
- [ ] Finish sets `onboarding_completed`, fires `onboarding_completed` analytics event with `duration_s`
- [ ] Finish enqueues the first ingestion run **and** shows the real progress interstitial (no fake loader)
- [ ] Interstitial polls actual counters: sources scanned / jobs found / jobs scored

---

### ONB-006 — Profile editing & rescore
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ONB-005

Settings pages to edit every onboarding field; saving triggers a `rescore_profile` task (never synchronous — C4).

> **Mostly open.** The four mutation actions from ONB-002..005 (`f8d367e`) make the fields editable, which is the substrate this ticket needs — but **no action enqueues `rescore_profile`** (`rescore_profile` appears in `src/` only as a `task_kind` string in `src/types/db.ts`), and **no action performs the `updated_at` optimistic-concurrency check** that [03 §5.2](./03-security-and-access.md) requires for the two-tab case.

**Done when:**
- [ ] Every onboarding field is editable post-setup from `/settings`
- [ ] Save enqueues `rescore_profile`; the UI shows "Rescoring your feed…" then a toast on completion
- [ ] Concurrent edit from two tabs → optimistic-concurrency message from [03 §5.2](./03-security-and-access.md)
- [ ] Changes are reflected in new scores; historical scores are replaced, not duplicated

---

### ONB-007 — Notification preferences
**[UI]** · **Priority:** SHOULD · **Depends on:** ONB-005

Per-channel, per-cadence digest controls: send time (IANA time zone), weekdays, max items, high-match threshold, mute.

> **Not started, and blocked on schema.** `updateNotificationPrefsRequestSchema` exists in `src/types/api.ts`, but the columns it would write (`digest_enabled`, `digest_channel`, `high_match_alerts`) are **not** in [02a §5.3](./02a-schema.md) and not in any migration. `profiles` has `time_zone` and `last_digest_at` only. An action for this was written and then deleted during the 2026-10-06 BE-304 work rather than invent columns. Needs a schema ticket first.

**Done when:**
- [ ] User can set time + weekdays + item cap; resolved local time is previewed ("Every day at 8:00 AM (Asia/Kolkata)")
- [ ] Mute stops all email; unsubscribe link works without a session
- [ ] DST correctness verified with a test around a transition date ([03 §6.1 X-17](./03-security-and-access.md))

---

### ONB-008 — Résumé upload, storage & ownership
**[SEC][DATA]** · **Priority:** MUST · **Depends on:** ENG-003, AUT-003 · **Added 2026-10-04**

The user uploads one résumé (PDF/DOCX, ≤ 10 MB) to prefill onboarding. Stored in a **private**
bucket at `{user_id}/{resume_id}.{ext}`, with a `resumes` row tracking status and the parse
result. Replaces hand-typing four wizard steps — not a replacement for them.

**Done when:**
- [x] `resumes` table + owner-only RLS on the table **and** on `storage.objects`, with `force row level security` ([03 §4.2a](./03-security-and-access.md))
- [x] Signed upload/download URLs, 1h expiry; no public URL is ever stored or returned
- [x] MIME type and size validated server-side — the client-supplied type is not trusted
- [ ] `supabase db reset` applies `0002_resumes.sql` from empty ⚠️ **never executed — no Postgres on the dev machine**
- [ ] RLS integration test proves user B cannot read user A's row or file
- [ ] Account deletion (BE-313) removes the storage objects, not just the row

### ONB-009 — Résumé parsing & extraction
**[DATA]** · **Priority:** MUST · **Depends on:** ONB-008 · **Added 2026-10-04**

PDF/DOCX → plain text → `ExtractedProfile` ([02a §5.11](./02a-schema.md)), with a per-run
`confidence` and a `needsReview` flag.

**Done when:**
- [x] Rule-based extraction is deterministic and offline — same file, same profile
- [x] Salary handles `₹15,00,000` (Indian `3-2-3` grouping) and `15L` / `1.2 Cr` notation
- [x] The LLM fallback is **opt-in** and defaults off; no request-path code calls OpenRouter ([02 §1.2](./02-technical-architecture.md))
- [x] `needsReview` is true below `confidence < 0.6` or when email/titles are missing
- [ ] Text extraction from real PDF and DOCX files is covered by fixtures ⚠️ **untested — `pdfjs-dist` bundling in a server action is unproven**
- [ ] A `parse_resume` queue task exists (BE-108) so the LLM fallback can run off the request path

### ONB-010 — Bootstrap prefill from résumé
**[DATA]** · **Priority:** MUST · **Depends on:** ONB-009, ONB-002..005 · **Added 2026-10-04**

Map `ExtractedProfile` → the onboarding wizard's fields and prefill them. **Review, never
auto-apply**: the user confirms before anything is written to their profile.

**Done when:**
- [x] Mapping is a pure function (`src/lib/resume/bootstrap.ts`) with no DB access
- [x] `mergeBootstrapWithExisting` prefers new values but never blanks a field the user already set
- [x] An empty extraction is detectable, so the wizard falls back to manual entry
- [ ] The Server Actions resolve a real session via `requireUser()` ⚠️ **blocked on AUT-003 / BE-302** — they throw rather than use the service role
- [ ] Writing the confirmed prefill to `profiles` is wired and covered by an RLS integration test

### ONB-011 — Deterministic extraction as the default
**[DATA]** · **Priority:** MUST · **Depends on:** ONB-009 · **Added 2026-10-04**

Stated separately because it is a decision, not a feature: the ranking-relevant fields are
extracted **without a model**. [02 §1](./02-technical-architecture.md) principle 6 is
"deterministic first, model second", and the free OpenRouter tier returns 429 under load.

**Done when:**
- [x] No model call is reachable from the synchronous parse path
- [x] A test asserts `fetch` is never called on the default path

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

### ING-013 — India vs international remote scope
**[DATA]** · **Priority:** MUST · **Depends on:** ENG-003 · **Added 2026-10-04**

`work_mode` says *remote or not*. It cannot say *which* remote: `"Remote - India"` and
`"Remote - Worldwide"` are both `remote`, and for an Indian candidate they are not
interchangeable. Adds a `remote_scope` enum, India-aware salary parsing, and the feed filter.

**Done when:**
- [x] `remote_scope` enum `('india','global','unknown')` and `jobs.remote_scope`, default `'unknown'`
- [x] India-specific phrases are matched **before** generic ones, so `"Remote - India (Worldwide)"` → `india`
- [x] Lakh/crore is resolved **before** the number scan (`15L` → `1500000`, not `15`) and Indian `3-2-3` grouping is handled
- [x] `v_ranked_jobs` exposes `remote_scope`, and the composite index leads with `work_mode`
- [x] Unit tests cover each notation and both remote phrasings
- [ ] `supabase db reset` applies `0003_remote_scope.sql` ⚠️ **never executed**
- [ ] FE-120 wires the filter end-to-end (Phase 2)

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
