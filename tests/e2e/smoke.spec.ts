/**
 * smoke.spec.ts — Phase 0 route smoke tests.
 *
 * ## Why these exist
 *
 * CI runs a Playwright job, and before these specs it failed with `Error: No tests found` —
 * `tests/e2e/` held only a `.gitkeep`. That is a *worse* CI signal than a red test: the job
 * proved nothing while reporting green. These specs assert the routes Phase 0 actually
 * created, which is the honest minimum for the gate to mean anything.
 *
 * ## Why these are not the E2E suite
 *
 * docs/06 §Phase 2 gates on "Playwright E2E green against unstyled UI: onboarding → feed →
 * apply → stage move". Those flows do not exist yet — no dashboard, no feed, no tracker until
 * Phase 2. Writing them now would mean inventing UI, which AGENTS.md forbids. So this file
 * covers the routes that exist and no more.
 *
 * Assertions are deliberately coarse (heading text, form controls, HTTP status) rather than
 * styled: Phase 3 owns presentation, and a spec asserting a class name would break the
 * moment Phase 3 restyles the page without any behaviour changing.
 */

import { expect, test } from "@playwright/test";

test.describe("public routes", () => {
  test("marketing page renders with a path to sign in", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "JobRadar" })).toBeVisible();

    // The only call to action on this page. Its href is the assertion — a marketing page
    // whose CTA points nowhere is broken even when it renders perfectly.
    const cta = page.getByRole("link", { name: "Start free" });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/login");
  });

  test("marketing page is usable at mobile width", async ({ page }) => {
    await page.goto("/");

    // No horizontal scroll at 375px. The layout is a centred column, so anything wider than
    // the viewport means something inside it is not shrinking — a real defect, and one that
    // only the mobile projects would catch.
    const overflowsHorizontally = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflowsHorizontally).toBe(false);
  });

  test("login page exposes a labelled, required email field", async ({ page }) => {
    const response = await page.goto("/login");

    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to JobRadar" })
    ).toBeVisible();

    // Asserted by accessible name, not by CSS selector. Phase 2 mandates semantic elements
    // and real labels (AGENTS.md), so this doubles as a check that the label is wired to the
    // input — an unlabelled input fails here rather than passing silently.
    const email = page.getByLabel("Email");
    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("required", "");

    await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Google/i })).toBeVisible();
  });

  test("unknown routes return the not-found page", async ({ page }) => {
    const response = await page.goto("/this-route-does-not-exist");

    expect(response?.status()).toBe(404);
  });
});

test.describe("navigation", () => {
  test("CTA reaches the login page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Start free" }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to JobRadar" })
    ).toBeVisible();
  });
});

test.describe("client bundle hygiene", () => {
  test("no service-role key reaches the browser", async ({ page }) => {
    const leaked: string[] = [];

    page.on("response", async (response) => {
      const url = response.url();
      // Server-rendered HTML legitimately mentions env var *names* while prerendering.
      // What must never appear is a credential *value* in anything the browser can fetch.
      if (!url.includes("/_next/static/")) return;

      try {
        const body = await response.text();
        // Shape check for the credential, plain substring for the variable name — neither
        // pattern has regex metacharacters that a `.test()` would need, and `includes()` is
        // both clearer and faster. The 20+ char minimum is what keeps this from matching the
        // bare prefix, which appears in any redaction helper.
        if (/sb_secret_[A-Za-z0-9_-]{20,}/.test(body) || body.includes("SUPABASE_SERVICE_ROLE_KEY")) {
          leaked.push(url);
        }
      } catch {
        // A body we cannot read is not evidence of a leak; the build-time
        // `scripts/scan-bundle-secrets.mjs` gate is the authoritative check.
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(leaked).toEqual([]);
  });
});
