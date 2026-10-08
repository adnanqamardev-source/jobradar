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
 *
 * ## Why the identifiers are lists
 *
 * `supabase/seed.sql` seeds one `sources` row per *provider*, not per posting: Greenhouse
 * carries `{"boards": []}`, Ashby `{"organizations": []}`, Firecrawl `{"urls": []}`. So a
 * connector iterates its list and streams every board it is given. `board` remains for the
 * single-board case (a `sources` row created by an admin for one company) and, when
 * present, takes precedence — otherwise a per-company row silently reads as "no boards"
 * and returns zero jobs.
 */
export interface SourceConfig {
  id?: string;
  name: string;
  kind: SourceKind;
  /** Board/company/feed identifier for the single-board case. Wins over `boards`. */
  board?: string;
  /**
   * Company name, for providers that do not return one.
   *
   * Lever's `/v0/postings/{slug}` and Ashby's `posting-api/job-board/{slug}` both return
   * postings with no company field at all — the company is implied by the slug. But
   * `RawJob.companyName` is non-nullable and the dedupe hash is built from it (docs/02b
   * §6.2), so a connector given only a slug has to be told the name. `cfg.name` cannot
   * stand in: it is the *source* row's name, which for the seeded rows is the provider
   * ("Lever"), and every posting would be attributed to Lever.
   */
  companyName?: string;
  /** Greenhouse/Lever board tokens — `sources.config.boards` (seed). */
  boards?: string[];
  /** Ashby organisation tokens — `sources.config.organizations` (seed). */
  organizations?: string[];
  /** Firecrawl search queries — `sources.config.queries` (seed). */
  queries?: string[];
  /** Firecrawl scrape targets — `sources.config.urls` (seed). */
  urls?: string[];
  /** Adzuna country codes — `sources.config.countries` (seed). */
  countries?: string[];
  /**
   * Remotive search term — `sources.config.query` (docs/04 §5.2). Also the Adzuna `what`
   * filter, which is why `adzuna.ts` reads it rather than inventing a second key.
   */
  query?: string;
  /** Adzuna `where` location filter. Also the Firecrawl `/map` site root. */
  where?: string;
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
  /**
   * Called once per HTTP attempt, retries included.
   *
   * This is how `scrape_runs.api_calls` gets its number (docs/04 §5.1: "api_calls counted
   * for cost attribution"). It lives on the context rather than inside `http.ts` because
   * the counter is the *run's* to own — BE-111 writes the row, and a connector that kept
   * its own tally would have nowhere to report it. Counting attempts, not requests, is
   * deliberate: a retry is a real billed call against Adzuna/Firecrawl quota.
   */
  onRequest?: (info: { url: string; attempt: number }) => void;
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
  // The retry *interval* used to live here as `backoffBaseMs: 1_000`, doubling per attempt.
  // It moved to `src/lib/backoff.ts` on 2026-10-09 because two functions both called "backoff"
  // and had drifted apart. It is deliberately NOT the queue's 30s/2m/8m ladder: this wait
  // happens inside a leased task, and the queue's totals 630s against a 300s lease — a
  // connector using it would be reaped mid-sleep and a second worker would run the same task.
} as const;

/**
 * Timeout for the job-source APIs — **15s, not the 30s default**.
 *
 * docs/04 §5.9 tabulates the timeout per integration: Firecrawl gets 30s because it renders
 * a page in a headless browser, while "Job APIs" get 15s. `HTTP_DEFAULTS.timeoutMs` is the
 * Firecrawl figure, so a connector that used the default would sit through two full timeouts
 * and three retries on a dead job API — 90 seconds of a Vercel function doing nothing before
 * the row is released.
 */
export const JOB_API_TIMEOUT_MS = 15_000;

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