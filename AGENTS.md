# AGENTS.md

Spec-first repo. **No application code exists yet** — `src/` is empty, no lockfile, no migrations. The six docs in `docs/` are the authority for everything.

## Order of work (do not reorder)

`Phase 0 Foundation → Phase 1 Back-End → Phase 2 Front-End functional → Phase 3 Design (LAST)`

Ticket IDs in `docs/06-work-breakdown.md`: `FND-*` · `BE-*` · `FE-*` · `DS-*`.
Mapping back to original IDs is in `docs/06-work-breakdown.md` §7 — use it, don't guess.

- **Phase 1 is backend-only.** No components, no styling, no page files. Verified by tests.
- **Phase 2 is unstyled but NOT unstructured.** Semantic elements, real `<button>`, labels, heading order, focus order, ARIA. Use Radix primitives **unstyled from the start** so Phase 3 is CSS, not a rewrite.
- **Phase 3 owns only presentation**: contrast, visible focus, non-colour-only signalling, touch targets, motion.
- Never start design work early, even "just quickly".

## Never invent — extend the docs first

If you need a table, column, env var, route, endpoint, colour, or ticket ID that isn't already written, **add it to the relevant doc first**, then implement. Prose that drifts from code is the failure mode this repo is designed to prevent.

| Need | Doc to edit |
|---|---|
| New feature / scope | `docs/01-prd.md` |
| Table, folder, env var, subsystem | `docs/02-technical-architecture.md` |
| Policy, auth rule, error copy | `docs/03-security-and-access.md` |
| Token, component style, integration | `docs/04-frontend-specification.md` |
| Task breakdown / acceptance criteria | `docs/05-feature-ticket-list.md` |
| Phase, track assignment, ticket mapping | `docs/06-work-breakdown.md` |

Read **only the cited section** — the six docs total ~190 KB. Pulling a whole doc into context wastes the session and buries the part you needed.

## Mandatory: update docs every iteration

Before you close any ticket, update every doc the change touched, in the **same** commit. An API-shape change means the type file *and* `docs/02` *and* `docs/06` §7 move together. If doc 06 §7 no longer matches doc 05's ticket IDs, it is stale and must be fixed.

## Hard constraints (follow these by hand now; automated guards land in Phase 0)

These are rules you must honour from the first commit. The lint rule ships in `FND-001`, the CI bundle scan in `FND-005`, and the token grep in `DS-001` — they are not active yet, so nothing will catch a violation for you.

- **Service-role key never reaches the client.** Only `lib/db/admin.ts`, imported *only* from `lib/queue/**`, `api/cron/**`, `api/webhooks/**`.
- **No hex or px literals outside `src/styles/tokens.css`.**
- **No live API calls in CI.** Connector tests run against `tests/integration/fixtures/sources/*.json`.
- **RLS enabled on every table, default deny.** Users read own rows only; `jobs` corpus is read-only to clients.
- **No direct LinkedIn/Indeed scraping.** Source priority is in `docs/02` §6.1.
- **No third-party failure may block the feed** — every integration has a timeout, retry budget, and defined degraded behaviour (`docs/04` §5.9).

## Testing gotchas

- RLS + queue tests need **real Postgres** (Testcontainers) — `FOR UPDATE SKIP LOCKED` concurrency can't be proven on a mock.
- Inject a fake clock for freshness decay, digest timezones, retry backoff. Never `sleep`.
- Prove idempotency explicitly: run each queue handler twice, assert one row.
- Scorer must be deterministic — same input, same score.
- Schema changes are forward-only migrations. Never edit an applied migration.

## Commands

```bash
pnpm install
pnpm dev                 # localhost:3000
pnpm typecheck           # tsc --noEmit
pnpm lint
pnpm test                # vitest (unit + integration)
pnpm test:e2e            # playwright
pnpm queue:drain --once  # process one queue batch locally; replaces Vercel cron
supabase db reset        # rebuild local schema + seed
```

Verify in this order: `typecheck → lint → test`. Claim done only with pasted output, not assertion.

## Before you build anything

1. Confirm the current phase from `docs/06-work-breakdown.md`.
2. Confirm the ticket exists. New work needs a ticket.
3. Check `notes.md` — if a method or loop is listed there, don't repeat it.
