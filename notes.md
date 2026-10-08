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
  dimensions, 429 behaviour), make the live call once.
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
  prove it rejects known-bad *and* accepts the real target, always both directions.
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
