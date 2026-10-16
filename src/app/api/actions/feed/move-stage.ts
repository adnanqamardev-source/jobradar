/**
 * move-stage.ts — Server Action for a stage move (TRK-002, FE-111, FE-112).
 *
 * ## The database is the authority
 *
 * This action does not decide which transitions are legal. `move_application` does, and it does
 * so in the same transaction that writes the stage and appends the history row. Validating here
 * as well would be a second copy of the rules that can disagree with the first — and the disagreeing
 * copy would be the one giving the user an error message. `src/lib/tracker/stages.ts` holds the
 * rules for the *UI* to offer the right options; `tests/unit/application-stages.test.ts` pins that
 * copy to the SQL so the two cannot drift.
 *
 * ## Error surfacing
 *
 * `move_application` raises with a human-readable reason, which PostgREST returns as `P0001` with
 * that text. Those messages are written for a user ("Invalid transition from applied"), so they are
 * surfaced rather than replaced with a generic failure. Anything unrecognised falls back to the
 * generic message, so an unexpected database error never leaks a raw string.
 *
 * ## Ownership
 *
 * Not checked here — the client is RLS-scoped and `move_application` filters on
 * `user_id = auth.uid()` (0015). A caller passing someone else's id gets the same
 * "Application not found" as a caller passing a nonsense one, so this action cannot be used to
 * probe which ids exist.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { applicationStageSchema, STAGE_LABELS, type ApplicationStage } from "@/lib/tracker/stages";

const moveStageSchema = z.object({
  applicationId: z.string().uuid(),
  toStage: applicationStageSchema,
  /** Optional; stored on the event row, which is the append-only record of the move. */
  note: z.string().trim().max(500).nullish(),
});

export interface MoveStageResult {
  ok: boolean;
  data?: { applicationId: string; stage: ApplicationStage };
  error?: { code: string; message: string };
}

/**
 * Raised reasons `move_application` can produce, mapped to a message a user can act on.
 *
 * Keyed by the SQL's exact wording. A reason not in this map is a genuinely unexpected database
 * error and gets the generic fallback — the alternative, echoing whatever the database said, risks
 * putting internal text in the UI.
 */
const RAISED_MESSAGES: Record<string, string> = {
  "Application not found": "That application could not be found.",
  "Already in target stage": "It is already in that stage.",
  "Cannot transition from terminal stage":
    "This application is closed, so its stage cannot change.",
};

/** `Invalid transition from applied` -> `An application in Applied cannot move to that stage.` */
function invalidTransitionMessage(message: string): string | null {
  const from = (/^Invalid transition from (\w+)$/.exec(message))?.[1];
  if (from === undefined) return null;

  const label = STAGE_LABELS[from as ApplicationStage] ?? from;
  return `An application in ${label} cannot move to that stage.`;
}

export async function moveApplicationStage(input: unknown): Promise<MoveStageResult> {
  try {
    const parsed = moveStageSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    const { error } = await supabase.rpc("move_application", {
      app_id: parsed.applicationId,
      to_stage: parsed.toStage,
      note: parsed.note ?? null,
    });

    if (!error) {
      return {
        ok: true,
        data: { applicationId: parsed.applicationId, stage: parsed.toStage },
      };
    }

    // PostgREST wraps a `raise exception` as code P0001 with the SQL text as the message.
    if (error.code === "P0001") {
      const raised = RAISED_MESSAGES[error.message];
      if (raised !== undefined) {
        return { ok: false, error: { code: "move_rejected", message: raised } };
      }

      const invalid = invalidTransitionMessage(error.message);
      if (invalid !== null) {
        return { ok: false, error: { code: "invalid_transition", message: invalid } };
      }
    }

    // 42501 should be unreachable: 0015 revoked EXECUTE from anon and the caller is
    // authenticated. Reaching it means the grant drifted, which is worth saying out loud rather
    // than reporting to the user as a generic failure.
    if (error.code === "42501") {
      return {
        ok: false,
        error: { code: "forbidden", message: "You do not have permission to move this application." },
      };
    }

    return {
      ok: false,
      error: { code: "internal_error", message: "We could not move that application. Try again." },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: "validation_failed", message: "That is not a stage we can move to." },
      };
    }
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      return { ok: false, error: { code: "unauthenticated", message: "Please sign in again." } };
    }
    return {
      ok: false,
      error: { code: "internal_error", message: "We could not move that application. Try again." },
    };
  }
}