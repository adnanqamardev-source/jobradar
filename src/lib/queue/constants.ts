/**
 * constants.ts — task-queue protocol constants (docs/02 §6.4).
 *
 * These are protocol values, not tunables: each one is a number the specification
 * states, so a caller cannot pass a different one without leaving the spec behind.
 * Lives beside `plan.ts` rather than in the executor so the drain script and the cron
 * route cannot disagree about what the protocol is.
 */

/**
 * Worker lease duration, 5 minutes.
 * docs/02 §6.4: "runs each in a try/catch with a 5-minute lease."
 */
export const LEASE_MS = 5 * 60 * 1000;

/**
 * Maximum tasks claimed per batch.
 * docs/02 §6.4: "Worker claims ≤ 25 tasks (FOR UPDATE SKIP LOCKED)."
 */
export const MAX_BATCH = 25;

/**
 * Fallback attempt ceiling when a row carries a non-positive `max_attempts`.
 * docs/02 §5.8: `max_attempts smallint default 3`.
 */
export const MAX_ATTEMPTS_DEFAULT = 3;

/**
 * Worker identity recorded in `locked_by` during local development.
 * Production workers use the Vercel function instance id.
 */
export const LOCAL_WORKER_ID = "local-drain";