import { defineConfig, devices } from "@playwright/test";

/**
 * Base URL resolution — docs/02 §4, and the fix for a defect docs/07 §2.1 recorded:
 * this config previously hardcoded `localhost:3000` and always booted `pnpm dev`, so a
 * job named "e2e against the preview URL" would have tested localhost while its name
 * claimed otherwise. A green result proving nothing is worse than a red one.
 *
 * Precedence: `PLAYWRIGHT_TEST_BASE_URL` (the name docs/07 §Step 4 specifies) →
 * `PLAYWRIGHT_BASE_URL` → `VERCEL_URL` → localhost.
 * When the resolved URL is *not* localhost there is nothing to boot, so `webServer`
 * is omitted entirely — otherwise Playwright would start a dev server and then be
 * pointed at the deployed URL, silently testing the wrong target.
 */
const baseURL =
  process.env.PLAYWRIGHT_TEST_BASE_URL ??
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.VERCEL_URL ??
  "http://localhost:3000";
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
