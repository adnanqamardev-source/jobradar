# AGENTS.md

Spec-first repo. **No application code exists yet** — `src/` holds only `.gitkeep` placeholders and `styles/tokens.css`. No migrations. The six docs in `docs/` are the authority for everything.

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

Read **only the cited section** — the six docs total ~209 KB. Pulling a whole doc into context wastes the session and buries the part you needed.

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
pnpm lint                # eslint . — NOT `next lint` (removed in Next 16)
pnpm test                # vitest (unit + integration)
pnpm test:e2e            # playwright
pnpm queue:drain --once  # process one queue batch locally; replaces Vercel cron
supabase db reset        # rebuild local schema + seed
```

Tooling notes (FND-001, settled):

- **Env loading in scripts:** Node's built-in `--env-file=.env.local`, wired into the
  `queue:drain` npm script. Do not add `dotenv`; it was never a dependency.
- **Vitest:** config is `vitest.config.mts` (`.mts`, not `.ts` — the `.ts` extension loaded ESM
  as CJS). Vitest 4+ removed `poolOptions`; serial execution is top-level `fileParallelism: false`.
- **ESLint:** flat config only. `next lint` is deprecated and gone in Next 16.
- **ESLint exclusions:** `next-env.d.ts` is ignored — Next generates its triple-slash references.

Verify in this order: `typecheck → lint → test`. Claim done only with pasted output, not assertion.

## Before you build anything

1. Confirm the current phase from `docs/06-work-breakdown.md`.
2. Confirm the ticket exists. New work needs a ticket.
3. Check `notes.md` — if a method or loop is listed there, don't repeat it.

## Rule 0 — Verify before asserting (overrides every other rule)

An unverified claim is worse than no claim, because downstream work inherits it. Every factual
statement about the repo, the database, or a server must come from a tool result in this
session — never from a plausible inference, a remembered tool listing, or an assumption that
something "should" exist.

**Run the check. Then state the finding. Never the reverse.**

| Claiming | Verify with | Not |
|---|---|---|
| A file is missing | `git ls-files`, `Get-ChildItem` | a `glob` result (may be partial) |
| A file exists | `git ls-files`, `git status --short` | memory of writing it |
| Secrets are protected | `git check-ignore -v <path>` | "`.gitignore` has it" |
| A migration applied | `list_migrations` via Supabase MCP | `db push` saying "up to date" |
| A DB table exists | `list_tables` via Supabase MCP | assuming a migration covered it |
| An MCP server is live | `opencode mcp list` | the tool catalog listing it |
| Tests pass | pasted `pnpm test` output | "tests pass" |

**"Up to date" against zero migrations means nothing was applied.** Treat any success message
whose scope is unverified as a non-answer.

If a check is skipped, say so explicitly. Silence reads as confirmation.

## Rule 1 — Stop repeating what `notes.md` already logged

Read `notes.md` **before** the first tool call of a task, not after. If a method is listed there,
it is forbidden for this session.

Logging a failure is not compliance. `notes.md` exists to prevent recurrence; if a rule in it is
violated anyway, the rule was too weak or too late. Escalate to a hard rule here instead of
appending a second note.

## Rule 2 — One question, plain text

Ask for a credential or decision **once**, in plain prose. Never loop the question tool, and never
re-ask for something already pasted in the conversation. Re-read the transcript before asking.

Validate credential *shape* before writing it anywhere:

| Prefix | Is | Belongs in |
|---|---|---|
| `sb_publishable_` | anon / public key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `sb_secret_` | service-role key | `SUPABASE_SERVICE_ROLE_KEY` |
| `eyJ` | legacy JWT service key | `SUPABASE_SERVICE_ROLE_KEY` |
| `sbp_` | personal access token | **never** an env var in this repo |

A PAT pasted into a key slot is a leak. Rotate it and say so.

## Rule 3 — Scratch files and the folder map

`docs/02` §4 maps every production path. Two carve-outs:

- **Sanctioned exceptions.** `scripts/queue-drain.ts` is referenced by `package.json` and lives in
  `scripts/`. This location is legitimate.
- **Throwaway utilities.** Ad-hoc verification scripts are allowed **only** if they are deleted in
  the same session they are created. Never commit one. Never let one justify a new §4 entry.

## Rule 4 — Finish with evidence, or say you did not finish

Close a task with pasted output from the commands in **Commands** above, in `typecheck → lint →
test` order. "Should work", "should pass", and "looks correct" are not results.

If a step was skipped, blocked, or partially completed, state that plainly in the summary —
alongside what would be needed to finish it. Partial work reported as complete costs more time
than work left undone.
