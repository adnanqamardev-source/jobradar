#!/usr/bin/env tsx
/**
 * scan-bundle-secrets.ts — the FND-005 client-bundle secret gate.
 *
 * docs/02 §4 rule 1: "The service-role key never crosses the client boundary." This is the
 * check that proves it, and it runs on the built output rather than on source, because the
 * only thing that matters is what a browser can actually download.
 *
 * ## Why this is a script and not a `grep` one-liner
 *
 * The version this replaces was:
 *
 *     grep -rE "(supabase|sk-|whsec_|rk_live|sb_secret_|sb_publishable_)" .next/static/chunks/
 *
 * That predicate can only ever do one of two things, and neither is "detect a secret":
 *
 *   1. **Always fail.** `supabase` matches the library name, which is in every page chunk.
 *      `sk-` matches `skipped`, `task-`, any minified identifier ending in those two
 *      characters. Verified: 18+ files matched on a build with no secret in it at all, and
 *      the CI job failed on every run.
 *   2. **Miss a real leak.** It greps for *names*, not *values*. `sb_secret_<the actual key>`
 *      is what a leak looks like; the bare prefix `sb_secret_` appears in any redaction
 *      helper, including this file's own source.
 *
 * A gate that always fails trains the team to ignore it, which is worse than no gate. So the
 * rules below match credential **values by shape**, and — the part a grep can never do — they
 * compare against the **actual secret values** in the environment. A leak of *this*
 * deployment's key is caught by exact match even if its shape is unfamiliar.
 *
 * ## Why TypeScript
 *
 * Because this file *is* the gate. A typo in a path or a regex that fails to compile would
 * otherwise turn the check into a no-op that reports success. `.mjs` would be outside
 * `tsconfig.json` and therefore outside `pnpm typecheck`.
 *
 * ## Scan boundary — three tiers, because "secret" means different things per tier
 *
 *   `.next/static/` (client bundle) — every credential shape, **plus** bare-name references.
 *                    Anything here is downloadable by any visitor, so even the *name*
 *                    `SUPABASE_SERVICE_ROLE_KEY` is a finding: reading that variable at all
 *                    client-side means the `lib/db/admin.ts` import boundary is already gone.
 *   `.next/server/` (server output) — service-role credential *shapes* only, **no name checks**.
 *                    Server output is *supposed* to contain the env contract, and that contract
 *                    names every variable by definition. Bare-name matching here produced a
 *                    false positive as soon as one route imported `@/lib/env`, failing the gate
 *                    on a variable that route never reads.
 *
 * The lesson, having got this wrong twice: a bare identifier is not a secret. Match values
 * everywhere; match names only where a name is itself the violation.
 *
 * Exit codes: 0 clean · 1 findings · 2 build output missing (i.e. `pnpm build` was skipped).
 */

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

interface ScanRoot {
  readonly dir: string;
  readonly scope: string;
  /** Credential shapes to match. */
  readonly values: readonly Rule[];
  /** Bare-name checks. Client bundle only — see {@link SERVICE_ROLE_REFERENCE_PATTERNS}. */
  readonly references: readonly Rule[];
}

const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css", ".map", ".txt"]);

interface Rule {
  readonly name: string;
  readonly re: RegExp;
}

/**
 * Credential shapes. Each requires a realistic amount of key material after the prefix —
 * 20+ characters — because a prefix alone is not a credential. That minimum is the single
 * biggest source of false positives in naive scanners: `sk-` alone matches ordinary English.
 */
const SECRET_PATTERNS: readonly Rule[] = [
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { name: "Supabase publishable key", re: /\bsb_publishable_[A-Za-z0-9_-]{20,}/g },
  {
    name: "Supabase legacy JWT",
    re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  },
  { name: "OpenRouter key", re: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { name: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{24,}/g },
  { name: "Stripe restricted key", re: /\brk_live_[A-Za-z0-9]{24,}/g },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
];

/**
 * Service-role credential *shapes* — checked in the client bundle AND the server output.
 *
 * These match an actual credential, so a hit means a key is genuinely present.
 */
const SERVICE_ROLE_VALUE_PATTERNS: readonly Rule[] = [
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { name: "Supabase legacy JWT", re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: "service-role JWT claim", re: /"?service_role"?\s*[:,]/ },
];

/**
 * The variable *name* — client bundle only, never the server output.
 *
 * Reading `SUPABASE_SERVICE_ROLE_KEY` at all in a client chunk means the import boundary in
 * `lib/db/admin.ts` has already been breached. That reasoning does **not** transfer to server
 * output, and checking it there produced a false positive the moment any route imported
 * `@/lib/env`: the Zod schema object legitimately contains the key name
 * `SUPABASE_SERVICE_ROLE_KEY:`, so `src/app/(auth)/auth/callback/route.ts` — which reads
 * `env.NEXT_PUBLIC_SUPABASE_ANON_KEY`, a public value — failed the gate on the *name* of a
 * variable it never touches.
 *
 * This is the same names-vs-values trap the script was written to escape, reintroduced one
 * level up: a bare identifier is not a secret, and the server bundle is *supposed* to contain
 * the contract that names every variable.
 */
const SERVICE_ROLE_REFERENCE_PATTERNS: readonly Rule[] = [
  { name: "SUPABASE_SERVICE_ROLE_KEY reference", re: /SUPABASE_SERVICE_ROLE_KEY/ },
];

// Declared after the pattern tables above: `ROOTS` composes them, and a `const` referenced
// before its declaration is a TDZ ReferenceError at module load.
const ROOTS: readonly ScanRoot[] = [
  {
    dir: ".next/static",
    scope: "client bundle",
    values: [...SECRET_PATTERNS, ...SERVICE_ROLE_VALUE_PATTERNS],
    references: SERVICE_ROLE_REFERENCE_PATTERNS,
  },
  {
    dir: ".next/server",
    scope: "server output",
    values: SERVICE_ROLE_VALUE_PATTERNS,
    references: [],
  },
];

/** Env vars whose *values* must not appear anywhere in the output. */
const SECRET_ENV_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "FIRECRAWL_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CRON_SECRET",
  "VERCEL_TOKEN",
  "SENTRY_AUTH_TOKEN",
] as const;

/** Below this length a value is a placeholder, not a credential worth matching on. */
const MIN_VALUE_LENGTH = 12;

interface Finding {
  readonly file: string;
  readonly scope: string;
  readonly rule: string;
  readonly excerpt: string;
}

function* walk(dir: string): Generator<string> {
  // Annotated as `Dirent[]` rather than `ReturnType<typeof readdirSync>`: the latter picks
  // the *Buffer* overload, which then types `entry.name` as a Buffer and fails to compile.
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      const dot = full.lastIndexOf(".");
      const ext = dot === -1 ? "" : full.slice(dot);
      if (EXTENSIONS.has(ext)) yield full;
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(): void {
  for (const root of ROOTS) {
    if (!isDirectory(root.dir)) {
      console.error(`\u274c Missing ${root.dir} \u2014 run \`pnpm build\` first.`);
      console.error("   Exit 2 is deliberate: a skipped build is not a passing scan.");
      process.exit(2);
    }
  }

  // Exact-value matching. Catches a leak of *this* deployment's key even when its shape is
  // one the patterns above do not cover.
  const liveValues = SECRET_ENV_VARS.map((name) => ({
    name,
    value: process.env[name] ?? "",
  })).filter((entry) => entry.value.length >= MIN_VALUE_LENGTH);

  const findings: Finding[] = [];
  let scanned = 0;

  for (const root of ROOTS) {
    const rules = [...root.values, ...root.references];

    for (const file of walk(root.dir)) {
      scanned += 1;

      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      for (const { name, re } of rules) {
        // Patterns carry the /g flag, and a shared global regex retains `lastIndex` between
        // calls. Reset per file or every second match is silently skipped.
        re.lastIndex = 0;
        const match = re.exec(text);
        if (!match) continue;

        const at = match.index;
        findings.push({
          file: relative(process.cwd(), file),
          scope: root.scope,
          rule: name,
          // Enough surrounding text to locate it, never enough to use it.
          excerpt: text
            .slice(Math.max(0, at - 30), at + match[0].length + 10)
            .replace(/\s+/g, " "),
        });
      }

      for (const { name, value } of liveValues) {
        if (text.includes(value)) {
          findings.push({
            file: relative(process.cwd(), file),
            scope: root.scope,
            rule: `live value of ${name}`,
            excerpt: "[exact value match \u2014 redacted]",
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error(`\n\u274c Secret scan FAILED \u2014 ${findings.length} finding(s) in build output:\n`);
    for (const f of findings) {
      console.error(`  [${f.scope}] ${f.rule}`);
      console.error(`    ${f.file}`);
      console.error(`    ...${f.excerpt}...`);
    }
    console.error(
      "\nSee docs/02 \u00a74 rule 1: the service-role key never crosses the client boundary.\n",
    );
    process.exit(1);
  }

  console.log(`\u2705 Client bundle clean \u2014 ${scanned} files scanned across ${ROOTS.length} roots.`);
  console.log(
    liveValues.length > 0
      ? `   Also exact-matched ${liveValues.length} live secret value(s) from the environment.`
      : "   No live secret values in the environment to exact-match (expected in CI).",
  );
  process.exit(0);
}

main();