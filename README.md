# JobRadar — automated job finding workflow

> Your background process for job search: it watches every source you care about, throws away duplicates and dead roles, ranks what's left against your profile, and tracks everything you've applied to.

**Status:** 📐 Specifications complete · 🏗️ Repository scaffolded · ⚙️ Not yet built

> **Working on this repo?** Read [AGENTS.md](./AGENTS.md) first — it defines phase order and the doc-update rule. Log anything that wastes time in [notes.md](./notes.md).

---

## Documentation

These five documents are the source of truth. Read them in order; each one builds on the last.

| # | Document | What it answers |
|---|---|---|
| 01 | [Product Requirements](./docs/01-prd.md) | What are we building, for whom, and how do we know it worked? |
| 02 | [Technical Architecture](./docs/02-technical-architecture.md) | What tools, what folder structure, what database schema, what config? |
| 03 | [Security & Access](./docs/03-security-and-access.md) | How do people sign in, who can do what, what breaks and what does it say? |
| 04 | [Frontend Specification](./docs/04-frontend-specification.md) | What does it look like, and how do we talk to every third-party service? |
| 05 | [Feature Ticket List](./docs/05-feature-ticket-list.md) | The build checklist — 87 tickets, one prompt each. |
| 06 | [Work Breakdown & Sequencing](./docs/06-work-breakdown.md) | Front-end vs back-end division: BE first, FE functional second, visual design last. |

**Never** introduce a technology, folder, table, colour, or environment variable that isn't defined in those documents without updating them first.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) · TypeScript · React 19 |
| Styling | Tailwind CSS 4 + Radix UI primitives |
| Database | Supabase — Postgres 17, pgvector, RLS, pg_cron, Storage |
| Auth | Supabase Auth (magic link + Google OAuth) |
| Scraping | Firecrawl (v2) + Greenhouse / Lever / Ashby / Remotive / Arbeitnow / USAJOBS / Adzuna |
| AI | OpenAI — `text-embedding-3-small`, `gpt-4o-mini` |
| Email · Payments · Analytics · Errors | Resend + React Email · Stripe · PostHog · Sentry |
| Queue | Postgres `task_queue` table + Vercel Cron |
| Hosting | Vercel |

Full reasoning and the "what we're not using" list: [docs/02-technical-architecture.md §2](./docs/02-technical-architecture.md).

---

## Getting started

```bash
cp .env.example .env.local   # fill in your keys — see docs/02 §7.1
pnpm install
supabase start                # local Supabase stack
supabase db reset             # migrations + seed
pnpm dev                      # http://localhost:3000
```

### Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Start the dev server |
| `pnpm build` | Production build |
| `pnpm lint` · `pnpm typecheck` | ESLint · `tsc --noEmit` |
| `pnpm test` | Vitest unit + integration |
| `pnpm test:e2e` | Playwright |
| `pnpm queue:drain --once` | Process one queue batch locally (replaces Vercel cron) |
| `supabase db reset` | Rebuild local schema and seed |

---

## Repository layout

```
docs/               the five specification documents (source of truth)
src/
  app/              App Router — routes only, no business logic
    (marketing)/    public landing, pricing, demo feed
    (auth)/         login + OAuth callback
    (app)/          authenticated shell: onboarding, dashboard, tracker, admin
    api/cron/       cron ingress — enqueue / process / digest
    api/actions/    server actions (all user mutations)
    api/webhooks/   Stripe
  components/       ui primitives + feature components (feed, job, tracker, admin)
  lib/
    db/             client (anon+RLS) / server / admin (service-role, restricted)
    connectors/     ★ one file per job source — the plug-in point
    ingest/         normalise → dedupe → freshness
    scoring/        gates → rules → semantic → rationale
    queue/          enqueue / claim / run / retry + handlers
    email/ billing/ analytics/ errors/ utils/
  styles/tokens.css ALL design tokens (no hex literals anywhere else)
supabase/migrations numbered SQL schema
tests/              unit · integration (fixtures, no live APIs) · e2e
```

Detailed map with rules: [docs/02-technical-architecture.md §4](./docs/02-technical-architecture.md).

---

## Guardrails

- **Service-role key never reaches the client.** Importing `src/lib/db/admin.ts` outside `lib/queue/**`, `api/cron/**`, `api/webhooks/**` fails lint; CI greps the built bundle for secrets.
- **RLS is enabled on every table**, default deny. Verified by integration tests ([docs/03 §4](./docs/03-security-and-access.md)).
- **No hex values outside `src/styles/tokens.css`** — CI enforces.
- **No third-party failure may block the feed.** Every integration has a timeout, retry budget, and a defined degraded behaviour ([docs/04 §5.9](./docs/04-frontend-specification.md)).
- **No direct LinkedIn/Indeed scraping.** Source priority and legal notes: [docs/02 §6.1](./docs/02-technical-architecture.md).

---

## Build order

```
E0 Foundation → E1 Auth → E2 Onboarding → E3 Ingestion → E4 Scoring → E5 Feed
                                         → E6 Job Detail → E7 Tracker
                                         → E8 Digests
E9 Billing (after E2)   E10 Ops (parallel from E3)   E11 Polish (last)
```

**MVP = the 59 `MUST` tickets** in [docs/05-feature-ticket-list.md](./docs/05-feature-ticket-list.md).
