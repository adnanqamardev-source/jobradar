# 03 â€” Security & Access Document

**Last reviewed:** 2026-10-04


**Product:** JobRadar Â· **Version:** 1.0 â€” MVP
**Depends on:** [02 Technical Architecture](./02-technical-architecture.md) Â· **Feeds:** [04 Frontend Specification](./04-frontend-specification.md)
**Last updated:** 2026-10-03

> Written so a non-technical founder can follow it. Every rule here is enforced in code or in the database â€” nothing is "by convention only." Where a rule maps to a table from Â§5 of the architecture doc, the table is named.

---

## 1. Plain-English Security Model

**Last reviewed:** 2026-10-04


Three ideas carry the whole document:

1. **You only ever see your own stuff.** A user's profile, scores, saved jobs and applications are locked to their own account by database rules (Row-Level Security), not by checking `userId` in application code. Even if a developer writes a buggy query, the database refuses to hand over someone else's rows.
2. **The keys have different powers.** There's a public key (weak, used in the browser, can only do what RLS allows) and a private key (all-powerful, used only by server-side workers). The all-powerful key never appears in anything the browser downloads.
3. **Everything that can fail, has a defined message.** No screen ever shows a raw stack trace, an empty white page, or a spinner that never ends.

---

## 2. Authentication Method

**Last reviewed:** 2026-10-04


### 2.1 What we use

**Last reviewed:** 2026-10-04


| Method | How it works | Where | Priority |
|---|---|---|---|
| **Email magic link (primary)** | User enters email â†’ we send a one-time link â†’ clicking it signs them in. No password exists to steal, forget, or reuse. | `/login` â†’ `POST /auth/v1/otp` | **M** |
| **Google OAuth (primary)** | One click, consent screen, session created. | `/login` â†’ Supabase `signInWithOAuth('google')` | **M** |
| **Email OTP code (fallback)** | 6-digit code, 10-minute expiry, 5 attempts max. For users whose mail client breaks link handling. | `/login` â†’ `POST /auth/v1/verify` | **S** |
| Password | **Not offered.** | â€” | deliberately omitted |

**Why magic link + OAuth, not passwords:** passwords generate the entire class of credential-stuffing, reuse and phishing risk, and for a job-search tool nobody wants to manage another password. OAuth adds a familiar one-click path for the 60%+ who have a Google account. OTP is kept as a fallback because magic links fail silently in some corporate mail clients â€” a real onboarding-abandonment cause.

**Google OAuth is not enabled by writing code.** `POST /api/auth/google` only asks Supabase to
start a flow; the provider itself must be configured on the project. Two halves, and *both* are
required before the button does anything:

| Half | Where | Who can do it |
|---|---|---|
| OAuth client (id + secret) | Google Cloud Console → APIs & Services → Credentials | **the project owner** — needs a Google account and the consent screen |
| Provider enabled + redirect URI allowlist | Supabase → Auth → Providers / URL Configuration, or `supabase config push` | needs `supabase login` first (interactive, owner's browser) |

**Three traps, all hit on 2026-10-05:**

1. The button 404ing on the deployed site meant the route had never been pushed — check
   `git status -sb` for `[ahead N]` before touching provider settings.
2. `env(...)` in `supabase/config.toml` matches the **whole value only** — the CLI's hook is
   `^env\((.*)\)$` (`supabase/cli` `pkg/config/decode_hooks.go`). A composed value such as
   `env(NEXT_PUBLIC_APP_URL)/auth/callback` is *never* interpolated and is sent to Google as that
   literal string, so a composed redirect must be its own single env var
   (`SUPABASE_AUTH_EXTERNAL_GOOGLE_REDIRECT_URI`).
3. Google is one of only two OAuth providers whose config schema accepts an empty `secret`, but
   `client_id` is still mandatory. Enabling the provider with a blank client id produces a consent
   screen that fails with an opaque Google-side error, not a Supabase one.

### 2.2 Session rules

**Last reviewed:** 2026-10-04


| Rule | Value | Reasoning |
|---|---|---|
| Access token lifetime | **1 hour** | Short enough that a leaked token has a small window. |
| Refresh token lifetime | **30 days**, sliding | Long enough that a returning user isn't logged out weekly; short enough to bound risk. |
| Cookie | `httpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix | Not readable by JS (blocks XSS token theft); `Lax` still allows navigation links from the digest email. |
| Refresh rotation | Enabled | A stolen refresh token is invalidated once it's used. |
| Logout | Server-side sign-out **and** cookie clear | Local-only logout leaves a usable token. Implemented at `POST /api/auth/logout` (2026-10-06). |
| Session invalidation on privilege change | On `role` or `plan` downgrade | A demoted admin must not keep admin access for up to 24h. |
| Concurrent sessions | Allowed, no cap | Not worth the support burden at MVP. |

### 2.3 Auth flow specifics

**Last reviewed:** 2026-10-04


- **Magic link:** 1-hour expiry, single use, bound to the exact email entered. Redirects to `/auth/callback`, which exchanges the code for a session then routes: new user â†’ `/onboarding`, returning user â†’ `/dashboard`.
- **State/nonce:** OAuth uses PKCE with a random `state` and `nonce` stored in a short-lived cookie; mismatch â†’ `auth_failed` error page (Â§6.2 E-05).
- **Email verification:** magic link *is* verification. OAuth inherits the provider's verified email. Unverified accounts cannot create applications (prevents throwaway accounts from filling the tracker).
- **Rate limiting:** per IP + per email: **5 sign-in attempts / 15 min**, **3 magic links / 10 min**. On breach â†’ generic `too_many_attempts` with a 15-minute cooldown. Same endpoint always returns the same response regardless of whether the email exists (no account enumeration).
- **Admin bootstrap:** first deploy seeds `ADMIN_EMAILS` â†’ those accounts get `role = 'admin'` via a one-time migration. Admin can never be self-assigned through the app.

**Profile creation on signup (added 2026-10-05, `0005_handle_new_user.sql`).** A trigger on
`auth.users` AFTER INSERT creates the `profiles` row, rather than each auth route doing it in
application code. Three auth methods each remembering to insert is three chances to forget, and a
user without a `profiles` row is not a partial signup — it is a user the scorer, the feed and every
owner-scoped RLS policy treats as nonexistent. Two properties are deliberate:

- **`SECURITY DEFINER` with `set search_path = ''`.** The trigger fires inside the auth service's
  insert, where the caller is not yet an authenticated principal, and `profiles` carries FORCE ROW
  LEVEL SECURITY — so the insert needs the definer's bypass role. The empty search_path is the
  privilege-escalation guard: a mutable one lets any caller able to create a schema shadow `auth`
  or `public` and execute as the definer.
- **`role` is never read from `raw_user_meta_data`.** That field is user-writable through the
  client SDK, so honouring a `role` key there would be admin self-assignment — precisely what the
  bullet above forbids. Verified by probe: a signup carrying `{"role":"admin"}` produces a
  `role = 'user'` row. Admin comes only from the one-time bootstrap or an operator update.

---

## 3. User Roles & Permissions

**Last reviewed:** 2026-10-04


### 3.1 Role definitions

**Last reviewed:** 2026-10-04


| Role | Who | How assigned |
|---|---|---|
| **`guest`** | Not signed in. Can view landing, pricing, and the public demo feed. | â€” |
| **`user` â†’ `free`** | Default. Full discovery loop within free quotas. | Signup |
| **`user` â†’ `pro`** | Paid. Higher quotas + LLM rationale + faster digests. | Stripe webhook only â€” **never** a client-writable field |
| **`admin`** | Platform operator. Sees ops data, not user content by default. | `ADMIN_EMAILS` allowlist, one-time migration |
| **`service`** | Server-side workers using the service-role key. No UI. | Key custody only |

### 3.2 Permission matrix

**Last reviewed:** 2026-10-04


**Legend:** âœ… allowed Â· â›” blocked Â· ðŸ”’ allowed but scoped to own records Â· âš ï¸ allowed with limits

| Capability | guest | free | pro | admin |
|---|---|---|---|---|
| View marketing / pricing / demo feed | âœ… | âœ… | âœ… | âœ… |
| Sign up / sign in | âœ… | â€” | â€” | âœ… |
| Complete onboarding, edit **own** profile | â›” | ðŸ”’ | ðŸ”’ | ðŸ”’ |
| View ranked feed of **own** scores | â›” | ðŸ”’ âš ï¸ | ðŸ”’ | ðŸ”’ |
| View the shared `jobs` corpus rows | â›” | ðŸ”’ | ðŸ”’ | ðŸ”’ |
| Create/save/dismiss **own** job actions | â›” | ðŸ”’ âš ï¸ | ðŸ”’ | ðŸ”’ |
| Create **own** applications | â›” | ðŸ”’ âš ï¸ | ðŸ”’ | ðŸ”’ |
| Saved searches | â›” | âš ï¸ max **3** | âš ï¸ max **25** | ðŸ”’ |
| Sources watched (defaults) | â›” | âš ï¸ max **5** | âš ï¸ max **30** | ðŸ”’ |
| Jobs scored per month | â›” | âš ï¸ **500** | âš ï¸ **10,000** | ðŸ”’ |
| LLM fit rationale | â›” | â›” | âœ… | âœ… |
| Digest frequency | â€” | daily | daily + **high-match alert** | â€” |
| Force "run now" on a source | â›” | âš ï¸ **3/day** | âš ï¸ **30/day** | âœ… |
| View `/admin` (source health, runs, queue) | â›” | â›” | â›” | âœ… |
| Retry / pause a source, retry a task | â›” | â›” | â›” | âœ… |
| Look up a user by email | â›” | â›” | â›” | âœ… âš ï¸ |
| **Read another user's profile, rÃ©sumÃ©, or applications** | â›” | â›” | â›” | â›” **blocked by RLS** |
| Edit another user's data | â›” | â›” | â›” | â›” |
| Change own `role` or `plan` | â›” | â›” | â›” | â›” (plan moves only via Stripe) |
| Disable a source globally | â›” | â›” | â›” | âœ… |
| Export / delete own account | â›” | ðŸ”’ | ðŸ”’ | ðŸ”’ own only |

**âš ï¸ limits** are enforced in two places: the Server Action checks `usage_events` against `PLAN_LIMITS` before acting, **and** a DB `CHECK`/trigger guards the same ceiling for the rows that can't drift (e.g. `saved_searches` count). Double enforcement because quota checks in app code alone are bypassable by a direct SQL mistake.

**Admin lookup caveat:** an admin can find an account by email for support purposes, but retrieving profile *content* requires an explicit, audited `audit_logs` entry (`action = 'admin.viewed_profile'`, with `target_id`). This is the "no casual access to user data" rule â€” support requests should be answerable from ops metrics, not from reading someone's applications.

---

## 4. Row-Level Security (RLS)

**Last reviewed:** 2026-10-04


RLS is **enabled on every table** in the schema. Default posture: **deny all**, then add named policies. The service-role key bypasses RLS â€” which is precisely why it never reaches the browser (Â§4.4).

### 4.1 The helper functions

**Last reviewed:** 2026-10-04


```sql
-- true when the JWT's sub == this row's user_id
create function auth.uid() returns uuid;          -- Supabase built-in

-- true when the JWT's app_metadata.role = 'admin'
-- Fixed 2026-10-03: the inner call is wrapped in (select ...). Do not unwrap it.
-- Fixed 2026-10-05 (D15): the claim lives under app_metadata — sync_profile_role_to_jwt()
-- writes it via auth.update_user(), which merges into raw_app_meta_data. The top-level
-- JWT `role` claim is the Postgres role ('authenticated'), never 'admin', so the old
-- body could never return true.
create function is_admin() returns boolean
  language sql stable as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', 'user') = 'admin'
$$;
```

**Why the `(select â€¦)` wrapper is not optional.** Postgres normally re-runs a function once per
row it checks. Wrapping the call in `select` tells Postgres to run it **once per query** and
reuse the answer. Without the wrapper, every row scanned re-reads and re-parses the JWT. On a
feed with thousands of rows that is the difference between a fast page and a timeout.

**This applies everywhere, not just here.** Every `auth.uid()` and `auth.jwt()` in a policy in
Â§4.2 must be written as `(select auth.uid())` for the same reason.

### 4.1a Force RLS â€” do not skip this

**Last reviewed:** 2026-10-04


**Added 2026-10-03.** Â§4.2 turns RLS *on* for every table. That is not sufficient on its own.

In Postgres, the **owner of a table is exempt** from its own row-level security. So if a table
and its policies are created by the same role that later queries it, that role sees every row
regardless of the policies. The policies look correct in `pg_policies` and do nothing.

The fix is one extra line per table:

```sql
alter table jobs enable row level security;    -- turn the policies on
alter table jobs force  row level security;     -- make them bind the owner too
```

`service_role` is unaffected, because it has its own bypass role. Every table in Â§4.2 gets both
lines.

### 4.2 Policy table

**Last reviewed:** 2026-10-04


**Legend:** `S` = SELECT Â· `I` = INSERT Â· `U` = UPDATE Â· `D` = DELETE

**Every table below gets both `enable row level security` and `force row level security`** â€”
see Â§4.1a for why the second one is not optional. Every `auth.uid()` / `auth.jwt()` in the
Rule column is written as `(select auth.uid())` â€” see Â§4.1.

| Table | Who | S | I | U | D | Rule (written out) |
|---|---|---|---|---|---|---|
| `profiles` | owner | âœ… | âœ… | âœ… | â›” | `auth.uid() = id`. Self-delete goes through the account-deletion flow, which uses the service key + cascade, never a direct row delete. |
| `profiles` | admin | âœ… | â›” | â›” | â›” | `is_admin()` â€” lookup only, and only non-sensitive columns via a restricted view. |
| `profile_skills` | owner | âœ… | âœ… | âœ… | âœ… | `exists(select 1 from profiles where id = profile_id and auth.uid() = id)` |
| `resume_versions` | owner | âœ… | âœ… | âœ… | âœ… | same ownership predicate; `storage_path` never returned as a public URL |
| `resumes` | owner | ✅ | ✅ | ✅ | ✅ | `auth.uid() = user_id` — **BE-314, added 2026-10-04.** `storage.objects` policies are scoped by `(storage.foldername(name))[1] = auth.uid()::text`. An uploaded résumé is the most sensitive user data in the system — see §4.2a. |
| `saved_searches` | owner | âœ… | âœ… | âœ… | âœ… | ownership predicate + insert-time quota check |
| `job_scores` | owner | âœ… | â›” | â›” | â›” | `auth.uid() = user_id`. **Write path is service-role only** (queue scorer) â€” users can't forge their own scores. |
| `applications` | owner | âœ… | âœ… | âœ… | âœ… | `auth.uid() = user_id`. `job_snapshot` is client-supplied-on-apply but validated by Zod. |
| `application_events` | owner | âœ… | âœ… | â›” | â›” | ownership via join to `applications`; history is append-only (an editable timeline is a lying timeline). |
| `jobs` | authenticated | âœ… | â›” | â›” | â›” | `auth.role() = 'authenticated'` â€” corpus is shared, **read-only**. All writes via service key. |
| `jobs` | service | full | | | | bypass â€” ingest pipeline only |
| `job_skills` | authenticated | âœ… | â›” | â›” | â›” | read-only, same as `jobs` |
| `skills` | authenticated | âœ… | â›” | â›” | â›” | seeded vocabulary, read-only |
| `companies` | authenticated | âœ… | â›” | â›” | â›” | read-only |
| `sources` | authenticated | âœ… | â›” | â›” | â›” | users may *view* what's watched |
| `sources` | admin | âœ… | âœ… | âœ… | â›” | `is_admin()` â€” add/configure/pause, never delete (history depends on it) |
| `scrape_runs` | authenticated | â›” | â›” | â›” | â›” | **no client access at all** |
| `scrape_runs` | admin | âœ… | â›” | â›” | â›” | ops visibility |
| `subscriptions` | owner | âœ… | â›” | â›” | â›” | `auth.uid() = user_id`. All writes from Stripe webhooks (service key). Client cannot grant itself `pro`. |
| `usage_events` | owner | âœ… | â›” | â›” | â›” | read-only for a "your usage this month" widget |
| `usage_events` | service | full | | | | counters written by Server Actions |
| `task_queue` | â€” | â›” | â›” | â›” | â›” | **service-role only**, no client policies defined |
| `audit_logs` | owner | â›” | â›” | â›” | â›” | no client access |
| `audit_logs` | admin | âœ… | â›” | â›” | â›” | append-only, service key writes |
| `digests` | owner | âœ… | â›” | â›” | â›” | user can see "we skipped yesterday, nothing new" |
| `job_events` | owner | âœ… | âœ… | â›” | â›” | implicit feedback rows |

### 4.2a Uploaded résumé files — why this table gets extra scrutiny

**Added 2026-10-04 (BE-314).** A résumé is the most sensitive thing a user will ever hand us:
full name, home address, phone, employment history, and often a photo and signature. It also
arrives as a file the user chose, so it is attacker-controlled input by definition.

| Rule | Why |
|---|---|
| **Private bucket only** | No public URL, ever. Access is a short-lived signed URL (1h) minted per request, after RLS has confirmed ownership. |
| **Path is user-scoped** | Files live at `{user_id}/{resume_id}.{ext}`, so a storage policy can authorise on the first path segment. A flat namespace cannot be authorised that way. |
| **`force row level security`** | Without it, the table owner bypasses the policies. §4.1a explains why that matters even though only the server writes here. |
| **Never fall back to the service key** | The service role bypasses RLS. A user-scoped action that "temporarily" uses it makes every policy above inert while still returning rows — the failure is invisible. `src/lib/db/user-client.ts` therefore *throws* rather than degrade, and `tests/unit/auth-guard.test.ts` pins that refusal. |
| **Type and size validated server-side** | PDF/DOCX only, ≤ 10 MB. The extension and the MIME type are both attacker-supplied, so neither is trusted alone. |
| **Delete cascades** | The `user_id` FK is `on delete cascade`, so account deletion removes the row; the storage objects are swept by the account-deletion worker (BE-313). |
| **No résumé content in logs** | `logger` redacts credentials, and résumé text is not a field any log call passes. `audit_logs.meta` is explicitly "no secrets, no résumé content" (§5.8). |

**What is deliberately not built yet.** Account export and deletion are the paths that must
sweep storage objects; until BE-313 lands, deleting the `resumes` row leaves the file in the
bucket. Recorded here rather than left implicit: an orphaned private file is low-risk (it is
unreachable without a signed URL) but it is still user data we were asked to remove.

### 4.3 Worked example â€” why this holds

**Last reviewed:** 2026-10-04


A malicious free user opens the browser console:

```js
supabase.from('job_scores').select('*')     // â†’ only their own rows
supabase.from('profiles').select('*')       // â†’ only their own row
supabase.from('task_queue').select('*')     // â†’ error: RLS disabled for role
supabase.from('job_scores').insert({...})   // â†’ 0 rows affected: no INSERT policy
```

To escalate, they'd need `SUPABASE_SERVICE_ROLE_KEY`, which is never sent to the client (Â§4.4) â€” it lives only in Vercel server-side env vars, referenced exclusively from `src/lib/db/admin.ts`, whose import is blocked everywhere except `lib/queue/**`, `api/cron/**`, `api/webhooks/**` by an ESLint `no-restricted-imports` rule.

Three independent gates enforce this, and each catches a different failure:

| Gate | Catches | Cannot catch |
|---|---|---|
| ESLint `no-restricted-imports` | A *source* file importing `lib/db/admin.ts` from a client-reachable path | A secret inlined into a string, or reaching the bundle by another route |
| CI `secret-scan` (`scripts/scan-bundle-secrets.mjs`) | A credential **value** in the built output â€” `.next/static/` for all key shapes, `.next/server/` for service-role only | Anything not in the build output |
| `tests/e2e/smoke.spec.ts` bundle-leak check | A service-role key served to a real browser over HTTP | Anything not fetched by a page load |

**Why the CI scan matches values, not names â€” corrected 2026-10-04.** The original spec here
called for grepping `(supabase|sk-|whsec_|rk_live)`. That predicate is broken in both
directions, and it was committed that way: `supabase` is the *library name*, present in every
page chunk, so the gate failed on every build; `sk-` matches `skipped`, `task-`, and any
minified identifier ending in those two characters. Meanwhile it greps for *names*, so a real
leak â€” `sb_secret_<the actual key>` â€” is no better matched than noise. A gate that always fails
teaches the team to ignore it, which is worse than no gate.

`scripts/scan-bundle-secrets.ts` replaces it with credential **shapes** (each requiring 20+
characters of key material after the prefix â€” a bare prefix is not a credential) plus
exact-value matching against the live values of 8 secret env vars, which catches *this*
deployment's key even if its shape is unfamiliar.

**Scan boundary â€” corrected again 2026-10-04, after the same mistake recurred.** The scan is
three-tier, and the tier is the whole point:

| Tier | Credential values | Bare names (`SUPABASE_SERVICE_ROLE_KEY`) |
|---|---|---|
| `.next/static/` â€” client bundle | yes | **yes** |
| `.next/server/` â€” server output | service-role shapes only | **no** |

Bare-name matching belongs in the client bundle *only*. Reading that variable client-side means
the `lib/db/admin.ts` import boundary is already gone, so the name is itself the violation. It
does **not** transfer to server output: the server bundle is *supposed* to contain the env
contract, and that contract names every variable by definition. Checking names there produced a
false positive the moment `auth/callback/route.ts` imported `@/lib/env` â€” the Zod schema bundles
into server output, so a route reading only `NEXT_PUBLIC_SUPABASE_ANON_KEY` (a public value)
failed the gate on the *name* of a variable it never touches.

A bare identifier is not a secret. Match values everywhere; match names only where a name is
itself the violation. All four quadrants are asserted: `sb_secret_` value in server output â†’
fail; name in client bundle â†’ fail; name in server output â†’ pass; clean build â†’ pass.

Exit codes: `0` clean, `1` findings printed, `2` build output missing (i.e. `pnpm build` was
skipped â€” not a pass).

### 4.4 Secrets & key custody

**Last reviewed:** 2026-10-04


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

**Rules:** never in git (a pre-commit hook runs `gitleaks`); never in client bundles (CI grep, above); never in logs (`redact()` strips `*_KEY`, `*_SECRET`, `authorization`, `cookie`); never in `jobs.raw` or `audit_logs.meta` (schema forbids it â€” the redaction runs before insert).

### 4.5 Transport & headers

**Last reviewed:** 2026-10-04


- HTTPS enforced (HSTS `max-age=31536000; includeSubDomains`), HTTP â†’ HTTPS redirect at the edge.
- CSP: `default-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`; script-src restricted to `'self'` + Supabase + PostHog + Stripe.js (nonce-based for the few inline scripts).
- `X-Content-Type-Options: nosniff` Â· `Referrer-Policy: strict-origin-when-cross-origin` Â· `Permissions-Policy: camera=(), microphone=(), geolocation=()` Â· `X-Frame-Options: DENY`.
- Static assets `immutable, max-age=31536000`; HTML `no-store` for the authenticated app.

---

## 5. Error Handling Guide

**Last reviewed:** 2026-10-04


Principles: **say what happened, say what to do, never leak internals.** Every failure maps to a stable code in `src/lib/errors/`, and the copy lives in one map so wording stays consistent across screens. Toasts for recoverable action failures; inline messages for field-level validation; full pages for auth/session/404/500.

### 5.1 Error codes

**Last reviewed:** 2026-10-04


| Code | Trigger | User sees | System does |
|---|---|---|---|
| `validation_failed` | Zod rejects input | Inline under the field: *"Add at least one target role to continue."* | 422, nothing written |
| `unauthenticated` | No/expired session | Redirect to `/login?next=â€¦` with *"Your session expired. Sign in to pick up where you left off."* | 401 |
| `forbidden` | Role/plan blocks the action | *"That's a Pro feature."* + inline What-you-get list | 403, `audit_logs` if admin route |
| `not_found` | Row missing or not yours | **Identical page for "doesn't exist" and "not yours"** â€” *"We couldn't find that job."* + link back | 404 (no existence leak) |
| `rate_limited` | Action ceiling hit | *"You're moving fast â€” try again in 60 seconds."* | 429 + `Retry-After` |
| `quota_exceeded` | Plan limit reached | Inline, non-modal (PRD Flow 6): *"You've used all 3 free saved searches. Pro gives you 25."* | 402-style code, `paywall_viewed` event |
| `upstream_timeout` | Firecrawl/OpenRouter/source > timeout | Toast: *"That source is slow right now â€” we'll retry it in the background."* | task retried, `last_error` set |
| `upstream_error` | Source returned 5xx/4xx | Same as above (never a raw response body) | retry Ã—3 with backoff |
| `scrape_parse_failed` | Connector output fails Zod | No user-facing error; admin run row shows it | run `partial`, row quarantined, `confidence` low |
| `email_delivery_failed` | Resend rejects | None (silent to user) | `digests.status='failed'`, retry once, admin tile |
| `payment_failed` | Stripe card declined | *"Payment didn't go through â€” your card was declined. Update it to stay on Pro."* + portal link | Entitlements unchanged; `past_due` handling |
| `webhook_invalid` | Stripe signature mismatch | â€” | 400, logged, alerted |
| `service_unavailable` | DB unreachable / 5xx burst | Full-page: *"Something's on our end. We're looking into it."* + `requestId` | 503, Sentry alert |
| `internal_error` | Unhandled exception | Full-page: *"Something went wrong. Try again."* + `requestId` (never a stack trace) | 500, Sentry capture with `requestId` |
| `file_too_large` / `file_type_invalid` | RÃ©sumÃ© upload | Under the field: *"PDFs under 5 MB."* | Rejected before upload |
| `account_locked` | Repeated auth failures | Generic: *"Too many attempts. Wait 15 minutes and try again."* | Cooldown, no account-existence hint |

### 5.2 Failure-point playbook

**Last reviewed:** 2026-10-04


| Failure point | Response |
|---|---|
| **API doesn't respond** | Connector timeout at 30s â†’ task retries 3Ã— at 30s/2m/8m â†’ then `failed`. Feed keeps serving the last good corpus; **the app never blocks on a source**. Admin sees the source flagged amber at 3 failures, paused at 5. |
| **Wrong password** | N/A â€” no passwords. Wrong OTP/code â†’ *"That code didn't match. Try again."* (5 attempts, then `account_locked`). |
| **Magic link expired / reused** | *"This link has expired. Request a new one."* + one-click resend. Not an error page â€” a normal login state. |
| **Payment fails** | Entitlements **unchanged** (never downgrade on a failed charge). `past_due` â†’ banner with update-card link. Grace 7 days â†’ `canceled` â†’ `plan='free'`. One dunning email at day 1, 3, 7. |
| **Payment succeeds but webhook lost** | Stripe retries webhooks for 3 days; a reconciliation job on `/api/cron` compares active subscriptions to local rows hourly and self-heals. |
| **RÃ©sumÃ© upload fails mid-way** | Client-side size/type check first; on network failure â†’ *"Upload didn't finish. Try again."* Partial objects are cleaned by a nightly `cleanup` task. |
| **Queue backlog / worker dies** | Leases expire after 5 min â†’ task returns to `pending` â†’ another worker picks it up. Idempotent handlers mean a duplicate run is harmless. |
| **User submits empty form** | Required fields disabled-submit until valid (client) **and** Zod rejects server-side (defense in depth). Message: *"This field is required."* |
| **Offline / slow connection** | Server Actions are retry-safe. On network error â†’ toast *"Couldn't save â€” check your connection and try again."* Inputs keep their values; never clear a form on failure. Feed shows cached RSC payload immediately, then refreshes. |
| **Concurrent edits (two tabs)** | `updated_at` optimistic-concurrency check â†’ *"This changed in another tab. Reload to see the latest."* **Implemented 2026-10-06** for the `profiles` write path: `lib/db/profile-update.ts` scopes the UPDATE by the `updated_at` the caller last read and returns `edit_conflict` (409, new code in `lib/errors/codes.ts`) on a 0-row match. Detection only — no merge; the user is told to reload. Opt-in: a caller that omits `expectedUpdatedAt` keeps unguarded behaviour, so the onboarding wizard is unaffected and `/settings` is the caller that must send it. |
| **Deleted job while an application references it** | `job_snapshot` on `applications` keeps title/company/salary; detail shows *"The original posting is no longer available."* with the tracker record intact. |

### 5.3 Presentation rules

**Last reviewed:** 2026-10-04


- **Never** render `error.message`, stack traces, SQL, or upstream response bodies to a user â€” only stable codes mapped to curated copy.
- Every 5xx page shows a copyable **`requestId`** that matches the Sentry event and the structured log line.
- Loading states are **real**: skeletons that match the final layout (no spinner-only pages), and the onboarding interstitial reflects actual progress counters (PRD Flow 1 step 8).
- Optimistic UI is allowed for save/dismiss/stage-move with rollback on failure â€” but never for anything billing-related.

---

## 6. Edge Cases

**Last reviewed:** 2026-10-04


### 6.1 Product edge cases

**Last reviewed:** 2026-10-04


| # | Edge case | Handling |

**Last reviewed:** 2026-10-04

|---|---|---|
| X-01 | Empty form submitted | Client: submit disabled until schema-valid. Server: Zod â†’ `validation_failed` with per-field messages. Never a silent no-op. |
| X-02 | User navigates to a page they can't access (e.g. `/admin` as free user) | `requireAdmin()` in the layout â†’ redirect to `/dashboard` with a neutral *"You don't have access to that page."* Not a 403 wall, not a crash. |
| X-03 | User edits the URL to another user's `jobId`/`applicationId` | RLS returns zero rows â†’ **same** `not_found` page as a genuinely missing ID. No information leak. |
| X-04 | Slow connection on the feed | RSC shell paints first with skeletons; LCP target < 2.0s. Long actions show inline progress, not a frozen button. |
| X-05 | Double-click "Mark applied" | Server Action is idempotent on `(user_id, job_id)` unique constraint â†’ one application, second click returns the existing one. |
| X-06 | Onboarding abandoned at step 2 of 4 | `onboarding_step` persisted per step; next login resumes there with a progress banner. Profile not marked complete â†’ feed shows the completion card, not an empty state. |
| X-07 | Email already registered (magic link) | **No enumeration**: always *"Check your inbox for your sign-in link."* Whether it's new or existing is only revealed after auth. |
| X-08 | Profile with zero skills / zero titles | Scoring skips (no fake score of 0). Feed shows an inline *"Add skills to start scoring jobs"* card linking to step 2. Never silently rank against nothing. |
| X-09 | Job with no disclosed salary | `salary_min/max` NULL â†’ compensation sub-score returns **neutral** (not 0), and the card shows *"Salary not disclosed"* with a confidence flag. Penalising silence would bury good jobs. |
| X-10 | Job posted 3 weeks ago still circulating | Freshness sub-score decays; status â†’ `stale` at 14 days unseen, `expired` at 28 â†’ demoted out of the default feed and shown under a "Older" filter. |
| X-11 | Same job from 4 sources | One card, `sighting_count = 4`, *"Seen on 4 sources"* chip; D5 dismisses the whole cluster. |
| X-12 | User blocks a company they'd already applied to | Existing application stays (history is never rewritten); only future feed results are gated. |
| X-13 | Free user hits a limit mid-scroll | Inline limit card in the feed position, not a modal. Shows current/limit as a meter + what Pro adds. |
| X-14 | Digest would contain zero jobs | `digests.status='skipped'`, **no email sent**. Silence over filler. |
| X-15 | User sets a follow-up date in the past | Allowed (they may be catching up) but immediately appears in *Needs attention*. |
| X-16 | RÃ©sumÃ© deleted while attached to an application | FK `on delete set null` â†’ application shows *"RÃ©sumÃ© removed"*, record and stage history intact. |
| X-17 | Timezone ambiguity for digest send time | Profile stores IANA `time_zone`; digest computed in that zone, with DST handled by Postgres `AT TIME ZONE`. UI always shows the resolved local time: *"Every day at 8:00 AM (Asia/Kolkata)"*. |
| X-18 | User signs up, never finishes onboarding, comes back 3 weeks later | Magic link still valid; session restored; resume onboarding. No "account stale" dead-end. |
| X-19 | Source stops returning data entirely | Circuit breaker at 5 consecutive failures pauses the source, admin tile turns red with a Retry action. Corpus stays intact â€” users never see an empty feed because one source died. |
| X-20 | Cron fires while a previous run is still going | Task claiming uses `FOR UPDATE SKIP LOCKED`; a task already `running` is not re-claimed. Leases expire, so nothing gets permanently stuck. |
| X-21 | User deletes their account | Cascade removes `profiles`, skills, scores, applications, events, digests, usage, subscriptions, and Storage objects. The shared `jobs` corpus is retained. Confirm dialog spells out exactly what's removed. |
| X-22 | Admin is demoted while logged in | `role` change triggers session refresh; `/admin` layout re-checks on every render â†’ immediate bounce to `/dashboard`. |
| X-23 | Accessibility: score conveyed by colour only | Every score shows a **numeric value + text label** alongside the coloured meter; `aria-label` reads *"Match score 78 out of 100, strong match"*. Colour is never the sole signal. |
| X-24 | Very long job description | Detail view caps the inline height with `Read more`; description text is sanitised HTML (XSS), never `dangerouslySetInnerHTML` on unsanitised input. |
| X-25 | Browser tab left open overnight | Refresh token rotation handles renewal; on failure â†’ clean redirect to `/login` with return path preserved. |

### 6.2 Security edge cases

**Last reviewed:** 2026-10-04


| # | Edge case | Handling |

**Last reviewed:** 2026-10-04

|---|---|---|
| S-01 | SQL injection in the search box | Parameterised SQL only (Supabase PostgREST + bound queries). `query` goes through `to_tsquery` with user input escaped via `websearch_to_tsquery`. No string-concatenated SQL anywhere â€” enforced by lint + code review. |
| S-02 | XSS in a job description | `description_html` sanitised on ingest (allowlist of `p, ul, li, strong, em, a, br, h3, h4`); rendered as text nodes. CSP blocks inline script. |
| S-03 | Forged `role` claim in a JWT | JWT is signed by Supabase; claims are not client-forgeable. `is_admin()` reads the server-issued claim, never a client-supplied field. |
| S-04 | Client calls `profiles.update({ plan: 'pro' })` | `plan` column has `REVOKE UPDATE` from authenticated + a trigger that rejects changes not originating from the Stripe webhook path (service role). Belt and braces. |
| S-05 | SSRF via a user-supplied scrape URL | Firecrawl only accepts URLs from `sources.config`, which admins authorise; the connector validates scheme (`https` only), rejects private IP ranges/localhost, and caps redirects. Free users can't add arbitrary URLs at all. |
| S-06 | Oversized file / zip bomb upload | 5 MB limit, `application/pdf` magic-byte check, storage policy restricts bucket + path, virus scan hook before `resume_versions` row is created. |
| S-07 | Rate limiting on write actions | `lib/ratelimit.ts` â€” sliding window per user+action (e.g. 30 saves/5 min, 60 stage moves/5 min). Exceeded â†’ `rate_limited`, never a silent drop. |
| S-08 | Stripe webhook replay | Signature verified with timestamp tolerance; `event.id` uniqueness enforced so replays are no-ops. |
| S-09 | Open redirect on `?next=` | Allowlist: only same-origin pathnames beginning with `/` are accepted; anything else falls back to `/dashboard`. |
| S-10 | Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`. |
| S-11 | Enumeration via timing on signup | Constant response shape and path for new vs existing emails; no timing branch. |
| S-12 | Log leakage | `redact()` applied centrally in `logger.ts`; a test asserts a sample log containing a fake key renders as `***`. |
| S-13 | Dependency supply chain | `pnpm audit` in CI (high+critical block), lockfile committed, `gitleaks` pre-commit, GitHub Dependabot on. |
| S-14 | Admin panel scraping | Admin routes are role-gated in the server layout **and** every admin Server Action re-checks `is_admin()` server-side; rate-limited; all mutations audited. |

---

## 7. Pre-Launch Security Checklist

**Last reviewed:** 2026-10-04


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
- [ ] Privacy policy + terms published, covering scraping sources and rÃ©sumÃ© storage.
- [ ] Dependency audit: no high/critical CVEs.
- [ ] Third-party data-processing terms reviewed (Firecrawl, OpenRouter, Resend, Stripe, PostHog, Supabase).
      Note: OpenRouter free-tier models may retain requests for training â€” re-check before any
      job-description or profile text is sent, and prefer a no-retention provider preference.

---

*The specific error copy and inline states referenced in Â§5 are specified as components in [04 Frontend Specification](./04-frontend-specification.md). Tickets covering every rule here are tagged `[SEC]` in [05 Feature Tickets](./05-feature-ticket-list.md).*

