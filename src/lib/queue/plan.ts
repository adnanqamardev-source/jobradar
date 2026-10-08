/**
 * plan.ts — the task-queue protocol, as decisions.
 *
 * Every rule the queue obeys lives here: ordering, eligibility, lease arithmetic,
 * attempt accounting, the backoff curve, and terminal failure. `scripts/queue-drain.ts`
 * and the future `api/cron/process` route are both executors of this plan.
 *
 * ## Why this module exists
 *
 * The protocol was previously written inline in the drain script, where it had drifted
 * from its specification (docs/02 §6.4) in thirteen places. Two callers now need the
 * identical protocol, and a rule corrected in one place but not the other is exactly the
 * failure this shape removes.
 *
 * ## Why it is pure
 *
 * It takes tasks and a clock and returns decisions. It never touches a database, never
 * reads the clock itself, and never throws on ordinary input. That is what lets the
 * "run it twice, assert one row" obligation in docs/02 §6.4 be tested without Postgres —
 * and it is also why `task_queue` not existing yet (FND-002) does not block it.
 *
 * ## The one rule NOT here
 *
 * The claim itself. docs/02 §6.4 specifies `FOR UPDATE SKIP LOCKED`, which supabase-js
 * cannot express; it needs an RPC. That RPC now exists —
 * `public.claim_tasks(...)` in `supabase/migrations/0009_claim_task_queue.sql` (FND-002).
 * `planClaim` still decides *whether* to claim; the function performs it. The two halves
 * must agree on ordering and on the batch cap, so both order by priority then run_after
 * and both cap at 25.
 *
 * ## Clock
 *
 * `now` is always injected. Never call `Date.now()` in this file — freshness decay,
 * digest timezones, and retry backoff all need a fake clock to be testable.
 */

import { MAX_ATTEMPTS_DEFAULT, MAX_BATCH } from "./constants";

/** The subset of a `task_queue` row this module needs. Matches docs/02 §5.8. */
export interface QueueTask {
  id: string;
  kind: string;
  status: string;
  priority: number;
  run_after: string;
  attempts: number;
  max_attempts: number;
}

/** Fields the claim update writes. Mirrors docs/02 §5.8's `locked_at` / `locked_by` lease. */
export interface LeaseStamp {
  locked_at: string;
  locked_by: string;
}

/** Why a task was not claimed. Surfaced by the executor so a silent skip is explainable. */
export type SkipReason = "not-pending" | "in-backoff" | "wrong-kind" | "over-batch-cap";

export interface Skip {
  kind: "skip";
  task: QueueTask;
  reason: SkipReason;
}

export interface Claim {
  kind: "claim";
  task: QueueTask;
  lease: LeaseStamp;
}

export type PlanEntry = Claim | Skip;

/**
 * The lease a claimed task carries: `locked_at` now, expiring LEASE_MS later.
 *
 * The expiry is deliberately NOT written to `run_after`. docs/02 §5.8 gives `run_after`
 * one job — backoff scheduling — and §6.4 orders by `run_after`. Storing a lease there
 * would make that ordering mix two unrelated clocks.
 */
export function leaseFor(now: Date, workerId: string): LeaseStamp {
  return { locked_at: now.toISOString(), locked_by: workerId };
}

/** True when `run_after` is at or before `now` — i.e. the backoff window has elapsed. */
export function isRunnable(task: QueueTask, now: Date): boolean {
  const due = Date.parse(task.run_after);
  // An unparseable run_after is treated as due rather than stranding the row forever.
  return Number.isNaN(due) || due <= now.getTime();
}

/**
 * Order the batch and decide what to claim.
 *
 * docs/02 §6.4: "Worker claims ≤ 25 tasks (FOR UPDATE SKIP LOCKED), runs each in a
 * try/catch with a 5-minute lease." The ordering is priority ascending ("lower runs
 * first", §5.8) then run_after ascending — both applied here, not in the caller.
 *
 * `kind`, when given, filters *before* the batch cap. Filtering after the cap is how
 * `--kind=score_jobs` came to select ten arbitrary tasks and then discard all of them.
 *
 * Every task is returned as an entry — claimed or skipped — so a caller can never
 * silently lose rows. The cap is a limit on claims, not on inspection.
 */
export function planClaim(
  tasks: readonly QueueTask[],
  now: Date,
  opts: { kind?: string | null; workerId: string; maxBatch?: number },
): PlanEntry[] {
  const cap = opts.maxBatch ?? MAX_BATCH;
  const lease = leaseFor(now, opts.workerId);

  const ordered = [...tasks].sort((a, b) => a.priority - b.priority || cmpRunAfter(a, b));
  const entries: PlanEntry[] = [];
  let claimed = 0;

  for (const task of ordered) {
    if (task.status !== "pending") {
      entries.push({ kind: "skip", task, reason: "not-pending" });
    } else if (opts.kind && task.kind !== opts.kind) {
      entries.push({ kind: "skip", task, reason: "wrong-kind" });
    } else if (!isRunnable(task, now)) {
      entries.push({ kind: "skip", task, reason: "in-backoff" });
    } else if (claimed >= cap) {
      entries.push({ kind: "skip", task, reason: "over-batch-cap" });
    } else {
      entries.push({ kind: "claim", task, lease });
      claimed += 1;
    }
  }

  return entries;
}

function cmpRunAfter(a: QueueTask, b: QueueTask): number {
  const at = Date.parse(a.run_after);
  const bt = Date.parse(b.run_after);
  // Unparseable sorts last rather than poisoning the comparator with NaN.
  if (Number.isNaN(at)) return Number.isNaN(bt) ? 0 : 1;
  if (Number.isNaN(bt)) return -1;
  return at - bt;
}

/**
 * Retry delay in milliseconds, per attempt number.
 *
 * **Changed 2026-10-09 from `2^n` to the documented 30s / 2m / 8m.**
 *
 * `docs/03` §5.2, `docs/04` §5.9 and `docs/05b` ING-008 all specify 30s / 2m / 8m; only
 * `docs/02b` §6.4's formula said `2^n`, and the code followed the minority. The tie is
 * broken toward the majority because a retry of a **metered** source is a billed call —
 * Adzuna and Firecrawl both price per request, and `RunCtx.onRequest` counts retries for
 * exactly that reason. Retrying a merely-slow upstream after 2s spends quota on failures
 * rather than on results.
 *
 * Attempt numbers map positionally, so the first failure (which leaves `attempts = 1`)
 * waits 30s. An attempt beyond the table is not extrapolated — `max_attempts` defaults to
 * 3, and an unbounded doubling would eventually produce a delay no scheduler can represent.
 * The last value repeats, which is deliberate: a task that has exhausted its attempts is
 * terminal anyway, and an ever-growing interval would only hide that.
 */
const LAST_RUNG_MS = 480_000;
const BACKOFF_LADDER_MS: readonly number[] = [30_000, 120_000, LAST_RUNG_MS];

export function backoffFor(attempts: number): number {
  const n = Math.trunc(attempts);

  // `attempts` is 1-based (the first failure leaves attempts = 1) while the array is
  // 0-based, so attempt 1 must read index 0. Both ends are clamped, and the fallback is the
  // named last rung rather than a non-null assertion — `noUncheckedIndexedAccess` is right
  // that an out-of-range index is `undefined`, and `?? LAST_RUNG_MS` is the honest way to
  // say "cannot happen, and here is what we'd do if it did".
  const index = Math.min(Math.max(n - 1, 0), BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[index] ?? LAST_RUNG_MS;
}

/** How a task's execution ended. */
export type Outcome = { ok: true } | { ok: false; error: string };

/**
 * The row update that settles a claimed task.
 *
 * `locked_at`/`locked_by` are nullable because the two outcomes differ: a success keeps
 * the lease (the worker still holds the row), a re-queue clears it. `cleared` says which,
 * so the executor never has to infer it.
 */
export interface Settlement {
  status: "done" | "pending" | "failed";
  attempts: number;
  last_error: string | null;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  cleared: boolean;
}

/**
 * Decide the row update for a claimed task.
 *
 * docs/02 §6.4: "Failure → attempts += 1, run_after = now() + 2^n seconds, status back
 * to pending; at max_attempts → failed."
 *
 * Three things this gets right that the inline version did not:
 *
 *  - `attempts` increments on FAILURE, not on claim. A task that succeeds three times
 *    must not arrive at its first real error with two retries already spent.
 *  - The lease is cleared when a task re-queues. A re-queued task holding a stale
 *    `locked_by` looks leased to every other worker.
 *  - Success does not touch `run_after`, so a completed row keeps the timestamp it
 *    was scheduled for rather than a lease expiry.
 */
export function settleTask(task: QueueTask, outcome: Outcome, now: Date, workerId: string): Settlement {
  if (outcome.ok) {
    return {
      status: "done",
      attempts: task.attempts,
      last_error: null,
      run_after: task.run_after,
      locked_at: now.toISOString(),
      locked_by: workerId,
      cleared: false,
    };
  }

  const attempts = task.attempts + 1;
  const ceiling = task.max_attempts > 0 ? task.max_attempts : MAX_ATTEMPTS_DEFAULT;
  const terminal = attempts >= ceiling;

  return {
    status: terminal ? "failed" : "pending",
    attempts,
    last_error: outcome.error,
    run_after: new Date(now.getTime() + backoffFor(attempts)).toISOString(),
    locked_at: null,
    locked_by: null,
    cleared: true,
  };
}

/**
 * Whether reaching `failed` requires an `audit_logs` row.
 *
 * docs/02 §6.4: "at max_attempts → failed + audit_logs entry + admin surface." The
 * admin surface is ADM-003 / BE-312; the row is the executor's to write.
 */
export function needsAuditLog(task: QueueTask, outcome: Outcome): boolean {
  if (outcome.ok) return false;
  const ceiling = task.max_attempts > 0 ? task.max_attempts : MAX_ATTEMPTS_DEFAULT;
  return task.attempts + 1 >= ceiling;
}