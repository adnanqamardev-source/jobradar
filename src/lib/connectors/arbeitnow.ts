/**
 * arbeitnow.ts — Arbeitnow job-board API (BE-103 / docs/04 §5.2).
 *
 * `GET https://www.arbeitnow.com/api/job-board-api?page=N`
 *
 * ## The mapping the ticket calls out
 *
 * docs/05b ING-003: "Arbeitnow `is_remote` maps to `work_mode`". The field is actually
 * named `remote` in the payload, and the ticket's `is_remote` is a paraphrase — so this
 * reads `remote`, and also accepts `is_remote` for older captures. It is the one provider
 * that hands us a *boolean* for this, so it maps directly: `true → "remote"`, `false →
 * null`.
 *
 * `false → null`, not `→ "onsite"`, is deliberate. Arbeitnow sets `remote: false` for roles
 * that are hybrid or whose city is merely listed, and asserting `onsite` would hard-fail
 * the `work_mode_mismatch` gate (docs/02b §6.3) against a user's hybrid preference on the
 * strength of one boolean. `null` means "unknown", and the gate does not fire on unknown.
 *
 * ## Pagination
 *
 * `meta.totalPages` is present, so this pages properly and stops at `meta.currentPage` —
 * unlike Remotive, where there is no cursor at all. `maxPages` caps the walk either way.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://www.arbeitnow.com";

/** Stops a mis-paged `totalPages` from spinning forever. */
const DEFAULT_MAX_PAGES = 20;

const boardSchema = z.object({
  data: z
    .array(
      z.object({
        slug: z.string(),
        company_name: z.string(),
        title: z.string(),
        description: z.string().nullish(),
        remote: z.boolean().nullish(),
        // Older captures use this spelling; the current API uses `remote`.
        is_remote: z.boolean().nullish(),
        url: z.string().url(),
        location: z.string().nullish(),
        tags: z.array(z.string()).nullish(),
        job_types: z.array(z.string()).nullish(),
        created_at: z.number().nullish(),
      }),
    )
    .default([]),
  meta: z
    .object({
      currentPage: z.number().nullish(),
      totalPages: z.number().nullish(),
    })
    .nullish(),
});

/** Epoch seconds or milliseconds → ISO, or null. Arbeitnow has used both across versions. */
function createdAtToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  // Below ~1e12 a "milliseconds" value is a second-count that has not been multiplied out:
  // 1.7e9 seconds is 2023, 1.7e9 milliseconds is January 1970. Anything at 1e12 is
  // unambiguously milliseconds, so the threshold is the only test needed.
  const ms = value < 1e12 ? value * 1000 : value;
  const iso = new Date(ms).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function workModeFor(remote: boolean | null | undefined): "remote" | "hybrid" | "onsite" | null {
  return remote === true ? "remote" : null;
}

export const arbeitnowConnector: SourceConnector = {
  kind: "api_arbeitnow",
  costClass: "free",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const maxPages = cfg.maxPages ?? DEFAULT_MAX_PAGES;

    for (let page = 1; page <= maxPages; page++) {
      const url = joinUrl(base, "/api/job-board-api") + `?page=${page}`;

      const payload = await fetchJson<unknown>(url, ctx, {
        label: `arbeitnow:p${page}`,
        timeoutMs: JOB_API_TIMEOUT_MS,
      });

      const parsed = boardSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("scrape_parse_failed", {
          message: `arbeitnow: page ${page} did not match the job-board schema`,
          cause: parsed.error,
        });
      }

      for (const job of parsed.data.data) {
        yield {
          externalId: job.slug,
          sourceUrl: job.url,
          applyUrl: job.url,
          companyName: job.company_name,
          companyDomain: null,
          title: job.title,
          descriptionText: null,
          // Arbeitnow's `description` is HTML, matching the field's other job APIs.
          descriptionHtml: job.description ?? null,
          locationRaw: job.location ?? null,
          workMode: workModeFor(job.remote ?? job.is_remote),
          employmentType: null,
          seniority: null,
          salaryRaw: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: null,
          skills: job.tags ?? [],
          postedAt: createdAtToIso(job.created_at),
          raw: job,
        };
      }

      // Stop on the last page, and on an empty one — a provider that keeps returning
      // `data: []` forever would otherwise burn every request in the run.
      const current = parsed.data.meta?.currentPage;
      const total = parsed.data.meta?.totalPages;
      if (parsed.data.data.length === 0) return;
      if (total !== null && total !== undefined && current !== null && current !== undefined) {
        if (current >= total) return;
      }
      if (total === null || total === undefined) return;
    }
  },
};