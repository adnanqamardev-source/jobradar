/**
 * phase1-queue.test.ts — BE-108 (handler dispatch) and BE-109 (cron auth, enqueue plan).
 *
 * These three tickets are mostly *policy* — "exactly once per cycle", "constant-time", "a
 * failing task must not stall the batch" — and policy is exactly what a mock can be made to
 * agree with. So each test here asserts a decision the pure module made, not a call a double
 * received.
 */

import { describe, expect, it } from "vitest";

import { CRON_HEADER, cronUnauthorizedBody, verifyCronSecret } from "@/lib/cron/auth";
import { planEnqueue } from "@/lib/cron/plan-enqueue";
import {
  dispatch,
  hasHandler,
  registeredKinds,
  type DispatchTask,
} from "@/lib/queue/dispatch";
import { buildRunLog, emptyRunCounts, runStatusFor } from "@/lib/ingest/sources";
import type { SourceRow } from "@/lib/ingest/sources";

// ---------------------------------------------------------------------------
// BE-109 — constant-time cron auth
// ---------------------------------------------------------------------------

const SECRET = "a".repeat(43);

describe("verifyCronSecret", () => {
  it("accepts the bare secret", () => {
    expect(verifyCronSecret(SECRET, SECRET)).toEqual({ ok: true });
  });

  // Vercel sends `Bearer <secret>`; a runbook's hand-written curl usually does not.
  it("accepts a Bearer-prefixed secret, case-insensitively", () => {
    expect(verifyCronSecret(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
    expect(verifyCronSecret(`bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
    expect(verifyCronSecret(`BEARER ${SECRET}`, SECRET)).toEqual({ ok: true });
  });

  it("rejects a wrong secret", () => {
    expect(verifyCronSecret("b".repeat(43), SECRET)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a missing header", () => {
    expect(verifyCronSecret(null, SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(verifyCronSecret(undefined, SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(verifyCronSecret("", SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(verifyCronSecret("   ", SECRET)).toEqual({ ok: false, reason: "missing" });
  });

  // The reason the comparison is over SHA-256 digests rather than the raw strings:
  // `timingSafeEqual` throws on a length mismatch, so comparing raw values would let a
  // caller measure the expected secret's length. Every one of these must take the same path.
  it("takes the same code path for a wrong secret of any length", () => {
    for (const guess of ["x", "xx".repeat(3), "z".repeat(500), `${SECRET}x`, SECRET.slice(0, 5)]) {
      expect(verifyCronSecret(guess, SECRET)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects a prefix of the real secret", () => {
    expect(verifyCronSecret(SECRET.slice(0, -1), SECRET)).toEqual({ ok: false, reason: "invalid" });
  });

  // An empty expected secret must never authenticate. `env/schema.ts` enforces min(32), so
  // this is unreachable in practice — and that is exactly why it needs a test, since relaxing
  // the schema is the change that would make it reachable.
  it("never authenticates when the expected secret is empty", () => {
    expect(verifyCronSecret("", "")).toEqual({ ok: false, reason: "missing" });
    expect(verifyCronSecret("anything", "")).toEqual({ ok: false, reason: "invalid" });
  });

  it("names the header Vercel actually sends", () => {
    expect(CRON_HEADER).toBe("authorization");
  });

  // An oracle: "missing" and "invalid" must be indistinguishable in the response body, or
  // the route tells an attacker whether their guess was well-formed.
  it("returns a body that does not reveal which check failed", () => {
    const body = cronUnauthorizedBody("req-1");
    expect(body.error).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toMatch(/missing|invalid/i);
    expect(body.requestId).toBe("req-1");
  });
});

// ---------------------------------------------------------------------------
// BE-109 — enqueue plan
// ---------------------------------------------------------------------------

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "src-1",
    name: "Greenhouse",
    kind: "api_greenhouse",
    enabled: true,
    cadence_minutes: 360,
    next_run_at: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("planEnqueue", () => {
  // A new source row has `next_run_at = null`. Reading that as "not due" would mean a source
  // created after the last `db:reset` never runs at all.
  it("treats a null next_run_at as due", () => {
    const { entries } = planEnqueue([source({ next_run_at: null })], NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sourceId).toBe("src-1");
  });

  it("enqueues a source whose next_run_at is exactly now", () => {
    const { entries } = planEnqueue([source({ next_run_at: NOW.toISOString() })], NOW);
    expect(entries).toHaveLength(1);
  });

  it("skips a source that is not due yet", () => {
    const later = new Date(NOW.getTime() + 60_000).toISOString();
    const { entries, skipped } = planEnqueue([source({ next_run_at: later })], NOW);
    expect(entries).toHaveLength(0);
    expect(skipped[0]?.reason).toBe("not-due");
  });

  it("skips a disabled source, reporting it rather than hiding it", () => {
    const { entries, skipped } = planEnqueue([source({ enabled: false })], NOW);
    expect(entries).toHaveLength(0);
    expect(skipped[0]).toEqual({ kind: "skip", sourceId: "src-1", reason: "disabled" });
  });

  // A non-positive cadence would set next_run_at to a time that never passes, so the source
  // is re-enqueued every cycle forever. Treated as a config error, not defaulted.
  it("skips a source with a non-positive cadence", () => {
    for (const cadence of [0, -60]) {
      const { entries, skipped } = planEnqueue([source({ cadence_minutes: cadence })], NOW);
      expect(entries).toHaveLength(0);
      expect(skipped[0]?.reason).toBe("no-cadence");
    }
  });

  // The load-bearing detail: advance from the previous due time, not from `now`. Advancing
  // from `now` means a source that has been down for a day never accumulates catch-up.
  it("advances next_run_at by one cadence from the previous due time", () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const { entries } = planEnqueue(
      [source({ next_run_at: twoHoursAgo, cadence_minutes: 60 })],
      NOW,
    );
    // Previous due was 10:00, so next is 11:00 — still in the past, which is how it
    // converges rather than jumping to 13:00.
    expect(entries[0]?.nextRunAt).toBe("2026-10-09T11:00:00.000Z");
  });

  it("reports how many intervals behind a source is", () => {
    const sixHoursAgo = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const { entries } = planEnqueue(
      [source({ next_run_at: sixHoursAgo, cadence_minutes: 60 })],
      NOW,
    );
    expect(entries[0]?.catchUp).toBe(6);
  });

  it("reports zero catch-up for a source that was just due", () => {
    const { entries } = planEnqueue(
      [source({ next_run_at: NOW.toISOString(), cadence_minutes: 60 })],
      NOW,
    );
    expect(entries[0]?.catchUp).toBe(0);
  });

  // "Exactly once per cycle" — the ING-009 obligation. A plan computed up front can prove it
  // structurally; a per-row re-query cannot.
  it("enqueues each source exactly once regardless of how many are due", () => {
    const sources = Array.from({ length: 5 }, (_, i) =>
      source({ id: `src-${i}`, next_run_at: null }),
    );
    const { entries } = planEnqueue(sources, NOW);
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((e) => e.sourceId)).size).toBe(5);
  });

  // The isolation requirement: one bad source is skipped, the rest still run.
  it("does not let one malformed source remove the others from the cycle", () => {
    const { entries, skipped } = planEnqueue(
      [
        source({ id: "good-1", next_run_at: null }),
        source({ id: "bad-cadence", next_run_at: null, cadence_minutes: 0 }),
        source({ id: "good-2", next_run_at: null }),
      ],
      NOW,
    );
    expect(entries.map((e) => e.sourceId)).toEqual(["good-1", "good-2"]);
    expect(skipped.map((s) => s.sourceId)).toEqual(["bad-cadence"]);
  });

  it("treats an unparseable next_run_at as due rather than stranding the row", () => {
    const { entries } = planEnqueue([source({ next_run_at: "not-a-date" })], NOW);
    expect(entries).toHaveLength(1);
  });

  it("returns empty for no sources", () => {
    expect(planEnqueue([], NOW)).toEqual({ entries: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// BE-108 — handler dispatch
// ---------------------------------------------------------------------------

function task(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "task-1",
    kind: "scrape_source",
    payload: { source_id: "src-1" },
    ...overrides,
  };
}

describe("dispatch", () => {
  const signal = new AbortController().signal;
  const now = new Date("2026-10-09T12:00:00.000Z");

  // The failure that motivated this module: a claimed task with no handler used to be marked
  // `done`, silently discarding real work. It must fail, and name the kind.
  it("fails a task whose kind has no handler, naming the kind", async () => {
    const result = await dispatch(task({ kind: "embed_jobs" }), now, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("embed_jobs");
  });

  it("never marks an unhandled task as done", async () => {
    // The specific regression: `ok: true` here would let the settle step write status=done.
    const result = await dispatch(task({ kind: "freshness_sweep" }), now, signal);
    expect(result.ok).toBe(false);
  });

  it("has no handler for any kind the enqueue cycle can produce", () => {
    // `scrape_source` is what `planEnqueue` plans. With no handler it must fail loudly, and
    // this test is what makes that a documented state rather than an accident.
    expect(hasHandler("scrape_source")).toBe(false);
  });

  it("reports a handler that is wired but not yet implemented as a failure", async () => {
    const result = await dispatch(task({ kind: "rescore_profile" }), now, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("rescore_profile");
  });

  // The distinction that makes the message actionable: "no handler registered" points at the
  // registry, "not yet wired" points at the missing store adapter. They must not collapse.
  it("distinguishes an unimplemented handler from an unregistered one", async () => {
    // A *valid* rescore payload, so this reaches the wiring gap rather than stopping at
    // payload validation — which is the whole point of asserting the two messages apart.
    const implemented = await dispatch(
      task({ kind: "rescore_profile", payload: { profile_id: "profile-1" } }),
      now,
      signal,
    );
    const unregistered = await dispatch(task({ kind: "score_jobs" }), now, signal);
    if (implemented.ok || unregistered.ok) throw new Error("expected both to fail");
    expect(implemented.error).toContain("not yet wired");
    expect(unregistered.error).toContain("no handler registered");
  });

  it("validates a handler's payload before reporting the wiring gap", async () => {
    // A malformed payload and a missing adapter are different bugs; the payload error must
    // not be masked by the "not wired" message that would otherwise always win.
    const result = await dispatch(
      task({ kind: "rescore_profile", payload: { profile_id: 42 } }),
      now,
      signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("profile_id");
  });

  it("does not start a handler once the worker is shutting down", async () => {
    // A task claimed as the function is being killed must be settled as not-run; starting it
    // would leave the lease held by a process that no longer exists.
    const controller = new AbortController();
    controller.abort();
    const result = await dispatch(task({ kind: "rescore_profile" }), now, controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("aborted");
  });

  it("lists its registered kinds", () => {
    expect(registeredKinds()).toEqual(["rescore_profile"]);
  });
});

// ---------------------------------------------------------------------------
// BE-111 — run accounting
// ---------------------------------------------------------------------------

describe("runStatusFor", () => {
  it("reports success for a clean run", () => {
    expect(runStatusFor({ ...emptyRunCounts(), found: 10, inserted: 8 }, false)).toBe("success");
  });

  // The operationally important case: a run that fetched 200 and failed to parse 3 is
  // neither a success nor a failure.
  it("reports partial when some items failed", () => {
    expect(runStatusFor({ ...emptyRunCounts(), found: 200, inserted: 197, failed: 3 }, false)).toBe(
      "partial",
    );
  });

  it("reports partial when the run also logged an error", () => {
    expect(runStatusFor({ ...emptyRunCounts(), found: 5, inserted: 5 }, true)).toBe("partial");
  });

  it("reports failed when nothing was found and there was an error", () => {
    expect(runStatusFor(emptyRunCounts(), true)).toBe("failed");
  });

  it("reports failed when nothing was found at all", () => {
    // A source that returns zero postings is a broken integration, not a clean run — an
    // empty ATS board looks identical to a working one from the outside.
    expect(runStatusFor(emptyRunCounts(), false)).toBe("failed");
  });

  it("prefers partial over success so failures cannot be hidden", () => {
    expect(runStatusFor({ ...emptyRunCounts(), found: 1, inserted: 1, failed: 1 }, false)).toBe(
      "partial",
    );
  });
});

describe("buildRunLog", () => {
  it("omits diagnostics for a clean run", () => {
    expect(buildRunLog({ status: "success", errors: [], skipped: 0 })).toEqual({ skipped: 0 });
  });

  it("records error diagnostics for a partial run", () => {
    const log = buildRunLog({ status: "partial", errors: ["bad json at row 3"], skipped: 1 });
    expect(log.errors).toEqual(["bad json at row 3"]);
    expect(log.errorCount).toBe(1);
  });

  // One pathological source must not write a multi-megabyte jsonb row.
  it("caps diagnostics and says so", () => {
    const log = buildRunLog({
      status: "failed",
      errors: Array.from({ length: 50 }, (_, i) => `err ${i}`),
      skipped: 0,
    });
    expect((log.errors as string[]).length).toBe(20);
    expect(log.errorCount).toBe(50);
    expect(log.truncated).toBe(true);
  });
});
