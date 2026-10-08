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

> **Mostly done on the BE side.** The four mutation actions from ONB-002..005 (`f8d367e`) make the fields editable. The `updated_at` optimistic-concurrency check required by [03 §5.2](./03-security-and-access.md) is implemented in `lib/db/profile-update.ts` (opt-in — `/settings` must send `expectedUpdatedAt`), and each successful save now enqueues a `rescore_profile` task via `enqueue_rescore_profile()` (migrations `0007`/`0008`), coalesced so repeated saves queue one task. Both were found by `tests/integration/`, not by reading code. **Still open on the BE side:** none. **Still open on the FE side:** the "Rescoring your feed…" state, the completion toast, and passing `expectedUpdatedAt`.

**Done when:**
- [ ] Every onboarding field is editable post-setup from `/settings`
- [ ] Save enqueues `rescore_profile`; the UI shows "Rescoring your feed…" then a toast on completion — **BE done** (2026-10-06, `lib/db/enqueue-rescore.ts` + migrations `0007`/`0008`); the UI states are FE work
- [ ] Concurrent edit from two tabs → optimistic-concurrency message from [03 §5.2](./03-security-and-access.md) — **BE done** (2026-10-06, `lib/db/profile-update.ts`); the FE must pass `expectedUpdatedAt` for it to fire
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
- [x] `supabase db reset` applies `0002_resumes.sql` from empty — ✅ **executed 2026-10-09.** All ten migrations apply from empty and the seed runs. RLS integration coverage for `resumes` is a separate, still-open box below.
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
- [x] The Server Actions resolve a real session via `requireUser()` — ✅ **CORRECTION 2026-10-09: this box said "blocked on AUT-003 / BE-302" and was stale.** BE-302 landed 2026-10-05. `src/app/api/actions/profile/bootstrap-from-resume.ts:89` calls `requireUser()` and `:90` calls `createUserClient(user.accessToken)`, so the write runs under the caller's own RLS-scoped JWT — no service-role fallback, which is the property the box was protecting. Covered by `tests/unit/resume-bootstrap.test.ts`.
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
- [x] `types.ts` matches the interface in [02 §6.1](./02-technical-architecture.md) — ✅ **BE-101, 2026-10-05.** `src/lib/connectors/{types,http,registry,index}.ts`. `SourceConnector` carries `kind` + `costClass` + an async-iterable `fetch(cfg, ctx)`; `fetch`, clock and sleep are injected on `RunCtx` so contract tests never touch the network. `RawJob` is re-exported from `src/types/canonical-job.ts` rather than redefined — the seam owns it.
- [x] `registry` maps `source_kind` → connector; unknown kind fails loudly — ✅ `connectors-registry.test.ts`; an unknown kind throws naming the kind.
- [x] Every connector validates its response through Zod before returning — ✅ each connector owns its provider schema and validates before mapping.
- [x] Contract tests run against recorded fixtures — **no live API calls in CI** — ✅ 8 JSON fixtures in `tests/integration/fixtures/sources/`, 153 tests across `connectors-{contract,registry,url-guard,http}.test.ts` (2026-10-09).
- [x] Each connector sets timeout, `AbortSignal`, and retry per [04 §5.9](./04-frontend-specification.md) — ✅ `http.ts`: 30s timeout, `AbortSignal`, retry ≤3 with `2^n` backoff, typed error mapping.

> **Corrected 2026-10-09.** This ticket and ING-002..005 were entirely unticked while
> `docs/06` §4.1 marked BE-101..105 **DONE**. The work and its tests are real; the boxes here
> were the stale side. Re-verified against the tree before ticking — see each box.

---

### ING-002 — Tier 1 API connectors (Greenhouse, Lever, Ashby)
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement the three public ATS connectors per the field-mapping table in [04 §5.2](./04-frontend-specification.md).

**Done when:**
- [x] Each maps to `RawJob` with `externalId`, `sourceUrl`, `title`, `companyName`, `postedAt`, `descriptionHtml` populated — ✅ **BE-102.** 15 fixture contract tests, each pinning the request as well as the output. Three provider quirks that would otherwise ingest zero are handled: Lever returns a **bare array** (not `{jobs:[]}`) and its `createdAt` is **epoch ms**, which fails `z.string().datetime()`; Ashby has no company name and an **object-shaped** `location`. `isRemote: false` maps to `null`, not `"onsite"` — asserting onsite would hard-fail the `work_mode_mismatch` gate against a hybrid preference on one boolean.
- [x] HTML content is preserved (not stripped) for `description_html` — ✅ carried through `RawJob.descriptionHtml` to `normaliseJob`. **But see the open gap below**: `normalize.ts:383` still writes `descriptionHtml: null`, so the column stays NULL for the whole corpus until the sanitiser exists.
- [x] Fixtures for each connector pass the contract test — ✅ `api_greenhouse.json`, `api_lever.json`, `api_ashby.json`.
- [ ] Pagination / large boards handled without truncation — ❌ **genuinely not done.** No connector contains a pagination loop: no `while`, no `for await`, no cursor or `next` handling anywhere in `src/lib/connectors/`. A board larger than one page of results is silently truncated. This is a real ingestion gap, not a doc oversight — a large Greenhouse board loses postings.
- [x] Failure returns a typed error → `upstream_error`, never an unhandled throw — ✅ `http.ts` maps abort/timeout to `upstream_timeout` and HTTP/transport failures to `upstream_error`, both as `AppError`.

---

### ING-003 — Tier 1 connectors (Remotive, Arbeitnow, USAJOBS)
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement per [04 §5.2](./04-frontend-specification.md). USAJOBS requires `Host`, `Authorization-Key`, **and** a `User-Agent` header.

**Done when:**
- [x] Remotive respects ≤1 request / 1.5s (throttled in the pipeline) — ✅ enforced as a **minimum interval between requests on the injected clock**, not a delay on entry. A delay on entry would not bound the rate when several requests are issued in sequence.
- [x] USAJOBS sends all three required headers; missing key fails fast with a clear ops message — ✅ `Host`, `Authorization-Key`, `User-Agent`. It fails fast **by name** when the key is blank, because USAJOBS answers a missing key with a 403 indistinguishable from a bad one — a generic error would send an operator hunting a rotated key that was never set.
- [x] Arbeitnow `is_remote` maps to `work_mode` — ✅ also normalises **both** second and millisecond epoch timestamps; treating seconds as ms dates the posting to 1970 and drops it out of every freshness window.
- [x] All three pass fixture contract tests — ✅ 20 fixture contract tests (BE-103).

---

### ING-004 — Adzuna aggregator connector
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement Adzuna search with country/`what`/`where` params and salary extraction (`salary_min`/`salary_max` → `salaryRaw` fallback).

**Done when:**
- [x] Credentials read from env only; missing creds fail fast — ✅ **BE-104.** A 401 cannot be retried, and retrying would burn quota that would otherwise buy results, so it throws by name instead.
- [x] Salary fields map into `salary_min`/`salary_max`/`salary_currency` when present — ✅ the only connector with structured salary, so it is the only one that can populate the numeric columns rather than leaving a `salaryRaw` string to re-parse. `salary_label` is carried alongside and never overrides them. Currency is upper-cased, because `rawJobSchema` only enforces `.length(3)` and `"gbp"` would otherwise reach a `char(3)` column as-is.
- [x] `descriptionHtml` handled (Adzuna returns HTML) — ✅ carried on `RawJob`. Same open gap as ING-002: `normalize.ts` nulls it until the sanitiser exists.
- [x] Fixture contract test passes; `api_calls` counted for cost attribution — ✅ 12 fixture contract tests. `costClass: "metered"`, and `RunCtx.onRequest` counts attempts **including retries**, because a retry is a billed call.

**Behaviour worth recording (not a ticket box):** a record with no `redirect_url` is
**skipped**, not defaulted. `sourceUrl` is non-nullable and the BE-107 dedupe hash is built
from it, so a placeholder would collide unrelated postings onto one row.

---

### ING-005 — Firecrawl generic connector
**[DATA]** · **Priority:** MUST · **Depends on:** ING-001

Implement `firecrawl.ts` using `/scrape` (JSON-schema extraction), `/search`, and `/map` exactly as specified in [04 §5.1](./04-frontend-specification.md).

**Done when:**
- [x] `/scrape` sends `formats:["json"]`, `onlyMainContent:true`, `maxAge` 12h, 30s timeout — ✅ **BE-105.** `maxAge: 43_200_000` (12h) is the documented cache window; without it every run re-crawls unchanged pages and burns quota. `timeout: 30000` is sent to Firecrawl as well as held locally, matching `HTTP_DEFAULTS.timeoutMs`.
- [x] Extraction schema matches `RawJob` — ✅ deliberately **narrower**: only `title`/`companyName`/`sourceUrl` are required. Requiring `salaryRaw` would fail extraction on every posting without a salary, when the right answer is `salary = null`.
- [x] Output validated by Zod; a bad parse → `scrape_parse_failed`, run `partial`, no user-facing error — ✅ a malformed posting is **skipped individually**, so one bad listing does not discard the whole page.
- [x] URL validation rejects non-`https`, localhost, and private IP ranges ([03 §6.2 S-05](./03-security-and-access.md)) — ✅ `url-guard.ts` runs **before any request**: non-`https`, credentials-in-URL, localhost, and private/reserved IPv4 **and** IPv6. `/map` results are filtered too, so an operator cannot poison `sources.config.urls`. 11 fixture contract tests plus **60 adversarial SSRF cases**. Stated limit: this is a name/literal check, so a public hostname that resolves to a private address is not caught here.
- [ ] Daily Firecrawl call count is recorded and capped per plan — ❌ **not done.** No per-day cap exists in `firecrawl.ts` (no `maxCalls`/`dailyCap`/`quota`). `docs/04` §5.1 specifies a hard daily cap per plan. This is a **cost** gap rather than a correctness one — it bills rather than corrupts — and it becomes urgent the moment a real Firecrawl key is configured (`.env.local` has `FIRECRAWL_API_KEY` empty, which is why nothing has burned money yet).

---

### ING-006 — Normalisation pipeline
**[DATA]** · **Priority:** MUST · **Depends on:** ING-002, ING-003, ING-004, ING-005

`lib/ingest/normalize.ts`: `RawJob` → `CanonicalJob`. Parse salary strings, seniority from title, employment type, location, remote/hybrid signals, and extract skills into `job_skills`.

**Done when:**
- [x] Salary parser handles `$160k–$190k`, `160000-190000 USD`, `€70.000/Jahr`, hourly rates, and returns `unknown` (never a guess) when ambiguous — ✅ `parseSalary`. Ordering is load-bearing: **lakh/crore is resolved before the number scan**, because `15L` read by a generic pattern is `15` — off by 100,000× — and `\d{1,3}(,\d{3})*` cannot match Indian `3-2-3` grouping at all, silently truncating `15,00,000` to `15`. The scan therefore matches any comma-grouped run and strips separators.
- [x] Seniority parser maps title → enum, `unknown` when unclear — ✅ `extractSeniority`.
- [x] Work-mode detection matches keywords (`remote`, `hybrid`, `on-site`, `in office`) — ✅ plus `detectRemoteScope`, which resolves **India-specific phrases before generic ones** so `"Remote - India (Worldwide)"` → `india`. A generic remote check first would match `worldwide` and hand an India-only role to the global bucket.
- [ ] Skill extraction uses `skills.aliases` with regex, low-confidence matches weighted `< 0.5` — ⚠️ **partially done, and the weighting half is not implemented.** BE-106 added `src/lib/ingest/skills.ts`, which matches posting text against a mirror of the `supabase/seed.sql` vocabulary (alias patterns, escaped literals, word-boundary guards) and populates `jobs.skills` with canonical slugs. **Not done:** there is no confidence value, so nothing is weighted `< 0.5`; matches are a flat set. There is also no `job_skills` write from the normaliser — `jobs.skills` is a `text[]`, and `job_skills` (the weighted m2m that `rules.ts` reads for the 35-point skills component) is still unpopulated. See the vocabulary gap in [05a ENG-003](./05a-phase0.md): the matcher mirrors 10 seeded skills, not ~600.
- [x] Unit tests cover ≥20 real-world title/salary/description samples — ✅ `ingest-normalize.test.ts` (25) + `ingest-skills.test.ts` (19) + `ingest-dedupe.test.ts` (36) = 80 across normalisation, skills and dedupe.
- [x] Nothing unparseable throws — it lands with `confidence < 1` — ✅ every parser returns a neutral/unknown value rather than throwing; `normaliseJob` is total.

**Delivered 2026-10-09** (re-scoped against the code — see the correction note under ING-001).
`parseSalary`, `parseLocation`, `detectRemoteScope` and `extractSeniority` had already shipped
under BE-317; the skill matcher was the only genuine gap.

---

### ING-007 — Deduplication
**[DATA]** · **Priority:** MUST · **Depends on:** ING-006

Two-pass dedupe per [02 §6.2](./02-technical-architecture.md): exact `dedupe_hash` upsert + trigram fuzzy merge.

**Done when:**
- [x] Hash = `sha256(norm_title | norm_company_domain | norm_city | work_mode)` with legal suffixes stripped
- [x] `on conflict (dedupe_hash)` updates `last_seen_at` and increments `sighting_count`, **does not** duplicate
- [x] Fuzzy pass merges `similarity > 0.85` + matching domain, keeping the richer description
- [x] Test: the same posting from 3 sources yields **one** `jobs` row with `sighting_count = 3` — ✅ **ran 2026-10-09 and caught a real bug.** `tests/integration/dedupe.db.test.ts` is green against a live Postgres.
- [x] Test: two genuinely different roles at the same company are **not** merged — ✅ green, and the fixture was fixed (see below)

### ⚠️ The first run of these tests found a silent data bug

Three upserts of one posting left **`sighting_count` at 1**, not 3. The cause was not the hash
and not the payload: **PostgREST cannot express the increment.** It renders
`on conflict … do update set <col> = <value>` with every value a literal, while
`docs/02b` §6.2 requires `sighting_count = jobs.sighting_count + 1` — an expression over the
existing row. The old code sent no `sighting_count`, so the column sat at its `default 1` on
insert and was untouched on conflict. The job count was right and the sighting count was wrong,
and `sighting_count` drives the "seen on N sources" chip, so this was a **user-visible lie**,
not a cosmetic defect.

Fixed by `supabase/migrations/0010_upsert_job.sql`: one atomic
`insert … on conflict do update` that increments, refreshes `last_seen_at`, and **preserves
`first_seen_at`**. The rejected alternative (upsert, then a second incrementing update) is two
round trips and races — two workers can each read 1 and each write 2. `dedupe.ts` now calls
`upsert_job` instead of `.upsert()`.

Two of my own test bugs surfaced alongside it and are worth recording, because both passed
before they were wrong:

- The `first_seen_at` test passed a value through the job object, but `toJobRow` never sends
  that column — the assertion was comparing a value that never reached the database. It now
  back-dates the column with a direct write and asserts the RPC preserves it.
- The "different roles are not merged" fixture hardcoded `title_norm`, so two different titles
  compared as **identical** and the test passed for the wrong reason. `title_norm` is now
  derived from the title exactly as `normalize.ts` does it.

**Delivered 2026-10-09.** `src/lib/ingest/dedupe.ts`. No migration needed: `dedupe_hash text not null unique`, `pg_trgm`, and both GIN trigram indexes already exist (`0001_init.sql:275-276`).

Three decisions the docs did not settle, each recorded in the module docstring:

1. **Company identity falls back to the name when there is no domain.** §6.2 specifies
   `norm_company_domain`, but many sources send none — and a `null` domain would make every
   same-titled, same-city role at *any* domain-less employer hash identically. It is never the
   *provider* name: `docs/02b` §6.1 records that Ashby and Lever send no company field, so
   falling back to `cfg.name` would attribute every posting to the provider.
2. **Trigram similarity is computed in TypeScript, not SQL.** PostgREST cannot call
   `similarity()` without an RPC in the exposed schema, and that is a migration. So the
   candidate set is narrowed by an indexed `company_domain` equality and the Dice coefficient
   is evaluated client-side. Faithful to `pg_trgm` defaults (two-space pad, multiset
   intersection), and it makes the 0.85 threshold testable without a database.
   **Consequence: the two GIN trigram indexes are unused by this pass.** If the per-company
   candidate set grows large enough to matter, the fix is one SQL function — open item, not
   done.
3. **At 0.85 the fuzzy pass only absorbs near-identical titles.** A plural `s` scores 0.8333
   and a roman-numeral suffix 0.7778, so both stay separate rows. That is the specified
   threshold behaving as written, but it means this pass is a safety net for whitespace and
   casing drift, **not** a synonym matcher. Useful to know before reading a "did not merge"
   report as a bug.

`company-slug.ts` is reused rather than reimplemented — its docstring already reserved
`stripLegalSuffix: true` for exactly this caller.

**State of the ticket: unit + integration green as of 2026-10-09.** 36 unit tests, and
`tests/integration/dedupe.db.test.ts` (5 tests) passes against a live local Postgres. The two
DB-level acceptance criteria that had never been executed are now the ones that caught the
`sighting_count` bug.

---

### ING-008 — Task queue
**[OPS] [DATA]** · **Priority:** MUST · **Depends on:** ENG-003

Implement `task_queue` claim/run/retry with `FOR UPDATE SKIP LOCKED`, 5-minute leases, exponential backoff, `max_attempts = 3` ([02 §6.4](./02-technical-architecture.md)).

**Done when:**
- [x] Claim statement matches [02 §6.4](./02-technical-architecture.md) — `claim_tasks` RPC (`0009`), called by `/api/cron/process`. **`scripts/queue-drain.ts` still claims by compare-and-swap**, which gives per-task mutual exclusion but not batch atomicity; local-dev only, and the open item below.
- [x] Lease expiry returns orphaned tasks to `pending` — the reaper is inside `claim_tasks`, in the claim's transaction. Verified in `0009`'s own session, not here.
- [x] Backoff at 30s / 2m / 8m; at `max_attempts` → `failed` + `audit_logs` + admin visibility — ✅ **2026-10-09: the code now matches the documents.** `plan.ts` had implemented `2^n` (2s/4s/8s) against three specs saying 30s/2m/8m. Changed to the positional ladder, clamped at both ends with no extrapolation: a retry of a **metered** source is a billed call, and `RunCtx.onRequest` counts retries for exactly that reason. Admin visibility is still BE-312.
- [ ] Handlers are idempotent (test: run twice, same end state) — `planRescoreBatch` and `persistScore`'s `(user_id, job_id)` upsert are idempotent by construction, and both are unit-tested. **Not demonstrated end-to-end**, because no handler is runnable yet.
- [x] Batch size respects Vercel function timeout; incomplete work re-enqueues itself — `/api/cron/process` runs exactly one batch of ≤25 and returns; `planRescoreBatch` returns a `requeue` verdict rather than looping.

**Delivered 2026-10-09.** `src/lib/queue/dispatch.ts` (kind → handler) and
`src/app/api/cron/process/route.ts`. The protocol was already pure in `plan.ts`, so this ticket
was the executors, not the rules.

**What actually changed, and why it mattered:** the drain script settled every claimed task
`done` **without running a handler**, silently discarding every task it claimed. An unregistered
kind is now a failed `Outcome` naming the kind — the task re-queues, burns an attempt, and
eventually writes an `audit_logs` row identifying what is missing.

**Still open:**
- No handler is runnable. `rescore_profile` needs a `RescoreStore` adapter over the real client;
  no other kind is registered. Tasks fail legibly rather than silently, which is the improvement,
  but the queue cannot yet do useful work.
- `scripts/queue-drain.ts` should call `claim_tasks` rather than compare-and-swap.
- `pg_cron` is not created on this project (see `docs/07`), so scheduling is Vercel Cron
  dashboard configuration.

### 🐛 Found and fixed 2026-10-09: the audit-log write never worked

`docs/02b` §6.4 requires `audit_logs` on terminal failure. Both executors did attempt it —
and both used the **wrong column names**: `entity_type` / `entity_id` / `detail`, where the
table has `target_type` / `target_id` / `meta`. PostgREST answers `PGRST204` ("Could not find
the … column in the schema cache"), the insert fails, and the only evidence was a
`console.warn` that nobody was watching.

So the requirement was unmet in practice while the code *looked* like it was met. It was found
by `tests/integration/rls-policies.db.test.ts`, which needed an `audit_logs` row and was refused
— the first time anything in this repo has written to that table under a real schema. Both
executors are fixed.

---

### ING-009 — Cron ingress & scheduler
**[OPS] [SEC]** · **Priority:** MUST · **Depends on:** ING-008

`/api/cron/enqueue`, `/api/cron/process`, `/api/cron/digest` guarded by `CRON_SECRET` (constant-time compare), plus the `pg_cron` schedule.

**Done when:**
- [x] Missing/incorrect `CRON_SECRET` → 401, constant-time comparison, no timing side channel — `src/lib/cron/auth.ts`, SHA-256 digests through `timingSafeEqual`. 9 tests, including that a wrong secret of *any* length takes the same path, and that the 401 body does not distinguish "missing" from "invalid".
- [ ] `pg_cron` enqueues on the documented cadence ([01 PRD B3](./01-prd.md): APIs 6h, Firecrawl-heavy daily) — **`pg_cron` was deliberately not created on this project** (see `docs/07`: unproven there, and a failure on line 6 of `0001_init.sql` would roll back every table). The cadence itself is honoured by `plan-enqueue.ts` from `sources.cadence_minutes`; what is missing is the *scheduler*, which is Vercel Cron dashboard configuration.
- [x] Sources with `next_run_at <= now()` are enqueued exactly once per cycle — `plan-enqueue.ts` snapshots the candidate set before any write, which is what makes "once" structural rather than incidental.
- [x] `/api/cron/process` drains a batch and re-enqueues if work remains — one batch per invocation, `moreLikely` reported when the cap is hit; handlers re-enqueue themselves.
- [x] A failing source cannot stall other sources (isolation test) — asserted in `planEnqueue`: a source with a bad cadence is skipped while its neighbours are enqueued.

**Delivered 2026-10-09.** `src/lib/cron/auth.ts`, `src/lib/cron/plan-enqueue.ts`,
`src/lib/ingest/sources.ts` (row shape + run accounting), `src/app/api/cron/enqueue/route.ts`,
`src/app/api/cron/process/route.ts`.

**Two decisions the docs did not settle, both recorded in code:**

1. **A non-positive `cadence_minutes` is skipped, not defaulted.** It would produce a
   `next_run_at` that never advances past `now`, so the source re-enqueues on every cycle
   forever. Defaulting hides a bad row; skipping reports it as `reason: "no-cadence"`.
2. **`next_run_at` advances from the previous due time, not from `now`.** Advancing from `now`
   makes a backlog permanent — a source down for a day never accumulates catch-up. `catchUp`
   reports the shortfall so an operator can decide whether to skip it.

`/api/cron/digest` is still a `.gitkeep`: that is BE-309, and it needs a Resend client.

**Not verified end-to-end.** No route has been executed against a live project — the unit
tests cover the pure decisions, and the routes are thin executors of them, but the RPC
call, the inserts and the RLS interaction are unexercised. A local stack **is** available
now (Docker Desktop 4.93.0, installed under `%LOCALAPPDATA%\\Programs\\DockerDesktop` rather
than the default path — which is why an earlier note here wrongly said it was not
installed), so this is achievable and simply not yet done.

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
- [x] Every run records `found`/`inserted`/`duplicates`/`failed` and `duration_ms` — `RunCounts` and the writer live in `src/lib/ingest/sources.ts`; the `scrape_runs` columns already exist in `0001_init.sql`.
- [x] Partial parses set `status='partial'` with parse diagnostics in `log` — `runStatusFor` checks `partial` **before** `success`, so a run with both successes and failures cannot report `success` and hide them. `buildRunLog` caps diagnostics at 20 entries and sets `truncated`, so one pathological source cannot write a multi-megabyte jsonb row.
- [x] `api_calls` is populated for cost tracking — counted by `RunCtx.onRequest` (`docs/02b` §6.1) and carried in `RunCounts.apiCalls`.
- [x] No `scrape_runs` access from the client (RLS test from ENG-004 holds) — RLS was enabled and forced on all 19 tables in FND-003, and the accounting module holds no client reference at all, so it cannot become a read path.

**Delivered 2026-10-09 (accounting only).** `runStatusFor` and `buildRunLog` in
`src/lib/ingest/sources.ts`, 11 unit tests.

**What is NOT done — this ticket is not complete.** The decision functions exist; **nothing
calls them yet.** There is no `scrape_source` handler, so no run is ever started, no row is
ever written, and `duration_ms` is never measured. The status logic is exercised only through
its own tests. Recorded as partial rather than done because the acceptance criteria are about
rows appearing in a table, and no row appears.

**One judgement call worth flagging:** a run that finds zero postings is reported `failed`, not
`success`. An empty ATS board is indistinguishable from a working one from the outside, so
"found nothing, no error" is a broken integration rather than a clean cycle. A source that
legitimately has zero new listings would be flagged — the trade is deliberate and reversible
once real cadence data exists.

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
- [x] `supabase db reset` applies `0003_remote_scope.sql` — ✅ **executed 2026-10-09** as part of the full `db reset`.
- [ ] FE-120 wires the filter end-to-end (Phase 2)

---

## E4 — Matching & Scoring

### SCR-001 — Scoring gates (hard filters)
**[DATA] [SEC]** · **Priority:** MUST · **Depends on:** ONB-005, ING-006

`lib/scoring/gates.ts` implementing the five gates from [02 §6.3](./02-technical-architecture.md): blocked company, excluded keyword, work mode, salary floor, seniority over-band.

**Done when:**
- [x] Each gate returns a machine-readable reason in `gate_result.reasons`
- [x] Any hit → `final_score = 0` **and** the job is excluded from the feed (not shown at 0)
- [x] Salary gate only fires when salary is disclosed; undisclosed never triggers it ([03 §6.1 X-09](./03-security-and-access.md))
- [x] Blocked company still allows an existing application to display ([03 §6.1 X-12](./03-security-and-access.md))
- [x] Unit tests: one passing case + one failing case per gate
- [x] No gate fires on missing data — a separate `describe` block pins this per gate, because a gate that excludes a job for want of data is invisible to the user

**BE-201 delivered** (`src/lib/scoring/gates.ts`, 38 tests). Reason codes are
`blocked_company` · `excluded_keyword` · `work_mode_mismatch` · `salary_below_floor` ·
`seniority_over_band`; the last four follow `salary_below_floor`'s naming from
[02a §5.5](./02a-schema.md), which is the only one the docs pin as a string.

Judgement calls the docs do not settle, all four now asserted in tests:

| Question | Decision | Why |
|---|---|---|
| Salary period `NULL` | treated as `year` | most postings state no period; treating it as "don't gate" would make the floor decorative |
| Hourly salary | gate declines | annualising needs an hours-per-week assumption nobody can audit |
| Currency mismatch | gate declines | no FX table exists; inventing rates changes results on unauditable numbers |
| `work_modes = '{}'` | no gate | the column defaults to empty, so gating on it would empty the feed for anyone who has not finished onboarding |
| Seniority `unknown` | no gate | the enum has no defined order, so `seniorityRank` is declared in `gates.ts`, not read from the DB |

Keywords match as whole phrases with **per-end** word boundaries — a blanket `\b…\b`
can never match "c++", while substring matching makes "ai" match "maintain".

**Shared helper:** `src/lib/utils/company-slug.ts` (`utils/` per [02 §4](./02-technical-architecture.md)).
Extracted because write and match had to agree: `blocked_companies` is documented as
"normalised slugs" but BE-304 stored `trim().toLowerCase()`, so "Acme Corp." was stored
verbatim and could never match a slugified job — the dealbreaker was silently inert.
Both sides now use it.

---

### SCR-002 — Rule-based fit score
**[DATA]** · **Priority:** MUST · **Depends on:** SCR-001

`lib/scoring/rules.ts` producing a 0–100 score with the weights from [02 §6.3](./02-technical-architecture.md): skills 35, seniority 15, compensation 15, location/work-mode 15, recency 10, company preference 10. Weights come from `weights.ts` (flag-overridable).

**Done when:**
- [x] Sum of weights is 100 and configurable without a code change path
- [x] Skills sub-score uses `job_skills.weight` so weak mentions count less
- [x] Compensation sub-score returns **neutral**, not 0, when salary is undisclosed
- [x] Recency decays monotonically (unit-tested)
- [x] Output includes a `breakdown` array in the exact shape rendered by [04 §3.4](./04-frontend-specification.md)
- [x] Same inputs → same score (pure function, deterministic test)

**BE-202 delivered** (`src/lib/scoring/weights.ts` + `rules.ts`, 53 tests).

The invariant the whole module is built around: **every sub-score returns `{ raw, known }`,
and a component that does not know scores `0.5`, never `0`.** docs/03 §6.1 X-09 requires
this for salary; it holds for all six because a ranking computed on absent data
systematically buries the jobs a source published least about.

`known` is carried into `breakdown[]` so the FE can label an inferred number rather than
present it as a finding. For the combined work-mode component it is `mode.known &&
location.known` — an earlier `||` reported "known" while a third of the weight was a
standing assumption about an undisclosed work mode.

Decisions the docs do not settle, each asserted in tests:

| Question | Decision | Why |
|---|---|---|
| `job_skills.weight` has **no CHECK** (`numeric(3,2)`) | divide by that job's own max weight | a connector writing 1/3 and one writing 0.2/0.6 must give the same ordering; clamping or trusting the raw value distorts one of them |
| `prof_level = null` | treated as `proficient` | the column's own default |
| seniority falloff | symmetric over 4 bands | a principal applying to an intern role is a mismatch too, even though only the over-qualified direction is gated |
| `recency` horizon | 28 days | the same boundary docs/02b §6.4 expires a job at, so a job cannot be "fresh" to the scorer and "expired" to the cron |
| future `posted_at` | clamped to 1.0 | a source clock problem must not outrank every real posting |
| empty `preferred_companies` | neutral, not 0 | "no companies listed" is not "every company is unwanted" |

**SCR-007 deferred.** The "flag-overridable" half of SCR-002 is not delivered: this repo
has no feature-flag or config table, and inventing one to make a tuning value dynamic is
a bad trade. `RULE_MODEL_VERSION` (`rule-v1`) is stamped into `job_scores.model_version`
so a stored score always states which weight set produced it, and `SEMANTIC_BLEND` is a
named constant because that is the single value SCR-007 needs to override.

---

### SCR-003 — Embeddings & semantic score
**[DATA]** · **Priority:** MUST · **Depends on:** SCR-002, ING-006

`lib/scoring/semantic.ts`: batch-embed job descriptions and the aggregate profile; cosine similarity → 0–100.

**Done when:**
- [x] Batches ≤100 inputs; embeddings written only when `description_text` changes
- [x] `semantic_score = (1 - cosine_distance) * 100`, clamped 0–100
- [ ] Profile embedding rebuilt on profile save — **blocked on E3**: nothing populates `jobs.embedding`, so there is no ingest path to hook this to
- [x] Embedding failure retries and does **not** block the feed ([04 §5.9](./04-frontend-specification.md))
- [x] Test: semantically similar role with no keyword overlap still scores materially above an unrelated role

**BE-203 delivered** (`src/lib/scoring/semantic.ts`, 24 tests).

Failure is non-fatal **by construction**, not by convention: every path returns `null`,
and `null` is a value `composeScore` already handles by reweighting to the rule score. The
alternative — throwing — would put the docs/04 §5.9 obligation on every future caller
rather than on the one function that can honour it.

Three guards exist because each failure passes a naive "did it return a number" check while
causing durable, invisible damage:

| Guard | Failure it prevents |
|---|---|
| re-order by the response's own `index` field | pairing text *i* with another text's vector. Embeddings are cached to `jobs.embedding` / `profiles.profile_embedding`, so a mis-pairing is permanent and surfaces nowhere but a slightly wrong score |
| `null` on short / duplicate-index / wrong-width responses | a partial array shifts every later text onto the wrong embedding |
| `null` on a zero vector or dimension mismatch | `NaN` propagating into `job_scores`, i.e. a score the UI cannot render. A mismatch means a different model — docs/02 §7.1 calls that a full reindex |

`dimensions` is **omitted from the request body entirely** rather than set to 2048: this
model rejects any other value with HTTP 400, and an absent field cannot drift from a
comment.

One deliberate trade recorded: a cosine above 1 is clamped rather than surfaced as a data
problem, because a score outside 0–100 breaks the feed's ordering, and a visibly odd
score is more usable than none.

---

### SCR-004 — Final score composition & persistence
**[DATA]** · **Priority:** MUST · **Depends on:** SCR-002, SCR-003

Compose `final = 0.5·rule + 0.5·semantic`, write `job_scores` with `breakdown`, `model_version`, `scored_at`.

**Done when:**
- [x] Unique `(user_id, job_id)`; re-scoring upserts rather than duplicating
- [x] Gated jobs get `final_score = 0` with `gate_result` populated
- [x] `breakdown` always present — the UI never shows a bare number (C3 / [04 §3.4](./04-frontend-specification.md))
- [ ] `v_ranked_jobs` returns these rows for the feed query — feed query is BE-306, not started
- [ ] Coverage: ≥98% of active jobs have a score for an active profile — `coverage()` shipped; nothing produces jobs yet

**BE-204 delivered** (`src/lib/scoring/index.ts`, 24 tests). Split in two on purpose:
`composeScore` is pure and unit-testable, `persistScore` is the only function that
touches Supabase and takes its client by injection.

Two decisions worth recording:

| Question | Decision | Why |
|---|---|---|
| Do gated jobs get a row? | **yes** — `final_score = 0` with `gate_result` populated, plus the rule score as evidence | that row is the only record of *why* a job is absent from a feed. Skipping the write makes the exclusion invisible and unanswerable. "HIDE from feed" is the feed query's job, not the writer's. |
| `semanticScore` is `null` | reweight to `rule` alone, **not** 0 | a 0 would rank every not-yet-embedded job below every embedded one, so a transient OpenRouter failure would empty the feed. [04 §5.9](./04-frontend-specification.md) requires an embedding failure not to block the feed. |

`persistScore` deliberately omits `explanation` from the upsert: SCR-006's rationale is
Pro-only and separately metered, and including it as `null` would delete a still-valid
rationale on every profile edit.

**Service role is required, not incidental.** `job_scores` has a SELECT-only RLS policy
(`job_scores_owner_select`, `0001_init.sql:652`) — there is no INSERT/UPDATE policy for a
user, so a user-scoped client cannot write a score. That is the right shape: scoring reads
one user's whole profile and writes on their behalf. The client is therefore passed in
rather than constructed here, so the caller is visibly choosing the privilege.

A `clamp01` (0–1) was briefly applied to the 0–100 blended score, which clamped every
score to exactly `1`. It survived the gate run because the tests asserted against the same
wrong scale; it was found by printing an actual composed score. `clamp100` now exists as a
distinctly-named function.

---

### SCR-005 — Batch rescoring on profile change
**[OPS] [DATA]** · **Priority:** MUST · **Depends on:** SCR-004, ING-008

`rescore_profile` task handler requeueing affected jobs asynchronously (C4).

**Done when:**
- [x] Profile save enqueues `rescore_profile`, never blocks the request
- [x] Handler processes in batches and is safe to run concurrently
- [ ] UI shows a "Rescoring your feed…" indicator that clears on completion — **Phase 2**; BE-304 now returns `rescoreTaskId` from every save so the FE has the handle it needs
- [x] New scores replace old rows; no unbounded growth of `job_scores`

**BE-205 delivered** (`src/lib/queue/handlers/rescore-profile.ts`, 19 tests). The
enqueue half was BE-304 (`enqueue_rescore_profile()`); this is the handler end of that
contract.

Split in two, matching `queue/plan.ts`'s shape: `planRescoreBatch` is pure (which pairs to
score, and whether to continue) and `runRescoreProfile` is the executor. That makes the
governing constraint testable without a queue or a database — [02 §6.4](./02-technical-architecture.md)
is explicit that "Vercel function timeouts are respected by **batch size, not
long-running loops** — if a batch is incomplete, the handler re-enqueues itself".

**BUG FOUND AND FIXED:** completion was originally decided by `jobs.length <= batchSize`.
That is true for *every* full batch, so a profile with 2,000 jobs would score 100, report
`done`, and leave 1,900 unscored with nothing indicating it. The store already limits the
page, so length cannot reveal whether more remains — only `countRemaining` can. Now
`jobs.length >= total`, with a test that pins the 100-against-2,000 case.

Concurrency is safe **structurally**: every write is an upsert keyed on `(user_id, job_id)`,
so two workers on the same profile converge rather than accumulate rows. No
`sighting_count`-style accumulator appears here precisely because it would double-count
under a race. A per-job failure is counted and skipped, never thrown — one malformed row
must not cost the other 99 in the batch.

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
