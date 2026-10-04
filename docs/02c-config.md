# 02c — Environment & Config

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [02 Technical Architecture](./02-technical-architecture.md) §7
**Last reviewed:** 2026-10-04

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
| `OPENROUTER_API_KEY` | server | embeddings + rationale | OpenRouter auth token; one key replaces OpenAI + Gemini + Groq |
| `OPENROUTER_BASE_URL` | server | default `https://openrouter.ai/api/v1` | OpenAI-compatible surface |
| `OPENROUTER_EMBEDDING_MODEL` | server | default `nvidia/nemotron-3-embed-1b:free` | change → full reindex |
| `OPENROUTER_CHAT_MODEL` | server | free `:free` model id | rationale + description cleanup |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | server | aggregator | |
| `USAJOBS_API_KEY` / `USAJOBS_AUTHORIZATION_KEY` | server | federal jobs | |
| `RAPIDAPI_KEY` | server | optional JSearch | may be blank |
| `RESEND_API_KEY` | server | transactional email | |
| `EMAIL_FROM` | server | e.g. `JobRadar <hi@jobradar.app>` | RFC 5322 address, display name optional. Plain `a@b.com` is also valid. Blank allowed (email disabled). |
| `STRIPE_SECRET_KEY` | server | billing | |
| `STRIPE_WEBHOOK_SECRET` | server | signature verification | |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | client | checkout | |
| `STRIPE_PRICE_ID_PRO` | server | Pro price | |
| `POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_KEY` | server/client | analytics | |
| `POSTHOG_HOST` | client | default EU or US host | defaults to `https://us.i.posthog.com` |
| `SENTRY_DSN` | server + client | errors | |
| `NEXT_PUBLIC_SENTRY_DSN` | client | errors | |
| `SLACK_WEBHOOK_URL` | server | optional Slack digest (F5) | may be blank |
| `ADMIN_EMAILS` | server | bootstrap admin allowlist | comma-separated |
| `RATE_LIMIT_APPLY_PER_MINUTE` | server | apply rate ceiling | defaults to `10` |
| `RATE_LIMIT_SAVE_PER_MINUTE` | server | save rate ceiling | defaults to `30` |
| `RATE_LIMIT_DISMISS_PER_MINUTE` | server | dismiss rate ceiling | defaults to `30` |
| `RATE_LIMIT_SEARCH_PER_MINUTE` | server | search rate ceiling | defaults to `60` |
| `CRON_SECRET` | server | bearer token for `/api/cron/*` | **minimum 32 characters**, verified constant-time |

### 7.2 Configuration rules

1. **Never hardcode** any value from §7.1, plus: API base URLs, plan limits, scoring weights, feature flags.
2. `.env.example` is committed with empty values and a one-line comment per variable. Real `.env.local` is gitignored; production vars live in Vercel + Supabase dashboards only.
3. **Validation at boot:** a Zod `envSchema` in `src/lib/env/schema.ts` throws on missing vars so misconfiguration fails at deploy, not at first user request.
   Verified: `next build` evaluates route modules during its "collecting page data" pass, so a
   route importing `@/lib/env` fails the **build** with `Failed to collect page data for /<route>`
   when a required var is absent. Two earlier claims that it did *not* were wrong — the test
   behind them left `.env.local` in place, and Next auto-loads it (see rule 8 and `notes.md`).
   The schema is reached through `parseEnv(record)`, which is pure and returns a result rather than throwing; the
   exported `env` object is the thin binding that calls it with `process.env` and throws. Tests and tooling use
   `parseEnv` directly, so neither has to mutate `process.env` or reload a module.
   Rule 1 above applies to scripts too: `scripts/queue-drain.ts` imports `env` and never reads `process.env` itself.
4. **Secrets hygiene:** no secrets in logs, `audit_logs.meta`, Sentry breadcrumbs, or `jobs.raw`. A `redact()` helper strips `*_KEY`, `*_SECRET`, `authorization`, `cookie` before any serialisation.
5. **Plan limits and scoring weights** live in code (`lib/billing/plans.ts`, `lib/scoring/weights.ts`) behind feature flags — not in env vars — so they're reviewed and versioned.
6. **Rotation:** rotate `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `FIRECRAWL_API_KEY`, `STRIPE_WEBHOOK_SECRET` on any suspected exposure; document rotation date in `docs/`.
6a. **Blank is not the same as absent.** `.env` files express "not configured" as `VAR=`, which
   parses to an empty string — *present*, not undefined. Zod's `.optional()` therefore does not
   cover it. Every optional var uses the `blank()` helper in `src/lib/env.ts`, which maps `""`
   to `undefined` before validating. Without this, any unset optional var fails boot validation
   and the whole app refuses to start.
   The same applies to a var that has a **default**: `VAR=` must fall back to the default, not fail
   boot. Every defaulted optional in `env.ts` is therefore wrapped as `blank(schema).default(...)`.
   Any new var that is optional or defaulted must follow one of those two shapes.
7. **Per-request scoping:** Server Actions and Route Handlers take the user-scoped client (user JWT → RLS enforced). Service-role client is created lazily and only inside queue handlers.
8. **CI needs placeholders, not secrets.** Rule 3 means any module importing `@/lib/env` makes
   `next build` require a schema-valid environment: the build's "collecting page data" pass
   evaluates route modules, so a missing var fails the build with
   `Failed to collect page data for /<route>`. That is the intended deploy-time gate working.

   `.github/workflows/ci.yml` therefore supplies **placeholder** values in workflow-level `env`
   for the five required vars. Constraints on those placeholders:

   - **Fake, always.** The schema checks shape and presence, not whether a credential works.
     AGENTS.md forbids live API calls in CI, so no real secret may enter a CI log.
   - **No credential shape.** `scripts/scan-bundle-secrets.ts` runs in the same workflow
     against the same build. A placeholder shaped like `sb_secret_…` or `sk-or-v1-…` would fail
     the gate on CI's own environment.
   - **Satisfy the constraint.** `CRON_SECRET` must be ≥ 32 characters (§7.1); the URL var must
     parse as a URL.

   `tests/unit/ci-placeholders.test.ts` asserts all four properties. It duplicates the values
   from the workflow on purpose: **CI cannot test its own environment**, so a unit test is the
   only available oracle. A new required var must be added in both places.

### 7.3 Local development

```bash
cp .env.example .env.local      # fill from Supabase / Firecrawl / OpenRouter dashboards
supabase start                  # local stack
supabase db reset               # migrations + seed
pnpm dev                        # http://localhost:3000
pnpm queue:drain --once         # process one queue batch locally (no Vercel cron)
```

Standalone scripts under `scripts/` load env through Node's built-in `--env-file=.env.local`
flag, wired into the npm script. There is **no `dotenv` dependency** — adding one is a
regression, not a fix. `scripts/scan-bundle-secrets.ts` is the exception: it reads
`process.env` directly and takes no `--env-file`, because it must see the *live* secret values
to exact-match them. It exits `2` if `.next/` is missing, so run `pnpm build` first:

```bash
pnpm build && pnpm secret:scan:bundle    # credential values in the build output
```

**Against a remote project:** `supabase link --project-ref <ref>` then `supabase db push`.
A `db push` reporting "up to date" when `supabase/migrations/` is empty means nothing was
applied, not that the schema is current. Confirm via the Supabase MCP `list_migrations`.

---
