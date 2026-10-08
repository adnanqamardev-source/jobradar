/**
 * backoff.test.ts — the two retry ladders, and the constraint that separates them.
 *
 * The point of `src/lib/backoff.ts` is that two functions once shared the name "backoff" and
 * drifted. These tests exist so the naming cannot quietly stop meaning anything: each ladder is
 * pinned to its own values, and the connector's is pinned to the *lease* it has to fit inside.
 */

import { describe, expect, it } from "vitest";

import {
  CONNECTOR_BACKOFF_LADDER_MS,
  CONNECTOR_BACKOFF_TOTAL_MS,
  QUEUE_BACKOFF_LADDER_MS,
  connectorBackoffMs,
  ladderMs,
  queueBackoffMs,
} from "@/lib/backoff";
import { LEASE_MS } from "@/lib/queue/constants";
import { backoffFor } from "@/lib/queue/plan";

describe("ladderMs", () => {
  const ladder = [30, 120, 480];

  it("reads the first rung for the first attempt", () => {
    // `attempt` is 1-based — the first failure leaves attempts = 1. Reading index 1 here is
    // the off-by-one this mapping exists to prevent; it shipped once in the queue ladder.
    expect(ladderMs(ladder, 1)).toBe(30);
  });

  it("maps attempts positionally", () => {
    expect(ladderMs(ladder, 2)).toBe(120);
    expect(ladderMs(ladder, 3)).toBe(480);
  });

  it("clamps below the first rung", () => {
    expect(ladderMs(ladder, 0)).toBe(30);
    expect(ladderMs(ladder, -5)).toBe(30);
  });

  // A task past max_attempts is terminal, and an unbounded ladder eventually produces a delay
  // no scheduler can represent.
  it("holds the last rung rather than extrapolating", () => {
    expect(ladderMs(ladder, 4)).toBe(480);
    expect(ladderMs(ladder, 100)).toBe(480);
  });

  it("returns 0 for an empty ladder rather than undefined", () => {
    expect(ladderMs([], 1)).toBe(0);
  });
});

describe("queue ladder — docs/03 §5.2, docs/04 §5.9, docs/05b ING-008", () => {
  it("is 30s / 2m / 8m", () => {
    expect(QUEUE_BACKOFF_LADDER_MS).toEqual([30_000, 120_000, 480_000]);
  });

  it("is what backoffFor returns, so the queue has one definition", () => {
    for (const attempt of [1, 2, 3]) {
      expect(backoffFor(attempt)).toBe(queueBackoffMs(attempt));
    }
  });
});

describe("connector ladder — bounded by the lease", () => {
  it("keeps its pre-existing values", () => {
    // Unchanged behaviour. What this commit changed is that the values are now named and
    // justified rather than being an unexplained `* 2 ** attempt`.
    expect(CONNECTOR_BACKOFF_LADDER_MS).toEqual([2_000, 4_000, 8_000]);
    expect(connectorBackoffMs(1)).toBe(2_000);
  });

  // The whole reason the two ladders are not the same numbers.
  //
  // A connector retry sleeps *inside* a leased task. The queue ladder totals 630s against a
  // 300s lease, so a connector using it would be reaped by `claim_tasks` mid-sleep and a
  // second worker would start the same task. `src/lib/backoff.ts` also asserts this at import
  // time; this test states the same fact where a reader will look for it.
  it("totals far less than the lease", () => {
    expect(CONNECTOR_BACKOFF_TOTAL_MS).toBeLessThan(LEASE_MS);
    expect(CONNECTOR_BACKOFF_TOTAL_MS).toBe(14_000);
  });

  it("is deliberately not the queue ladder", () => {
    // Guards the specific mistake: someone "unifying" the two backoffs.
    expect(connectorBackoffMs(1)).not.toBe(queueBackoffMs(1));
    expect(CONNECTOR_BACKOFF_TOTAL_MS).toBeLessThan(queueBackoffMs(1) + queueBackoffMs(2));
  });
});
