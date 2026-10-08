/**
 * GET /api/cron/process — claim and run one batch of queued tasks (BE-108, BE-109).
 *
 * docs/02b §6.4: "Vercel Cron hits `/api/cron/process` every minute with `CRON_SECRET`.
 * Worker claims <= 25 tasks (`FOR UPDATE SKIP LOCKED`), runs each in a try/catch with a
 * 5-minute lease."
 *
 * ## This route decides nothing
 *
 * The protocol — ordering, eligibility, attempt accounting, the backoff curve, terminal
 * failure — is `src/lib/queue/plan.ts`. Who runs a task is `src/lib/queue/dispatch.ts`. This
 * route claims, dispatches, settles, and reports. `scripts/queue-drain.ts` is the second
 * executor of the same three modules, which is the property that stops the cron path and the
 * local path from disagreeing about what the queue does.
 *
 * ## The claim
 *
 * `claim_tasks` (migration `0009`) performs the `FOR UPDATE SKIP LOCKED` claim, because
 * supabase-js cannot attach either clause to a read. It also reaps expired leases, so a
 * worker killed mid-task does not strand its rows — see that migration's header.
 *
 * An earlier revision claimed by compare-and-swap (`.eq("status","pending")` on an update),
 * which gives mutual exclusion per task but not batch-claim atomicity: two workers read the
 * same candidate list and both win on disjoint subsets. The RPC is the specified primitive
 * and is already granted to `service_role` only.
 *
 * ## Incomplete batches re-enqueue rather than loop
 *
 * docs/02b §6.4: "Vercel function timeouts are respected by **batch size, not long-running
 * loops**." This route runs at most one batch and returns. A handler that needs more passes
 * re-enqueues itself (that is `planRescoreBatch`'s `requeue` verdict). Looping here would
 * hold a worker until Vercel kills it, leaving the lease held by a process that no longer
 * exists.
 */

import { NextResponse } from "next/server";

import { CRON_HEADER, cronUnauthorizedBody, verifyCronSecret } from "@/lib/cron/auth";
import { createClient } from "@/lib/db/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { LEASE_MS, MAX_BATCH } from "@/lib/queue/constants";
import { dispatch, type DispatchTask } from "@/lib/queue/dispatch";
import { needsAuditLog, settleTask, type Outcome, type QueueTask } from "@/lib/queue/plan";

export const dynamic = "force-dynamic";

/**
 * Worker identity written to `locked_by`.
 *
 * The Vercel instance id would be more useful in production, but it is not available through
 * a supported API in a serverless function, so a stable per-invocation id is used instead.
 * What matters for the protocol is that it is *distinct per invocation*: two concurrent
 * invocations sharing an id make a stuck row ambiguous between them.
 */
function workerId(): string {
  return `vercel-${crypto.randomUUID()}`;
}

function toQueueTask(row: Record<string, unknown>): QueueTask | null {
  if (typeof row.id !== "string" || typeof row.kind !== "string") return null;
  return {
    id: row.id,
    kind: row.kind,
    status: typeof row.status === "string" ? row.status : "pending",
    priority: typeof row.priority === "number" ? row.priority : 100,
    run_after: typeof row.run_after === "string" ? row.run_after : new Date(0).toISOString(),
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    max_attempts: typeof row.max_attempts === "number" ? row.max_attempts : 3,
  };
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();

  const auth = verifyCronSecret(request.headers.get(CRON_HEADER), env.CRON_SECRET);
  if (!auth.ok) {
    logger.warn("Cron auth failed", { requestId, route: "process", reason: auth.reason });
    return NextResponse.json(cronUnauthorizedBody(requestId), { status: 401 });
  }

  const supabase = createClient();
  const now = new Date();
  const worker = workerId();

  // `rpc` returns `any` for a function that is not in the generated Database types, so the
  // result is narrowed to `unknown` before anything reads it. The cast is to a row-shaped
  // record rather than to a task type on purpose: `toQueueTask` re-validates every field it
  // uses, because this is data that crossed a SQL boundary and a row can be missing columns
  // the TypeScript side believes are `not null`.
  const claim = (await supabase.rpc("claim_tasks", {
    p_worker_id: worker,
    p_limit: MAX_BATCH,
    p_kind: null,
    p_lease_seconds: Math.floor(LEASE_MS / 1000),
  })) as { data: unknown; error: { message: string } | null };

  const claimedRows = claim.data;
  const claimError = claim.error;

  if (claimError) {
    logger.error("Cron process: claim failed", { requestId, message: claimError.message });
    return NextResponse.json(
      { error: "claim_failed", message: "Could not claim tasks.", requestId },
      { status: 500 },
    );
  }

  const rows = Array.isArray(claimedRows) ? claimedRows : [];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, requestId, claimed: 0, done: 0, failed: 0, requeued: 0 });
  }

  // One controller for the whole batch: if the function is killed, handlers that check
  // `signal` can stop writing rather than holding a lease they cannot renew.
  const controller = new AbortController();

  const summary = { done: 0, failed: 0, requeued: 0, unhandled: 0 };

  for (const row of rows) {
    const task = toQueueTask(row as Record<string, unknown>);
    if (!task) {
      logger.warn("Cron process: unparseable claimed row", { requestId });
      continue;
    }

    const dispatchTask: DispatchTask = {
      id: task.id,
      kind: task.kind,
      payload: ((row as { payload?: unknown }).payload ?? {}) as Record<string, unknown>,
    };

    // One task's failure must not abort the rest of the batch. `dispatch` catches handler
    // throws, and this try/catch covers the settle path, so a write error is recorded against
    // its own task rather than ending the invocation with 24 tasks still leased.
    let outcome: Outcome;
    try {
      outcome = await dispatch(dispatchTask, now, controller.signal);
    } catch (error) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!outcome.ok && outcome.error.includes("no handler registered")) {
      summary.unhandled += 1;
    }

    const settlement = settleTask(task, outcome, now, worker);

    const { error: settleError } = await supabase
      .from("task_queue")
      .update({
        status: settlement.status,
        attempts: settlement.attempts,
        last_error: settlement.last_error,
        run_after: settlement.run_after,
        locked_at: settlement.cleared ? null : settlement.locked_at,
        locked_by: settlement.cleared ? null : settlement.locked_by,
        updated_at: now.toISOString(),
      })
      .eq("id", task.id);

    if (settleError) {
      // The task stays `running` with a lease, and the reaper in `claim_tasks` returns it to
      // `pending` once the lease expires. That is the designed recovery path, so this is
      // logged rather than retried here.
      logger.error("Cron process: settle failed", {
        requestId,
        taskId: task.id,
        message: settleError.message,
      });
      continue;
    }

    if (needsAuditLog(task, outcome)) {
      // docs/02b §6.4: terminal failure writes an audit_logs row (admin surface is BE-312).
      const { error: auditError } = await supabase.from("audit_logs").insert({
        action: "queue.task_failed",
        entity_type: "task_queue",
        entity_id: task.id,
        detail: { kind: task.kind, attempts: settlement.attempts, error: settlement.last_error },
      });
      if (auditError) {
        logger.warn("Cron process: audit log failed", { requestId, message: auditError.message });
      }
    }

    if (settlement.status === "done") summary.done += 1;
    else if (settlement.status === "failed") summary.failed += 1;
    else summary.requeued += 1;
  }

  logger.info("Cron process complete", { requestId, worker, claimed: rows.length, ...summary });

  return NextResponse.json({
    ok: true,
    requestId,
    claimed: rows.length,
    ...summary,
    // `claimed === MAX_BATCH` means there is probably more waiting. Reported rather than
    // acted on: the next minute's invocation picks it up, which is the "batch size, not
    // long-running loops" rule.
    moreLikely: rows.length >= MAX_BATCH,
  });
}
