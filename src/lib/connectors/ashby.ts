/**
 * ashby.ts — Ashby public job board API (BE-102 / docs/04 §5.2).
 *
 * `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
 *
 * `includeCompensation=true` is what populates `compensation.compensationTierSummary`, which
 * is Ashby's *only* salary signal — it is a display string like `"$120k – $160k"`, not a
 * range. It goes to `salaryRaw` and lets BE-106's salary parser split it, because this
 * module cannot know whether the tier is annual or hourly and guessing is what
 * `salaryRaw` exists to avoid.
 *
 * Also provider-specific here: Ashby's payload has no company name, and `location` is an
 * object (`{location: "..."}`), not a string. `isRemote` is a real boolean here, so unlike
 * the other ATS boards it maps straight into `workMode` — but only when it is explicitly
 * true, since Ashby sets it false for hybrid roles that mention remote in the description.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://api.ashbyhq.com";

const postingSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  jobUrl: z.string().url(),
  applyUrl: z.string().url().nullish(),
  publishedAt: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  employmentType: z.string().nullish(),
  // `location` is an object here. Greenhouse has no field at all and Lever has a string;
  // the three shapes are exactly why this is a per-connector schema.
  location: z
    .object({ location: z.string().nullish() })
    .nullish(),
  compensation: z
    .object({ compensationTierSummary: z.string().nullish() })
    .nullish(),
});

const boardSchema = z.object({
  jobs: z.array(postingSchema),
});

function organisationTokens(cfg: SourceConfig): string[] {
  if (cfg.board) return [cfg.board];
  return cfg.organizations ?? [];
}

/**
 * Ashby's employment types are free-text-ish ("Full time", "Internship"), and `RawJob`
 * wants a closed enum. Guessing is BE-106's seniority/employment pass; this leaves it null
 * rather than mapping four of the five values and silently dropping the rest.
 */
function mapWorkMode(isRemote: boolean | null | undefined): "remote" | "hybrid" | "onsite" | null {
  if (isRemote === true) return "remote";
  return null;
}

export const ashbyConnector: SourceConnector = {
  kind: "api_ashby",
  costClass: "free",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;

    for (const organisation of organisationTokens(cfg)) {
      const url =
        joinUrl(base, `/posting-api/job-board/${encodeURIComponent(organisation)}`) +
        "?includeCompensation=true";

      const payload = await fetchJson<unknown>(url, ctx, {
        label: `ashby:${organisation}`,
        timeoutMs: JOB_API_TIMEOUT_MS,
      });

      const parsed = boardSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("scrape_parse_failed", {
          message: `ashby:${organisation}: response did not match the job board schema`,
          cause: parsed.error,
        });
      }

      const companyName = cfg.companyName ?? organisation;

      for (const posting of parsed.data.jobs) {
        yield {
          externalId: posting.id,
          sourceUrl: posting.jobUrl,
          applyUrl: posting.applyUrl ?? posting.jobUrl,
          companyName,
          companyDomain: null,
          title: posting.title,
          descriptionText: posting.descriptionPlain ?? null,
          descriptionHtml: posting.descriptionHtml ?? null,
          locationRaw: posting.location?.location ?? null,
          workMode: mapWorkMode(posting.isRemote),
          employmentType: null,
          seniority: null,
          salaryRaw: posting.compensation?.compensationTierSummary ?? null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: null,
          skills: [],
          postedAt: posting.publishedAt ?? null,
          raw: posting,
        };
      }
    }
  },
};