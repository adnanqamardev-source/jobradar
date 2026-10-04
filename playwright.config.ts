import { defineConfig, devices } from "@playwright/test";

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
