/**
 * dispatch.ts — task-kind → handler registry (BE-108).
 *
 * `plan.ts` decides *what* should happen to a task. This module decides *who runs it*.
 * `scripts/queue-drain.ts` and `api/cron/process/route.ts` are both executors: they claim,
 * dispatch, settle, and report. Neither of them decides anything, which is the property that
 * let the protocol drift from `docs/02b` §6.4 in thirteen places before `plan.ts` existed.
 *
 * ## Why an unknown kind is a failure, not a no-op
 *
 * The drain script previously marked every claimed task `done` without running anything,
 * which silently discarded real work. Here an unregistered kind returns a failed `Outcome`
 * carrying the kind **by name**: the task goes back to `pending`, burns one attempt, and
 * eventually lands in `failed` with an `audit_logs` row that says which kind has no
 * handler. A missing handler is then a visible queue problem instead of a job that quietly
 * never runs.
 *
 * ## Why a handler throwing is a failed outcome, not a crash
 *
 * A handler runs inside the drain's per-task try/catch by contract, but a handler can also
 * throw asynchronously in a way the caller does not await. `dispatch` therefore catches
 * itself, so one bad handler cannot abort the remaining 24 claims in the batch — which is
 * the isolation `docs/05b` ING-009 requires ("a failing source cannot stall other sources").
 *
 * ## Payload
 *
 * `task_kind` is a closed enum in the schema, so a kind here is always one the database
 * accepted. What is *not* guaranteed is a handler for it, and the payload shape is validated
 * per handler rather than here — this module stays ignorant of every task's business shape.
 */

import { logger } from "@/lib/logger";
import type { Outcome } from "@/lib/queue/plan";

/** The closed `task_kind` enum, from `0001_init.sql`. */
export const TASK_KINDS = [
  "scrape_source",
  "score_jobs",
  "rescore_profile",
  "send_digest",
  "generate_rationale",
  "embed_jobs",
  "freshness_sweep",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** The `task_queue` fields dispatch needs. */
export interface DispatchTask {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * What a handler receives.
 *
 * `signal` exists so a long handler can stop early: the executor aborts when the Vercel
 * function is about to be killed, and a handler that keeps writing after that holds a lease
 * it can no longer renew.
 */
export interface HandlerContext {
  task: DispatchTask;
  /** Injected clock — handlers must not call `Date.now()` themselves. See `plan.ts`. */
  now: Date;
  /** Aborted when the executor is shutting down. */
  signal: AbortSignal;
}

export type TaskHandler = (context: HandlerContext) => Promise<Outcome>;

export type HandlerRegistry = Readonly<Partial<Record<TaskKind, TaskHandler>>>;

/**
 * The registered handlers.
 *
 * `rescore_profile` is the only one wired: it is the one task kind something already
 * enqueues (`0007_enqueue_rescore.sql`, BE-304) and the only one with a handler
 * (`handlers/rescore-profile.ts`, BE-205). The rest are registered as absent on purpose, so
 * the drain reports the gap by name instead of the registry implying coverage it does not
 * have. BE-108's remaining work is filling these in.
 */
export const HANDLERS: HandlerRegistry = {
  // Registered, but not yet runnable: `runRescoreProfile` needs a `RescoreStore` adapter over
  // the real Supabase client, and that adapter does not exist. Writing the entry anyway is
  // deliberate — it makes the gap a *reported* failure naming the kind, rather than "no
  // handler registered", which points at the registry instead of at the missing store.
  //
  // The handler module is deliberately NOT imported here. It pulls the whole scoring
  // pipeline (embeddings, OpenRouter client) into every process that drains the queue,
  // including the paths that never run a rescore, and importing a function only to not call
  // it would read as a wiring that does not exist.
  // `Promise.resolve` rather than `async`: the signature is `TaskHandler`, which returns a
  // promise, and marking this `async` with no `await` inside is the same lint error as an
  // empty try/catch — it asserts an asynchrony that does not exist.
  rescore_profile: ({ task }) => {
    const profileId = (task.payload as { profile_id?: unknown }).profile_id;

    const error =
      typeof profileId !== "string" || profileId.length === 0
        ? "rescore_profile: payload.profile_id is missing or not a string"
        : "rescore_profile: handler is not yet wired to a RescoreStore (BE-108 open)";

    return Promise.resolve({ ok: false, error } as const);
  },
};

/** Kinds with a registered handler, sorted, for reporting. */
export function registeredKinds(): TaskKind[] {
  return Object.keys(HANDLERS)
    .filter((kind): kind is TaskKind => HANDLERS[kind as TaskKind] !== undefined)
    .sort();
}

/** True when `kind` has a handler. */
export function hasHandler(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}

/**
 * Run a task's handler, converting every failure mode into an `Outcome`.
 *
 * Three distinct failures, deliberately reported differently:
 *
 *  - **no handler** — names the kind, so the `audit_logs` row on terminal failure identifies
 *    what is missing.
 *  - **handler throws** — the message is preserved, because a queue that retries a
 *    consistently-throwing handler without saying why is unactionable.
 *  - **handler returns `ok: false`** — passed through untouched; the handler already knows
 *    more about its own failure than this function does.
 *
 * `signal` is checked before invoking: a task claimed just as the worker is shutting down
 * should be settled as not-run rather than started and abandoned with the lease held.
 */
export async function dispatch(
  task: DispatchTask,
  now: Date,
  signal: AbortSignal,
): Promise<Outcome> {
  const handler = HANDLERS[task.kind as TaskKind];

  if (!handler) {
    return { ok: false, error: `no handler registered for task kind "${task.kind}"` };
  }

  if (signal.aborted) {
    return { ok: false, error: "aborted before handler start (worker shutting down)" };
  }

  try {
    return await handler({ task, now, signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Task handler threw", { kind: task.kind, taskId: task.id, message });
    return { ok: false, error: `handler for "${task.kind}" threw: ${message}` };
  }
}
