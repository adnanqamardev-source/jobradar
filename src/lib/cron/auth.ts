/**
 * cron-auth.ts — `CRON_SECRET` verification for the `/api/cron/*` routes (BE-109).
 *
 * docs/02b §6.4 and `docs/05b` ING-009: every cron route is guarded by a shared secret
 * compared in constant time.
 *
 * ## Why the length leak is accepted, and the content leak is not
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, so a naive
 * implementation leaks the secret's *length* through that throw. Length is not treated as
 * secret here — it is bounded by the `min(32)` in `env/schema.ts` and a caller learns nothing
 * actionable from it. Content is: a byte-by-byte `===` returns early on the first difference,
 * which is exactly the timing side channel ING-009 forbids. So the hash is compared, not the
 * raw value.
 *
 * ## Why SHA-256 rather than comparing the raw strings
 *
 * Hashing first gives two constant-length buffers to hand to `timingSafeEqual`, so a wrong
 * secret of any length cannot take a different code path. The comparison is then over fixed
 * 32-byte digests regardless of what the caller sent. A 10-byte guess and a 64-byte guess cost
 * the same.
 *
 * ## Why a missing header is a 401 and not a 400
 *
 * A cron route with no credential is an unauthenticated request, and 401 is what a client
 * should read. The distinction that matters operationally: the response body never says
 * *which* part was wrong. "Missing" and "incorrect" are indistinguishable to the caller, so
 * the route cannot be used as an oracle for whether a guess was close.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Vercel Cron sends the secret in this header. `x-vercel-signature` is not used. */
export const CRON_HEADER = "authorization";

/** The scheme prefix Vercel Cron puts in front of the secret. */
const BEARER_PREFIX = "bearer ";

export type CronAuthFailure = "missing" | "invalid";

export type CronAuthResult = { ok: true } | { ok: false; reason: CronAuthFailure };

/** SHA-256 of a string, as a fixed-length buffer. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Strip the `Bearer ` prefix if present, case-insensitively.
 *
 * Vercel sends `Bearer <secret>`; a hand-rolled curl in a runbook often sends the bare
 * secret. Both are accepted, because rejecting one of them produces a 401 that reads like a
 * credential problem when it is a formatting one. The prefix is optional, not ignored — the
 * secret itself is still compared in full.
 */
function stripScheme(header: string): string {
  return header.toLowerCase().startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length).trim()
    : header.trim();
}

/**
 * Verify a cron request's credential.
 *
 * Takes the header value and the expected secret as arguments rather than importing `env`,
 * so the comparison is testable without a configured environment and so a route cannot
 * accidentally verify against a different variable than the one the schema validated.
 *
 * An empty or whitespace-only expected secret is `invalid` rather than a match. That case
 * should be impossible — `env/schema.ts` enforces `min(32)` — but if the schema were ever
 * relaxed, an empty expected value must not authenticate every request.
 */
export function verifyCronSecret(headerValue: string | null | undefined, expected: string): CronAuthResult {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    return { ok: false, reason: "missing" };
  }

  if (expected.length === 0) {
    return { ok: false, reason: "invalid" };
  }

  const presented = digest(stripScheme(headerValue));
  const reference = digest(expected);

  // Both are 32 bytes by construction, so this cannot throw for a length mismatch — which
  // is the whole point of hashing first.
  if (!timingSafeEqual(presented, reference)) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true };
}

/**
 * The 401 body for a failed cron check.
 *
 * Deliberately identical for "missing" and "invalid" so the route is not an oracle for
 * whether a guess was well-formed. `requestId` is echoed because the cron routes log it and
 * an operator debugging a 401 needs the correlation id, not the reason.
 */
export function cronUnauthorizedBody(requestId: string): Record<string, unknown> {
  return {
    error: "unauthorized",
    message: "Cron authentication failed.",
    requestId,
  };
}
