# AGENTS.md

JobRadar — automated job finding. Spec-first repo; `docs/` is the authority for everything.

## Orientation

| I need to… | Read |
|---|---|
| Understand the product | [docs/01-prd.md](./docs/01-prd.md) |
| Find a table, folder, env var, or route | [docs/02-technical-architecture.md](./docs/02-technical-architecture.md) |
| Check a security or auth rule | [docs/03-security-and-access.md](./docs/03-security-and-access.md) |
| Know a component or integration contract | [docs/04-frontend-specification.md](./docs/04-frontend-specification.md) |
| Find a ticket or acceptance criteria | [docs/05-feature-ticket-list.md](./docs/05-feature-ticket-list.md) |
| Check phase order or ticket mapping | [docs/06-work-breakdown.md](./docs/06-work-breakdown.md) |
| See what happened in past sessions | [docs/07-session-log.md](./docs/07-session-log.md) |
| Know what NOT to repeat | [notes.md](./notes.md) |

## Phase order (do not reorder)

```
Phase 0 Foundation → Phase 1 Back-End → Phase 2 Front-End functional → Phase 3 Design (LAST)
```

- **Phase 1 is backend-only.** No components, no styling, no page files.
- **Phase 2 is unstyled but NOT unstructured.** Semantic elements, real `<button>`, labels, heading order, focus order, ARIA. Radix primitives unstyled from the start.
- **Phase 3 owns only presentation**: contrast, visible focus, non-colour-only signalling, touch targets, motion.
- Never start design work early, even "just quickly".

## Boundaries

### Always do
- Read `notes.md` before the first tool call — if a method is listed there, don't repeat it.
- Update every doc the change touched, in the **same** commit.
- Verify before asserting. Run the check, then state the finding. Never the reverse.
- Paste gate output as evidence. "Should pass" is not a result.

### Ask first
- New dependency, schema change, env var, route, or ticket ID.
- Anything that changes the phase order or the seam contract.

### Never do
- Start Phase 2 work before Phase 0 and Phase 1 gates are green.
- Invent a table, column, env var, route, endpoint, colour, or ticket ID that isn't in the docs.
- Hand-write a stub to make a gate look passed.
- Print a credential to stdout, a transcript, or a log — even locally, even to "check" it.
- Edit an applied migration. Schema changes are forward-only.
- Use `process.env.X!` in `src/` — import `env` from `@/lib/env` so Zod names the missing variable.
- Commit a secret or a PAT. A `sbp_` prefix in an env var is a leak — rotate it and say so.

## Gates

```bash
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint . — NOT `next lint` (removed in Next 16)
pnpm test         # vitest (unit + integration)
```

Verify in that order. Claim done only with pasted output.

## Rules (full text in [notes.md](./notes.md))

| Rule | One-line |
|---|---|
| Rule 0 | Verify before asserting — every claim from a tool result |
| Rule 1 | Stop repeating what `notes.md` already logged |
| Rule 2 | One question, plain text — never loop the question tool |
| Rule 3 | Scratch files deleted in the same session; `docs/02` §4 maps every production path |
| Rule 4 | Finish with evidence, or say you did not finish |

**Tooling notes** (FND-001, settled): env loading via Node's `--env-file=.env.local` (no `dotenv`); vitest config is `vitest.config.mts` with top-level `fileParallelism: false`; ESLint flat config only; `next-env.d.ts` is ignored.
