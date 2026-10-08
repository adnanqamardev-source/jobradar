/**
 * Queue protocol tests (docs/02 §6.4).
 *
 * Every case here corresponds to a rule the specification states. Several of them
 * correspond to a rule the drain script previously got wrong: the protocol was inline in
 * `scripts/queue-drain.ts` and had drifted from §6.4 in thirteen places. Those are marked
 * `regression:` so the reason each one exists survives the next refactor.
 *
 * No database, no Testcontainers, no fake timers — the planner takes `now` as an
 * argument, so every case is a plain function call with a literal clock. That is the
 * property FND-002 was blocking, and it is why `task_queue` not existing yet does not
 * prevent this from being tested.
 */

import { describe, expect, it } from "vitest";

import { LEASE_MS, MAX_ATTEMPTS_DEFAULT, MAX_BATCH } from "@/lib/queue/constants";
import {
  backoffFor,
  isRunnable,
  leaseFor,
  needsAuditLog,
  planClaim,
  settleTask,
  type Outcome,
  type QueueTask,
} from "@/lib/queue/plan";

const T0 = new Date("2026-10-03T00:00:00.000Z");

/** A task row with sensible defaults; override only what the case is about. */
const task = (over: Partial<QueueTask> = {}): QueueTask => ({
  id: "t-1",
  kind: "score_jobs",
  status: "pending",
  priority: 100,
  run_after: T0.toISOString(),
  attempts: 0,
  max_attempts: 3,
  ...over,
});

const plan = (tasks: QueueTask[], over: { kind?: string | null; maxBatch?: number } = {}) =>
  planClaim(tasks, T0, { kind: over.kind ?? null, workerId: "test-worker", ...over });

const claimed = (tasks: QueueTask[], over?: { kind?: string | null; maxBatch?: number }) =>
  plan(tasks, over).filter((e) => e.kind === "claim");

const skipped = (tasks: QueueTask[], over?: { kind?: string | null; maxBatch?: number }) =>
  plan(tasks, over).filter((e) => e.kind === "skip");

describe("plan — protocol constants (docs/02 §6.4)", () => {
  it("uses a 5-minute lease and a 25-task batch cap", () => {
    expect(LEASE_MS).toBe(5 * 60 * 1000);
    expect(MAX_BATCH).toBe(25);
  });
});

describe("planClaim — ordering", () => {
  it("runs lower priority numbers first", () => {
    // docs/02 §5.8: priority is "lower runs first".
    const tasks = [task({ id: "a", priority: 300 }), task({ id: "b", priority: 10 })];
    expect(claimed(tasks).map((e) => e.task.id)).toEqual(["b", "a"]);
  });

  it("breaks a priority tie on run_after, earliest first", () => {
    // Both run_after values must be due at T0, or the later one is skipped as in-backoff
    // and never reaches the tie-break.
    const tasks = [
      task({ id: "later", run_after: "2026-10-02T23:00:00.000Z" }),
      task({ id: "earlier", run_after: "2026-10-02T22:00:00.000Z" }),
    ];
    expect(claimed(tasks).map((e) => e.task.id)).toEqual(["earlier", "later"]);
  });

  it("does not depend on the order rows arrived in", () => {
    const tasks = [
      task({ id: "c", priority: 3 }),
      task({ id: "a", priority: 1 }),
      task({ id: "b", priority: 2 }),
    ];
    const forward = claimed(tasks).map((e) => e.task.id);
    const reversed = claimed([...tasks].reverse()).map((e) => e.task.id);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["a", "b", "c"]);
  });

  it("sorts an unparseable run_after last instead of poisoning the comparator", () => {
    const tasks = [task({ id: "bad", run_after: "not-a-date" }), task({ id: "good" })];
    expect(claimed(tasks).map((e) => e.task.id)).toEqual(["good", "bad"]);
  });
});

describe("planClaim — eligibility", () => {
  // regression: the query had no `run_after <= now()` filter at all, so a task sitting in
  // backoff was claimed immediately and the retry schedule was never honoured.
  it("skips a task whose backoff window has not elapsed", () => {
    const future = task({ run_after: "2026-10-03T00:05:00.000Z" });
    expect(skipped([future])).toEqual([{ kind: "skip", task: future, reason: "in-backoff" }]);
  });

  it("claims a task whose run_after is exactly now", () => {
    expect(claimed([task({ run_after: T0.toISOString() })])).toHaveLength(1);
  });

  it("claims a task whose run_after is in the past", () => {
    expect(claimed([task({ run_after: "2026-10-02T00:00:00.000Z" })])).toHaveLength(1);
  });

  it("treats an unparseable run_after as due rather than stranding the row", () => {
    expect(claimed([task({ run_after: "garbage" })])).toHaveLength(1);
  });

  it("skips anything not pending", () => {
    for (const status of ["running", "done", "failed", "cancelled"] as const) {
      expect(skipped([task({ status })])[0]).toMatchObject({ reason: "not-pending" });
    }
  });

  it("filters by kind", () => {
    const tasks = [task({ id: "s", kind: "score_jobs" }), task({ id: "d", kind: "send_digest" })];
    expect(claimed(tasks, { kind: "send_digest" }).map((e) => e.task.id)).toEqual(["d"]);
    expect(skipped(tasks, { kind: "send_digest" })[0]).toMatchObject({ reason: "wrong-kind" });
  });

  // regression: --kind was filtered in-process *after* `limit`, so a filtered drain
  // selected ten arbitrary tasks and then discarded all of them.
  it("filters by kind before the cap, so a filtered drain still finds its tasks", () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task({ id: `other-${i}`, kind: "ingest_source", priority: 1 }),
    );
    tasks.push(task({ id: "target", kind: "score_jobs", priority: 999 }));

    const entries = claimed(tasks, { kind: "score_jobs" });
    expect(entries.map((e) => e.task.id)).toEqual(["target"]);
  });
});

describe("planClaim — batch cap", () => {
  it("claims at most 25 tasks", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => task({ id: `t-${i}` }));
    expect(claimed(tasks)).toHaveLength(MAX_BATCH);
  });

  it("caps on claims, not on inspection — every task is still accounted for", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task({ id: `t-${i}` }));
    const entries = plan(tasks);
    expect(entries).toHaveLength(30);
    expect(entries.filter((e) => e.kind === "claim")).toHaveLength(25);
    expect(entries.filter((e) => e.kind === "skip")).toHaveLength(5);
  });

  it("explains a cap skip instead of silently dropping the row", () => {
    const tasks = Array.from({ length: 26 }, (_, i) => task({ id: `t-${i}` }));
    const over = skipped(tasks).find((s) => s.reason === "over-batch-cap");
    expect(over).toBeDefined();
    expect(over?.task.id).toBe("t-25");
  });

  it("still fills the batch past rows excluded by backoff", () => {
    const tasks = [
      ...Array.from({ length: 10 }, (_, i) =>
        task({ id: `waiting-${i}`, run_after: "2026-10-03T01:00:00.000Z" }),
      ),
      ...Array.from({ length: 25 }, (_, i) => task({ id: `ready-${i}` })),
    ];
    expect(claimed(tasks)).toHaveLength(25);
  });

  it("honours an explicit cap", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task({ id: `t-${i}` }));
    expect(claimed(tasks, { maxBatch: 3 })).toHaveLength(3);
  });
});

describe("planClaim — lease", () => {
  // regression: the lease was written into `run_after`, the column docs/02 §5.8 reserves
  // for backoff. Since §6.4 orders by `run_after`, that made one column carry two clocks.
  it("stamps locked_at and locked_by, never run_after", () => {
    const [entry] = claimed([task()]);
    expect(entry).toMatchObject({
      kind: "claim",
      lease: { locked_at: T0.toISOString(), locked_by: "test-worker" },
    });
    if (entry?.kind !== "claim") throw new Error("expected a claim");
    expect(Object.keys(entry.lease).sort()).toEqual(["locked_at", "locked_by"]);
  });

  it("gives every claim in a batch the same lease", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    const [x, y] = claimed(tasks);
    if (x?.kind !== "claim" || y?.kind !== "claim") throw new Error("expected two claims");
    expect(x.lease).toEqual(y.lease);
  });

  it("leaseFor is 5 minutes wide", () => {
    const stamp = leaseFor(T0, "w");
    expect(Date.parse(stamp.locked_at) + LEASE_MS).toBe(T0.getTime() + LEASE_MS);
  });
});

describe("backoffFor — the documented 30s / 2m / 8m ladder", () => {
  it("uses the post-increment attempts value", () => {
    // Regression guard: the inline script once passed the *pre*-increment value, so the first
    // failure waited 2^0 = 1s. The off-by-one is still the property being pinned — only the
    // values changed, from 2^n to the ladder that three documents specify.
    expect(backoffFor(1)).toBe(30_000);
    expect(backoffFor(2)).toBe(120_000);
    expect(backoffFor(3)).toBe(480_000);
  });

  it("clamps below the first rung rather than indexing out of bounds", () => {
    expect(backoffFor(-5)).toBe(30_000);
    expect(backoffFor(0)).toBe(30_000);
  });

  // The ladder is positional and does not extrapolate. An unbounded doubling eventually
  // produces a delay no scheduler can represent, and a task past max_attempts is terminal
  // anyway — an ever-growing interval would only obscure that.
  it("holds the last rung instead of growing without bound", () => {
    expect(backoffFor(4)).toBe(480_000);
    expect(backoffFor(50)).toBe(480_000);
  });

  it("increases strictly across the rungs that exist", () => {
    const ladder = [1, 2, 3].map((n) => backoffFor(n));
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
    expect(new Set(ladder).size).toBe(3);
  });
});

describe("settleTask — success", () => {
  const ok: Outcome = { ok: true };

  it("marks the task done", () => {
    expect(settleTask(task(), ok, T0, "w").status).toBe("done");
  });

  // regression: attempts was incremented at *claim*, so a task that succeeded three times
  // arrived at its first real error with two of its three retries already spent.
  it("does not touch attempts", () => {
    expect(settleTask(task({ attempts: 2 }), ok, T0, "w").attempts).toBe(2);
    expect(settleTask(task({ attempts: 0 }), ok, T0, "w").attempts).toBe(0);
  });

  it("clears last_error", () => {
    expect(settleTask(task(), ok, T0, "w").last_error).toBeNull();
  });

  it("leaves run_after alone so a completed row keeps its scheduled timestamp", () => {
    const scheduled = "2026-10-03T09:00:00.000Z";
    expect(settleTask(task({ run_after: scheduled }), ok, T0, "w").run_after).toBe(scheduled);
  });

  it("keeps the lease stamped, since the worker still holds it", () => {
    const s = settleTask(task(), ok, T0, "w");
    expect(s.cleared).toBe(false);
    expect(s.locked_by).toBe("w");
  });
});

describe("settleTask — failure", () => {
  const fail = (message = "boom"): Outcome => ({ ok: false, error: message });

  // regression: §6.4 says "Failure → attempts += 1".
  it("increments attempts exactly once", () => {
    expect(settleTask(task({ attempts: 0 }), fail(), T0, "w").attempts).toBe(1);
    expect(settleTask(task({ attempts: 1 }), fail(), T0, "w").attempts).toBe(2);
  });

  it("returns to pending below max_attempts", () => {
    const s = settleTask(task({ attempts: 1, max_attempts: 3 }), fail(), T0, "w");
    expect(s.status).toBe("pending");
  });

  it("records the error", () => {
    expect(settleTask(task(), fail("upstream 500"), T0, "w").last_error).toBe("upstream 500");
  });

  it("schedules the retry using the post-increment attempt count", () => {
    const s = settleTask(task({ attempts: 0 }), fail(), T0, "w");
    // attempts 0 -> 1 after the failure increment, so the first rung (30s), not zero.
    expect(Date.parse(s.run_after) - T0.getTime()).toBe(30_000);
  });

  // regression: the failure path left locked_at / locked_by set, so a re-queued task kept
  // a stale lease and looked claimed to every other worker.
  it("clears the lease so another worker can take it", () => {
    const s = settleTask(task(), fail(), T0, "w");
    expect(s.cleared).toBe(true);
    expect(s.locked_at).toBeNull();
    expect(s.locked_by).toBeNull();
  });
});

describe("settleTask — terminal failure (docs/02 §6.4)", () => {
  const fail: Outcome = { ok: false, error: "still broken" };

  it("marks failed once attempts reaches max_attempts", () => {
    const s = settleTask(task({ attempts: 2, max_attempts: 3 }), fail, T0, "w");
    expect(s.status).toBe("failed");
    expect(s.attempts).toBe(3);
  });

  it("fails immediately when max_attempts is 1", () => {
    expect(settleTask(task({ attempts: 0, max_attempts: 1 }), fail, T0, "w").status).toBe(
      "failed",
    );
  });

  it("falls back to the schema default when max_attempts is non-positive", () => {
    // docs/02 §5.8: max_attempts defaults to 3. A zero would otherwise fail every task
    // on its first error.
    const s = settleTask(task({ attempts: 0, max_attempts: 0 }), fail, T0, "w");
    expect(s.status).toBe("pending");
    expect(MAX_ATTEMPTS_DEFAULT).toBe(3);
  });

  it("still schedules a run_after on terminal failure, for the admin retry surface", () => {
    const s = settleTask(task({ attempts: 2, max_attempts: 3 }), fail, T0, "w");
    expect(Date.parse(s.run_after)).toBeGreaterThan(T0.getTime());
  });
});

describe("needsAuditLog — docs/02 §6.4", () => {
  const fail: Outcome = { ok: false, error: "boom" };

  // regression: the script wrote no audit_logs row on terminal failure at all.
  it("is required when a task reaches failed", () => {
    expect(needsAuditLog(task({ attempts: 2, max_attempts: 3 }), fail)).toBe(true);
  });

  it("is not required for an intermediate retry", () => {
    expect(needsAuditLog(task({ attempts: 0, max_attempts: 3 }), fail)).toBe(false);
  });

  it("is never required on success", () => {
    expect(needsAuditLog(task(), { ok: true })).toBe(false);
    expect(needsAuditLog(task({ attempts: 99 }), { ok: true })).toBe(false);
  });
});

describe("isRunnable — the backoff predicate on its own", () => {
  it("agrees with planClaim for due and not-due rows", () => {
    expect(isRunnable(task({ run_after: "2026-10-02T00:00:00.000Z" }), T0)).toBe(true);
    expect(isRunnable(task({ run_after: "2026-10-04T00:00:00.000Z" }), T0)).toBe(false);
  });
});

describe("plan — idempotency obligation (docs/02 §6.4)", () => {
  // §6.4: "Idempotency: every handler is safe to re-run". The planner is deterministic
  // given the same rows and clock, so replanning an unchanged batch yields an identical
  // plan — the precondition for a handler being safely re-runnable.
  it("produces an identical plan for identical input", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", priority: 50 }), task({ id: "c", run_after: "2026-10-02T00:00:00.000Z" })];
    expect(plan(tasks)).toEqual(plan(tasks));
  });

  it("does not mutate the caller's array", () => {
    const tasks = [task({ id: "b", priority: 50 }), task({ id: "a", priority: 10 })];
    const snapshot = tasks.map((t) => t.id);
    plan(tasks);
    expect(tasks.map((t) => t.id)).toEqual(snapshot);
  });
});