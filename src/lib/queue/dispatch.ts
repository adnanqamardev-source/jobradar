/**
 * dispatch.ts — task-kind → handler registry (BE-108).
 */

import { logger } from "@/lib/logger";
import type { Outcome } from "@/lib/queue/plan";
import { runRescoreProfile } from "@/lib/queue/handlers/rescore-profile";
import { createSupabaseRescoreStore } from "@/lib/queue/handlers/rescore-store";
import { runScrapeSource } from "@/lib/queue/handlers/scrape-source";
import { createAdminClient } from "@/lib/db/admin";

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
      now,
    });

    return { ok: true };
  },

  scrape_source: async (context) => {
    return await runScrapeSource(context);
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
