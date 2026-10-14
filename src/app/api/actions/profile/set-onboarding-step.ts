/**
 * set-onboarding-step.ts — Server Action for per-step progress (ONB-001).
 *
 * docs/05b ONB-001: "`onboarding_step` persisted on every step so an abandoned wizard
 * resumes". It was **read** by `getOwnProfileSummary` and by the dashboard, but nothing ever
 * wrote it — so `onboarding_step` was permanently 1 and "resume where you left off" was
 * indistinguishable from "start from the top".
 *
 * ## Why this is its own action rather than a field on the four step actions
 *
 * The step actions already write `profiles` and already enqueue a rescore on every save.
 * Adding `onboardingStep` to them would make every keystroke-commit enqueue scoring work, and
 * would widen four shipped seams to carry a field only the wizard reads. Progress is not a
 * profile change, so it gets its own write.
 *
 * ## Failure is non-fatal by construction
 *
 * Progress is a convenience — a courtesy resume point, not data. If this write fails the
 * wizard still advances, because the profile values are already saved by the step action and
 * losing a resume marker must never lose a saved answer. The error is returned rather than
 * thrown so the caller can log it, and the caller deliberately does nothing user-visible with
 * it.
 */

"use server";

import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { logger } from "@/lib/logger";

const setOnboardingStepSchema = z.object({
  /** 1–4, or 5 meaning "finished" — the same sentinel `completeOnboarding` writes. */
  step: z.number().int().min(1).max(5),
});

/** The one column written back. The client is untyped, so `.select()` returns `any`. */
const writtenSchema = z.object({ onboarding_step: z.number() });

export interface SetOnboardingStepResult {
  ok: boolean;
  data?: { onboardingStep: number };
  error?: { code: string; message: string };
}

export async function setOnboardingStep(input: unknown): Promise<SetOnboardingStepResult> {
  try {
    const { step } = setOnboardingStepSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    const { data, error } = await supabase
      .from("profiles")
      .update({ onboarding_step: step })
      .eq("id", user.id)
      .select("onboarding_step")
      .single();

    if (error) throw error;

    const written = writtenSchema.safeParse(data);
    if (!written.success) {
      return {
        ok: false,
        error: { code: "internal_error", message: "We could not save your progress." },
      };
    }

    return { ok: true, data: { onboardingStep: written.data.onboarding_step } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: "validation_error", message: "That step value was not valid." },
      };
    }
    logger.warn("setOnboardingStep failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    // Not surfaced to the user: see the header. Losing a resume marker is not worth an error
    // banner on a step the user just completed.
    return {
      ok: false,
      error: { code: "internal_error", message: "We could not save your progress." },
    };
  }
}
