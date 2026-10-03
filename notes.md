# notes.md — AI failure log

Append one line when something wastes time. Delete entries that stop being true.

**Format:** `<!-- date --> | what happened | what to do instead`

| Date | What happened | Do this instead |
|---|---|---|
| 2026-10-03 | Assumed "OpenRouter is OpenAI-compatible so `text-embedding-3-small` is free there." It is **not** — OpenRouter charges $0.00000002/token for it. `GET /api/v1/embeddings/models` lists pricing per model; check it before assuming free. | Query `openrouter.ai/api/v1/embeddings/models` and filter `pricing.prompt -eq 0` before naming a free model. Only two free embedding models exist: `liquid/lfm-2.5-embedding-350m:free` (1024-dim, 512 ctx) and `nvidia/nemotron-3-embed-1b:free` (2048-dim, 32768 ctx). |
| 2026-10-03 | Nearly changed `vector(1536)` → `vector(2048)` and treated it as a breaking change needing a reindex. No migration file existed yet (FND-002 unwritten), so the schema had never been created. | Before calling a schema constant a breaking change, run `Get-ChildItem supabase\migrations`. Zero `.sql` files means the dimension was never materialised — change the doc freely. |
| 2026-10-03 | `powershell` on this machine is Windows PowerShell 5.1: `[System.Security.Cryptography.RandomNumberGenerator]::Fill()` and `[Convert]::ToHexString()` do not exist (both .NET Core-era APIs). | Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — works on every Node ≥ 12 regardless of PowerShell version. |
| 2026-10-03 | Ran `git diff -- <10 files>` in one loop to inspect a dirty tree; `git status` showed 12 modified files but `git diff` was empty for all of them. They were LF↔CRLF line-ending flips, not content changes. | When `git status` shows modified but `git diff` is blank, suspect line endings. Check `.gitattributes`, then `git checkout --` the noise files and keep only real content diffs. Do not "review" 12 phantom changes. |
| 2026-10-03 | Attempted a `for` loop in PowerShell one-liner: `for ($f in @(...)) { ... }`. This shell is PowerShell, not bash — bash `do...done` syntax is a parse error. | PowerShell uses `foreach ($f in @(...)) { }`. When a command fails with `ParserError`, re-read the error before assuming the tool is broken. |
| 2026-10-03 | Built a throwaway `env-check.tmp.ts` harness and used `await import(\`@/lib/env?bust=${Math.random()}\`)` to re-run module-level validation. It does not work: the `@/` alias does not resolve through the query string, so every case failed with "Cannot find package". Worse, the first `load()` left mutated `process.env` behind and later cases reported bogus results. | Never hand-roll a module-cache-busting harness. Write a real Vitest test using `vi.resetModules()` — it is the artifact you want anyway. Vitest also needs an explicit `resolve.alias` for `@`; it does **not** read tsconfig `paths` on its own (added to `vitest.config.mts`). |
| 2026-10-03 | `.optional()` on every env var in `env.ts` was believed to cover "unset". It does not: `.env` expresses unset as `VAR=`, which is `""` — present, not `undefined`. Every blank optional var failed boot validation, so importing `@/lib/env` threw on a clean checkout. | Any env var documented as "may be blank" needs a preprocess that maps `""`/`whitespace` → `undefined` before `.optional()`. Zod's `.optional()` only handles a missing key, never an empty value. |
| 2026-10-03 | `EMAIL_FROM` was validated with `z.string().email()`, which rejects `JobRadar <hi@jobradar.app>` — the exact format `docs/02` §7.1 documents. The schema made the documented value illegal. | When a doc specifies a literal example value, assert the schema accepts it. RFC 5322 display-name form needs a custom refine, not `z.string().email()`. |
| 2026-10-03 | OpenRouter's free tier returned **HTTP 429** on the very first rationale call, minutes after a successful embeddings call. Also `qwen/qwen3.8-27b:free` returned HTTP 200 with **empty content** on the first attempt. | Free OpenRouter tiers are rate-limited and intermittently return empty completions. Any caller must treat 429 as retryable, honour `Retry-After`, and validate non-empty content before parsing JSON. Never assume 200 means usable. Docs/04 §5.9 now records this. |
| 2026-10-03 | `@eslint/js` and `typescript-eslint` were imported by `eslint.config.mjs` but absent from `package.json`, so `pnpm lint` failed with "Cannot find package". Also `next lint` was still the script despite `next lint` being removed in Next 16. | When a flat config imports a package, verify it is in `devDependencies` before running the linter. A missing transitive is a config bug, not a lint failure. |

<!-- Sections: failed methods · broken loops · wrong-file waste · flaky tests -->

## Hard rules (escalated from repeat offences — see AGENTS.md Rule 1)

- **Do not start Phase 2 work.** Phase 2 is gated on `supabase db reset` succeeding (P0→P1) and
  BE tests green (P1→P2). With zero migrations and empty `src/types/`, neither gate can pass.
  Being asked to "plan and implement Phase 2" is not authorisation to invent FE components.
- **Never hand-write a stub to make a gate look passed.** No placeholder `SupabaseClient`, no
  mock `env`, no example migration. A green check with no output behind it is worthless.
- **`"latest"` in `package.json` is a bug, not a default.** 42 dependencies were unpinned,
  making CI builds non-reproducible. Pin exact versions; re-pin deliberately, never implicitly.
- **CRON_SECRET must be ≥ 32 chars** (Zod `min(32)`, verified constant-time). The committed
  placeholder `your_cron_secret_here` (19 chars) made `import { env }` throw at module load.
  Generate with `crypto.randomBytes(32)`, never hand-type.
- **Verify env against the real API, not just the schema.** The schema accepted both model ids;
  only a live call proved 2048 dims, the `:free` price, and the 429 behaviour. Schema-green is
  not integration-green.
- **Every doc'd literal value needs a test.** `EMAIL_FROM`'s documented example was rejected by
  its own schema for two sessions. Put doc examples in tests.
