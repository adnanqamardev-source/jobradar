/**
 * plan-enqueue.ts — which sources a cron cycle should enqueue (BE-109).
 *
 * docs/02b §6.4: "Vercel Cron hits `/api/cron/process` every minute with `CRON_SECRET`."
 * `docs/05b` ING-009 adds: "Sources with `next_run_at <= now()` are enqueued exactly once
 * per cycle."
 *
 * ## Why this is pure and separate from the route
 *
 * "Exactly once per cycle" is the obligation, and it is the one that is easy to get wrong in
 * a way no test notices if the test only checks the happy path. Two implementations diverge
 * here: one that re-queries inside the loop, and one that decides the whole set up front.
 * Only the second can *prove* once-per-source, because the candidate list is snapshotted
 * before any row is written. A per-row re-query re-reads `next_run_at` after the first insert
 * and can double-enqueue a source whose `next_run_at` was advanced by a trigger.
 *
 * So this module returns a plan; `api/cron/enqueue/route.ts` executes it.
 *
 * ## Cadence, and why `next_run_at` is the source of truth
 *
 * `sources.cadence_minutes` is the interval; `next_run_at` is when this source is next due.
 * The plan advances `next_run_at` by exactly one cadence from its **previous** due time, not
 * from `now`. Advancing from `now` is the bug that makes a backlog permanent: a source that
 * has not run for a day would, on each catch-up cycle, get its next slot set to "now + 6h"
 * and never accumulate enough catch-up to matter. Anchoring to the prior due time converges.
 *
 * A source that is very far behind still advances by one interval, so it walks forward
 * rather than jumping — `catchUp` reports how many cycles behind it was so the caller can
 * decide whether to skip it.
 */

import type { SourceRow } from "@/lib/ingest/sources";

/** A source due to run, with the `next_run_at` it should be advanced to. */
export interface EnqueuePlanEntry {
  sourceId: string;
  kind: string;
  /** The `next_run_at` to write after enqueueing this source. */
  nextRunAt: string;
  /** How many cadence intervals this source is behind `now`. 0 means it was just due. */
  catchUp: number;
}

export type EnqueueSkipReason = "disabled" | "not-due" | "no-cadence" | "no-kind";

export interface EnqueueSkip {
  kind: "skip";
  sourceId: string;
  reason: EnqueueSkipReason;
}

export type EnqueuePlan = EnqueuePlanEntry | EnqueueSkip;

/**
 * Decide which sources to enqueue, and what to write back.
 *
 * Every source produces exactly one entry — enqueued or skipped — so a source that silently
 * vanishes from the cycle is explainable rather than invisible. The ING-009 isolation
 * requirement follows from this: the plan is computed for all sources before any write, so
 * one source's failure cannot remove another from the batch.
 */
export function planEnqueue(
  sources: readonly SourceRow[],
  now: Date,
): { entries: EnqueuePlanEntry[]; skipped: EnqueueSkip[] } {
  const entries: EnqueuePlanEntry[] = [];
  const skipped: EnqueueSkip[] = [];

  for (const source of sources) {
    if (!source.enabled) {
      skipped.push({ kind: "skip", sourceId: source.id, reason: "disabled" });
      continue;
    }

    if (typeof source.kind !== "string" || source.kind.length === 0) {
      skipped.push({ kind: "skip", sourceId: source.id, reason: "no-kind" });
      continue;
    }

    // A non-positive cadence would produce a `next_run_at` that never moves past `now`, so
    // the source is re-enqueued on every single cycle forever. Treated as a config error
    // rather than defaulted, because defaulting hides a bad row.
    if (!Number.isFinite(source.cadence_minutes) || source.cadence_minutes <= 0) {
      skipped.push({ kind: "skip", sourceId: source.id, reason: "no-cadence" });
      continue;
    }

    const due = source.next_run_at ? Date.parse(source.next_run_at) : Number.NaN;

    // A null or unparseable `next_run_at` is treated as due. A brand-new source row has
    // `next_run_at = null`, and treating that as "not due" would mean a newly created source
    // never runs — the row exists precisely to be run.
    if (!Number.isNaN(due) && due > now.getTime()) {
      skipped.push({ kind: "skip", sourceId: source.id, reason: "not-due" });
      continue;
    }

    const intervalMs = source.cadence_minutes * 60 * 1000;

    // Anchor to the previous due time, not to `now`. See the module docstring.
    const anchor = Number.isNaN(due) ? now.getTime() : due;
    const nextRunAt = new Date(anchor + intervalMs);

    // How many intervals behind we are. A source 25h overdue on a 60-minute cadence is 25
    // cycles behind; it gets exactly one enqueue and one interval of progress, so it
    // converges instead of stampeding.
    const catchUp = Number.isNaN(due)
      ? 0
      : Math.floor((now.getTime() - anchor) / intervalMs);

    entries.push({
      sourceId: source.id,
      kind: source.kind,
      nextRunAt: nextRunAt.toISOString(),
      catchUp,
    });
  }

  return { entries, skipped };
}

/** Milliseconds in a minute, for readability at the call sites above. */
export const MS_PER_MINUTE = 60 * 1000;
