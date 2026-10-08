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

import { connectorBackoffMs } from "@/lib/backoff";
import { HTTP_DEFAULTS, JOB_API_TIMEOUT_MS, type RunCtx } from "./types";

// The timeout policy is applied here, so it is offered from here too — a connector that
// imported its timeout from `./types` would be reaching past the module that enforces it.
export { JOB_API_TIMEOUT_MS };

const log = logger.child({ module: "connectors/http" });

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Label used in logs and errors — never a URL with credentials in it. */
  label: string;
  /**
   * HTTP method. Defaults to GET.
   *
   * Firecrawl is the reason this exists: `/scrape`, `/search` and `/map` are all POST with a
   * JSON body carrying the extraction schema (docs/04 §5.1), so a GET-only helper cannot
   * reach the one integration the docs say to fall back on for everything else.
   */
  method?: "GET" | "POST";
  /** Request body. Serialised as JSON; requires `method: "POST"`. */
  body?: unknown;
}

/**
 * Join a base URL and a path, tolerating a trailing slash on the base.
 *
 * Not string concatenation: a `baseUrl` override ending in `/` — which a test fixture or an
 * ATS mirror will happily supply — otherwise yields `https://host//v0/postings` and the
 * provider 404s with no hint that the fault is ours.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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
 * GET or POST `url` and parse JSON, with timeout, retry, metering and typed failure.
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
  const method = options.method ?? "GET";

  for (let attempt = 1; attempt <= retries; attempt++) {
    // A cancelled run must not spend its remaining retries: re-requesting an aborted
    // source is pure quota waste, and the caller already knows it stopped.
    if (ctx.signal.aborted) {
      throw new AppError("upstream_timeout", { message: `${options.label}: run cancelled` });
    }

    // Counted before the request goes out, so a call that throws still costs quota and
    // `api_calls` never under-reports. Retries included: a retry is a billed call.
    ctx.onRequest?.({ url, attempt });

    let error: AppError;
    let retryable: boolean;

    try {
      const response = await ctx.fetch(url, {
        method,
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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

/**
 * Wait before retrying, using the **connector** ladder.
 *
 * Deliberately not the queue's ladder. This wait happens *inside* a leased task, and the
 * connector ladder is bounded by `LEASE_MS` — see `src/lib/backoff.ts` for the constraint and
 * the table comparing the two contexts. The attempt number is post-incremented, so attempt 1
 * reads the first rung.
 */
async function backoff(attempt: number, label: string, ctx: RunCtx): Promise<void> {
  const waitMs = connectorBackoffMs(attempt);
  log.warn("retrying upstream call", { label, attempt, waitMs });
  await ctx.sleep(waitMs);
}