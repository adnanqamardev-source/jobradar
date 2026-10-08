/**
 * backoff.ts — the two retry ladders, named for what they are.
 *
 * ## Why this module exists
 *
 * The repository had two functions both called "backoff", both doubling from a base, both
 * documented as following `docs/02b` §6.4 — and they had drifted. The queue's became
 * 30s / 2m / 8m; the connector's stayed at 2s / 4s / 8s. Neither name said which context it
 * served, so correcting one left the other looking equally correct and equally wrong. That is
 * the `notes.md` lesson from `company-slug.ts`: two definitions of one thing will drift, and
 * the fix is one definition, not two careful edits.
 *
 * They are not, however, *one thing*. They are two policies for two different situations, and
 * giving them a single shared set of values would introduce a bug:
 *
 * | | Queue (`lib/queue/plan.ts`) | Connector (`lib/connectors/http.ts`) |
 * |---|---|---|
 * | When the wait happens | between task attempts, across separate worker invocations | inside one task execution |
 * | Is a lease held? | **no** — the row is `pending`, nobody owns it | **yes** — the row is `running` and leased |
 * | Cost of a long wait | a slower recovery, nothing else | exceeds the lease, and the task is reaped mid-sleep |
 * | Ladder | 30s / 2m / 8m | short, and bounded by the lease |
 *
 * ## The constraint that fixes the connector ladder
 *
 * `docs/02b` §6.4 specifies a **5-minute lease**, and `claim_tasks` reaps any `running` row
 * whose `locked_at` is older than that. The queue ladder totals **630 seconds** of sleeping.
 * If a connector retried with that ladder, a single task would hold its lease for 10.5 minutes,
 * the reaper would mark it `pending`, and a second worker would start the *same* task while the
 * first was still awaiting `ctx.sleep` — two workers, one row, duplicate ingestion.
 *
 * So the connector ladder is deliberately short. It is not a smaller version of the queue's; it
 * is bounded by a different constraint, and `CONNECTOR_BACKOFF_TOTAL_MS` below is asserted
 * against `LEASE_MS` in `tests/unit/backoff.test.ts` so the two cannot drift apart again.
 */

import { LEASE_MS } from "@/lib/queue/constants";

/**
 * Queue retry ladder: 30s, 2m, 8m.
 *
 * Decided 2026-10-09. `docs/03` §5.2, `docs/04` §5.9 and `docs/05b` ING-008 all specify these
 * three values; only `docs/02b` §6.4's `2^n` formula disagreed. A retry of a **metered** source
 * is a billed call — Adzuna and Firecrawl both price per request, and `RunCtx.onRequest` counts
 * retries for exactly that reason — so the long ladder is the right trade for a wait that
 * happens while nobody holds a lease.
 */
export const QUEUE_BACKOFF_LADDER_MS: readonly number[] = [30_000, 120_000, 480_000];

/**
 * Connector retry ladder: 2s, 4s, 8s — the pre-existing values, kept.
 *
 * Unchanged behaviour. What changed is that the *reason* is now written down: this ladder runs
 * inside a leased task and must total well under `LEASE_MS`. See the table in the module
 * docstring.
 */
export const CONNECTOR_BACKOFF_LADDER_MS: readonly number[] = [2_000, 4_000, 8_000];

/** Total of the connector ladder — the number the lease constraint is about. */
export const CONNECTOR_BACKOFF_TOTAL_MS = CONNECTOR_BACKOFF_LADDER_MS.reduce((a, b) => a + b, 0);

/**
 * The delay for a given attempt, from a ladder.
 *
 * `attempt` is 1-based — the first failure leaves `attempts = 1` — so attempt 1 reads index 0.
 * Both ends are clamped and the last rung repeats rather than extrapolating: a task past
 * `max_attempts` is terminal anyway, and a doubling ladder eventually produces a delay no
 * scheduler can represent.
 *
 * The `?? last` fallback is not a non-null assertion. `noUncheckedIndexedAccess` is right that
 * an out-of-range index is `undefined`; naming the fallback says "cannot happen, and this is
 * what we would do if it did" rather than asserting it away.
 */
export function ladderMs(ladder: readonly number[], attempt: number): number {
  const last = ladder[ladder.length - 1] ?? 0;
  if (last === 0) return 0;

  const index = Math.min(Math.max(Math.trunc(attempt) - 1, 0), ladder.length - 1);
  return ladder[index] ?? last;
}

/** Queue backoff for a post-increment attempt count. */
export function queueBackoffMs(attempt: number): number {
  return ladderMs(QUEUE_BACKOFF_LADDER_MS, attempt);
}

/** Connector backoff for a post-increment attempt number. */
export function connectorBackoffMs(attempt: number): number {
  return ladderMs(CONNECTOR_BACKOFF_LADDER_MS, attempt);
}

/**
 * Guard for the constraint above, evaluated at import time.
 *
 * Throwing at module load is deliberate: a connector ladder that outgrew the lease is not a
 * condition to discover in production, and an import-time throw fails the test suite and the
 * build instead. It cannot fire with the current values (14s against a 300s lease).
 */
if (CONNECTOR_BACKOFF_TOTAL_MS >= LEASE_MS) {
  throw new Error(
    `CONNECTOR_BACKOFF_LADDER_MS totals ${CONNECTOR_BACKOFF_TOTAL_MS}ms, which is not below ` +
      `LEASE_MS (${LEASE_MS}ms). A connector retrying that long holds its lease past expiry, so ` +
      `claim_tasks reaps the row and a second worker runs the same task.`,
  );
}
