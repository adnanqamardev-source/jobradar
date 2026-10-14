import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Load `.env.local` into the test process (FND-001: Node's own loader, never `dotenv`).
 *
 * Needed because `tests/e2e/support/auth.ts` talks to Supabase through the admin API, and
 * Playwright — unlike `next dev` — does not read `.env.local` on its own. Without this the
 * authed specs would skip locally with "no real Supabase credentials", which reads like a
 * configuration problem rather than the missing loader it is.
 *
 * ## Why this cannot break CI
 *
 * `process.loadEnvFile` matches `--env-file` semantics: **a variable already in the environment
 * wins** and is not overwritten. CI exports placeholder values (see `.github/workflows/ci.yml`),
 * so on CI this loads nothing over them and `adminEnv()` keeps returning `null` and the authed
 * specs keep skipping. That is the intended behaviour, and it is also the reason this is
 * `loadEnvFile` and not a merge that assigns unconditionally.
 *
 * The file is gitignored and never leaves this machine. `try`/`catch` rather than
 * `existsSync` alone: a machine with no `.env.local` should skip the authed specs with a stated
 * reason, not fail the whole e2e job at config load.
 */
try {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
} catch {
  // No `.env.local` (fresh clone, or CI). The specs that need credentials skip themselves.
}

/**
 * Base URL resolution — docs/02 §4, and the fix for a defect docs/07 §2.1 recorded:
 * this config previously hardcoded `localhost:3000` and always booted `pnpm dev`, so a
 * job named "e2e against the preview URL" would have tested localhost while its name
 * claimed otherwise. A green result proving nothing is worse than a red one.
 *
 * Precedence: `PLAYWRIGHT_TEST_BASE_URL` (the name docs/07 §Step 4 specifies) →
 * `PLAYWRIGHT_BASE_URL` → `VERCEL_URL` → localhost.
 *
 * ## Why blank is treated as absent — this is a real bug, not a hypothetical
 *
 * `??` only falls through on `null`/`undefined`. It does **not** fall through on `""`.
 * GitHub Actions expands an unset repository variable to an *empty string*, so
 * `${{ vars.PLAYWRIGHT_TEST_BASE_URL }}` sets the variable to `""` rather than leaving it
 * unset. With `??` that made `baseURL` `""`, which then:
 *
 *   - failed the localhost regex below, so `isExternal` became `true`
 *   - omitted `webServer`, so no dev server was ever started
 *   - left Playwright with `baseURL: ""`, so all 18 tests died on
 *     `page.goto: Protocol error (Playwright.navigate): Cannot navigate to invalid URL`
 *
 * This is the same class of bug as the env schema (`docs/02` §7.2): an unset variable
 * expressed as `VAR=` is *present and empty*, not absent. `notes.md` records it from the
 * other direction — Zod's `.optional()` ignoring `""`. Do not use `??` on a value that a
 * CI system may hand you as an empty string.
 *
 * When the resolved URL is *not* localhost there is nothing to boot, so `webServer` is
 * omitted entirely — otherwise Playwright would start a dev server and then be pointed at
 * the deployed URL, silently testing the wrong target.
 */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

const baseURL =
  firstNonEmpty(
    process.env.PLAYWRIGHT_TEST_BASE_URL,
    process.env.PLAYWRIGHT_BASE_URL,
    process.env.VERCEL_URL,
  ) ?? "http://localhost:3000";

const isExternal = !/^https?:\/\/localhost(:\d+)?/.test(baseURL);

export default defineConfig({
  testDir: "./tests/e2e",
  // Runs once per invocation, in the parent process, before workers fork. This is where the
  // orphan-user sweep lives: doing it in a `beforeAll` meant every parallel worker ran it, and
  // they deleted each other's test users mid-test. See `tests/e2e/support/global-setup.ts`.
  globalSetup: "./tests/e2e/support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 12"] },
    },
  ],
  // Only boot a server when we are actually testing localhost. See `isExternal` above.
  ...(isExternal
    ? {}
    : {
        webServer: {
          command: "pnpm dev",
          url: "http://localhost:3000",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
