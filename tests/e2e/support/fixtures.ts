/**
 * support/fixtures.ts — the `e2eUser` fixture: a real signed-in session, torn down after.
 *
 * ## Why a fixture and not a helper called from each test
 *
 * The first attempt registered cleanup with `test.afterEach()` *inside* a `signIn()` helper, and
 * Playwright rejects that outright — hooks may only be declared in describe scope, never from a
 * running test. A fixture is the supported mechanism and has a second advantage: a test that
 * never asks for `e2eUser` never creates a user, so the signed-out spec stays signed out without
 * needing to opt back out of an ambient session.
 *
 * The teardown runs even when the test fails, which is the whole point — the first version of
 * this harness created 12 accounts on the project and removed none of them.
 */

import { test as base, expect } from "@playwright/test";

import { signInAsFreshUser, teardownUser } from "./auth";

export interface E2eUser {
  userId: string;
  email: string;
}

/**
 * A brand-new account with a working session cookie on `context`.
 *
 * Resolving this fixture is what signs the test in. Tests that need a signed-*out* browser simply
 * do not destructure it.
 */
export const test = base.extend<{ e2eUser: E2eUser }>({
  e2eUser: async ({ context, baseURL }, use) => {
    const account = await signInAsFreshUser(context, baseURL ?? "http://localhost:3000");
    await use(account);
    await teardownUser(account.userId);
  },
});

export { expect };
