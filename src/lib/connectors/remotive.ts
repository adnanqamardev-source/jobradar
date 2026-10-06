/**
 * remotive.ts — Remotive remote-jobs API (BE-103 / docs/04 §5.2).
 *
 * `GET https://remotive.com/api/remote-jobs?search={q}&limit=50`
 *
 * ## The throttle is the whole reason this file is not a copy of greenhouse.ts
 *
 * docs/04 §5.2 and docs/05b ING-003 both state Remotive's limit: **≤1 request per 1.5s**.
 * `fetchJson` retries 429 three times with exponential backoff, which is correct for an API
 * that allows retries — but hammering a documented-1.5s-limit endpoint while *already* in
 * a backoff loop is how an account gets rate-limited for hours.
 *
 * So the wait happens here, before every call including the first, and it is expressed as
 * "at least 1.5s since the last request" rather than "sleep 1.5s", so the cost is paid once
 * no matter how many pages the run walks. The clock and the sleep are both injected, so a
 * contract test asserts the timestamps without waiting.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://remotive.com";

/** docs/04 §5.2: "free, ≤1 req/1.5s". */
export const REMOTIVE_MIN_INTERVAL_MS = 1_500;

const POSTING_LIMIT = 50;

const remoteJobsSchema = z.object({
  // `job-count` is Remotive's total across all pages. It is the only pagination signal
  // there is: the API returns everything up to `limit` and stops, with no next-page cursor.
  "job-count": z.number().nullish(),
  jobs: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).transform(String),
        url: z.string().url(),
        title: z.string(),
        company_name: z.string(),
        candidate_required_location: z.string().nullish(),
        publication_date: z.string().nullish(),
        // Remotive's `description` is HTML, despite the field having no `_html` suffix.
        description: z.string().nullish(),
        category: z.string().nullish(),
        tags: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
});

/**
 * `publication_date` is documented as `YYYY-MM-DD`. `rawJobSchema.postedAt` requires a full
 * ISO datetime, so a bare date is widened to midnight UTC rather than dropped — the posting
 * is real, only its timestamp is coarse, and BE-106 lowers `confidence` for that.
 *
 * Returns null when the value is not a date at all: a malformed string must not become
 * `Invalid Date`, which `z.string().datetime()` would reject and take the whole page with it.
 */
function publicationDateToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Track the last request time across pages, so the interval is paid once per page. */
class Throttle {
  private lastAt: number | null = null;

  constructor(private readonly ctx: RunCtx) {}

  async wait(): Promise<void> {
    if (this.lastAt !== null) {
      const elapsed = this.ctx.now() - this.lastAt;
      const remaining = REMOTIVE_MIN_INTERVAL_MS - elapsed;
      if (remaining > 0) await this.ctx.sleep(remaining);
    }
    this.lastAt = this.ctx.now();
  }
}

export const remotiveConnector: SourceConnector = {
  kind: "api_remotive",
  costClass: "free",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const throttle = new Throttle(ctx);

    const url = new URL(joinUrl(base, "/api/remote-jobs"));
    url.searchParams.set("limit", String(POSTING_LIMIT));
    // Remotive treats an empty `search` as "no filter", so only send one that was given.
    if (cfg.query) url.searchParams.set("search", cfg.query);

    await throttle.wait();
    const payload = await fetchJson<unknown>(url.toString(), ctx, {
      label: "remotive",
      timeoutMs: JOB_API_TIMEOUT_MS,
    });

    const parsed = remoteJobsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError("scrape_parse_failed", {
        message: "remotive: response did not match the remote-jobs schema",
        cause: parsed.error,
      });
    }

    for (const job of parsed.data.jobs) {
      yield {
        externalId: job.id,
        sourceUrl: job.url,
        applyUrl: job.url,
        companyName: job.company_name,
        companyDomain: null,
        title: job.title,
        descriptionText: null,
        descriptionHtml: job.description ?? null,
        locationRaw: job.candidate_required_location ?? null,
        // Remotive only lists remote roles; `work_mode` is settled by BE-106's keyword
        // pass from the location string, which can still find "hybrid" in the body.
        workMode: null,
        employmentType: null,
        seniority: null,
        salaryRaw: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
        skills: job.tags ?? [],
        postedAt: publicationDateToIso(job.publication_date),
        raw: job,
      };
    }
  },
};