/**
 * complete-onboarding.ts — Server Action for the wizard's `Finish` (ONB-005).
 *
 * ## What it writes
 *
 * `onboarding_completed = true` and `onboarding_step = 4`. Nothing else — every field the
 * wizard collected was already written by the four step actions, each of which also enqueues a
 * `rescore_profile` task. Re-writing the profile here would race the steps and duplicate the
 * optimistic-concurrency check.
 *
 * ## Why it does NOT enqueue the first ingestion run
 *
 * docs/01 §5 Flow 1 step 6 says Finish "enqueues a first ingestion run immediately". It cannot,
 * and the reason is structural: `task_queue` is RLS-**forced** with **no policies**
 * (0001_init.sql), so an authenticated request cannot insert a row — which is the same
 * constraint that forced `enqueue_rescore_profile()` to be a `SECURITY DEFINER` function
 * (migrations 0007/0008).
 *
 * So doing it honestly needs one of:
 *
 *   1. A new `SECURITY DEFINER` function (e.g. `enqueue_ingest_now()`) granted to
 *      `authenticated` — a **migration**, and a new privilege to argue about.
 *   2. This action inserting through the service-role client — no migration, but it turns a
 *      user-facing action into a service-role writer, which is exactly what BE-304's actions
 *      were built to avoid.
 *
 * Neither is a call to make inside an unrelated slice, and the feed is not stranded without it:
 * `/api/cron/enqueue` already treats a `next_run_at = null` source as due, so every enabled
 * source is picked up on the next cron tick. Deferred deliberately, and recorded as still-open.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { logger } from "@/lib/logger";
import { ONBOARDING_COMPLETE_STEP, ONBOARDING_STEPS } from "@/lib/onboarding/constants";

const completeOnboardingSchema = z.object({
  /** Sent by the client so the log can say which step the user finished from. */
  fromStep: z.number().int().min(1).max(ONBOARDING_STEPS).optional(),
});

/**
 * The columns written back, validated.
 *
 * The Supabase client is untyped, so `.select(...)` returns `any`. Without this the action
 * returns `any` into its own result type and every caller inherits it — the same trap as the
 * feed's row schema, one layer up.
 */
const completionSchema = z.object({
  onboarding_completed: z.boolean(),
  onboarding_step: z.number(),
});

export interface CompleteOnboardingResult {
  ok: boolean;
  data?: { onboardingCompleted: boolean; onboardingStep: number };
  error?: { code: string; message: string };
}

/**
 * Mark the wizard finished and enqueue the rescore that scores the newly populated profile.
 *
 * `enqueue_rescore_profile()` is called explicitly rather than relying on the last step's
 * save, because the steps enqueue on *every* save and the partial unique index
 * (`idx_task_queue_one_pending_rescore_per_profile`, 0007) coalesces them into one pending task.
 * That coalescing means the task may already exist from step 1 and be long since done — so this
 * call is what guarantees a rescore happens *after* the final values land. It is idempotent in
 * the same way: a second Finish within the same cycle coalesces rather than duplicating.
 */
export async function completeOnboarding(input?: unknown): Promise<CompleteOnboardingResult> {
  try {
    const parsed = completeOnboardingSchema.parse(input ?? {});
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    const { data, error } = await supabase
      .from("profiles")
      .update({ onboarding_completed: true, onboarding_step: ONBOARDING_COMPLETE_STEP })
      .eq("id", user.id)
      .select("onboarding_completed, onboarding_step")
      .single();

    if (error) throw error;

    const written = completionSchema.safeParse(data);
    if (!written.success) {
      // The UPDATE reported success but did not return the row it wrote — `.single()` returns
      // null when RLS hides it, or when the row vanished between the update and the read.
      // Either way the completion must not be reported as confirmed.
      logger.warn("completeOnboarding wrote no readable row", {
        fromStep: parsed.fromStep ?? null,
      });
      return {
        ok: false,
        error: { code: "internal_error", message: "We could not confirm your setup. Try again." },
      };
    }

    // The scoring trigger. Fire-and-report: a missing rescore is recoverable (the dashboard
    // offers an edit path), whereas a thrown error here would tell the user Finish failed
    // after it actually succeeded.
    const rescore = await supabase.rpc("enqueue_rescore_profile");
    if (rescore.error) {
      logger.warn("Onboarding complete but rescore enqueue failed", {
        message: rescore.error.message,
        fromStep: parsed.fromStep ?? null,
      });
    }

    return {
      ok: true,
      data: {
        onboardingCompleted: written.data.onboarding_completed,
        onboardingStep: written.data.onboarding_step,
      },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: "validation_error", message: "That step value was not valid." },
      };
    }
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      return { ok: false, error: { code: "unauthenticated", message: "Please sign in again." } };
    }
    logger.error("completeOnboarding failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: { code: "internal_error", message: "We could not finish setup. Try again." },
    };
  }
}
