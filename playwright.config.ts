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
  // `pnpm dev` compiles routes on demand, and a cold compile of a server component can exceed
  // Playwright's 5s default `expect` budget. The symptom is not a slow assertion, it is a
  // **misleading** one: `/applications` does redirect a signed-out visitor, verified independently
  // with curl, but `expect(page).toHaveURL(/\/login\?next=/)` timed out while the compile was
  // still in flight and reported the page as never redirecting.
  //
  // 15s is generous for a warm server and still fails fast on a genuinely broken assertion. The
  // durable fix is running e2e against `pnpm build && pnpm start`, which needs a build step in CI;
  // until then this keeps a dev-server artefact out of the results.
  expect: { timeout: 15_000 },
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
          // Always false, deliberately — this used to be `!process.env.CI`.
          //
          // With `true`, Playwright boots nothing when anything already answers on 3000, and it
          // cannot tell *what* is answering. Twice that has been a foreign process, and the
          // failure is silent: the tests load the wrong server and fail as if the code regressed.
          //
          //   2026-10-16: `reactive-resume-app-1` (an unrelated project) published
          //   127.0.0.1:3000 when Docker Desktop restarted. It returned HTTP 200 with 120 bytes of
          //   its own. All 8 tracker specs failed on `locator.waitFor` timeouts, which read
          //   exactly like "the tracker I just wrote is broken" — and cost a long investigation
          //   chasing a regression that did not exist.
          //
          // `false` inverts that: if 3000 is squatted, `pnpm dev` cannot bind and Playwright
          // reports the webServer failing to start. A loud, correct failure at setup, instead of a
          // quiet wrong-target run. It costs the convenience of reusing an already-running
          // `pnpm dev`, which is the right trade against three recorded incidents about stale
          // listeners (`notes.md`, "Execute the feature, don't just compile it").
          //
          // If you *do* want a warm server, prove it is this app first:
          //   Get-NetTCPConnection -LocalPort 3000 -State Listen
          // and check the owning process is a `next dev` you started.
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});
