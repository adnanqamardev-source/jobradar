/**
 * firecrawl.ts — Firecrawl scrape / search / map (BE-105 / docs/04 §5.1).
 *
 * Tier 3, used **only** where no official API exists (docs/02b §6.1). This is the most
 * expensive integration in the system, so the cost guards here are not optional:
 *
 * - `maxAge: 43_200_000` (12h) — the documented cache window. Without it every run re-crawls
 *   unchanged pages and bills for them.
 * - `onlyMainContent: true` — drops nav/footer chrome that otherwise lands in
 *   `description_html` and pollutes the skill extractor.
 * - `timeout: 30000` — matches `HTTP_DEFAULTS.timeoutMs`, and is sent to Firecrawl as well
 *   so its own renderer gives up on the same schedule ours does.
 *
 * ## URL validation happens before the request, not in Firecrawl
 *
 * docs/03 §6.2 S-05. Firecrawl runs from *its* network, so an internal host would not be our
 * SSRF — but a URL that names one still discloses what is reachable and would waste a
 * billed call. `assertScrapeUrl` refuses non-`https`, localhost, private and reserved
 * addresses, and credentials-in-URL. See `url-guard.ts` for what that check deliberately
 * cannot cover (DNS rebinding) — the limit is documented rather than glossed.
 *
 * ## Two connector kinds, one module
 *
 * `source_kind` has both `firecrawl_scrape` and `firecrawl_search`, so this file exports two
 * connectors over a shared client. `/map` is exposed as a helper rather than a kind of its
 * own, because sitemap discovery feeds `sources.config.urls` — it is an admin-time tool for
 * finding what to scrape, not an ingestion source.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, joinUrl } from "./http";
import { assertScrapeUrl } from "./url-guard";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev/v2";

/** docs/04 §5.1: 12h cache. */
const MAX_AGE_MS = 43_200_000;

/** docs/04 §5.1: `timeout: 30000`, matching the HTTP default. */
const SCRAPE_TIMEOUT_MS = 30_000;

/**
 * The extraction schema sent to `/scrape`, mirroring `RawJob` (docs/04 §5.1).
 *
 * `title`, `companyName` and `sourceUrl` are the only required fields — they are the ones a
 * posting cannot be identified without. Everything else is optional on purpose: requiring
 * `salaryRaw` would make every posting without a salary fail extraction and return nothing,
 * when the correct outcome is a posting with `salary = null`.
 *
 * Note `location`, not `locationRaw`: the schema mirrors what the *model* should read out of
 * a page, and BE-106 maps it onto `RawJob.locationRaw` afterwards.
 */
const extractionSchema = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          companyName: { type: "string" },
          location: { type: "string" },
          workMode: { type: "string", enum: ["remote", "hybrid", "onsite", "unknown"] },
          salaryRaw: { type: "string" },
          postedAt: { type: "string" },
          sourceUrl: { type: "string", format: "uri" },
          applyUrl: { type: "string", format: "uri" },
          descriptionHtml: { type: "string" },
        },
        required: ["title", "companyName", "sourceUrl"],
      },
    },
  },
  required: ["jobs"],
} as const;

/** What Firecrawl hands back for an extracted posting, before it becomes a `RawJob`. */
const scrapedJobSchema = z.object({
  title: z.string(),
  companyName: z.string(),
  location: z.string().nullish(),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).nullish(),
  salaryRaw: z.string().nullish(),
  postedAt: z.string().nullish(),
  sourceUrl: z.string().url(),
  applyUrl: z.string().url().nullish(),
  descriptionHtml: z.string().nullish(),
});

const scrapeResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      markdown: z.string().nullish(),
      // Zod-validated here so a shape change becomes `scrape_parse_failed` (the run is
      // marked `partial`) instead of an `undefined` that quietly yields zero jobs.
      json: z.object({ jobs: z.array(z.unknown()).default([]) }).nullish(),
      metadata: z
        .object({
          statusCode: z.number().nullish(),
          sourceUrl: z.string().nullish(),
          cached: z.boolean().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const searchResponseSchema = z.object({
  success: z.boolean().nullish(),
  // v2 `/search` returns web results, whose URL is the posting link.
  data: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .nullish(),
});

const mapResponseSchema = z.object({
  success: z.boolean().nullish(),
  links: z.array(z.string().url()).nullish(),
});

/** Read the key from the environment, failing fast and by name. */
function apiKey(cfg: SourceConfig): string {
  const key = cfg.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!key || key.trim() === "") {
    throw new AppError("validation_failed", {
      message:
        "firecrawl: FIRECRAWL_API_KEY is not set. Firecrawl bills per page, so an " +
        "unauthenticated call would fail rather than cost anything — but it should never " +
        "get that far.",
    });
  }
  return key;
}

/** The request body shared by `/scrape` and `/search`, minus the url/query. */
function baseBody(): Record<string, unknown> {
  return {
    onlyMainContent: true,
    maxAge: MAX_AGE_MS,
    timeout: SCRAPE_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// /scrape
// ---------------------------------------------------------------------------

export const firecrawlScrapeConnector: SourceConnector = {
  kind: "firecrawl_scrape",
  costClass: "firecrawl",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const key = apiKey(cfg);
    const targets = cfg.urls?.length ? cfg.urls : cfg.board ? [cfg.board] : [];

    for (const target of targets) {
      // Before the request and before we build the URL: an internal target must not reach
      // the network layer at all (docs/03 §6.2 S-05).
      const url = assertScrapeUrl(target);

      const payload = await fetchJson<unknown>(
        joinUrl(base, "/scrape"),
        ctx,
        {
          label: `firecrawl:scrape:${url}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: {
            ...baseBody(),
            url,
            formats: ["json"],
            jsonOptions: { schema: extractionSchema },
          },
        },
      );

      const parsed = scrapeResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("scrape_parse_failed", {
          message: `firecrawl: scrape of ${url} did not match the response schema`,
          cause: parsed.error,
        });
      }

      if (parsed.data.success === false) {
        // docs/04 §5.1: non-`success` → upstream_error/timeout → task retry ×3.
        throw new AppError("upstream_error", {
          message: `firecrawl: scrape of ${url} returned success:false`,
        });
      }

      const extracted = parsed.data.data?.json?.jobs ?? [];

      for (const candidate of extracted) {
        const job = scrapedJobSchema.safeParse(candidate);
        if (!job.success) {
          // One malformed posting must not discard the rest of the page: a career page
          // with 40 listings and one missing a title should yield 39, and the run is
          // marked `partial` by the caller because a skip happened.
          continue;
        }
        yield {
          externalId: job.data.sourceUrl,
          sourceUrl: job.data.sourceUrl,
          applyUrl: job.data.applyUrl ?? job.data.sourceUrl,
          companyName: job.data.companyName,
          companyDomain: null,
          title: job.data.title,
          descriptionText: null,
          descriptionHtml: job.data.descriptionHtml ?? null,
          locationRaw: job.data.location ?? null,
          workMode: job.data.workMode ?? null,
          employmentType: null,
          seniority: null,
          salaryRaw: job.data.salaryRaw ?? null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: null,
          skills: [],
          postedAt: job.data.postedAt ?? null,
          raw: job.data,
        };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// /search
// ---------------------------------------------------------------------------

/**
 * `/search` yields **discovered URLs**, not postings.
 *
 * docs/02b §6.1 puts `firecrawl_search` in the discovery tier: it finds candidate posting
 * pages that `/scrape` then extracts. So a search result is emitted as a `RawJob` whose only
 * real content is its `sourceUrl`, and the caller is expected to feed those URLs back
 * through `firecrawl_scrape`. Emitting a `RawJob` with `title` equal to the search snippet
 * would insert a bogus posting into `jobs`.
 *
 * The `title` therefore carries the discovered URL rather than being invented, which keeps
 * the row identifiable and makes the handoff explicit in the data.
 */
export const firecrawlSearchConnector: SourceConnector = {
  kind: "firecrawl_search",
  costClass: "firecrawl",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const key = apiKey(cfg);

    for (const query of cfg.queries?.length ? cfg.queries : cfg.query ? [cfg.query] : []) {
      const payload = await fetchJson<unknown>(
        joinUrl(base, "/search"),
        ctx,
        {
          label: `firecrawl:search:${query}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: { ...baseBody(), query, limit: 10 },
        },
      );

      const parsed = searchResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("scrape_parse_failed", {
          message: `firecrawl: search for "${query}" did not match the response schema`,
          cause: parsed.error,
        });
      }

      for (const hit of parsed.data.data ?? []) {
        // Discovered URLs go through the same guard as scrape targets — a search engine
        // will happily return an internal host for a query like "intranet jobs".
        if (!isSafeTarget(hit.url)) continue;
        yield {
          externalId: hit.url,
          sourceUrl: hit.url,
          applyUrl: hit.url,
          companyName: cfg.companyName ?? cfg.name,
          companyDomain: null,
          title: hit.title ?? hit.url,
          descriptionText: hit.description ?? null,
          descriptionHtml: null,
          locationRaw: null,
          workMode: null,
          employmentType: null,
          seniority: null,
          salaryRaw: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: null,
          skills: [],
          postedAt: null,
          raw: hit,
        };
      }
    }
  },
};

/** Non-throwing form, for filtering a list where one bad URL should not end the run. */
function isSafeTarget(candidate: string): boolean {
  try {
    assertScrapeUrl(candidate);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// /map
// ---------------------------------------------------------------------------

/**
 * Enumerate a careers-site sitemap (docs/04 §5.1).
 *
 * Returns URLs for the operator to put in `sources.config.urls`. Not a `SourceConnector`,
 * because it produces no postings — it produces the input to one.
 *
 * Safe because every returned URL is filtered through the same guard before it is handed
 * back, so an operator cannot poison `sources.config` with an internal target by mapping a
 * host that resolves there.
 */
export async function firecrawlMap(
  cfg: SourceConfig,
  ctx: RunCtx,
): Promise<string[]> {
  const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
  const key = apiKey(cfg);
  const root = cfg.urls?.[0] ?? cfg.board;
  if (!root) {
    throw new AppError("validation_failed", {
      message: "firecrawl: /map needs a site URL in cfg.board or cfg.urls[0]",
    });
  }
  const site = assertScrapeUrl(root);

  const payload = await fetchJson<unknown>(
    joinUrl(base, "/map"),
    ctx,
    {
      label: "firecrawl:map",
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: { url: site, ...baseBody() },
    },
  );

  const parsed = mapResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError("scrape_parse_failed", {
      message: `firecrawl: /map for ${site} did not match the response schema`,
      cause: parsed.error,
    });
  }

  return (parsed.data.links ?? []).filter(isSafeTarget);
}