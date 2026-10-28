# notes.md — AI failure log

Append one line when something wastes time. Delete entries that stop being true.

**Format:** `<!-- date --> | what happened | what to do instead`

## Failed methods

Approaches that didn't work — read before trying something similar.

| Date | What happened | Do this instead |
|---|---|---|
| 2026-10-03 | Split `env.ts` into `parseEnv()` + a thin binding and assumed the module-load throw was gone. `tests/unit/env.test.ts` still failed to collect: importing the file **evaluates** `export const env = bindProcessEnv()`, which reads `process.env` and throws. Splitting the *function* does not remove the *module* side effect. | When a module's side effect is at import time, the seam must be a **separate module** (`env/schema.ts` pure, `env/index.ts` binds). Test the pure file. Verify by running the suite — a "pure function" inside an impure module is still an impure import. |
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
| 2026-10-03 | `pnpm lint` reported a **fake failure** — PowerShell surfaced ESLint's stderr echo as `NativeCommandError` with a `ParserError`-looking wrapper, on a run that actually exited 0 with no findings. Nearly logged as a lint regression. | Judge ESLint by its exit code, not its wrapper's error record: `node node_modules/eslint/bin/eslint.js . ; $LASTEXITCODE`. On this machine PowerShell is 5.1 and turns *any* stderr write into an error record — `pnpm build` does the same thing to its ⚠ warnings. |
| 2026-10-03 | Used the `glob` tool to inventory the repo and concluded `.github/`, `src/lib/errors/` and `src/app/` did not exist. All three existed. `glob` silently returned a partial listing, and I nearly reported three files as missing. | Never inventory this repo with `glob`. Use `git ls-files` for tracked and `Get-ChildItem -Recurse` for on-disk. AGENTS.md Rule 0 already says this — this is the second time it cost a false claim. |

| 2026-10-05 | **Second transcript exposure, and this one the user did it, not me.** A Supabase **secret** key (`sb_secret_…` — the key that bypasses RLS entirely) was pasted into the chat while asking why Google sign-in was failing. Nothing was written to the repo, and no value was echoed back, but the transcript holds a live copy of the one credential that can read every row. | This is what the 2026-10-04 rule above predicts, and it happened again one day later. **A pasted credential is a rotated credential** — say so immediately, name the exact rotation path (Supabase → Project Settings → API Keys), and never repeat the value, not even to "confirm" it. Second-order lesson worth stating: **a Supabase secret key cannot fix a Google OAuth failure.** Provider config needs a *Google Cloud* OAuth client (id + secret) and an authorised `supabase login`; if the person reaching for a platform key is holding the wrong credential, fix the diagnosis before accepting the secret. |
| 2026-10-05 | `0001_init.sql` ran `create table if not exists auth.users` to imitate Supabase, assuming "if not exists" makes it a no-op on the real stack. It is not: the migration role has no CREATE privilege on schema `auth`, so the *whole migration* failed with SQLSTATE 42501 and zero tables were created. | Any DDL that might already exist on the real Supabase stack must be guarded by an existence check in a `DO` block (or dropped entirely when the platform owns the object). `if not exists` still requires the schema-level CREATE privilege — permission errors are checked before the existence shortcut applies. Verify with `supabase db reset` from empty, not with a successful remote push. |
| 2026-10-06 | **Read a diff's line count, pushed, and shipped data loss.** A docs-only commit reported `386 insertions, 344 deletions` for ~30 added lines. That ratio was the tell: PowerShell `Get-Content -Raw` + `Set-Content` had rewritten `docs/07-session-log.md` at a different encoding, turning every em-dash `—` in the file into `?`. I pushed it, then caught it only when re-reading the diff afterwards. Reverting also destroyed the intended appends, which then had to be redone. | **Read `git show --stat` before pushing, and sanity-check the numbers.** A docs append must be roughly additive; a 2:1 delete ratio means the file was rewritten, not appended. Root cause is the `Process` rule below about `Set-Content` round-trips — which was already written down and which I used anyway. Use the edit/write tool for every file edit and never pipe file content through PowerShell. |
| 2026-10-06 | Wrote migration `0007` ending `revoke all on function ... from public; grant execute ... to authenticated;` and believed it restricted the function. Supabase sets `ALTER DEFAULT PRIVILEGES` granting EXECUTE to `anon`/`authenticated`/`service_role` **per-role**, so revoking `PUBLIC` removed a grant that never existed. The ACL came back `{postgres=X/postgres,anon=X/postgres,...}` — anon could call it. A grant statement that silently does nothing is worse than no grant at all, because it reads as a decision. | **Verify grants by reading `pg_proc.proacl` / `has_function_privilege`, never by re-reading the GRANT.** A `revoke ... from public` is not a default-privilege revoke; revoke each role explicitly. Same class as the "guards must be able to fail" rule: assert the effect, not the statement. |
| 2026-10-14 | Wrote three idempotency tests for the feed actions and confirmed they pass — **against the old, broken code too.** The cause was not a weak assertion but the client double: its `single()` and `maybeSingle()` were the same terminal, so the distinction the tests depended on (PostgREST returns `PGRST116` on zero rows for `single()`, `null` for `maybeSingle()`) did not exist in the test world. Two more double defects hid behind it — `limit()` returned a terminal, so `.limit(1).maybeSingle()` was `TypeError: not a function`, and `is()` only existed one chain level down. | **A stub whose two methods are behaviourally identical makes a real defect invisible** — the new axis of "guards must be able to fail". After writing a regression test, revert the production fix and confirm the test *fails*: `.single()` restored over the `markApplied` upsert is the exact check that exposed it. Keep the double generic (`eq`/`is` any order, terminal decides row-vs-array, `then` so `await` works) instead of hand-rolling a chain per table. |

| 2026-10-14 | Closed the session claiming everything was verified at unit level because "the Docker daemon is down" — and the very first integration test found `job_events` has no `id` column, so `.select("id")` returned `42703` and **every save and dismiss 500'd**. 16 green unit tests sat on top of a completely broken query, because the double answers any column name. | **A stub that accepts any input cannot falsify a claim about that input's validity.** Column names, constraints and SQL semantics belong in `tests/integration/*.db.test.ts` against a live database, not in a double. When a claim is deferred for lack of a database, treat the whole feature as unverified — the double's green is not partial credit. Start Docker Desktop and run `pnpm db:reset` before calling any query-shaped work done. |
| 2026-10-14 | Hours after that fix, wrote an integration test seeding a `sources` row with `sources.slug` (that column is on `companies`) and `kind: "greenhouse"` (the enum is `api_greenhouse`). Both from memory of a similar table, both caught only by Postgres. | **Read the DDL before writing a fixture against a table you have not just read** — same failure as `job_events.id`, and the second time in one day. The lesson is not "tests are good", it is that *the database is the only authority on its own shape*, so a fixture is a schema assertion in disguise. `pg_policies` is not PostgREST-exposed either: assert the RLS outcome with a signed-in client, not the policy catalog. |
| 2026-10-14 | Shipped the feed with 26 green unit tests; it crashed on **100%** of real rows. `feedRowSchema` used `z.string().datetime()`, which rejects PostgREST's `timestamptz` output (`…+00:00`, 1–6 fractional digits). Same session also declared `skills` non-null on a nullable `text[]`, and `queryFeed` rethrew PostgREST errors into a server component that only handled one error case — so the whole thing surfaced as *"An error occurred in the Server Components render"*, a digest and nothing else. The user's browser console was the only symptom; I had "verified" it three sessions running. | **A client double returns the fixtures you hand it, so it can only ever confirm your assumptions.** 26 green tests proved the query *shape*; only the database proves the *values*. Any schema that validates a row coming back out of Postgres must be exercised by a `*.db.test.ts` running the real schema over real rows — and the double's fixtures must copy the format the database actually emits (`+00:00`, not `.000Z`), because otherwise the stub silently vouches for the wrong format. Second lesson: **an unhandled throw in a server component is a silent total outage.** Read paths return a typed error the page renders; they do not rethrow, because "digest only" is the most expensive possible failure mode. |
| 2026-10-14 | Three self-inflicted traps while writing the job-detail page, each caught by a different tool rather than by reading. (1) Wrote a regex character class containing a **literal NUL byte**, which made the file read as binary — `Read`/`Grep`/`Edit` all refused it and the `edit` tool could not match its own line. (2) `close === -1` on a `RegExp.exec` result, comparing a match array to a number: always false, so `close.index` threw a TypeError on every unterminated `<script>` — i.e. every truncated scrape, on the page the sanitiser exists to protect. (3) Asserted `expect(getByRole(...)).toBeUndefined()` in three places; `getByRole` **throws** when nothing matches, so the test would have passed for entirely the wrong reason. | **Never put a literal control character in a source file** — build the range from `String.fromCharCode` or use `\u` escapes; a literal NUL is invisible in review and turns the file into a binary blob no tool can edit. **Let `tsc` police your comparisons**: `exec()` returns `T \| null`, so `=== -1` and `close.index` are errors TS will name for you — read the compiler output rather than pattern-matching on `-1`. And **assert absence with `queryBy…`, never `getBy…`**; `getByRole` throwing is a pass-looking failure mode, the same class as the stub that agrees with anything. |

| 2026-10-18 | A migration was **already on the remote** and `supabase db push --dry-run` reported `"upToDate":true` with an empty pending list. I nearly pushed anyway, and then spent several calls hunting for a Postgres password to confirm the FK's *action* rather than its existence. There was no password in the environment, none in `supabase/.temp/`, and none in `.env.local`. | `supabase migration list` and `db push --dry-run` read `supabase_migrations.schema_migrations` on the remote — that is the **authority** on what is applied, and it uses the credential in Windows Credential Manager, so it works when the project's own keys do not. For what the schema *is* rather than what was *recorded*, `supabase gen types typescript --linked --schema public > tmp.ts` is read-only, needs no secret in hand, and answers nullability outright (`job_id: string | null`). Reach for it instead of hunting for a password. Corollary: a stale `sb_secret_` service key 401s against `/rest/v1/` **and** makes PostgREST's OpenAPI route return "Secret API key required" — that is a revoked key, not a permissions problem, and it means the e2e harness cannot reach the database at all. |

## Broken loops

Repeating the same mistake, or shipping something broken while claiming it worked.

| Date | What happened | Do this instead |
|---|---|---|
| 2026-10-04 | Marked **FND-005 "Completed"** in `docs/06` after running the *local* gates, and pushed. Three of its seven CI jobs failed on that first push: `pnpm audit --level=high` (not a pnpm flag — exits 2 on the typo, reads as a CVE), `secret-scan` (matched the literal word `supabase`, so it failed every build), and `e2e` (`tests/e2e/` held only `.gitkeep` → `No tests found`). | **A ticket whose deliverable is a workflow is not done until that workflow has run green.** Local `typecheck/lint/test` says nothing about a YAML file. Push, read the run, then write the completion claim — never before. Same class as notes.md's "up to date against zero migrations": a gate that was never executed is not a pass. |
| 2026-10-04 | Wrote a secret scanner as `grep -rE "(supabase\|sk-\|whsec_\|rk_live\|sb_secret_\|sb_publishable_)"`. It matched **names**, not **values**: `supabase` is the library name (in every chunk) and `sk-` matches `skipped`/`task-`/minified identifiers, so it failed on every clean build — while a real leak (`sb_secret_<actual key>`) was no better matched. It was in `docs/03` §4.1 as if correct. | A leak is a credential **value**. Match shapes requiring 20+ chars of key material after the prefix, and additionally exact-match the live `process.env` values — that catches *this* deployment's key whatever its shape. Then prove the gate both ways: plant a fake `sb_secret_<40 chars>` (must fail) and ordinary minified code containing `supabase`/`sk-` (must pass). A gate that cannot fail is as bad as one that always fails. |
| 2026-10-04 | Wrote the FND-005 bundle scanner to fix a grep that matched *names*. Then immediately **reintroduced the same class of bug one level up**: it also flagged the bare string `SUPABASE_SERVICE_ROLE_KEY` in the *server* bundle. Wiring `auth/callback/route.ts` to import `@/lib/env` made the Zod schema bundle into server output — where the key `SUPABASE_SERVICE_ROLE_KEY:` legitimately exists — so the gate failed on a variable that route never reads. | Three tiers, and the tier is the point: **client** bundle → credential values *and* bare names (a name there means the import boundary is gone). **Server** output → credential *values* only; the server bundle is *supposed* to contain the contract that names every variable. A bare identifier is not a secret. After any change to what gets bundled, re-run the scan — it was green one command earlier and red the next, which is what exposed this. |
| 2026-10-04 | `playwright.config.ts` read its base URL with `??`. CI passes `${{ vars.PLAYWRIGHT_TEST_BASE_URL }}`, and GitHub expands an **unset** repo variable to `""`, *not* `undefined` — so `??` did not fall through. `baseURL` became `""`, the localhost regex failed, `webServer` was omitted, no dev server booted, and all 18 e2e tests died on `Cannot navigate to invalid URL`. This is the **second** occurrence of blank-vs-undefined in this repo; the first was Zod `.optional()` ignoring `""` (2026-10-03, row above). | Any value coming from a `.env` file **or a CI `vars:`/`env:` expression** must be normalised with a `firstNonEmpty(...values)` helper that trims and skips `""` — never `??`. `??` and `.optional()` both treat `""` as present. When a config bug is suspected, reproduce it with the literal the CI system actually produces, not with a deleted variable. |
| 2026-10-04 | A revert-edit left **two** `secret-scan:` job blocks in `ci.yml`. GitHub rejected the file at parse time, so the run finished in **0s with zero jobs and no log**. Nothing caught it: lint doesn't read YAML, typecheck doesn't, tests didn't — and my verification, `python -c "yaml.safe_load(...)"`, **passed**, because PyYAML's default loader silently keeps the *last* value for a duplicate key. I had "verified" the workflow five times and shipped an invalid one. | Duplicate mapping keys must be treated as an error, and the check belongs in `pnpm test` — `tests/unit/workflow-yaml.test.ts` parses the workflows with a hand-rolled duplicate-rejecting loader, because a config gate that only runs on my machine is not a gate. When validating YAML, **assume the default loader is too permissive**; prove the checker catches a known-bad input before trusting a pass. |
| 2026-10-04 | Claimed twice, in a code comment and then in a commit message, that `next build` **succeeds** without env vars because "Next does not evaluate dynamic route modules at build time." Both claims were wrong. `next build` runs a "collecting page data" pass that evaluates route modules, so it fails with `Failed to collect page data for /auth/callback`. My test was invalid: I cleared `process.env` but left `.env.local` in place, and Next auto-loads it, satisfying the schema. The third CI run then failed for exactly the reason I had denied. | To test an env-dependent failure, **move `.env.local` aside** — clearing `process.env` proves nothing, for both `next build` and `next start`. And never write a timing claim ("fails at build", "fails at boot") you have not executed with the inputs genuinely absent. Two of my three assertions this session were of this kind and both were false. |
| 2026-10-04 | Shipped `.github/workflows/deploy.yml` on the first push as if deploy were configured. It was dead on arrival **twice over**: it required `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`, none of which were set (no Vercel project even existed), so every push died on `Input required and not supplied: vercel-token`; and `deploy-preview` was gated on `github.event_name == 'pull_request'` inside a workflow whose only trigger was `push`, so it could never run even with the token present. I committed it as part of a "Completed" ticket without ever reading the run. | A workflow step that references three secrets you have never created is not configured — **read the step's `if:` conditions and its `with:` inputs against the trigger block before committing it**. And prefer the platform's native integration over a third-party action: Vercel's Git integration needs no YAML and no long-lived account token, so `deploy.yml` was deleted rather than repaired. Storing a Vercel account token beside the service-role key in repo secrets widens the blast radius for a deploy that the platform already does for free. |
| 2026-10-04 | **A helper script printed live credential values into the conversation transcript** — the Supabase service-role key, the OpenRouter key, and `CRON_SECRET` went to stdout while I was reading `.env.local` to push them to Vercel. The repo itself stayed clean (gitleaks clean across full history, no value in any tracked file, `.env.local` gitignored) — but the transcript is now an exposed copy of the one key that bypasses RLS. | Never print a credential to stdout, even locally, even to "check" it. Read it and write it where it belongs in the same command. When you must *reference* a value, print `length` and the first 6 chars of the prefix only. **Exposure of a secret in a log, transcript, or CI output counts as a leak even when the repo is clean** — rotate per `docs/03` §4.4 and record the date, rather than reasoning that the repository has no copy. |
| 2026-10-04 | `/auth/callback` read `process.env.NEXT_PUBLIC_SUPABASE_URL!`. The `!` asserted a value that nothing had checked, and the first production deploy returned an opaque `500`: `Error: Your project's URL and Key are required to create a Supabase client!` — naming none of the missing variables, so the operator has no idea which of five config values is wrong. | A non-null assertion on `process.env` converts a *configuration* error into a *runtime* error with useless copy. Import `env` from `@/lib/env` instead: Zod reports every missing or malformed variable by name at once. Any place where `process.env.X!` appears in `src/` is a latent version of this bug. |
| 2026-10-04 | Node was pinned in **four independent places** — `.nvmrc`, `ci.yml`, `package.json` `engines`, and the Vercel dashboard — all of which had to be moved 20 → 24 by hand. Nothing failed, which is exactly the problem: the next drift produces a "works in CI, fails in prod" bug with no signal that the versions ever diverged. | One source of truth per setting. CI reads `env.NODE_VERSION` at workflow level and every `setup-node` reads it (`tests/unit/workflow-yaml.test.ts` asserts no job hardcodes a version). A value that must be edited in N places has already been wrong in at least one of them. |
| 2026-10-04 | Ran `pnpm test` first on a brand-new file: **105 passed**. Then ran the documented order and got `typecheck exit=2` and `lint exit=1` on that same file — missing `import { describe, expect, it } from "vitest"` (there are no vitest globals in this repo's tsconfig), `Array<T>` instead of `T[]`, an implicit `any`, and a `String(x)` on an object. Green tests had told me nothing about either gate. | **Run gates in the documented order, `typecheck → lint → test`, and never substitute one for another** — they check disjoint properties, and `vitest` resolves types and ignores ESLint rules that `tsc` and `eslint` enforce. A new test file is the single most likely file in the repo to fail the other two gates, because it uses APIs the compiler does not see as ambient. |
| 2026-10-04 | Wrote a duplicate-key-rejecting YAML parser to catch a bug that had shipped — and its first run failed on **valid** YAML, because it treated `needs: [lint, typecheck, test]` as the literal string `"[lint, typecheck, test]"`. The ordering assertion then compared a string against an array. A checker that rejects the file it is supposed to protect is no better than one that accepts everything. | A checker must cover the syntax the target file **actually uses** — inspect it before writing the parser, and when an assertion fails, suspect the parser first. Then prove it both ways: feed it the known-bad input (must throw) *and* the real file (must pass). I only had the second until the test failed. |
| 2026-10-04 | Fixed a one-space misalignment in the `docs/02a` ER diagram with `Set-Content`, which silently **rewrote the whole file** and destroyed every UTF-8 box-drawing character — 86 U+FFFD replacement chars, `─` gone from all 10 diagram lines. PowerShell 5.1's `Get-Content`/`Set-Content` round-trip is not UTF-8-safe. The `read` tool showed the damage, but I nearly dismissed it as console mojibake, because these docs display as mojibake even when healthy. | **Never round-trip a repo file through `Get-Content`/`Set-Content`.** Use the `edit` tool for text edits. Verify encoding by counting U+FFFD at the byte level — *not* by whether the console renders the glyphs, which it never does: `[System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($f))` then `([regex]::Matches($t,[char]0xFFFD)).Count`. Recovery is `git checkout -- <file>`, which is why the edit should be small and re-appliable. |

## Wrong-file waste

Editing the wrong file, or trusting a stale path.

| Date | What happened | Do this instead |
|---|---|---|
| 2026-10-03 | Believed `docs/07`'s "WSL2 is not installed / Docker cannot run — the only hard blocker" and carried it forward as fact. WSL2 had been installed since; the engine simply wasn't running. | A plan document's environment findings decay exactly like its code findings. Re-run the environment probes (`wsl -l -v`, `docker version`, `git remote -v`) before repeating a blocker claim to the user — and distinguish **Client** vs **Server** version: a working client with no server is "not running", not "not installed". |

## Flaky tests

Non-deterministic test behaviour — intermittent failures, order-dependent results.

| Date | What happened | Do this instead |
|---|---|---|
| 2026-10-04 | `playwright.config.ts` baseURL bug (see Broken loops) caused all 18 e2e tests to fail intermittently depending on whether `PLAYWRIGHT_TEST_BASE_URL` was set. The tests themselves were fine; the config made them order-dependent on environment state. | When tests fail only in certain environments, suspect the config before the tests. A test that passes locally but fails in CI is not flaky — it is environment-dependent, and the fix belongs in the config, not the test. |
| 2026-10-16 | `tracker.spec.ts`: 2 of 8 failed at `--workers=1`'s default (parallel), 0 of 8 at `--workers=1`. The failing stage moves left the card in its original column with **no** error on the page. Cause: the server action call *rejected*, so `result` was never assigned — a silent no-op. `next dev` under 8 concurrent browsers drops server-action POSTs. CI already pins `workers: 1`, so CI never saw this. | `next dev` under parallel e2e load is not a reliable target. Verify suspicious parallel failures with `--workers=1` before treating them as product bugs — and catch rejected server actions, because a thrown action leaves the UI looking like the click did nothing. |
| 2026-10-16 | **Repeated a second documented rule in the same session.** The 2026-10-06 row says *"use the edit/write tool for every file edit and never pipe file content through PowerShell"*. I read that, then used `[System.IO.File]::ReadAllText` / `WriteAllText` to do a two-line string replacement in `tests/e2e/tracker.spec.ts` — the same read-modify-write hazard, just spelled with the .NET overloads instead of `Set-Content`. No damage (the file was new and BOM-less, and `git diff` confirmed em-dashes and `→` intact), which is exactly what makes it worth writing down: the rule was breached for convenience and the outcome happened to be benign. | A rule phrased around one *spelling* is not a rule. It named `Set-Content`; I found another way to do the same thing, so in my judgement the rule did not apply — which is how a hazard survives being documented. Rules about *how* to do something must name the class of operation ("never round-trip a file through a shell"), not one function. The 2026-10-06 row is promoted into a `### Process` hard rule; the check is `git diff --numstat` on every edited file. |
| 2026-10-16 | **Repeated a rule already in this file.** The "kill the old listener first" check was already recorded, and I skipped it three times. I checked port 3000 once early (free), then restarted Docker Desktop — which invalidated that check — and ran the suite anyway. `reactive-resume-app-1`, an unrelated project's container, published 127.0.0.1:3000 when Docker came back and returned HTTP 200 with 120 bytes of its own. `reuseExistingServer` trusted it, so all 8 specs loaded a foreign page and failed on `locator.waitFor` timeouts — a **phantom regression I then investigated at length**, treating an environment artefact as a code defect. | A check performed once does not stay true. Anything that can invalidate it — a Docker restart, a branch switch, a port change — means re-run it, not assume it. And "I know this rule" is not the same as obeying it, so make the harness enforce it where you can: `reuseExistingServer` is now `false`, turning a squatted port into a loud startup failure instead of a quiet wrong-target run. |

## Hard rules

Escalated from repeat offences. Each rule is a check you run, not a sentiment. Incident
detail lives in the tables above; here is only the rule and its trigger.

### Security

- **Secrets are matched by value, never by name — except in the client bundle**, where a
  bare name is itself the leak (the server bundle legitimately names every env var).
  Test the scanner both ways: planted secret fails, minified noise with `supabase`/`sk-` passes.
- **Never print a credential to stdout, a transcript, or a log.** Refer to a value by its
  length and prefix. Exposure outside the repo counts as a leak: rotate (`docs/03` §4.4),
  record the date.
- **`CRON_SECRET` ≥ 32 chars**, generated (`crypto.randomBytes(32)`), never typed by hand —
  a 19-char placeholder made `import { env }` throw at load.
- **No `process.env.X!` in `src/`.** The `!` turns a config error into an opaque runtime 500;
  import `env` from `@/lib/env` so Zod names every missing variable.
- **No service-role fallback.** A "temporary" service key in a user-scoped action silently
  disables RLS while queries keep returning rows — `src/lib/db/user-client.ts` throws instead;
  don't route around it.

### Process

- **`docs/02a-schema.md` is NOT valid UTF-8 — edit it byte-level or you destroy it.** A 35-line
  append turned into 178 insertions / 108 deletions because I read it with `readFileSync(f,
  "utf8")` and wrote it back the same way. Node decodes each invalid byte to U+FFFD on read, so
  the write replaces the original bytes with EF BF BD and re-normalises every other line. This is
  the same failure as the 2026-10-06 `docs/07` loss, and it survived because **U+FFFD count
  cannot tell you which kind of damage you have**: `docs/06` also has 30 U+FFFD but is *valid*
  UTF-8 with replacement chars already baked in, so a normal utf8 edit there is lossless. The
  only reliable test is the round trip —
  `node -e "const b=require('fs').readFileSync(F);console.log(Buffer.from(b.toString('utf8'),'utf8').equals(b))"`
  — and the only safe edit is latin1 in and latin1 out (a 1:1 byte↔codepoint map), with the
  inserted block pure ASCII. Currently `02a-schema.md` is the **only** file in `docs/` that
  fails that test; re-run the check before editing any doc, not just this one. See
  "Schema-green is not integration-green" for the sibling lesson: the diff *shape* is the tell.
- **Never round-trip a file through PowerShell. Use the edit/write tools.** Trigger: any file edit.
  Run: `git diff --numstat <file>` afterwards — a docs append is roughly additive, and a rewrite
  shows a large delete ratio. This bans `Get-Content -Raw` + `Set-Content`, `Add-Content`,
  `[System.IO.File]::ReadAllText`/`WriteAllText`, and `WriteAllLines` — the .NET overloads are the
  same hazard as the cmdlets, and using them instead is not a way around the rule. Two separate
  reasons, both learned the hard way:
  - **Encoding.** `Set-Content` on PowerShell 5.1 defaults to a code page that mangles `—`, `→`
    and `’`. `[System.IO.File]::WriteAllText(path, text)` without an explicit encoding writes
    UTF-8 **without** BOM and will strip one. Both silently rewrite the whole file.
  - **Diff shape.** Even when the bytes survive, a read-modify-write is invisible as an edit and
    destroys concurrent changes, which is how the `docs/07` append was reverted and redone.
  Provenance matters: `notes.md` already recorded this after losing `docs/07-session-log.md` on
  2026-10-06, and the repeat on 2026-10-16 used the .NET overloads specifically because the rule
  named `Set-Content` and not the class of operation. A rule phrased around one spelling is not a
  rule.
- **Restore with `git checkout` before re-applying, and take the backup BEFORE the mutation.**
  Two self-inflicted losses in one session: a restore script that read a file into a PowerShell
  variable, had the variable come back null, and then wrote null over the source; and a
  perturb-and-restore helper whose "original" was captured *after* the edit, so it faithfully
  restored the broken value. Both looked like working scripts. Assert the backup is non-empty
  before writing, and never let a restore depend on a value read in the same breath as the
  mutation.
- **A docs append is roughly additive.** `git diff --numstat` is the check. A large delete
  ratio means the file was rewritten, not edited — which is how the `02a` corruption was caught
  after the fact, and how the 2026-10-06 `docs/07` loss was caught.
- **Schema-green is not integration-green.** Before relying on an API assumption (price,
  dimensions, 429 behaviour), make the live call once. A client double **accepts any input**,
  so it cannot falsify a claim that the input is valid: `.select("id")` against a table with
  no `id` column passed 16 green unit tests and failed `42703 undefined_column` on every real
  request. Column names, constraint behaviour and SQL semantics are asserted against a live
  database, never against a stub.
- **A double also vouches for the format you imagine.** Trigger: any schema validating a value
  that comes back out of Postgres. Run: `pnpm vitest run tests/integration/<area>.db.test.ts`
  with the production schema over production-shaped rows. Pointer: `z.string().datetime()`
  rejects PostgREST's `timestamptz` (`…+00:00`, 1–6 fractional digits — Postgres strips
  trailing zeros); use `dbTimestampSchema` from `src/types/db.ts`, and copy the *real* format
  into unit fixtures so the double stops agreeing with itself. 26 green feed tests once hid a
  100%-failure row schema behind `.000Z` fixtures.
- **Never let a read path rethrow into a server component.** Trigger: `throw error` on a
  PostgREST failure, or an error branch no page handles. Run: `pnpm typecheck`, then read the
  page for a branch that renders the typed error. Pointer: an unhandled throw there is a
  total outage whose only symptom is Next's *"An error occurred in the Server Components
  render"* plus a digest — so return `{ error }`, `logger.error` the real cause, and let the
  page say which thing failed.
- **A gate that never opens a connection cannot see the database.** Trigger: adding a
  migration, or any claim that "the schema is fine". Run:
  `pnpm exec vitest run tests/integration/schema-drift.db.test.ts` with `TEST_SUPABASE_URL`
  set — point it at whatever the app points at. Pointer: `migration-drift.test.ts` is static
  (it greps SQL text) and happily reported green while the configured database was three
  migrations behind, for three days. Static checks and live checks answer different questions;
  a repo needs both, and only the live one notices the database moved.
- **`as never` on a column value deletes the compiler's only opinion.** Trigger: an insert or
  select through the **untyped** Supabase client (`createClient` with no database generic)
  where the column is constrained in Postgres. Run: `pnpm typecheck`, then grep for
  `as never` and delete it — if the code needs the cast, the code is wrong, not the type. Pointer:
  `/api/cron/enqueue` wrote `kind: row.kind as never`, which is how `kind: "scrape_source"`
  shipped against a `task_kind` enum that has never contained it. Every enqueue failed with
  `invalid input value for enum task_kind` and **ingestion never ran a single task** — with
  typecheck, lint and 994 tests green. A value constrained by a Postgres enum has exactly one
  legal vocabulary; derive it from the schema (`taskKindSchema.options`) and let the mismatch
  be a compile error. `tests/unit/queue-kind-vocabulary.test.ts` pins it.
- **Execute the feature, don't just compile it.** Trigger: any claim that a route, worker or
  handler "works". Run: curl it — `GET /api/cron/enqueue` with the cron secret, then
  `/api/cron/process`, then count the rows the feature is supposed to produce. Pointer: this is
  the same rule as the feed's `.000Z` fixtures and the stale remote, one layer up: a unit suite
  proves the code agrees with itself, a curl proves it agrees with the world.
- **Before any run that needs a server, check that the thing on the port is yours.** Trigger:
  `pnpm dev`, `pnpm start`, **or `pnpm exec playwright test`** — anything that binds or *reuses*
  localhost:3000. Run: `Get-NetTCPConnection -LocalPort 3000 -State Listen`, then confirm the owning
  process is the `next dev` you started; otherwise free it first. **Re-check after anything that
  restarts Docker, and do not carry a check forward across such a change** — the whole point is
  that it goes stale. Why this is separate from the rule above: `reuseExistingServer` cannot tell
  *what* is answering on 3000, so a foreign listener turns every assertion into a test of the wrong
  server and the failure looks exactly like a code regression.
  Pointer: `playwright.config.ts` now sets `reuseExistingServer: false`, so a squatted port fails
  loudly at webServer startup instead. The config now enforces the rule; the check is still yours to
  run before a manual curl.
- **`"use server"` files export async functions and nothing else.** Trigger: exporting a const,
  type re-export or helper from any file with the `"use server"` directive. Run: `pnpm build` —
  typecheck and lint both pass, because this is a *Next* rule, not a TypeScript one, so it only
  surfaces at build: *"Only async functions are allowed to be exported in a 'use server' file."*
  Pointer: put the constants in `src/lib/<area>/constants.ts` and import them into the action.
  Corollary for components: the same applies to `page.tsx`, which may only export the default
  component — so a page cannot export a shared constant either.
- **A "use client" component must not `.from()` directly.** Trigger: reaching for a Supabase
  client inside a page or component. Run: `pnpm lint` — `@typescript-eslint/no-unsafe-*` fires
  on every column, because the client is untyped and the read returns `any`. Pointer: docs/06 §8.1
  already forbids it; put the read in `src/lib/db/queries/` behind a Zod schema. The lint rule
  and the architecture rule are the same rule, which is the nice part.
- **`fill()` needs a `click()` first on WebKit.** Trigger: a Playwright spec that fills a React
  controlled input and then reads component state (a chip appearing, a button becoming enabled),
  especially in `tests/e2e/`. Run: `pnpm exec playwright test <file> --project=mobile-safari
  --workers=1`. Symptom: the DOM value is right, the state is empty, and the assertion fails on
  `mobile-safari` while passing on chromium and mobile-chrome. Cause: React's controlled-input
  tracker never sees a change when nothing focused the field. Pointer: use the `fillInto()` helper
  in `tests/e2e/onboarding.spec.ts`; the measurement table is in its docstring. **Never write this
  off as "flaky on Safari"** — that is how a one-browser failure becomes a permanent mystery.
- **A parallel suite's cleanup belongs in `globalSetup`, not `beforeAll`.** Trigger: any test or
  fixture that deletes shared state (users, rows, files) while other tests may be using it. Run:
  the suite with default workers, not `--workers=1`. Symptom: `User from sub claim in JWT does
  not exist`, or a cascade of unrelated locator failures — because one worker deleted another's
  data mid-test. `fullyParallel: true` means `beforeAll` runs **once per worker**. Pointer:
  `tests/e2e/support/global-setup.ts`.
- **Test fixtures cannot be torn down from inside a test.** Trigger: wanting `test.afterEach()` in
  a `signIn()` helper. Run: the test fails immediately with *"Playwright Test did not expect
  test.afterEach() to be called here."* Pointer: make it a fixture — `tests/e2e/support/fixtures.ts`.
  The bonus is that a test which never binds the fixture never creates a user, so the signed-out
  spec stays signed out without opting back out.
- **Verify the claim, not the components.** Trigger: saying a feature "works" or "is usable" after
  unit and component tests pass. Run: drive it in a browser with a real session — Playwright spec,
  or curl. Pointer: docs/06 Phase 2 gates on *"Playwright E2E green against unstyled UI:
  onboarding → feed → apply → stage move"*. A component test renders a component with props; it
  cannot see a server action that 400s, a signup trigger that never fired, or a counter nothing
  writes. The wizard had 43 green tests and a resume feature that lost its state on navigation.
- **`admin.generateLink` does not give you a `?code=` link.** Trigger: building an E2E sign-in
  around the Supabase admin API, then following `action_link`. Symptom: the browser lands on
  `/auth/auth_code_error` while holding `#access_token=…` in the **fragment**. Cause: it mints an
  implicit-flow link; only `signInWithOtp` from a browser registers a PKCE challenge. Pointer:
  `tests/e2e/support/auth.ts` — real `grant_type=password` tokens with the cookie written by
  `@supabase/ssr`. This is a harness limitation, not a callback bug; do not "fix" `/auth/callback`.
- **A queue reap must respect every unique index on the table, not just `status`.** Trigger:
  writing or changing a `task_queue` UPDATE — the reaper in `claim_tasks`, the requeue in
  `rescore-store.ts`, anything with `where status = 'running'`. Run: build the state the enqueue
  path is designed to prevent (here: one stale `running` row **plus** one `pending` row for the
  same profile), then call `claim_tasks` and expect no error —
  `pnpm vitest run tests/integration/claim-reaper.db.test.ts`. Symptom when it is wrong:
  `duplicate key value violates unique constraint "idx_task_queue_one_pending_rescore_per_profile"`.
  Cause: `claim_tasks`'s reap raised `23505` on the **first statement of the function**, so the
  whole transaction aborted and `/api/cron/process` returned `500 {"error":"claim_failed"}` for
  *every* task, *every* user, forever — the reap that causes the wedge is the code meant to clear
  it. Pointer: `0013_reaper_guard_and_orphan_cleanup.sql` and docs/02b §6.4. **Unit tests cannot
  catch this class** — it needs two rows in a state the enqueue path prevents.
- **A jsonb payload column cannot cascade.** Trigger: storing a reference in `task_queue.payload`
  (or any jsonb) and expecting `delete user` to clean it up. Symptom: the worker keeps claiming
  tasks for profiles that no longer exist; the queue grows without bound. Run: after a test run,
  count tasks whose `payload->>'profile_id'` has no matching `profiles` row. Pointer: migration
  `0013`'s purge, `tests/e2e/support/auth.ts` clearing tasks before deleting a user, and the
  "Still open" note in docs/02b §6.4. Do not claim this is fixed — only that the harness no
  longer makes it worse.
- **A failure that aborts a shared transaction takes down unrelated work.** Trigger: any `UPDATE`
  at the head of a multi-statement function that all callers depend on. Ask: "if this raises,
  what *else* stops working?" Here the answer was "scoring, for everyone, permanently" — which is
  why a single bad row is a severity-1 incident rather than a retry. Pointer: the two-statement
  reap in `0013`, where the guard is per-profile so one profile's bad state cannot block another's.
- **A cursor over a non-unique column silently drops rows.** Trigger: any `lt`/`gt` cursor on
  `posted_at`, `created_at`, `updated_at`, or anything else a tie is possible on. Run: count the
  distinct values — `select posted_at, count(*) from jobs group by 1 having count(*) > 1` — then
  check scored-vs-total per profile. Symptom: a loop that never drains, or a total that is short by
  exactly the size of the largest tie group. Measured: 291/306 scored, 30 jobs sharing one
  `posted_at`, 15 lost. Cause: `lt(posted_at, cursor)` skips every row sharing the cursor's value.
  Pointer: the composite cursor in docs/02b §6.4 — `posted_at < C OR (posted_at = C AND id > I)`,
  so `(posted_at, id)` is a total order and every row is visited exactly once.
- **A paginating loop needs a termination test, not just a progress test.** Trigger: a batch
  handler that re-enqueues itself. Symptom: `verdict` is always the requeue variant and the queue
  never empties. Cause: completeness was `jobs.length >= total`, where `total` counts the whole
  corpus rather than what remains after the cursor, so an exhausted cursor read as "incomplete".
  Pointer: a short page (`jobs.length < batchSize`) is proof of exhaustion because `LIMIT` is
  applied *after* the filter. **Watch the real queue, not the unit tests** — the planner was fully
  green while production logged `"verdict":"requeue"` every minute for hours.
- **An insert whose error is ignored is a silent data loss.** Trigger: `await supabase.from(...).insert(...)`
  with no `{ error }` destructure, especially against a table with a unique index. Symptom: work
  vanishes and nothing says so. Pointer: `rescore-store.ts` `requeue()` — now logs, because the
  partial unique index makes that insert collide routinely and benignly, which is exactly the case
  an ignored error hides best.
- **Adding a positional parameter to a seam with test doubles breaks them silently.** Trigger:
  inserting a parameter into any signature that a `vi.fn()`/stub implements — especially
  *between* two existing ones. Symptom: the double receives the wrong argument, every call
  returns empty, and the failures land in ten unrelated tests with no mention of the signature.
  Run: after widening a seam, `pnpm vitest run <the double's test file>` and read the *first*
  failure, not the count. Pointer: `RescoreStore.listJobs` now takes
  `{ cursor: RescoreCursor | null; limit: number }`, and `RescoreCursor` is
  `{ postedAt: string; id: string | null }`. Note what the fix does and does not buy: a strict
  `toEqual` on the call shape still fails, and should — the gain is **where** it fails. Verified
  both ways: adding a *field* to the options object left the stub working and produced only two
  named contract failures; adding a *positional parameter* produced ten silent zero-score ones.
- **PowerShell 5.1 on this machine.** No `&&` (use one command per line, or `;`), and
  `supabase` is not on PATH — use `pnpm exec supabase …` or `node_modules\.bin\supabase.cmd`.
  Also: judge `eslint`/`build`/`supabase` by `$LASTEXITCODE`, not by the red stderr, because
  the PowerShell wrapper turns an upgrade notice into `RemoteException`.
- **Docs' literals are tests' inputs.** If a doc shows an example value, the schema/code
  must accept it — assert it in a test, don't re-read it.
- **`""` is a value.** `??` and Zod `.optional()` both accept it; `.env` and CI `vars:`
  produce it for unset. Normalise with `firstNonEmpty()` before defaulting.
- **A YAML/CI claim is data, read from the run.** `conclusion` via `--json`, not the glyph.
  A locally-"verified" workflow is unverified: duplicate keys, unset secrets, dead `if:`/trigger
  combos only surface in the real run — so config gates live in `pnpm test`, proven by feeding
  a known-bad input to a real file.
- **Benchmark the claim against a genuinely-absent input.** To test an env-dependent failure,
  move `.env.local` aside; clearing `process.env` proves nothing because Next auto-loads it.
- **Pin every version.** One source of truth per setting (`env.NODE_VERSION`, asserted in
  `tests/unit/workflow-yaml.test.ts`); `"latest"` in package.json is a bug.
- **Guards must be able to fail.** A checker that can't reject its own file is decoration —
  prove it rejects known-bad *and* accepts the real target, always both directions. The same
  applies to a **stub whose two methods behave identically**: after a regression test, revert
  the production fix and confirm the test fails before trusting it. And check the *test* can
  fail under the environment it runs in: "local midnight ≠ UTC midnight" passes under `TZ=UTC`
  against both implementations, so pin a non-UTC `TZ` before believing it.
- **Tables and regexes are transcribed programmatically.** Never hand-copy literals between
  files or reverse them by typing; script it and assert the order.
- **`\b` stops at word characters.** A token ending in punctuation (`C++`, `C#`) needs a
  negative lookahead; when any literal ends in punctuation, audit every `\b` guard.
- **Two sessions, one tree = silent loss.** Check `git status` for files you didn't create
  before and after writes; commit early. Never edit through PowerShell `Get-Content`/`Set-Content`
  round-trips (UTF-8-lossy) — use the edit tool.
- **Review the diff before every push** (Rule 5). Run `git show --stat` and read the diff, then
  fix what you find. Check the numbers against the change: a docs *append* is ~additive, so a
  large delete ratio means the file was rewritten (encoding loss), not edited. This is per-iteration,
  not per-milestone — the 2026-10-06 encoding loss shipped in a commit whose own stat line announced it.
- **Doc numbers are counted, not estimated.** Any number in docs is derived or asserted
  (`tests/unit/doc-drift.test.ts`), never typed from memory.

### Config

- **One source of truth per setting.** A value edited in N places is wrong in at least one;
  give it one owner and assert the rest derive from it.

### Schema

- **A snapshot column is not a fallback while its FK still cascades.** Trigger: any table holding a
  `*_snapshot jsonb` alongside a foreign key to the live row (check `applications.job_id`). Run:
  `pnpm vitest run tests/e2e/tracker.spec.ts -t "hard-deleting"` after changing either. **Resolved
  2026-10-18 by `0016`** — `applications.job_id` is now `on delete set null`, so `job_snapshot`
  really is the fallback. The rule survives as the *method*, because it is the class of defect that
  hides: a documentation claim ("keeps rendering the role after the source deletes it") that the
  schema made impossible, discovered only because someone wrote the obvious test and it failed
  against correct code. Two things it cost: **the claim was cited to the wrong row.** `mark-applied.ts`
  called it "X-16", but `docs/03` X-16 is *résumé* deletion; the job-deletion case is the
  "Deleted job while an application references it" row in `docs/03` §5.2. A wrong anchor is a
  claim nobody can check. **When a comment cites a doc row, open the row.** And when the fix is a
  schema change, the gate has to be one the schema cannot fake — a component test renders from
  whatever props it is handed, so it passes against `cascade` and `set null` alike; only
  `*.db.test.ts` can tell the two apart.

- **A `SECURITY DEFINER` function that writes a row must filter on `user_id = auth.uid()`
  explicitly.** Trigger: any definer function taking a row id. Run:
  `pnpm vitest run tests/integration/move-application.db.test.ts`. Definer bypasses RLS, so the
  policy does not protect it, and Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`.
  Report "not found" for unowned *and* missing rows so the function is not an existence oracle.

### UI behaviour

- **A server action that rejects must say so.** Trigger: any `await someAction()` whose result is
  checked. Run: a test that asserts the failure path renders `role="alert"`. A rejected action never
  assigns `result`, so the branch that reports `{ok:false}` is never reached and the UI looks like
  the click did nothing — silent, and indistinguishable from a slow render. Wrap the call and
  `catch`.

- **A stage/pipeline rule lives in SQL, mirrored in TS only for the UI, and the two are pinned.**
  Trigger: duplicating any rule that SQL enforces (`move_application`'s transitions). Run:
  `pnpm vitest run tests/unit/application-stages.test.ts`, which parses the `raise exception`
  guards out of the migration. Read the guard's direction carefully — `to_stage not in (...)`
  **raises**, so the listed values are the permitted set.

- **A `CREATE OR REPLACE FUNCTION` must reproduce the parameter list exactly, order included.**
  Trigger: replacing an existing function. Run: `pnpm db:reset` and confirm the migration applied.
  A different order does not replace — it adds an overload and leaves the original callable. A
  defaulted parameter in the wrong position fails outright (SQLSTATE 42P13).
