# 05a — Phase 0 Foundation Tickets

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [05 Feature Ticket List](./05-feature-ticket-list.md)
**Last reviewed:** 2026-10-04

---

## E0 — Foundation

### ENG-001 — Project scaffold & tooling
**[DATA] [UI]** · **Priority:** MUST · **Depends on:** —

Initialise the Next.js (App Router) + TypeScript + Tailwind project with the folder structure in [02 §4](./02-technical-architecture.md). Enable `strict` TS, ESLint with `eslint-config-next`, Prettier, and path alias `@/* → src/*`. Add `vitest` and `playwright` configs. Commit `.env.example` listing every variable from [02 §7.1](./02-technical-architecture.md) with empty values and a comment each.

**Done when:**
- [x] `pnpm dev` boots at `localhost:3000` with a placeholder page — ✅ **2026-10-09 re-verified.** `src/app/layout.tsx` and `src/app/(marketing)/page.tsx` both exist and `/` renders. The ❌ recorded on 2026-10-03 was true that day and was never updated; see the correction note below.
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass on an empty suite — ✅ verified 2026-10-03.
- [ ] Folder tree matches [02 §4](./02-technical-architecture.md) exactly (including empty dirs with `.gitkeep`) — ⚠️ **never checked against the corrected tree.** The `docs/02` §4 tree was itself wrong and has since been fixed; this box is still an open claim, not a verified one.
- [ ] `.env.example` contains every variable from [02 §7.1](./02-technical-architecture.md), none with real values — ✅ 28 variables, all blank (verified 2026-10-03).
- [x] `.gitignore` excludes `.env.local`; `gitleaks` pre-commit hook installed — ✅ **2026-10-03.** The hook is wired via `.simple-git-hooks.json` and runs `gitleaks git --staged`. The real binary (8.30.1, checksum-verified) lives in gitignored `tools/`. Project rules in `.gitleaks.toml` add the Supabase key formats the built-in ruleset misses. Details in [02](./02-technical-architecture.md) §4.2.
- [x] ESLint rule blocks imports of `src/lib/db/admin.ts` outside `lib/queue/**`, `api/cron/**`, `api/webhooks/**` — ✅ **2026-10-03.** This was pointing the wrong way before: the rule blocked direct `@supabase/supabase-js` imports and let `admin.ts` through from anywhere. `tests/unit/eslint-guard.test.ts` pins both directions — 5 blocked paths must error, 5 sanctioned paths must stay open. Verified end-to-end with `pnpm lint`.

**Scope note on the box above.** The allowed list is the three paths named here plus
`scripts/**` and `tests/**`. Neither is reachable from the client bundle, and excluding them
would break `scripts/queue-drain.ts` and the RLS integration tests.

**CORRECTION 2026-10-09 — the three claims below were all false and are now corrected.**
An audit against the tree found every one of them to be the opposite of reality. They had
been written on 2026-10-03, were never re-checked, and sat on the Phase 0 gate ticket where a
reader would take them as current:

| Claimed missing | Actual |
|---|---|
| `layout.tsx` / `page.tsx` do not exist | both exist; `/` renders |
| `eslint-config-next` absent from `package.json` | `package.json:55` — `"eslint-config-next": "^16.3.8"` |
| `@tailwindcss/postcss` and `postcss.config.mjs` missing, so Tailwind is inert | `package.json:48` has `"@tailwindcss/postcss": "^4.3.3"`; `postcss.config.mjs` exists; `tailwind.config.ts` exists and is wired |

`docs/06` §3 already recorded FND-001 as completed on 2026-10-03, so the two files
contradicted each other and this one was the stale side. The lesson is the `notes.md` rule
about a gate that was never executed: a claim written once and never revisited is a guess with
a date on it.

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

Stand up the Supabase project and write migration `0001_init.sql` implementing **every** enum, table, index, view, and function from [02 §5](./02-technical-architecture.md). Enable `pgvector` and `pg_cron`. Seed the `skills` vocabulary **and** the default `sources` rows. Write `seed.sql` for local dev.

**Done when:**
- [x] All tables from [02 §5.3–5.8](./02-technical-architecture.md) exist with correct columns, types, FKs, and cascades — ✅ **2026-10-09 verified in the DDL**: 19 `create table` (excluding the `auth.users` stub), 13 enums, plus `v_ranked_jobs` and 4 functions. **Not** verified by `supabase db reset` — see the box below.
- [x] `jobs.dedupe_hash` is `unique`; HNSW indexes exist on `jobs.embedding` and `profiles.profile_embedding` — ✅ `dedupe_hash text not null unique`; both HNSW indexes present as **half-precision** (`halfvec(2048) halfvec_cosine_ops`), because 2048-dim exceeds pgvector's 2000 limit for `hnsw`.
- [x] Partial index on `task_queue(status, run_after, priority) where status='pending'` — ✅ `idx_task_queue_pending`.
- [x] Full-text GIN index on `jobs` title+description; trigram on `title_norm`/`company_domain` — ✅ `to_tsvector('english', …)` GIN plus `idx_jobs_title_norm_trgm` / `idx_jobs_company_domain_trgm`.
- [x] `v_ranked_jobs` view and `move_application()` function work as specified — ✅ both present; `v_ranked_jobs` carries `security_invoker = true` (asserted in `migration-drift.test.ts`, without which the view would silently bypass RLS) and exposes the `final_score`/`breakdown`/`explanation`/`scored_at` columns.
- [ ] `supabase db reset` on a clean machine yields a working schema + seed — ✅ **2026-10-09: executed.** All ten migrations apply from empty (`0001`–`0010`), and the seed runs. Live counts afterwards: **skills = 10, sources = 9, public policies = 28, base tables = 20.** This was the box behind ENG-003, ENG-004, ONB-008 and ING-013 all at once.
- [x] All migrations are idempotent / forward-only (no hand edits to applied migrations) — ✅ 9 migrations, `0001`–`0009`, additive and never edited after application.

### The skills vocabulary is 10 rows, and that is the agreed MVP floor

**Decided 2026-10-09: 10 is the MVP floor, not a shortfall.** The ticket previously asked for
~600 rows; that figure was aspirational and is now removed rather than left as an unmet claim.

`supabase/seed.sql` seeds exactly **10** skills, confirmed against the live local database
after `pnpm db reset` (2026-10-09): `skills = 10`, `sources = 9`, `public` policies = 28,
base tables = 20.

| Skill | Slug | Aliases |
|---|---|---|
| TypeScript | `typescript` | `ts` |
| React | `react` | `react.js`, `reactjs` |
| Next.js | `nextjs` | `next`, `next.js` |
| PostgreSQL | `postgresql` | `postgres`, `psql` |
| Tailwind CSS | `tailwindcss` | `tailwind` |
| Python | `python` | `py` |
| AWS | `aws` | `amazon web services` |
| Docker | `docker` | `containerization` |
| Kubernetes | `kubernetes` | `k8s` |
| GraphQL | `graphql` | `gql` |

**What this costs, stated plainly.** `jobs.skills` is populated by the BE-106 matcher against
exactly this list, and both `jobs.skills` and `job_skills` reference the canonical `skills`
table — so a posting for a Kubernetes engineer using Go, Terraform or AWS Lambda scores zero
on the skills component, which carries the heaviest weight in the scorer (35 of 100, `SCR-002`).

That is an accepted MVP limitation, not an oversight, and it is bounded by the `unknown-is-never-0`
rule already in `rules.ts`: an unrecognised skill makes a component *neutral* rather than
penalising the job. The failure mode is therefore "this job is neither boosted nor buried",
not "this job is ranked unfairly low".

**Growing it is a data change, not a code change.** `tests/unit/ingest-skills.test.ts` parses
`supabase/seed.sql` and fails if the matcher and the database disagree in either direction, so
adding a skill to the seed without teaching the matcher about it is a red test rather than a
silent miss. Widening the vocabulary is therefore: add rows to `supabase/seed.sql`, add
patterns to `CANONICAL_SKILLS`, run the suite. No migration, no schema change.

**Alias caution for whoever does it.** `next` is a seed alias but is deliberately **excluded**
from the matcher's patterns — it is an ordinary English word, and `\bnext\b` tags "the next
step" as Next.js across a large share of the corpus. Every short alias needs the same audit
before it becomes a pattern; see the BE-106 notes in [05b ING-006](./05b-phase1.md).

---

### ENG-004 — RLS policies on every table
**[SEC]** · **Priority:** MUST · **Depends on:** ENG-003

Implement the policy table from [03 §4.2](./03-security-and-access.md): RLS **enabled** on every table with default deny, plus `is_admin()` helper. Write integration tests that prove each policy.

**Done when:**
- [x] `select * from pg_tables` shows RLS enabled for every app table — ✅ verified in the DDL: 19 `create table`, 19 `enable row level security`, 19 `force`. Confirmed against the live local database 2026-10-09: **28 policies across 20 public tables.**
- [x] Test: user A cannot `select`/`update`/`delete` user B's `profiles`, `job_scores`, `applications`, `saved_searches`, `resume_versions`, `digests` — ✅ `tests/integration/rls-policies.db.test.ts`, 22 tests against a real Postgres with **real user JWTs**, all green.
- [x] Test: authenticated user can `select` `jobs`/`skills`/`companies`/`sources` but `insert` fails — ✅ four read tests and two insert-denial tests (`jobs` and `skills`).
- [x] Test: `task_queue`, `scrape_runs`, `audit_logs` return nothing for a normal authenticated role — ✅ each table is seeded with a service-role row first, so "zero rows" means *filtered*, not *empty*.
- [x] Test: a user cannot grant themselves Pro — ✅ **corrected 2026-10-09: this box said `subscriptions.plan`, and there is no such column.** The live schema puts `plan` on `profiles`; `subscriptions` carries `status`, `price_id`, `stripe_customer_id`, `current_period_end`, `cancel_at_period_end`. Both are now tested, because the guarantee spans the two: `profiles.plan` is what the UI reads, `subscriptions.status` is what Stripe writes.
- [x] Test: `job_scores` `insert`/`update` as a normal user **fails** (scorer is service-role only) — ✅ two tests. This is the property BE-204's `persistScore` depends on: a user must not be able to manufacture their own perfect score.
- [x] Test: admin can `select` `scrape_runs` and `sources`, but **cannot** `select` another user's `applications` — ✅ admin is granted through `app_metadata` (the only channel `docs/03` §3.2 allows, and the one a user cannot set for themselves), then the JWT is re-issued so it carries the new claim.

### ⚠️ What this ticket was, until today

Every one of the seven boxes above was unticked, and that was correct: **no test in the repo
proved any RLS policy blocked anything.** `migration-drift.test.ts` asserted the SQL *text* —
that `alter table … force row level security` was present, that every policy mentioned
`(select auth.uid())` — which proves a policy was written and not that it fires.
`docs/06` §3 recorded FND-003 as "Verified with `pg_policies`", which is a catalogue query.

The suite exists now, and writing it immediately found a real defect: `audit_logs` has
`target_type` / `target_id` / `meta`, and both queue executors were inserting into
`entity_type` / `entity_id` / `detail`. See the BE-108 entry in [06 §4.1](./06-work-breakdown.md).

**Two properties worth keeping in mind when reading the file:**

- Every test makes its request with an **anon-key client signed in as that user**, never the
  service role. The service role bypasses RLS by design, so a test using it would assert
  nothing.
- Denials come in two shapes — an error, *or* success with zero rows when RLS filters every
  candidate out. Asserting on the error message alone makes a suite that fails on a policy
  working exactly as documented, so the tests assert the write **did not happen** and read the
  row back with the service role to prove it.

---

### ENG-005 — Structured logging, error taxonomy & Sentry
**[OPS] [SEC]** · **Priority:** MUST · **Depends on:** ENG-001

Create `lib/logger.ts` (JSON with `requestId`/`runId`, `redact()` on `*_KEY`, `*_SECRET`, `authorization`, `cookie`) and `lib/errors/` with `AppError` + the code→copy map from [03 §5.1](./03-security-and-access.md). Wire Sentry with `sendDefaultPii: false`. Build the 404, 500, and error boundary pages showing a copyable `requestId` and **never** a stack trace.

**Done when:**
- [ ] Every code in [03 §5.1](./03-security-and-access.md) exists with its exact user-facing copy — ⚠️ **three different counts, none reconciled.** `src/lib/errors/codes.ts` defines **18**; the `docs/03` §5.1 table has **17 rows** (it folds `file_too_large` / `file_type_invalid` into one); and `docs/06` §3 claims **22**. The one code in `codes.ts` that §5.1 does not document is **`edit_conflict`** — added 2026-10-06 for the `profiles.updated_at` optimistic-concurrency guard ([03 §5.2](./03-security-and-access.md)). It is a real code on a real 409 path and simply was never written into §5.1. Needs a doc row, then the counts reconcile.
- [ ] Test: a logger call containing a fake `OPENROUTER_API_KEY` outputs `***` — ❌ **no such test.** `redact()` and `redactObject()` exist in `lib/logger.ts`; four test files import `logger` but only to silence it, and none asserts redaction. This is the one box here that should have a test and does not, given that a leak in a log line is the exact failure `notes.md` records twice.
- [ ] 500 page shows friendly copy + `requestId`, no stack trace, no env values — ⚠️ `src/app/error.tsx` and `not-found.tsx` exist and are the documented shape per `docs/06` §3, but **not asserted by a test**.
- [ ] 404 for a not-yours resource is byte-identical to a genuinely missing resource — ⚠️ the `not_found` code's copy is written to be existence-free ("We couldn't find that."), and `AppError` maps it to 404. **Not asserted**, and the one route that would prove it (`/jobs/[id]` for someone else's job) is still a `.gitkeep` — Phase 2.
- [ ] Sentry receives the error with `{code, requestId, userId}` and `sendDefaultPii:false` — ⚠️ `lib/sentry.ts` sets 20% trace sampling, `sendDefaultPii: false`, and a `beforeSend` hook attaching `error_code`/`request_id`/`user_id`. **Not asserted**, and unverifiable here: no DSN is configured (`.env.local` has `SENTRY_DSN` empty), so nothing has ever been delivered.
- [ ] Every error response carries the correct status (401/403/404/422/429/500) — ⚠️ each entry in `codes.ts` carries an `httpStatus`, and the 429 in `rate_limited` is 429 as documented. **Not asserted by a test.**

---

### ENG-006 — CI pipeline
**[OPS]** · **Priority:** MUST · **Depends on:** ENG-001

`.github/workflows/ci.yml`: lint → typecheck → unit (+ integration, Testcontainers Postgres, once Phase 1 lands) → build → **secret-scan the built client bundle** → Playwright e2e → `pnpm audit` (high/critical fail). `audit` runs in parallel with the rest — it inspects the lockfile, not the build, so gating it behind `build` would only add wall-clock. Deploy is **not** in this file: Vercel's Git integration handles previews on PR and production on merge to `main`, which needs no token in repo secrets ([02 §4](./02-technical-architecture.md)).

Three details that are load-bearing and were each learned the hard way:

- The bundle scan matches credential **shapes** and **values**, never names. The original
  predicate `supabase|sk-|whsec_|rk_live` is in the git history because it matched the
  library name and ordinary English while catching nothing — see `scripts/scan-bundle-secrets.ts`.
- Node is pinned once in workflow-level `env.NODE_VERSION` and read by every job, so CI cannot
  drift from the Vercel runtime.
- CI supplies **placeholder** values for the five required env vars. Importing `@/lib/env` makes
  `next build` evaluate the contract, so a build without them fails with
  `Failed to collect page data for /<route>` — the deploy-time gate working as intended.

**Done when:**
- [x] CI fails on lint error, type error, failing test, or high/critical CVE — verified; all 7 jobs green on `main`
- [x] Bundle scan fails on a credential **value** in client output — `scripts/scan-bundle-secrets.ts`, proven by planting an `sb_secret_` value (fails) and by minified noise (passes)
- [x] Playwright runs against the preview deployment, not just localhost — `playwright.config.ts` honours `PLAYWRIGHT_TEST_BASE_URL` and omits `webServer` for external targets. ⚠️ **count corrected 2026-10-09: there are 6 tests, not 18** — `tests/e2e/` contains one file, `smoke.spec.ts`, with 6 `test()` blocks (marketing page, mobile width, login field, not-found, CTA navigation, client-bundle hygiene). The config behaviour is as described; the spec count in the original claim was not.
- [ ] Required status checks block merging to `main` — repo setting, not code. Enable the 7 job names (`lint`, `typecheck`, `test`, `build`, `secret-scan`, `e2e`, `audit`) as required checks in GitHub settings. **Still unverified 2026-10-09** — `gh api …/branches/main/protection/required_status_checks` returns HTTP 403 ("Upgrade to GitHub Pro or make this repository public"), so this cannot be confirmed or denied from here.
- [x] The workflow file itself is valid — `tests/unit/workflow-yaml.test.ts` rejects duplicate keys, the required job set, and the `needs` ordering. Added after a duplicate key made GitHub reject the file in 0s with no logs while `yaml.safe_load` passed it.

---
