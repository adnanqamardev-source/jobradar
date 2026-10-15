/**
 * dispatch.ts — task-kind → handler registry (BE-108).
 */

import { logger } from "@/lib/logger";
import type { Outcome } from "@/lib/queue/plan";
import { runRescoreProfile } from "@/lib/queue/handlers/rescore-profile";
import { createSupabaseRescoreStore } from "@/lib/queue/handlers/rescore-store";
import { runIngestSource } from "@/lib/queue/handlers/ingest-source";
import { createAdminClient } from "@/lib/db/admin";
import { taskKindSchema } from "@/types/db";

/**
 * The kinds this dispatcher can handle.
 *
 * Sourced from `taskKindSchema`, which mirrors the Postgres `task_kind` enum (0001_init.sql:51),
 * so **a kind the database would reject is a compile error here rather than a runtime 400**.
 *
 * This list used to be hand-written, and had drifted in both directions:
 *
 * | | present only in the old list | present only in the enum |
 * |---|---|---|
 * | kinds | `scrape_source`, `generate_rationale`, `embed_jobs`, `freshness_sweep` | `ingest_source`, `account_export`, `cleanup` |
 *
 * `scrape_source` is the one that actually bit: `/api/cron/enqueue` inserted it, the enum
 * rejected it, and all nine sources failed with
 * `invalid input value for enum task_kind: "scrape_source"` — so ingestion had never enqueued
 * a task. Deriving the list from the schema makes that class of drift impossible, and
 * `tests/unit/queue-kind-vocabulary.test.ts` pins the two against each other explicitly.
 *
 * `TASK_KINDS` includes kinds with **no handler** (`account_export`, `cleanup`). That is
 * deliberate: `HANDLERS` is a `Partial`, and a task of an unimplemented kind gets a clear
 * "no handler registered" failure rather than being indistinguishable from a malformed task.
 */
export const TASK_KINDS = taskKindSchema.options;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface DispatchTask {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface HandlerContext {
  task: DispatchTask;
  now: Date;
  signal: AbortSignal;
}

export type TaskHandler = (context: HandlerContext) => Promise<Outcome>;

export type HandlerRegistry = Readonly<Partial<Record<TaskKind, TaskHandler>>>;

export const HANDLERS: HandlerRegistry = {
  rescore_profile: async ({ task, now }) => {
    const payload = task.payload;
    const profileId = payload.profile_id;
    const resumeAfter = payload.resume_after;
    // The tie-breaker half of the composite cursor. Absent on tasks enqueued before 2026-10-15,
    // which then fall back to the timestamp-only filter rather than failing.
    const resumeAfterId = payload.resume_after_id;

    if (typeof profileId !== "string" || profileId.length === 0) {
      return { ok: false, error: "rescore_profile: payload.profile_id is missing or not a string" };
    }

    const supabase = createAdminClient();
    const store = createSupabaseRescoreStore(supabase);

    const queryResult = await supabase
      .from("profiles")
      .select("*")
      .eq("id", profileId)
      .single();

    if (queryResult.error || !queryResult.data) {
      return { ok: false, error: `rescore_profile: profile ${profileId} not found` };
    }

    const profile = queryResult.data as Parameters<typeof runRescoreProfile>[0]["profile"];

    await runRescoreProfile({
      store,
      profile,
      resumeAfter: typeof resumeAfter === "string" ? resumeAfter : null,
        resumeAfterId: typeof resumeAfterId === "string" ? resumeAfterId : null,
      now,
    });

    return { ok: true };
  },

  // Keyed by `ingest_source`: the Postgres `task_kind` enum's name for this work, per
  // 0001_init.sql:51 and docs/02 §5.9. `HandlerRegistry` is keyed by the schema's union, so
  // writing `scrape_source` here is now a compile error instead of a task that can never be
  // enqueued.
  ingest_source: async (context) => {
    return await runIngestSource(context);
  },
};

export function registeredKinds(): TaskKind[] {
  return Object.keys(HANDLERS)
    .filter((kind): kind is TaskKind => HANDLERS[kind as TaskKind] !== undefined)
    .sort();
}

export function hasHandler(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}

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
