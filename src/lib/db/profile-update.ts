/**
 * profile-update.ts — the shared write path for `profiles` (BE-304).
 *
 * ## Why this module exists
 *
 * Three Server Actions (`updateProfile`, `updateLogistics`, `updateDealbreakers`)
 * need the same five things, and copy-pasting them produced three near-identical
 * files that each had to be fixed separately. The logic that actually matters is
 * the concurrency guard below — one implementation means one place to be right.
 *
 * ## The optimistic-concurrency guard
 *
 * docs/03 §5.2: "Concurrent edits (two tabs) → `updated_at` optimistic-concurrency
 * check → 'This changed in another tab. Reload to see the latest.'"
 *
 * The caller sends the `updated_at` it last read (`expectedUpdatedAt`). We scope the
 * UPDATE to that value. If another tab has written since, the WHERE clause matches
 * zero rows and Postgres reports success with no data — which is exactly the
 * ambiguous case. The previous revision did a bare `.update(...).eq("id", userId)`,
 * so the second tab silently clobbered the first one's changes.
 *
 * `expectedUpdatedAt` is **optional**. When absent we keep the unguarded behaviour:
 * callers that never send it (the onboarding wizard, which has nothing to conflict
 * with) must not start failing on a column they don't track yet. ONB-006 wants the
 * guard on `/settings`, and `/settings` is the caller that will send it.
 *
 * Note this is last-writer-wins *detection*, not a merge. Per docs/03 §5.2 the
 * response is a message telling the user to reload — we do not attempt to reconcile
 * two people's edits.
 */

import { revalidatePath } from "next/cache";

import { enqueueRescoreProfile } from "@/lib/db/enqueue-rescore";
import type { SupabaseClient } from "@/lib/db/user-client";
import type { ProfileRow } from "@/types/db";

export interface ProfileUpdateFailure {
  ok: false;
  error: { code: string; message: string };
}

export type ProfileUpdateResult =
  | { ok: true; data: { profile: ProfileRow; rescoreTaskId: string | null } }
  | ProfileUpdateFailure;

/**
 * Apply a partial `profiles` update to the caller's own row.
 *
 * @param supabase      RLS-scoped client from `createUserClient(user.accessToken)`
 * @param userId        `auth.uid()` — the row owner; also the RLS boundary
 * @param updates       snake_case columns; only what the caller supplied
 * @param expectedUpdatedAt  the `updated_at` the caller last read; guards the write
 * @param failureMessage     copy for a genuine database failure (action-specific)
 */
export async function updateOwnProfile(
  supabase: SupabaseClient,
  userId: string,
  updates: Record<string, unknown>,
  expectedUpdatedAt: string | undefined,
  failureMessage: string,
): Promise<ProfileUpdateResult> {
  let query = supabase.from("profiles").update(updates).eq("id", userId);

  // The guard. Scoping by updated_at turns "someone else wrote" into 0 rows.
  if (expectedUpdatedAt !== undefined) {
    query = query.eq("updated_at", expectedUpdatedAt);
  }

  // `.select()` rather than `.single()`: `single()` *errors* on zero rows, which
  // collapses "row is gone" and "row changed under you" into one error shape.
  // Zero rows here means the guard rejected the write, which is a 409, not a 500.
  const { data, error } = (await query.select()) as {
    data: ProfileRow[] | null;
    error: { message: string } | null;
  };

  if (error?.message) {
    return { ok: false, error: { code: "DATABASE_ERROR", message: failureMessage } };
  }

  if (!data || data.length === 0) {
    if (expectedUpdatedAt !== undefined) {
      return {
        ok: false,
        error: {
          code: "edit_conflict",
          message: "This changed in another tab. Reload to see the latest.",
        },
      };
    }
    // No guard was requested, so zero rows means the row genuinely isn't there.
    return {
      ok: false,
      error: { code: "not_found", message: "Profile not found." },
    };
  }

  // docs/02:183 — `actions/` are "mutations w/ revalidate", so the cached RSC
  // payload for the caller's own pages is refreshed here rather than at each
  // call site.
  revalidatePath("/dashboard");
  revalidatePath("/settings");

  // docs/02b: a profile save queues a `rescore_profile` task — never synchronous (C4).
  // Best-effort by design: the write above has already committed, so a failure here is
  // logged rather than surfaced as a save error the user cannot act on. The id is
  // coalesced, so a caller already queued does not create a second task.
  const rescoreTaskId = await enqueueRescoreProfile(supabase);

  const profile = data[0];
  if (!profile) {
    // Unreachable given the length check above, but the type can't know that.
    return { ok: false, error: { code: "not_found", message: "Profile not found." } };
  }

  return { ok: true, data: { profile, rescoreTaskId } };
}