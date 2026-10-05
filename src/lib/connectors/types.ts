/**
 * types.ts — the connector plug-in point (BE-101, docs/02b §6.1).
 *
 * Every source implements `SourceConnector`; adding a source is a new file, not a
 * new architecture.
 *
 * ## RawJob lives in `src/types/`, not here
 *
 * docs/02b §6.1 sketches `RawJob` in this file. The repo's seam contract puts the
 * *type* in `src/types/canonical-job.ts` (the Zod schema is normative — TypeScript is
 * derived from it, docs/06 §8.1), and the normalisation pipeline (BE-106) already
 * consumes that schema. Defining a second `RawJob` here would create exactly the
 * parallel-definition drift §8.1 forbids, so this module re-exports it instead.
 *
 * ## Why `fetch` and the clock are injected
 *
 * docs/06 §8.5: CI never calls live APIs, and backoff must be deterministic. So the
 * HTTP layer takes its `fetch` from `RunCtx` and its delay from `RunCtx.sleep`.
 * A connector written against this interface is testable with a fixture and a fake
 * clock, with no network and no `sleep`.
 */

import { z } from "zod";

import type { RawJob } from "@/types/canonical-job";
import type { SourceKind } from "@/types/db";

export type { RawJob };

/** How a source's requests are paid for / metered (docs/02b §6.1 tier table). */
export type CostClass = "free" | "metered" | "firecrawl";

/**
 * Per-source configuration — the `sources` row plus its `config` jsonb
 * (docs/02a-schema.md). Credentials live here and must never be logged.
 */
export interface SourceConfig {
  id?: string;
  name: string;
  kind: SourceKind;
  /** Board/company/feed identifier the connector needs (e.g. a Greenhouse board token). */
  board?: string;
  /** Base URL override, for mirrors and tests. */
  baseUrl?: string;
  /** API key / secret for sources that require one (Adzuna, USAJOBS, Firecrawl). */
  apiKey?: string;
  /** Stop after this many pages, whatever the provider's own limit. */
  maxPages?: number;
  rateLimitPerDay?: number;
}

/** Everything a connector needs from its caller. Nothing here is global state. */
export interface RunCtx {
  /** `scrape_runs.id`, for log correlation. */
  runId: string;
  /** Aborts the whole run; every request must thread this through. */
  signal: AbortSignal;
  /** Injected clock (docs/06 §8.5). Defaults to `Date.now` in `defaultRunCtx`. */
  now: () => number;
  /** Injected delay, so retry backoff is testable without real time passing. */
  sleep: (ms: number) => Promise<void>;
  /** Injected fetch, so contract tests run against fixtures, never the network. */
  fetch: typeof fetch;
}

/**
 * One source of jobs. `fetch` is async-iterable so a large board streams rather
 * than buffering, and so a page failure surfaces mid-stream instead of losing the
 * pages already read.
 */
export interface SourceConnector {
  readonly kind: SourceKind;
  readonly costClass: CostClass;
  fetch(cfg: SourceConfig, ctx: RunCtx): AsyncIterable<RawJob>;
}

/** HTTP defaults every connector inherits (docs/04 §5.9). */
export const HTTP_DEFAULTS = {
  timeoutMs: 30_000,
  retries: 3,
  /** Exponential: first retry waits 2^1 = 2s (docs/02b §6.4 uses the same convention). */
  backoffBaseMs: 1_000,
} as const;

/**
 * A Zod schema for one connector's provider response. Every connector validates
 * through its own schema before mapping — that is what makes a provider shape
 * change a `scrape_parse_failed` run instead of a silent data-quality leak.
 */
export type ProviderSchema<T> = z.ZodType<T>;

/** Build a `RunCtx` with real `Date.now`/`setTimeout`/`fetch`. Tests inject their own. */
export function defaultRunCtx(
  runId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): RunCtx {
  return {
    runId,
    signal,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: fetchImpl,
  };
}