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
- [ ] `pnpm dev` boots at `localhost:3000` with a placeholder page — ❌ **2026-10-03: no `layout.tsx` or `page.tsx` exists, so `/` renders the built-in 404.**
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass on an empty suite — ✅ verified 2026-10-03.
- [ ] Folder tree matches [02 §4](./02-technical-architecture.md) exactly (including empty dirs with `.gitkeep`) — ⚠️ **the tree in `docs/02` §4 was itself wrong and has now been corrected. Re-check against the fixed version.**
- [ ] `.env.example` contains every variable from [02 §7.1](./02-technical-architecture.md), none with real values — ✅ 28 variables, all blank (verified 2026-10-03).
- [x] `.gitignore` excludes `.env.local`; `gitleaks` pre-commit hook installed — ✅ **2026-10-03.** The hook is wired via `.simple-git-hooks.json` and runs `gitleaks git --staged`. The real binary (8.30.1, checksum-verified) lives in gitignored `tools/`. Project rules in `.gitleaks.toml` add the Supabase key formats the built-in ruleset misses. Details in [02](./02-technical-architecture.md) §4.2.
- [x] ESLint rule blocks imports of `src/lib/db/admin.ts` outside `lib/queue/**`, `api/cron/**`, `api/webhooks/**` — ✅ **2026-10-03.** This was pointing the wrong way before: the rule blocked direct `@supabase/supabase-js` imports and let `admin.ts` through from anywhere. `tests/unit/eslint-guard.test.ts` pins both directions — 5 blocked paths must error, 5 sanctioned paths must stay open. Verified end-to-end with `pnpm lint`.

**Scope note on the box above.** The allowed list is the three paths named here plus
`scripts/**` and `tests/**`. Neither is reachable from the client bundle, and excluding them
would break `scripts/queue-drain.ts` and the RLS integration tests.

**Also required by the ticket body, but missing from the boxes above:**
- `eslint-config-next` is **not installed** (absent from `package.json`), though the first
  sentence of this ticket requires it.
- Tailwind is **inert**: `tailwindcss@4.3.3` is installed, but `@tailwindcss/postcss` and
  `postcss.config.mjs` are missing, and `docs/02` §4 wrongly required a `tailwind.config.ts`
  that Tailwind 4 ignores. See [02](./02-technical-architecture.md) §4.1.

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
- [x] Playwright runs against the preview deployment, not just localhost — `playwright.config.ts` honours `PLAYWRIGHT_TEST_BASE_URL` and omits `webServer` for external targets; 18 specs pass against the live deployment
- [ ] Required status checks block merging to `main` — repo setting, not code. Enable the 7 job names as required checks in GitHub settings.
- [x] The workflow file itself is valid — `tests/unit/workflow-yaml.test.ts` rejects duplicate keys, the required job set, and the `needs` ordering. Added after a duplicate key made GitHub reject the file in 0s with no logs while `yaml.safe_load` passed it.

---
