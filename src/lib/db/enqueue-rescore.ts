/**
 * enqueue-rescore.ts — queue a `rescore_profile` task for the calling user (ONB-006).
 *
 * docs/02b: "profile save → `rescore_profile` task (requeue, never synchronous — C4)".
 * ONB-006: "Save enqueues `rescore_profile`; the UI shows 'Rescoring your feed…'".
 *
 * ## Why this goes through an RPC
 *
 * `task_queue` is service-role only: RLS is enabled *and forced* with no policies, so a
 * user-scoped client cannot INSERT no matter what the table grants say. Two ways around
 * that, both rejected:
 *
 * - service-role client inside a user-facing action — breaks the rule this repo repeats
 *   most: service-role bypasses RLS and is never for user-facing work;
 * - `grant insert on task_queue` — also grants UPDATE/DELETE, so a user could claim and
 *   run other people's tasks.
 *
 * Instead, `enqueue_rescore_profile()` (migration 0007) is a `security definer` function
 * that takes no arguments: the kind is fixed and the profile is forced to `auth.uid()`.
 * There is nothing for a caller to forge.
 *
 * ## Failure is not fatal
 *
 * The profile write has already committed by the time this runs. If enqueueing fails we
 * log and return success — the user's data is saved, and the alternative (reporting an
 * error the user cannot act on, over a background job) would be a lie. The stale score is
 * recoverable: the next save, or a `cleanup` run, re-enqueues.
 */

import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@/lib/db/user-client";

/**
 * Enqueue a rescore for the caller. Never throws.
 *
 * @param supabase RLS-scoped client from `createUserClient(user.accessToken)` — the
 *   caller's JWT is what `auth.uid()` resolves to inside the RPC.
 * @returns the task id, or `null` if it could not be enqueued.
 */
export async function enqueueRescoreProfile(
  supabase: SupabaseClient,
): Promise<string | null> {
  try {
    // `rpc` is untyped here — the schema types are not generated — so the result is
    // narrowed explicitly rather than destructured off an `any`.
    const result = await supabase.rpc("enqueue_rescore_profile");
    const error = result.error as { message?: string } | null;
    const data = result.data as string | null;

    if (error?.message) {
      logger.error("Failed to enqueue rescore_profile", { error: error.message });
      return null;
    }

    // Coalesced calls return the already-pending task's id, so a non-null id here does
    // not necessarily mean *this* call created a task.
    return data ?? null;
  } catch (error) {
    logger.error("rescore_profile enqueue threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}