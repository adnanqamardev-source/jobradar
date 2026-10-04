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
 * End-to-end confirmation that the rule fires on real source is `pnpm lint`.
 *
 * ## Why the lists are imported, not repeated
 *
 * This file used to declare its own `BLOCKED` and `ALLOWED` arrays and assert against
 * those. That made it look like an oracle while proving nothing about the config: add a
 * path to `eslint.config.mjs` tomorrow and every case here still passed, because none of
 * them were looking at the new entry.
 *
 * The allow-lists now come from `eslint.config.mjs` itself, so this asserts that the
 * config honours the policy it declares. The blocked list stays local — those are
 * concrete client-reachable files we want to keep failing, and there is no policy to
 * import them from.
 */

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// eslint.config.mjs is plain ESM JavaScript; `eslint.config.d.mts` declares the shape of
// the two exports this file asserts against, so the import below is typed.
import { ADMIN_ALLOWED, SERVICE_ROLE_ALLOWED } from "../../eslint.config.mjs";

/**
 * Client-reachable paths that must never reach the service-role client.
 * Any file here failing to parse config is itself a signal worth surfacing.
 *
 * Note `src/lib/queue/**` is deliberately absent: it is a sanctioned path, so the guard is
 * expected to be off there. `plan.ts` and `constants.ts` live under it and are covered by
 * the "policy sanctions" block instead, which reads the real list.
 */
const BLOCKED = [
  "src/components/feed/JobCard.tsx",
  "src/app/(app)/dashboard/page.tsx",
  "src/app/(marketing)/page.tsx",
  "src/lib/scoring/score.ts",
  "src/lib/ingest/fetch.ts",
  "src/app/(app)/applications/page.tsx",
  "src/app/api/actions/jobs.ts",
  "src/lib/billing/stripe.ts",
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
  return patterns.some((p) => (p.group ?? []).some((g) => g.includes("lib/db/admin")));
}

/** True when the config restricts direct `@supabase/supabase-js` imports. */
function restrictsSupabase(options: Record<string, unknown>): boolean {
  const paths = (options.paths ?? []) as { name?: string }[];
  return paths.some((p) => p.name === "@supabase/supabase-js");
}

/**
 * Turn an allow-list entry into a concrete path ESLint can resolve a config for.
 *
 * `src/lib/queue/**` → `src/lib/queue/probe.ts`. An entry with no wildcard is already a
 * path and is used as-is — `src/lib/db/admin.ts` is the reason this cannot just assume a
 * glob. The file need not exist: `calculateConfigForFile` only needs the path to match
 * the config's `files` globs.
 */
function sampleFor(entry: string): string {
  if (!entry.includes("*")) return entry;
  const dir = entry.slice(0, entry.indexOf("*")).replace(/\/$/, "");
  return `${dir}/probe.ts`;
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

  describe("every path the policy sanctions is actually honoured", () => {
    // This is the half that used to be missing. Each entry of the exported lists is
    // checked against the resolved config, so the lists and the config cannot drift.
    it.each([...new Set([...SERVICE_ROLE_ALLOWED, ...ADMIN_ALLOWED])])(
      "%s has the guard switched off",
      async (entry) => {
        const { severity } = await guardFor(sampleFor(entry));
        expect(severity).toBe("off");
      },
    );
  });

  describe("the two policies are declared where the rule needs them", () => {
    it("sanctions the three worker paths docs/02 §4 names", () => {
      // The spec lists three; the code widens it. Both facts are asserted so the
      // widening is a deliberate, visible decision rather than an accident.
      for (const required of [
        "src/lib/queue/**",
        "src/app/api/cron/**",
        "src/app/api/webhooks/**",
      ]) {
        expect(SERVICE_ROLE_ALLOWED).toContain(required);
        expect(ADMIN_ALLOWED).toContain(required);
      }
    });

    it("admits admin.ts to create the client it owns", () => {
      expect(SERVICE_ROLE_ALLOWED).toContain("src/lib/db/admin.ts");
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