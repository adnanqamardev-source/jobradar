# 03 — Security & Access Document

**Product:** JobRadar · **Version:** 1.0 — MVP
**Depends on:** [02 Technical Architecture](./02-technical-architecture.md) · **Feeds:** [04 Frontend Specification](./04-frontend-specification.md)
**Last updated:** 2026-10-03

> Written so a non-technical founder can follow it. Every rule here is enforced in code or in the database — nothing is "by convention only." Where a rule maps to a table from §5 of the architecture doc, the table is named.

---

## 1. Plain-English Security Model

Three ideas carry the whole document:

1. **You only ever see your own stuff.** A user's profile, scores, saved jobs and applications are locked to their own account by database rules (Row-Level Security), not by checking `userId` in application code. Even if a developer writes a buggy query, the database refuses to hand over someone else's rows.
2. **The keys have different powers.** There's a public key (weak, used in the browser, can only do what RLS allows) and a private key (all-powerful, used only by server-side workers). The all-powerful key never appears in anything the browser downloads.
3. **Everything that can fail, has a defined message.** No screen ever shows a raw stack trace, an empty white page, or a spinner that never ends.

---

## 2. Authentication Method

### 2.1 What we use

| Method | How it works | Where | Priority |
|---|---|---|---|
| **Email magic link (primary)** | User enters email → we send a one-time link → clicking it signs them in. No password exists to steal, forget, or reuse. | `/login` → `POST /auth/v1/otp` | **M** |
| **Google OAuth (primary)** | One click, consent screen, session created. | `/login` → Supabase `signInWithOAuth('google')` | **M** |
| **Email OTP code (fallback)** | 6-digit code, 10-minute expiry, 5 attempts max. For users whose mail client breaks link handling. | `/login` → `POST /auth/v1/verify` | **S** |
| Password | **Not offered.** | — | deliberately omitted |

**Why magic link + OAuth, not passwords:** passwords generate the entire class of credential-stuffing, reuse and phishing risk, and for a job-search tool nobody wants to manage another password. OAuth adds a familiar one-click path for the 60%+ who have a Google account. OTP is kept as a fallback because magic links fail silently in some corporate mail clients — a real onboarding-abandonment cause.

### 2.2 Session rules

| Rule | Value | Reasoning |
|---|---|---|
| Access token lifetime | **1 hour** | Short enough that a leaked token has a small window. |
| Refresh token lifetime | **30 days**, sliding | Long enough that a returning user isn't logged out weekly; short enough to bound risk. |
| Cookie | `httpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix | Not readable by JS (blocks XSS token theft); `Lax` still allows navigation links from the digest email. |
| Refresh rotation | Enabled | A stolen refresh token is invalidated once it's used. |
| Logout | Server-side sign-out **and** cookie clear | Local-only logout leaves a usable token. |
| Session invalidation on privilege change | On `role` or `plan` downgrade | A demoted admin must not keep admin access for up to 24h. |
| Concurrent sessions | Allowed, no cap | Not worth the support burden at MVP. |

### 2.3 Auth flow specifics

- **Magic link:** 1-hour expiry, single use, bound to the exact email entered. Redirects to `/auth/callback`, which exchanges the code for a session then routes: new user → `/onboarding`, returning user → `/dashboard`.
- **State/nonce:** OAuth uses PKCE with a random `state` and `nonce` stored in a short-lived cookie; mismatch → `auth_failed` error page (§6.2 E-05).
- **Email verification:** magic link *is* verification. OAuth inherits the provider's verified email. Unverified accounts cannot create applications (prevents throwaway accounts from filling the tracker).
- **Rate limiting:** per IP + per email: **5 sign-in attempts / 15 min**, **3 magic links / 10 min**. On breach → generic `too_many_attempts` with a 15-minute cooldown. Same endpoint always returns the same response regardless of whether the email exists (no account enumeration).
- **Admin bootstrap:** first deploy seeds `ADMIN_EMAILS` → those accounts get `role = 'admin'` via a one-time migration. Admin can never be self-assigned through the app.

---

## 3. User Roles & Permissions

### 3.1 Role definitions

| Role | Who | How assigned |
|---|---|---|
| **`guest`** | Not signed in. Can view landing, pricing, and the public demo feed. | — |
| **`user` → `free`** | Default. Full discovery loop within free quotas. | Signup |
| **`user` → `pro`** | Paid. Higher quotas + LLM rationale + faster digests. | Stripe webhook only — **never** a client-writable field |
| **`admin`** | Platform operator. Sees ops data, not user content by default. | `ADMIN_EMAILS` allowlist, one-time migration |
| **`service`** | Server-side workers using the service-role key. No UI. | Key custody only |

### 3.2 Permission matrix

**Legend:** ✅ allowed · ⛔ blocked · 🔒 allowed but scoped to own records · ⚠️ allowed with limits

| Capability | guest | free | pro | admin |
|---|---|---|---|---|
| View marketing / pricing / demo feed | ✅ | ✅ | ✅ | ✅ |
| Sign up / sign in | ✅ | — | — | ✅ |
| Complete onboarding, edit **own** profile | ⛔ | 🔒 | 🔒 | 🔒 |
| View ranked feed of **own** scores | ⛔ | 🔒 ⚠️ | 🔒 | 🔒 |
| View the shared `jobs` corpus rows | ⛔ | 🔒 | 🔒 | 🔒 |
| Create/save/dismiss **own** job actions | ⛔ | 🔒 ⚠️ | 🔒 | 🔒 |
| Create **own** applications | ⛔ | 🔒 ⚠️ | 🔒 | 🔒 |
| Saved searches | ⛔ | ⚠️ max **3** | ⚠️ max **25** | 🔒 |
| Sources watched (defaults) | ⛔ | ⚠️ max **5** | ⚠️ max **30** | 🔒 |
| Jobs scored per month | ⛔ | ⚠️ **500** | ⚠️ **10,000** | 🔒 |
| LLM fit rationale | ⛔ | ⛔ | ✅ | ✅ |
| Digest frequency | — | daily | daily + **high-match alert** | — |
| Force "run now" on a source | ⛔ | ⚠️ **3/day** | ⚠️ **30/day** | ✅ |
| View `/admin` (source health, runs, queue) | ⛔ | ⛔ | ⛔ | ✅ |
| Retry / pause a source, retry a task | ⛔ | ⛔ | ⛔ | ✅ |
| Look up a user by email | ⛔ | ⛔ | ⛔ | ✅ ⚠️ |
| **Read another user's profile, résumé, or applications** | ⛔ | ⛔ | ⛔ | ⛔ **blocked by RLS** |
| Edit another user's data | ⛔ | ⛔ | ⛔ | ⛔ |
| Change own `role` or `plan` | ⛔ | ⛔ | ⛔ | ⛔ (plan moves only via Stripe) |
| Disable a source globally | ⛔ | ⛔ | ⛔ | ✅ |
| Export / delete own account | ⛔ | 🔒 | 🔒 | 🔒 own only |

**⚠️ limits** are enforced in two places: the Server Action checks `usage_events` against `PLAN_LIMITS` before acting, **and** a DB `CHECK`/trigger guards the same ceiling for the rows that can't drift (e.g. `saved_searches` count). Double enforcement because quota checks in app code alone are bypassable by a direct SQL mistake.

**Admin lookup caveat:** an admin can find an account by email for support purposes, but retrieving profile *content* requires an explicit, audited `audit_logs` entry (`action = 'admin.viewed_profile'`, with `target_id`). This is the "no casual access to user data" rule — support requests should be answerable from ops metrics, not from reading someone's applications.

---

## 4. Row-Level Security (RLS)

RLS is **enabled on every table** in the schema. Default posture: **deny all**, then add named policies. The service-role key bypasses RLS — which is precisely why it never reaches the browser (§4.4).

### 4.1 The helper functions

```sql
-- true when the JWT's sub == this row's user_id
create function auth.uid() returns uuid;          -- Supabase built-in

-- true when the JWT role claim = 'admin'
-- Fixed 2026-10-03: the inner call is wrapped in (select ...). Do not unwrap it.
create function is_admin() returns boolean
  language sql stable as $$
  select coalesce((select auth.jwt()) ->> 'role', 'user') = 'admin'
$$;
```

**Why the `(select …)` wrapper is not optional.** Postgres normally re-runs a function once per
row it checks. Wrapping the call in `select` tells Postgres to run it **once per query** and
reuse the answer. Without the wrapper, every row scanned re-reads and re-parses the JWT. On a
feed with thousands of rows that is the difference between a fast page and a timeout.

**This applies everywhere, not just here.** Every `auth.uid()` and `auth.jwt()` in a policy in
§4.2 must be written as `(select auth.uid())` for the same reason.

### 4.1a Force RLS — do not skip this

**Added 2026-10-03.** §4.2 turns RLS *on* for every table. That is not sufficient on its own.

In Postgres, the **owner of a table is exempt** from its own row-level security. So if a table
and its policies are created by the same role that later queries it, that role sees every row
regardless of the policies. The policies look correct in `pg_policies` and do nothing.

The fix is one extra line per table:

```sql
alter table jobs enable row level security;    -- turn the policies on
alter table jobs force  row level security;     -- make them bind the owner too
```

`service_role` is unaffected, because it has its own bypass role. Every table in §4.2 gets both
lines.

### 4.2 Policy table

**Legend:** `S` = SELECT · `I` = INSERT · `U` = UPDATE · `D` = DELETE

**Every table below gets both `enable row level security` and `force row level security`** —
see §4.1a for why the second one is not optional. Every `auth.uid()` / `auth.jwt()` in the
Rule column is written as `(select auth.uid())` — see §4.1.

| Table | Who | S | I | U | D | Rule (written out) |
|---|---|---|---|---|---|---|
| `profiles` | owner | ✅ | ✅ | ✅ | ⛔ | `auth.uid() = id`. Self-delete goes through the account-deletion flow, which uses the service key + cascade, never a direct row delete. |
| `profiles` | admin | ✅ | ⛔ | ⛔ | ⛔ | `is_admin()` — lookup only, and only non-sensitive columns via a restricted view. |
| `profile_skills` | owner | ✅ | ✅ | ✅ | ✅ | `exists(select 1 from profiles where id = profile_id and auth.uid() = id)` |
| `resume_versions` | owner | ✅ | ✅ | ✅ | ✅ | same ownership predicate; `storage_path` never returned as a public URL |
| `saved_searches` | owner | ✅ | ✅ | ✅ | ✅ | ownership predicate + insert-time quota check |
| `job_scores` | owner | ✅ | ⛔ | ⛔ | ⛔ | `auth.uid() = user_id`. **Write path is service-role only** (queue scorer) — users can't forge their own scores. |
| `applications` | owner | ✅ | ✅ | ✅ | ✅ | `auth.uid() = user_id`. `job_snapshot` is client-supplied-on-apply but validated by Zod. |
| `application_events` | owner | ✅ | ✅ | ⛔ | ⛔ | ownership via join to `applications`; history is append-only (an editable timeline is a lying timeline). |
| `jobs` | authenticated | ✅ | ⛔ | ⛔ | ⛔ | `auth.role() = 'authenticated'` — corpus is shared, **read-only**. All writes via service key. |
| `jobs` | service | full | | | | bypass — ingest pipeline only |
| `job_skills` | authenticated | ✅ | ⛔ | ⛔ | ⛔ | read-only, same as `jobs` |
| `skills` | authenticated | ✅ | ⛔ | ⛔ | ⛔ | seeded vocabulary, read-only |
| `companies` | authenticated | ✅ | ⛔ | ⛔ | ⛔ | read-only |
| `sources` | authenticated | ✅ | ⛔ | ⛔ | ⛔ | users may *view* what's watched |
| `sources` | admin | ✅ | ✅ | ✅ | ⛔ | `is_admin()` — add/configure/pause, never delete (history depends on it) |
| `scrape_runs` | authenticated | ⛔ | ⛔ | ⛔ | ⛔ | **no client access at all** |
| `scrape_runs` | admin | ✅ | ⛔ | ⛔ | ⛔ | ops visibility |
| `subscriptions` | owner | ✅ | ⛔ | ⛔ | ⛔ | `auth.uid() = user_id`. All writes from Stripe webhooks (service key). Client cannot grant itself `pro`. |
| `usage_events` | owner | ✅ | ⛔ | ⛔ | ⛔ | read-only for a "your usage this month" widget |
| `usage_events` | service | full | | | | counters written by Server Actions |
| `task_queue` | — | ⛔ | ⛔ | ⛔ | ⛔ | **service-role only**, no client policies defined |
| `audit_logs` | owner | ⛔ | ⛔ | ⛔ | ⛔ | no client access |
| `audit_logs` | admin | ✅ | ⛔ | ⛔ | ⛔ | append-only, service key writes |
| `digests` | owner | ✅ | ⛔ | ⛔ | ⛔ | user can see "we skipped yesterday, nothing new" |
| `job_events` | owner | ✅ | ✅ | ⛔ | ⛔ | implicit feedback rows |

### 4.3 Worked example — why this holds

A malicious free user opens the browser console:

```js
supabase.from('job_scores').select('*')     // → only their own rows
supabase.from('profiles').select('*')       // → only their own row
supabase.from('task_queue').select('*')     // → error: RLS disabled for role
supabase.from('job_scores').insert({...})   // → 0 rows affected: no INSERT policy
```

To escalate, they'd need `SUPABASE_SERVICE_ROLE_KEY`, which is never sent to the client (§4.4) — it lives only in Vercel server-side env vars, referenced exclusively from `src/lib/db/admin.ts`, whose import is blocked everywhere except `lib/queue/**`, `api/cron/**`, `api/webhooks/**` by an ESLint `no-restricted-imports` rule. A CI check greps the built client bundle for any key matching `(supabase|sk-|whsec_|rk_live)` and fails the build on a hit.

### 4.4 Secrets & key custody

| Key | Stored | Reachable from | Rotation |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel + browser | anywhere | tied to project config |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel **server-only** env | `lib/db/admin.ts` imports | on any suspected exposure |
| `CRON_SECRET` | Vercel server env | `/api/cron/*` verify | quarterly |
| `FIRECRAWL_API_KEY` | Vercel server env | ingest pipeline | quarterly |
| `OPENROUTER_API_KEY` | Vercel server env | scoring | quarterly |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Vercel server env | billing | on exposure |
| `RESEND_API_KEY` | Vercel server env | email | quarterly |
| Supabase DB passwords | Supabase vault | never in code | 90 days |

**Rules:** never in git (a pre-commit hook runs `gitleaks`); never in client bundles (CI grep, above); never in logs (`redact()` strips `*_KEY`, `*_SECRET`, `authorization`, `cookie`); never in `jobs.raw` or `audit_logs.meta` (schema forbids it — the redaction runs before insert).

### 4.5 Transport & headers

- HTTPS enforced (HSTS `max-age=31536000; includeSubDomains`), HTTP → HTTPS redirect at the edge.
- CSP: `default-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`; script-src restricted to `'self'` + Supabase + PostHog + Stripe.js (nonce-based for the few inline scripts).
- `X-Content-Type-Options: nosniff` · `Referrer-Policy: strict-origin-when-cross-origin` · `Permissions-Policy: camera=(), microphone=(), geolocation=()` · `X-Frame-Options: DENY`.
- Static assets `immutable, max-age=31536000`; HTML `no-store` for the authenticated app.

---

## 5. Error Handling Guide

Principles: **say what happened, say what to do, never leak internals.** Every failure maps to a stable code in `src/lib/errors/`, and the copy lives in one map so wording stays consistent across screens. Toasts for recoverable action failures; inline messages for field-level validation; full pages for auth/session/404/500.

### 5.1 Error codes

| Code | Trigger | User sees | System does |
|---|---|---|---|
| `validation_failed` | Zod rejects input | Inline under the field: *"Add at least one target role to continue."* | 422, nothing written |
| `unauthenticated` | No/expired session | Redirect to `/login?next=…` with *"Your session expired. Sign in to pick up where you left off."* | 401 |
| `forbidden` | Role/plan blocks the action | *"That's a Pro feature."* + inline What-you-get list | 403, `audit_logs` if admin route |
| `not_found` | Row missing or not yours | **Identical page for "doesn't exist" and "not yours"** — *"We couldn't find that job."* + link back | 404 (no existence leak) |
| `rate_limited` | Action ceiling hit | *"You're moving fast — try again in 60 seconds."* | 429 + `Retry-After` |
| `quota_exceeded` | Plan limit reached | Inline, non-modal (PRD Flow 6): *"You've used all 3 free saved searches. Pro gives you 25."* | 402-style code, `paywall_viewed` event |
| `upstream_timeout` | Firecrawl/OpenRouter/source > timeout | Toast: *"That source is slow right now — we'll retry it in the background."* | task retried, `last_error` set |
| `upstream_error` | Source returned 5xx/4xx | Same as above (never a raw response body) | retry ×3 with backoff |
| `scrape_parse_failed` | Connector output fails Zod | No user-facing error; admin run row shows it | run `partial`, row quarantined, `confidence` low |
| `email_delivery_failed` | Resend rejects | None (silent to user) | `digests.status='failed'`, retry once, admin tile |
| `payment_failed` | Stripe card declined | *"Payment didn't go through — your card was declined. Update it to stay on Pro."* + portal link | Entitlements unchanged; `past_due` handling |
| `webhook_invalid` | Stripe signature mismatch | — | 400, logged, alerted |
| `service_unavailable` | DB unreachable / 5xx burst | Full-page: *"Something's on our end. We're looking into it."* + `requestId` | 503, Sentry alert |
| `internal_error` | Unhandled exception | Full-page: *"Something went wrong. Try again."* + `requestId` (never a stack trace) | 500, Sentry capture with `requestId` |
| `file_too_large` / `file_type_invalid` | Résumé upload | Under the field: *"PDFs under 5 MB."* | Rejected before upload |
| `account_locked` | Repeated auth failures | Generic: *"Too many attempts. Wait 15 minutes and try again."* | Cooldown, no account-existence hint |

### 5.2 Failure-point playbook

| Failure point | Response |
|---|---|
| **API doesn't respond** | Connector timeout at 30s → task retries 3× at 30s/2m/8m → then `failed`. Feed keeps serving the last good corpus; **the app never blocks on a source**. Admin sees the source flagged amber at 3 failures, paused at 5. |
| **Wrong password** | N/A — no passwords. Wrong OTP/code → *"That code didn't match. Try again."* (5 attempts, then `account_locked`). |
| **Magic link expired / reused** | *"This link has expired. Request a new one."* + one-click resend. Not an error page — a normal login state. |
| **Payment fails** | Entitlements **unchanged** (never downgrade on a failed charge). `past_due` → banner with update-card link. Grace 7 days → `canceled` → `plan='free'`. One dunning email at day 1, 3, 7. |
| **Payment succeeds but webhook lost** | Stripe retries webhooks for 3 days; a reconciliation job on `/api/cron` compares active subscriptions to local rows hourly and self-heals. |
| **Résumé upload fails mid-way** | Client-side size/type check first; on network failure → *"Upload didn't finish. Try again."* Partial objects are cleaned by a nightly `cleanup` task. |
| **Queue backlog / worker dies** | Leases expire after 5 min → task returns to `pending` → another worker picks it up. Idempotent handlers mean a duplicate run is harmless. |
| **User submits empty form** | Required fields disabled-submit until valid (client) **and** Zod rejects server-side (defense in depth). Message: *"This field is required."* |
| **Offline / slow connection** | Server Actions are retry-safe. On network error → toast *"Couldn't save — check your connection and try again."* Inputs keep their values; never clear a form on failure. Feed shows cached RSC payload immediately, then refreshes. |
| **Concurrent edits (two tabs)** | `updated_at` optimistic-concurrency check → *"This changed in another tab. Reload to see the latest."* |
| **Deleted job while an application references it** | `job_snapshot` on `applications` keeps title/company/salary; detail shows *"The original posting is no longer available."* with the tracker record intact. |

### 5.3 Presentation rules

- **Never** render `error.message`, stack traces, SQL, or upstream response bodies to a user — only stable codes mapped to curated copy.
- Every 5xx page shows a copyable **`requestId`** that matches the Sentry event and the structured log line.
- Loading states are **real**: skeletons that match the final layout (no spinner-only pages), and the onboarding interstitial reflects actual progress counters (PRD Flow 1 step 8).
- Optimistic UI is allowed for save/dismiss/stage-move with rollback on failure — but never for anything billing-related.

---

## 6. Edge Cases

### 6.1 Product edge cases

| # | Edge case | Handling |
|---|---|---|
| X-01 | Empty form submitted | Client: submit disabled until schema-valid. Server: Zod → `validation_failed` with per-field messages. Never a silent no-op. |
| X-02 | User navigates to a page they can't access (e.g. `/admin` as free user) | `requireAdmin()` in the layout → redirect to `/dashboard` with a neutral *"You don't have access to that page."* Not a 403 wall, not a crash. |
| X-03 | User edits the URL to another user's `jobId`/`applicationId` | RLS returns zero rows → **same** `not_found` page as a genuinely missing ID. No information leak. |
| X-04 | Slow connection on the feed | RSC shell paints first with skeletons; LCP target < 2.0s. Long actions show inline progress, not a frozen button. |
| X-05 | Double-click "Mark applied" | Server Action is idempotent on `(user_id, job_id)` unique constraint → one application, second click returns the existing one. |
| X-06 | Onboarding abandoned at step 2 of 4 | `onboarding_step` persisted per step; next login resumes there with a progress banner. Profile not marked complete → feed shows the completion card, not an empty state. |
| X-07 | Email already registered (magic link) | **No enumeration**: always *"Check your inbox for your sign-in link."* Whether it's new or existing is only revealed after auth. |
| X-08 | Profile with zero skills / zero titles | Scoring skips (no fake score of 0). Feed shows an inline *"Add skills to start scoring jobs"* card linking to step 2. Never silently rank against nothing. |
| X-09 | Job with no disclosed salary | `salary_min/max` NULL → compensation sub-score returns **neutral** (not 0), and the card shows *"Salary not disclosed"* with a confidence flag. Penalising silence would bury good jobs. |
| X-10 | Job posted 3 weeks ago still circulating | Freshness sub-score decays; status → `stale` at 14 days unseen, `expired` at 28 → demoted out of the default feed and shown under a "Older" filter. |
| X-11 | Same job from 4 sources | One card, `sighting_count = 4`, *"Seen on 4 sources"* chip; D5 dismisses the whole cluster. |
| X-12 | User blocks a company they'd already applied to | Existing application stays (history is never rewritten); only future feed results are gated. |
| X-13 | Free user hits a limit mid-scroll | Inline limit card in the feed position, not a modal. Shows current/limit as a meter + what Pro adds. |
| X-14 | Digest would contain zero jobs | `digests.status='skipped'`, **no email sent**. Silence over filler. |
| X-15 | User sets a follow-up date in the past | Allowed (they may be catching up) but immediately appears in *Needs attention*. |
| X-16 | Résumé deleted while attached to an application | FK `on delete set null` → application shows *"Résumé removed"*, record and stage history intact. |
| X-17 | Timezone ambiguity for digest send time | Profile stores IANA `time_zone`; digest computed in that zone, with DST handled by Postgres `AT TIME ZONE`. UI always shows the resolved local time: *"Every day at 8:00 AM (Asia/Kolkata)"*. |
| X-18 | User signs up, never finishes onboarding, comes back 3 weeks later | Magic link still valid; session restored; resume onboarding. No "account stale" dead-end. |
| X-19 | Source stops returning data entirely | Circuit breaker at 5 consecutive failures pauses the source, admin tile turns red with a Retry action. Corpus stays intact — users never see an empty feed because one source died. |
| X-20 | Cron fires while a previous run is still going | Task claiming uses `FOR UPDATE SKIP LOCKED`; a task already `running` is not re-claimed. Leases expire, so nothing gets permanently stuck. |
| X-21 | User deletes their account | Cascade removes `profiles`, skills, scores, applications, events, digests, usage, subscriptions, and Storage objects. The shared `jobs` corpus is retained. Confirm dialog spells out exactly what's removed. |
| X-22 | Admin is demoted while logged in | `role` change triggers session refresh; `/admin` layout re-checks on every render → immediate bounce to `/dashboard`. |
| X-23 | Accessibility: score conveyed by colour only | Every score shows a **numeric value + text label** alongside the coloured meter; `aria-label` reads *"Match score 78 out of 100, strong match"*. Colour is never the sole signal. |
| X-24 | Very long job description | Detail view caps the inline height with `Read more`; description text is sanitised HTML (XSS), never `dangerouslySetInnerHTML` on unsanitised input. |
| X-25 | Browser tab left open overnight | Refresh token rotation handles renewal; on failure → clean redirect to `/login` with return path preserved. |

### 6.2 Security edge cases

| # | Edge case | Handling |
|---|---|---|
| S-01 | SQL injection in the search box | Parameterised SQL only (Supabase PostgREST + bound queries). `query` goes through `to_tsquery` with user input escaped via `websearch_to_tsquery`. No string-concatenated SQL anywhere — enforced by lint + code review. |
| S-02 | XSS in a job description | `description_html` sanitised on ingest (allowlist of `p, ul, li, strong, em, a, br, h3, h4`); rendered as text nodes. CSP blocks inline script. |
| S-03 | Forged `role` claim in a JWT | JWT is signed by Supabase; claims are not client-forgeable. `is_admin()` reads the server-issued claim, never a client-supplied field. |
| S-04 | Client calls `profiles.update({ plan: 'pro' })` | `plan` column has `REVOKE UPDATE` from authenticated + a trigger that rejects changes not originating from the Stripe webhook path (service role). Belt and braces. |
| S-05 | SSRF via a user-supplied scrape URL | Firecrawl only accepts URLs from `sources.config`, which admins authorise; the connector validates scheme (`https` only), rejects private IP ranges/localhost, and caps redirects. Free users can't add arbitrary URLs at all. |
| S-06 | Oversized file / zip bomb upload | 5 MB limit, `application/pdf` magic-byte check, storage policy restricts bucket + path, virus scan hook before `resume_versions` row is created. |
| S-07 | Rate limiting on write actions | `lib/ratelimit.ts` — sliding window per user+action (e.g. 30 saves/5 min, 60 stage moves/5 min). Exceeded → `rate_limited`, never a silent drop. |
| S-08 | Stripe webhook replay | Signature verified with timestamp tolerance; `event.id` uniqueness enforced so replays are no-ops. |
| S-09 | Open redirect on `?next=` | Allowlist: only same-origin pathnames beginning with `/` are accepted; anything else falls back to `/dashboard`. |
| S-10 | Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`. |
| S-11 | Enumeration via timing on signup | Constant response shape and path for new vs existing emails; no timing branch. |
| S-12 | Log leakage | `redact()` applied centrally in `logger.ts`; a test asserts a sample log containing a fake key renders as `***`. |
| S-13 | Dependency supply chain | `pnpm audit` in CI (high+critical block), lockfile committed, `gitleaks` pre-commit, GitHub Dependabot on. |
| S-14 | Admin panel scraping | Admin routes are role-gated in the server layout **and** every admin Server Action re-checks `is_admin()` server-side; rate-limited; all mutations audited. |

---

## 7. Pre-Launch Security Checklist

- [ ] RLS enabled on **every** table; `supabase test` runs a policy test per table (green).
- [ ] CI grep confirms no secret material in the built client bundle.
- [ ] `gitleaks` clean across full git history.
- [ ] Service-role client imported only from `lib/queue/**`, `api/cron/**`, `api/webhooks/**`.
- [ ] All `/api/cron/*` routes reject requests without a valid `CRON_SECRET` (constant-time compare).
- [ ] Stripe webhook signature verification tested with a real signed fixture.
- [ ] Magic-link + OAuth flows tested end-to-end (including expired and reused links).
- [ ] Rate limits active on auth, write actions, and ingestion triggers.
- [ ] CSP, HSTS, and frame headers verified in a live response.
- [ ] Error pages verified: 404 for not-yours, 500 with `requestId` and no stack trace.
- [ ] Account export produces valid JSON; account delete cascades and leaves no orphan Storage objects.
- [ ] Privacy policy + terms published, covering scraping sources and résumé storage.
- [ ] Dependency audit: no high/critical CVEs.
- [ ] Third-party data-processing terms reviewed (Firecrawl, OpenRouter, Resend, Stripe, PostHog, Supabase).
      Note: OpenRouter free-tier models may retain requests for training — re-check before any
      job-description or profile text is sent, and prefer a no-retention provider preference.

---

*The specific error copy and inline states referenced in §5 are specified as components in [04 Frontend Specification](./04-frontend-specification.md). Tickets covering every rule here are tagged `[SEC]` in [05 Feature Tickets](./05-feature-ticket-list.md).*
