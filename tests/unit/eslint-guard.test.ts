/**
 * Service-role import guard — ENG-001 "Done when" #6.
 *
 * A regression test, not a smoke test. Before 2026-10-03 the ESLint config
 * guarded the wrong direction: it blocked direct `@supabase/supabase-js` imports
 * but did nothing about importing `src/lib/db/admin.ts`. A probe proved a
 * component could import the admin client with no error at all.
 *
 * ## Why this asserts on resolved config rather than linting a string
 *
 * The obvious approach — `eslint.lintText(code, { filePath })` — does not work here
 * and silently passes for the wrong reason. This project uses type-aware linting
 * (`parserOptions.project`), so ESLint can only lint files that TypeScript has
 * actually put in its program. A virtual path has no file on disk, so parsing
 * fails first and the restricted-import rule never runs. That produced four tests
 * asserting "no error" against a config that does contain the rule.
 *
 * `calculateConfigForFile` asks the question the ticket actually cares about:
 * *for a file at this path, is the rule on or off?* It needs no file on disk and
 * no type information, so it is deterministic.
 *
 * These assertions fail against the pre-fix config, which is the point.
 *
 * End-to-end confirmation that the rule fires on real source is `pnpm lint`.
 */

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** Paths that must never reach the service-role client. */
const BLOCKED = [
  "src/components/feed/JobCard.tsx",
  "src/app/(app)/dashboard/page.tsx",
  "src/app/(marketing)/page.tsx",
  "src/lib/scoring/score.ts",
  "src/lib/ingest/fetch.ts",
];

/** Paths AGENTS.md and ENG-001 sanction. */
const ALLOWED = [
  "src/lib/queue/worker.ts",
  "src/app/api/cron/process/route.ts",
  "src/app/api/webhooks/stripe/route.ts",
  "scripts/queue-drain.ts",
  "tests/integration/rls/jobs.test.ts",
];

const eslint = new ESLint({ cwd: process.cwd() });

type RuleEntry = unknown;

/** ESLint reports severity as either a string or a number; normalise to the string. */
function toSeverity(value: unknown): string {
  if (Array.isArray(value)) value = value[0];
  if (value === 0 || value === "off" || value === undefined) return "off";
  if (value === 1 || value === "warn") return "warn";
  return "error";
}

/** Normalises a rule entry to `{ severity, options }`. */
function normalise(entry: RuleEntry) {
  if (Array.isArray(entry)) {
    return {
      severity: toSeverity(entry[0]),
      options: entry[1] as Record<string, unknown>,
    };
  }
  return { severity: toSeverity(entry), options: {} as Record<string, unknown> };
}

async function guardFor(filePath: string) {
  const config = await eslint.calculateConfigForFile(filePath);
  return normalise(config?.rules?.["no-restricted-imports"]);
}

/** True when the config restricts `@/lib/db/admin` imports at this path. */
function restrictsAdmin(options: Record<string, unknown>): boolean {
  const patterns = (options.patterns ?? []) as { group?: string[] }[];
  return patterns.some((p) =>
    (p.group ?? []).some((g) => g.includes("lib/db/admin")),
  );
}

/** True when the config restricts direct `@supabase/supabase-js` imports. */
function restrictsSupabase(options: Record<string, unknown>): boolean {
  const paths = (options.paths ?? []) as { name?: string }[];
  return paths.some((p) => p.name === "@supabase/supabase-js");
}

describe("service-role import guard", () => {
  describe("paths that must be blocked", () => {
    it.each(BLOCKED)("%s cannot import lib/db/admin", async (filePath) => {
      const { severity, options } = await guardFor(filePath);

      expect(severity).toBe("error");
      expect(restrictsAdmin(options)).toBe(true);
    });

    it.each(BLOCKED)("%s cannot import supabase-js directly", async (filePath) => {
      const { severity, options } = await guardFor(filePath);

      expect(severity).toBe("error");
      expect(restrictsSupabase(options)).toBe(true);
    });
  });

  describe("sanctioned paths that must stay open", () => {
    it.each(ALLOWED)("%s may import lib/db/admin", async (filePath) => {
      const { severity } = await guardFor(filePath);

      expect(severity).toBe("off");
    });
  });

  it("explains the block instead of failing silently", async () => {
    const { options } = await guardFor("src/components/feed/JobCard.tsx");
    const patterns = (options.patterns ?? []) as { message?: string }[];
    const admin = patterns.find((p) => p.message?.includes("service-role key"));

    expect(admin?.message).toMatch(/never reach a component/);
  });

  it("admin.ts itself may create the client", async () => {
    // The rule is all-or-nothing per file, so the allowed list has to cover
    // admin.ts too or the file that owns the Supabase client cannot import it.
    const { severity } = await guardFor("src/lib/db/admin.ts");

    expect(severity).toBe("off");
  });
});
