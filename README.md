# JobRadar — automated job finding workflow

> Your background process for job search: it watches every source you care about, throws away duplicates and dead roles, ranks what's left against your profile, and tracks everything you've applied to.

**Status:** 🔨 In active development · Phase 0–2 · Core subsystems implemented and tested

<!--
WHY THIS FILE EXISTS
====================
The original status line read:

    **Status:** Specifications complete · Repository scaffolded · Not yet built

That was accurate earlier and is now wrong. The repository contains real implementation:

    src/lib/connectors/   14 connectors (Firecrawl, Greenhouse, Lever, Ashby,
                          Remotive, Arbeitnow, USAJobs, Adzuna) + url-guard
    src/lib/scoring/      gates, rules, semantic matching, weights
    src/lib/ingest/       dedupe, normalize, skills extraction
    tests/unit/           39 Vitest suites

A recruiter who reads "Not yet built" on the first screen stops reading. The README is the
first thing anyone sees, and it currently contradicts the repository.

The line above is the replacement. If the true state differs, edit this line rather than
reverting to "Not yet built" — an accurate but pessimistic status costs you more than
an accurate optimistic one.
-->

> **Working on this repo?** Read [AGENTS.md](./AGENTS.md) first — it defines phase order and the doc-update rule. Log anything that wastes time in [notes.md](./notes.md).

---

## Quick start

```bash
cp .env.example .env.local   # fill in your keys — see docs/02 §7.1
pnpm install
supabase start                # local Supabase stack
supabase db reset             # migrations + seed
pnpm dev                      # http://localhost:3000
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Next dev server |
| `pnpm build` | Production build |
| `pnpm test` | Vitest unit suite |
| `pnpm test:e2e` | Playwright end-to-end |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm secret:scan` | gitleaks over staged changes |
| `pnpm db:reset` | Recreate local database from migrations |

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) · TypeScript · React 19 |
| Styling | Tailwind CSS 4 + Radix UI primitives |
| Database | Supabase — Postgres 17, pgvector, RLS, pg_cron, Storage |
| Auth | Supabase Auth (magic link + Google OAuth) |
| Scraping | Firecrawl (v2) + Greenhouse / Lever / Ashby / Remotive / Arbeitnow / USAJOBS / Adzuna |
| AI | OpenRouter — `nvidia/nemotron-3-embed-1b:free` (2048-dim embeddings), `:free` chat model |
| Email · Payments · Analytics · Errors | Resend + React Email · Stripe · PostHog · Sentry |
| Queue | Postgres `task_queue` table + Vercel Cron |
| Hosting | Vercel |

## Subsystems

| Area | Location | Notes |
|---|---|---|
| Connectors | `src/lib/connectors/` | 14 job-board sources behind one contract, plus `url-guard.ts` for SSRF protection |
| Scoring — gates | `src/lib/scoring/gates.ts` | Hard eligibility filters applied before any ranking |
| Scoring — semantic | `src/lib/scoring/semantic.ts` | Embedding-based match against the profile |
| Scoring — rules | `src/lib/scoring/rules.ts` | Weighted heuristics complementing semantic score |
| Ingest | `src/lib/ingest/` | Normalisation, cross-source dedupe, skill extraction |
| Queue | `src/lib/queue/` | Postgres-backed task queue with backoff and retry |
| Resume parsing | `src/lib/resume/` | PDF/DOCX extraction with regression tests |

## Testing approach

39 unit suites under `tests/unit/`. The cases worth reading are the negative ones — a gate that
excludes a job because data was missing fails invisibly, so the feed can disappear without an
error ever being raised. `scoring-gates.test.ts` pins those cases explicitly.

Three additional suites guard against drift between the docs and the code
(`doc-drift.test.ts`, `migration-drift.test.ts`, `ci-placeholders.test.ts`), which matters
because the specification documents are treated as authoritative here.

## Documentation

These documents are the source of truth, in dependency order:

| # | Document | What it answers |
|---|---|---|
| 01 | [Product Requirements](./docs/01-prd.md) | What are we building, for whom, how do we know it worked? |
| 02 | [Technical Architecture](./docs/02-technical-architecture.md) | Tools, folder structure, config |
| 02a | [Database Schema](./docs/02a-schema.md) | Tables, enums, relationships, indexes |
| 02b | [Key Subsystems](./docs/02b-subsystems.md) | Connectors, dedup, scoring, queue, digest |
| 02c | [Environment & Config](./docs/02c-config.md) | Env vars, config rules, local dev |
| 03 | [Security & Access](./docs/03-security-and-access.md) | Auth, authorization, failure behaviour |
| 04 | [Frontend Specification](./docs/04-frontend-specification.md) | Layout and third-party integration |
| 05 | [Feature Ticket List](./docs/05-feature-ticket-list.md) | Build checklist — 58 MUST tickets |
| 05a–05d | [Phase 0](./docs/05a-phase0.md) · [1](./docs/05b-phase1.md) · [2](./docs/05c-phase2.md) · [3](./docs/05d-phase3.md) | Tickets by phase |
| 06 | [Work Breakdown](./docs/06-work-breakdown.md) | Sequencing |
| 07 | [Session Log](./docs/07-session-log.md) | Historical, not authoritative |

**Never** introduce a technology, folder, table, colour, or environment variable that isn't
defined in those documents without updating them first.

---

## A note on how this was built

**To be precise about the split: I wrote the specification. AI wrote nearly all of the code.**

My contribution is the seven specification documents in `docs/`, the architecture decisions
recorded in `docs/02*`, the subsystem contracts, the test strategy, and the review of what came
back. I did not hand-write the implementation.

Being clear about this matters more here than it usually would, because the specs are the part of
this project that took the most thinking — and they are invisible in the source files. Someone
opening `src/lib/connectors/` sees code. The reasoning behind *why there are fourteen connectors
and what contract they share* is in `docs/02b`, and that is the part I actually did.

That is what is worth discussing in detail:

- **Why scoring splits into hard gates plus a semantic score** rather than one ranking function.
  A job you are not eligible for should never reach a ranking stage, because to the ranking
  function it looks identical to a job you merely ranked low.
- **Why the queue is a Postgres table** rather than a managed queue service — one fewer paid
  dependency, and the queue becomes queryable with the same tools as everything else.
- **Why the negative test cases matter more than the positive ones.** A gate that excludes a job
  because data was missing fails invisibly: the feed can go empty and no error is raised anywhere.
  `scoring-gates.test.ts` pins those cases explicitly.
- **Why doc drift is a CI failure.** When the specification is authoritative, a change that
  contradicts it is a defect rather than a preference.

Happy to go into any of these in depth, or to walk through how a decision was reached rather than
only what it was.
