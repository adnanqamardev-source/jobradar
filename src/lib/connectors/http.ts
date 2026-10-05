/**
 * http.ts — the one place connectors are allowed to touch the network.
 *
 * docs/04 §5.9 fixes the policy for every integration: 30s timeout, AbortSignal,
 * retry ×3 with exponential backoff, a redacted structured log, and failures mapped
 * onto the error codes in docs/03 §5.1. Writing that per connector is how it drifts,
 * so it lives here once and connectors call `fetchJson`.
 *
 * Retrying is deliberately narrow: retry on timeout, network error, HTTP 429 and
 * HTTP 5xx. A 4xx that is not 429 is the caller's fault (bad key, bad board) and
 * retrying it three times only wastes quota.
 */

import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

import { HTTP_DEFAULTS, type RunCtx } from "./types";

const log = logger.child({ module: "connectors/http" });

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Label used in logs and errors — never a URL with credentials in it. */
  label: string;
}

/** Combine the caller's signal with a timeout, without mutating either. */
function signalWithTimeout(ctx: RunCtx, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [ctx.signal, timeout];
  return AbortSignal.any(signals);
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET `url` and parse JSON, with timeout, retry and typed failure.
 *
 * @throws {AppError} `upstream_timeout` on abort/timeout, `upstream_error` on HTTP or
 *         network failure, `scrape_parse_failed` when the body is not JSON.
 */
export async function fetchJson<T>(
  url: string,
  ctx: RunCtx,
  options: FetchJsonOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? HTTP_DEFAULTS.timeoutMs;
  const retries = options.retries ?? HTTP_DEFAULTS.retries;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // A cancelled run must not spend its remaining retries: re-requesting an aborted
    // source is pure quota waste, and the caller already knows it stopped.
    if (ctx.signal.aborted) {
      throw new AppError("upstream_timeout", { message: `${options.label}: run cancelled` });
    }

    let error: AppError;
    let retryable: boolean;

    try {
      const response = await ctx.fetch(url, {
        headers: options.headers,
        signal: signalWithTimeout(ctx, timeoutMs),
      });

      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch (parseError) {
          // A body that is not JSON is not going to become JSON on retry #2.
          throw new AppError("scrape_parse_failed", {
            message: `${options.label}: response was not JSON`,
            cause: parseError as Error,
          });
        }
      }

      error = new AppError("upstream_error", {
        message: `${options.label}: HTTP ${response.status}`,
      });
      retryable = isRetryable(response.status);
    } catch (thrown) {
      if (AppError.isAppError(thrown)) throw thrown;

      const isAbort =
        thrown instanceof DOMException &&
        (thrown.name === "TimeoutError" || thrown.name === "AbortError");
      error = isAbort
        ? new AppError("upstream_timeout", {
            message: `${options.label}: timed out`,
            cause: thrown,
          })
        : new AppError("upstream_error", {
            message: `${options.label}: request failed`,
            cause: thrown as Error,
          });
      retryable = true;
    }

    if (retryable && attempt < retries) {
      await backoff(attempt, options.label, ctx);
      continue;
    }
    throw error;
  }

  // Unreachable: the loop either returns or throws. Kept so a future edit that lets
  // the loop fall through still produces a typed error instead of `undefined`.
  throw new AppError("upstream_error", { message: `${options.label}: failed` });
}

/** Wait `backoffBaseMs * 2^attempt` — the attempt number is post-incremented. */
async function backoff(attempt: number, label: string, ctx: RunCtx): Promise<void> {
  const waitMs = HTTP_DEFAULTS.backoffBaseMs * 2 ** attempt;
  log.warn("retrying upstream call", { label, attempt, waitMs });
  await ctx.sleep(waitMs);
}