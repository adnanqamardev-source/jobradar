/**
 * dismiss-job.ts — Dismiss a job from the feed (BE-305, FED-002).
 *
 * Writes a `job_events` row with `event = 'dismiss'`. Dismissed jobs never
 * resurface: the feed query excludes them (`dismissed = false` in
 * `queryFeed`), and because scoring surfaced sets derive from the same view,
 * a dismissed job is excluded from future surfaced sets too — FED-002.
 *
 * Idempotency and auth: see `save-job.ts` — same pattern, same reasoning.
 *
 * ## What this deliberately does not do
 *
 * FED-005's "hide all of these" (dismissing a whole duplicate cluster by
 * `dedupe_hash`) is a separate action. This one dismisses a single sighting;
 * the cluster action lands with FED-005.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { dismissJobRequestSchema } from "@/types/api";
import type { FeedActionResult } from "./save-job";

export async function dismissJob(input: unknown): Promise<FeedActionResult> {
  try {
    const { jobId } = dismissJobRequestSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    // `.select("at")` — `job_events` has **no `id` column** (composite PK
    // `(user_id, job_id, event, at)`); see `save-job.ts`.
    const { data: existingRows, error: existingError } = await supabase
      .from("job_events")
      .select("at")
      .eq("user_id", user.id)
      .eq("job_id", jobId)
      .eq("event", "dismiss")
      .limit(1);

    if (existingError) throw existingError;

    if ((existingRows ?? []).length === 0) {
      const { error } = await supabase
        .from("job_events")
        .insert({ user_id: user.id, job_id: jobId, event: "dismiss" });
      if (error) throw error;
    }

    return { ok: true, dismissed: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: "validation_failed", message: "Please check your input and try again." },
      };
    }
    if (AppError.isAppError(error)) throw error;
    return {
      ok: false,
      error: { code: "internal_error", message: "Something went wrong. Try again." },
    };
  }
}
