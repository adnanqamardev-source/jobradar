/**
 * save-job.ts — Save a job from the feed (BE-305, FED-002).
 *
 * Writes a `job_events` row with `event = 'save'`. The feed view derives the
 * `saved` flag from exactly this row, so the action and the read path cannot
 * drift apart.
 *
 * ## Idempotency
 *
 * `job_events`' primary key is `(user_id, job_id, event, at)` — it includes
 * `at`, so a blind re-insert would log a second row for the same save. The
 * action checks for an existing `save` event first and no-ops when one exists.
 * The check-then-insert race (two concurrent saves) can only produce a
 * duplicate *event* row, never a duplicate *state* — the view's EXISTS
 * subquery collapses them.
 *
 * ## Auth
 *
 * `requireUser()` before any database access, and the write goes through the
 * caller's RLS-scoped client — `job_events_owner_insert` checks
 * `auth.uid() = user_id`, so a user can only save to their own event log.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { saveJobRequestSchema } from "@/types/api";

export interface FeedActionResult {
  ok: boolean;
  saved?: boolean;
  dismissed?: boolean;
  applied?: boolean;
  error?: { code: string; message: string };
}

export async function saveJob(input: unknown): Promise<FeedActionResult> {
  try {
    const { jobId } = saveJobRequestSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    // `.select("at")` — `job_events` has **no `id` column**: its primary key is
    // the composite `(user_id, job_id, event, at)`. Selecting `"id"` returns
    // PostgREST `42703 undefined_column`, which would fail *every* save, not
    // just the duplicate case. Found by `tests/integration/feed-actions.db.test.ts`,
    // which a client double could never catch: it answered any column name.
    //
    // `.limit(1)` (not `.maybeSingle()`): job_events can hold several rows for
    // the same (user, job, event) when a double-click straddles the check/insert
    // window — the PK includes `at`, so both inserts succeed. maybeSingle on
    // two rows is a PostgREST error and would turn a clean save into a 500.
    const { data: existingRows, error: existingError } = await supabase
      .from("job_events")
      .select("at")
      .eq("user_id", user.id)
      .eq("job_id", jobId)
      .eq("event", "save")
      .limit(1);

    if (existingError) throw existingError;

    if ((existingRows ?? []).length > 0) {
      return { ok: true, saved: true };
    }

    const { error } = await supabase
      .from("job_events")
      .insert({ user_id: user.id, job_id: jobId, event: "save" });
    if (error) throw error;

    return { ok: true, saved: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: "validation_failed", message: "Please check your input and try again." },
      };
    }
    // unauthenticated and friends propagate — the caller maps them to a status.
    if (AppError.isAppError(error)) throw error;
    return {
      ok: false,
      error: { code: "internal_error", message: "Something went wrong. Try again." },
    };
  }
}
