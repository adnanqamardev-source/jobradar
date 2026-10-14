/**
 * global-setup.ts — runs once per `playwright test` invocation, before any worker starts.
 *
 * ## Why not `test.beforeAll`
 *
 * The first version swept orphan users from a `beforeAll` inside `onboarding.spec.ts`. With
 * `fullyParallel: true` and seven workers, **every worker ran that sweep**, so worker 2 routinely
 * deleted the user worker 1 had created seconds earlier. The failures were spectacular and
 * misleading:
 *
 *     Error: setSession failed: User from sub claim in JWT does not exist
 *     Error: expect(locator).toHaveText(expected) failed
 *
 * — the second and third being downstream of the first, as a deleted session bounces the browser
 * to `/login` where no wizard element exists. Cleanup that breaks the tests it is cleaning up
 * after is worse than no cleanup, and it looked like a flaky wizard.
 *
 * `globalSetup` runs exactly once, in the parent process, before workers are forked. That is the
 * only place a whole-run invariant belongs.
 */

import { adminEnv, sweepOrphanUsers } from "./auth";

export default async function globalSetup(): Promise<void> {
  // The authed specs skip when there is nothing real to talk to (CI placeholders). Do not fail
  // the whole run — including the public-route smoke tests, which need no database — because
  // there was nothing to sweep.
  if (adminEnv() === null) {
    console.log("[e2e] no Supabase credentials — skipping orphan sweep");
    return;
  }

  const removed = await sweepOrphanUsers();
  console.log(
    removed > 0
      ? `[e2e] swept ${removed} orphan test user(s) from earlier runs`
      : "[e2e] no orphan test users to sweep",
  );
}
