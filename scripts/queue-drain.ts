#!/usr/bin/env tsx
/**
 * queue-drain.ts — Process one batch of the task queue locally.
 * Replaces the Vercel cron for local development.
 *
 * Usage:
 *   pnpm queue:drain --once          # process one batch and exit
 *   pnpm queue:drain --once --kind=score_jobs  # filter by task_kind
 *
 * ## This script is an executor, not the protocol
 *
 * Every queue rule — ordering, eligibility, lease arithmetic, attempt accounting, the
 * backoff curve, terminal failure — lives in `src/lib/queue/plan.ts` (docs/02 §6.4).
 * This file decides nothing; it performs the plan and reports what happened. The
 * production drain at `src/app/api/cron/process/route.ts` (BE-109) is the second caller
 * of that same module.
 *
 * It previously held the protocol inline, where it had drifted from docs/02 §6.4 in
 * thirteen places — most consequentially, it marked every claimed task `done` without
 * running a handler.
 *
 * ## Env loading
 *
 * Node's built-in `--env-file` flag, wired into the `queue:drain` npm script. No dotenv
 * dependency — it was never in package.json.
 *
 * ## claim-primitive (known gap, FND-002)
 *
 * docs/02 §6.4 specifies `FOR UPDATE SKIP LOCKED`, which supabase-js cannot express — it
 * needs an RPC function that FND-002 must create in a migration. Until that exists this
 * uses a compare-and-swap: the update carries `.eq("status","pending")`, so only one
 * worker can win a given row. That preserves mutual exclusion per task but not
 * batch-claim atomicity. Recorded in docs/02 §6.4.
 *
 * ## Not yet implemented (BE-108)
 *
 * Handler dispatch. `src/lib/queue/handlers/*` does not exist, so a claimed task cannot
 * be executed yet. Rather than mark it `done` — which silently discarded every task this
 * script claimed — it is released back to `pending` with an explanatory `last_error`,
 * leaving the row visible and retryable instead of falsely complete.
 */

import { createClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { LEASE_MS, LOCAL_WORKER_ID, MAX_BATCH } from "@/lib/queue/constants";
import { needsAuditLog, planClaim, settleTask, type Outcome, type QueueTask } from "@/lib/queue/plan";

// Validated by src/lib/env.ts, not by hand. Reading process.env directly here used to
// give this script a second, laxer definition of "configured" than the rest of the app:
// a whitespace-only key passed this file's `!KEY` check and would have thrown in env.ts.
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** The inferred client type. `ReturnType<typeof createClient>` would erase the schema
 *  generics to `never` and break every `.from(...)` call. */
type Db = typeof supabase;

/** Narrow an unknown Supabase row to the fields the planner reads. */
function toTask(row: Record<string, unknown>): QueueTask | null {
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

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const kindArg = args.find((a) => a.startsWith("--kind="));
  const kind: string | null = kindArg ? (kindArg.split("=")[1] ?? null) : null;

  console.log(
    `[queue-drain] starting${once ? " (--once)" : ""}${kind ? ` kind=${kind}` : ""} ` +
      `(cap ${MAX_BATCH}, lease ${LEASE_MS / 1000}s)`,
  );

  // The kind filter belongs in the query. Filtering in-process after `limit` selected
  // ten arbitrary tasks and then discarded all of them.
  //
  // Ordering here matches §6.4 so Postgres can use the index, but it is the planner that
  // has the final say: this over-fetches (2× the cap) because `run_after <= now()` cannot
  // be expressed in PostgREST, and dropping backoff rows after a LIMIT would silently
  // shrink the batch below the cap.
  let query = supabase
    .from("task_queue")
    .select("id,kind,status,priority,run_after,attempts,max_attempts")
    .eq("status", "pending")
    .order("priority", { ascending: true })
    .order("run_after", { ascending: true })
    .limit(MAX_BATCH * 2);

  if (kind) query = query.eq("kind", kind);

  const { data: rows, error } = await query;

  if (error) {
    console.error("[queue-drain] fetch error:", error.message);
    process.exit(1);
  }

  const tasks = (rows ?? []).flatMap((row) => {
    const task = toTask(row);
    return task ? [task] : [];
  });

  if (tasks.length === 0) {
    console.log("[queue-drain] no pending tasks");
    return;
  }

  // Injected, never Date.now() inside the plan. See plan.ts.
  const now = new Date();
  const entries = planClaim(tasks, now, { kind, workerId: LOCAL_WORKER_ID });

  for (const skipped of entries.filter((e) => e.kind === "skip")) {
    if (skipped.reason !== "wrong-kind") {
      console.log(`[queue-drain] ${skipped.task.id} skipped: ${skipped.reason}`);
    }
  }

  for (const claim of entries.filter((e) => e.kind === "claim")) {
    const { task, lease } = claim;

    // Compare-and-swap claim. See the `claim-primitive` note in the header.
    const { data: claimed, error: claimErr } = await supabase
      .from("task_queue")
      .update({ status: "running", locked_at: lease.locked_at, locked_by: lease.locked_by })
      .eq("id", task.id)
      .eq("status", "pending")
      .select("id");

    if (claimErr) {
      console.warn(`[queue-drain] task ${task.id} claim failed:`, claimErr.message);
      continue;
    }
    if (!claimed || claimed.length === 0) {
      console.log(`[queue-drain] task ${task.id} claimed by another worker, skipping`);
      continue;
    }

    console.log(`[queue-drain] processing ${task.kind} (${task.id})`);

    // BE-108 owns the handlers. Until they exist there is nothing to run, and the
    // honest outcome is "not done" — see the header.
    const outcome: Outcome = {
      ok: false,
      error: "no handler registered for this task kind (BE-108)",
    };

    await settle(supabase, task, outcome, now);
  }
}

/** Apply a settlement the planner decided, plus the audit row §6.4 requires on terminal failure. */
async function settle(client: Db, task: QueueTask, outcome: Outcome, now: Date) {
  const s = settleTask(task, outcome, now, LOCAL_WORKER_ID);

  const { error: settleErr } = await client
    .from("task_queue")
    .update({
      status: s.status,
      attempts: s.attempts,
      last_error: s.last_error,
      run_after: s.run_after,
      locked_at: s.cleared ? null : s.locked_at,
      locked_by: s.cleared ? null : s.locked_by,
    })
    .eq("id", task.id);

  if (settleErr) {
    console.error(`[queue-drain] ${task.kind} settle error (${task.id}):`, settleErr.message);
    return;
  }

  if (needsAuditLog(task, outcome)) {
    // docs/02 §6.4: terminal failure writes an audit_logs entry (BE-108 owns the table).
    const { error: auditErr } = await client.from("audit_logs").insert({
      action: "queue.task_failed",
      entity_type: "task_queue",
      entity_id: task.id,
      detail: { kind: task.kind, attempts: s.attempts, error: s.last_error },
    });
    if (auditErr) console.warn(`[queue-drain] audit log failed (${task.id}):`, auditErr.message);
  }

  if (outcome.ok) {
    console.log(`[queue-drain] ${task.kind} done (${task.id})`);
  } else {
    console.error(`[queue-drain] ${task.kind} -> ${s.status} (${task.id}): ${s.last_error}`);
  }
}

main().catch((e) => {
  console.error("[queue-drain] fatal:", e);
  process.exit(1);
});