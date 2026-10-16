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

import { MIN_FEED_SCORE } from "@/lib/db/queries/feed";
import { adminClient, signInAsFreshUser, teardownUser } from "./auth";

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

/**
 * Give a fresh profile something to see, by copying scores from an already-scored profile.
 *
 * ## Why this is necessary
 *
 * A new profile has no `job_scores` until a `rescore_profile` task runs, and a full rescore is
 * ~100 jobs per invocation — several worker passes and minutes of wall clock. An E2E spec that
 * waits for real scoring is a spec nobody runs.
 *
 * So the harness borrows rows from a profile that already has them. This is **seeded data, not
 * faked behaviour**: the rows are genuine `job_scores` written by the real handler, the feed
 * renders them through the real query, and every action the spec exercises afterwards is the
 * production one. Only the waiting is skipped.
 *
 * Without it there is nothing to mark applied, and "apply" is the first half of the Phase 2 gate
 * `tests/e2e/tracker.spec.ts` exists to prove.
 *
 * @returns how many scores were copied. Zero is a failure the caller should surface, not an
 *          empty board to assert on.
 */
export async function seedFeedForUser(userId: string): Promise<number> {
  const admin = adminClient();
  if (admin === null) throw new Error("seedFeedForUser called without Supabase credentials");

  // One donor *profile*, then that profile's scores.
  //
  // Not "any 12 score rows": `neq("user_id", …)` spans every other profile, and the same job is
  // scored for many of them, so the payload carried a `job_id` twice and the upsert failed with
  // `ON CONFLICT DO UPDATE command cannot affect row a second time`. Restricting to a single
  // profile also guarantees distinct job_ids, because `job_scores` is unique on
  // `(user_id, job_id)`.
  //
  // `gte(MIN_FEED_SCORE)` is not optional. `queryFeed` reads `v_ranked_jobs` with
  // `.gte("final_score", MIN_FEED_SCORE)`, and a scoring profile's distribution sits mostly
  // *below* that line - one has 300 scores of which 69 clear the bar, with a maximum of 67.56
  // against a threshold of 60. Seeding an arbitrary 12 therefore seeds mostly rows the feed
  // discards, and the dashboard renders its empty state. Worse, an unordered `.limit(12)` returns
  // whatever the heap yields, so the fixture silently passed or failed depending on row order:
  // this spec was 8/8 green and then 8/8 red against identical application code. The threshold is
  // imported from `feed.ts` rather than hard-coded here, so the fixture cannot drift from the gate
  // it is meant to satisfy.
  const { data: donorProfile, error: profileError } = await admin
    .from("job_scores")
    .select("user_id")
    .neq("user_id", userId)
    .gte("final_score", MIN_FEED_SCORE)
    .limit(1);

  if (profileError) throw new Error(`could not find a donor profile: ${profileError.message}`);
  const donorId = donorProfile?.[0]?.user_id;
  if (!donorId) {
    throw new Error(
      `no donor job_scores at or above MIN_FEED_SCORE (${MIN_FEED_SCORE}) — run the worker ` +
        "first (GET /api/cron/process until claimed is 0) or this spec cannot seed a feed.",
    );
  }

  const { data: donor, error: donorError } = await admin
    .from("job_scores")
    .select("job_id, final_score, breakdown, explanation, scored_at")
    .eq("user_id", donorId)
    .gte("final_score", MIN_FEED_SCORE)
    .order("final_score", { ascending: false })
    .limit(12);

  if (donorError) throw new Error(`could not read donor scores: ${donorError.message}`);
  if (!donor || donor.length === 0) {
    throw new Error(
      `donor profile ${donorId} has no scores at or above MIN_FEED_SCORE (${MIN_FEED_SCORE}).`,
    );
  }

  const { error } = await admin.from("job_scores").upsert(
    donor.map((score) => ({
      user_id: userId,
      job_id: score.job_id,
      final_score: score.final_score,
      breakdown: score.breakdown,
      explanation: score.explanation,
      scored_at: score.scored_at,
    })),
    { onConflict: "user_id,job_id" },
  );
  if (error) throw new Error(`could not seed job_scores: ${error.message}`);

  return donor.length;
}
