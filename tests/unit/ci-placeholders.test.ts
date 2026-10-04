import { describe, expect, it } from "vitest";

import { formatEnvProblems, parseEnv } from "@/lib/env/schema";

/**
 * The exact values `.github/workflows/ci.yml` passes as workflow-level `env`.
 *
 * Duplicated here on purpose: this file is the oracle. If someone edits the workflow
 * placeholders and breaks one, this fails — which is the only way a CI-only config value
 * gets tested at all, since CI cannot test its own env.
 */
const CI_PLACEHOLDERS = {
  NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "ci-placeholder-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "ci-placeholder-service-role-key",
  CRON_SECRET: "ci-placeholder-cron-secret-not-a-real-secret",
  OPENROUTER_API_KEY: "ci-placeholder-openrouter-key",
};

describe("CI placeholder env", () => {
  it("satisfies the env contract, so `next build` can run in CI", () => {
    // Importing `@/lib/env` makes the module-level validation throw, and `next build`
    // evaluates route modules during "collecting page data". Without a schema-valid
    // environment the Build job dies with `Failed to collect page data for
    // /auth/callback` — observed on CI run 37195342795.
    const result = parseEnv(CI_PLACEHOLDERS);

    if (!result.ok) {
      throw new Error(
        `CI placeholders rejected by the env schema:\n${formatEnvProblems(result.problems)}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("gives CRON_SECRET the 32 characters docs/02 §7.1 requires", () => {
    expect(CI_PLACEHOLDERS.CRON_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("matches no credential shape, so secret-scan does not flag CI's own build", () => {
    // `scripts/scan-bundle-secrets.ts` runs in the same workflow against this build.
    // A placeholder shaped like `sb_secret_...` or `sk-or-v1-...` would fail the gate on
    // CI's own environment — the same names-vs-values trap, in a new place.
    const credentialShapes = [
      /\bsb_secret_[A-Za-z0-9_-]{20,}/,
      /\bsb_publishable_[A-Za-z0-9_-]{20,}/,
      /\bsk-or-v1-[A-Za-z0-9]{32,}/,
      /\bwhsec_[A-Za-z0-9]{24,}/,
      /\brk_live_[A-Za-z0-9]{24,}/,
      /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./,
      /\bgh[pousr]_[A-Za-z0-9]{36,}/,
    ];

    for (const [key, value] of Object.entries(CI_PLACEHOLDERS)) {
      for (const shape of credentialShapes) {
        expect(
          shape.test(value),
          `${key} matches a credential shape the bundle scanner would flag`,
        ).toBe(false);
      }
    }
  });

  it("is obviously not a real credential", () => {
    for (const [key, value] of Object.entries(CI_PLACEHOLDERS)) {
      expect(value.toLowerCase(), `${key} should say it is a placeholder`).toContain(
        "placeholder",
      );
    }
  });
});
