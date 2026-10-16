/**
 * stages.ts — the application pipeline, in one place.
 *
 * ## Why the rules live in TypeScript *and* in SQL
 *
 * `move_application` (migrations 0001/0015) is the authority: it rejects an illegal transition
 * server-side, and that is what TRK-002 requires. This module exists for a different reason —
 * the UI must **offer** only legal moves, because a dropdown listing `applied -> offer` is a
 * control the server will refuse, which is a worse experience than not offering it.
 *
 * Duplicating the rules invites drift, and the failure would be silent: the board would keep
 * offering a move the database has quietly stopped allowing. So the duplication is pinned:
 * `tests/unit/application-stages.test.ts` parses the `raise exception` rules out of the migration
 * SQL and fails if this file and the database disagree — the same technique
 * `tests/unit/queue-kind-vocabulary.test.ts` uses to keep `task_kind` in sync.
 *
 * ## The pipeline is not a linear order
 *
 * `app_stage` is an enum whose order is the happy path, but `rejected` and `withdrawn` are
 * reachable from every active stage, and `saved` can go back to `discovered`. Treating the enum
 * as a pipeline and offering "the next one" would therefore be wrong in both directions, which
 * is why this is an explicit map.
 */

import { z } from "zod";

/** Mirrors the `app_stage` enum in 0001_init.sql. Order is the happy path. */
export const APPLICATION_STAGES = [
  "discovered",
  "saved",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const applicationStageSchema = z.enum(APPLICATION_STAGES);

/** Stages that end the pipeline: `move_application` refuses any transition out of them. */
export const TERMINAL_STAGES: readonly ApplicationStage[] = ["rejected", "withdrawn"];

/** A human label. Presentation only — Phase 3 owns anything visual. */
export const STAGE_LABELS: Record<ApplicationStage, string> = {
  discovered: "Discovered",
  saved: "Saved",
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/**
 * Legal transitions, transcribed from `move_application`.
 *
 * Kept explicit rather than derived: "every active stage can reach rejected or withdrawn" is true
 * of the SQL today, but encoding it as a rule would obscure the one exception (`discovered`,
 * which cannot jump to withdrawn) and make a future SQL change look like a bug here.
 */
export const STAGE_TRANSITIONS: Record<ApplicationStage, readonly ApplicationStage[]> = {
  discovered: ["saved"],
  saved: ["applied", "discovered"],
  applied: ["screening", "rejected", "withdrawn"],
  screening: ["interview", "rejected", "withdrawn"],
  interview: ["offer", "rejected", "withdrawn"],
  offer: ["rejected", "withdrawn"],
  rejected: [],
  withdrawn: [],
};

/** Stages the kanban renders a column for, in pipeline order. */
export const BOARD_STAGES: readonly ApplicationStage[] = [
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
];

/**
 * The stages a card in `from` may be moved to, excluding `from` itself.
 *
 * Returns `[]` for a terminal stage, which is what makes the control disappear rather than
 * render an empty dropdown.
 */
export function legalMoves(from: ApplicationStage): readonly ApplicationStage[] {
  return STAGE_TRANSITIONS[from].filter((stage) => stage !== from);
}

/** `true` when the move is one `move_application` will accept. Used to disable options. */
export function isLegalMove(from: ApplicationStage, to: ApplicationStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}