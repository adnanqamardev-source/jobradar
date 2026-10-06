/**
 * usajobs.ts — USAJOBS Search API (BE-103 / docs/04 §5.2).
 *
 * `GET https://data.usajobs.gov/api/search?Keyword=&LocationName=&ResultsPerPage=25&Page=N`
 *
 * ## All three headers are mandatory, and two of them are not auth
 *
 * docs/04 §5.2 and docs/05b ING-003: "Headers: `Host: data.usajobs.gov`,
 * `Authorization-Key: ${USAJOBS_AUTHORIZATION_KEY}`, `User-Agent` (**required**)."
 *
 * USAJOBS rejects a request without `User-Agent` outright, and it does so with a 403 that
 * is indistinguishable from a bad key. So `Authorization-Key` missing → a clear ops error
 * naming the variable, while a 403 is surfaced as an upstream error with both possibilities
 * named, rather than "invalid credentials" — which is what a User-Agent omission would be
 * misdiagnosed as.
 *
 * ## Credentials come from env, never from `sources.config`
 *
 * ING-004 states the rule for Adzuna and it holds here too: credentials are read from the
 * environment only. They must never reach `sources.config`, because that column is
 * admin-readable through RLS and the raw payload is persisted to `jobs.raw`.
 *
 * Reading `env` lazily (inside the generator body, not at module scope) is what keeps this
 * importable from a unit test with no environment configured.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://data.usajobs.gov";

/** docs/04 §5.2 fixes `ResultsPerPage=25`. */
const RESULTS_PER_PAGE = 25;

/** Stops a `SearchResultCount` that disagrees with paging from looping forever. */
const DEFAULT_MAX_PAGES = 10;

const searchSchema = z.object({
  SearchResult: z
    .object({
      SearchResultCount: z.number().nullish(),
      SearchResultItems: z
        .array(
          z.object({
            MatchedObjectId: z.string(),
            MatchedObjectDescriptor: z.object({
              PositionTitle: z.string().nullish(),
              PositionLocationDisplay: z.array(z.string()).nullish(),
              // `[0].Value` is the documented salary field, and it is a display string
              // ("$100,000.00 Per Year"), not a number — hence `salaryRaw` only.
              PositionRemuneration: z
                .array(
                  z.object({
                    Value: z.string().nullish(),
                    RateIntervalCode: z.string().nullish(),
                  }),
                )
                .nullish(),
              DatePosted: z.string().nullish(),
              DepartmentName: z.string().nullish(),
              PositionStartDate: z.string().nullish(),
            }),
          }),
        )
        .default([]),
    })
    .nullish(),
});

/**
 * USAJOBS wants a contactable user agent. A generic one is the documented failure mode
 * described in the header, so this carries an address an operator can answer.
 */
const USER_AGENT = "JobRadar-Ingest/1.0 (contact: admin@jobradar.app)";

/** Read the key from the environment, failing fast and by name when it is absent. */
function authorizationKey(): string {
  const key = process.env.USAJOBS_AUTHORIZATION_KEY;
  if (!key || key.trim() === "") {
    throw new AppError("validation_failed", {
      message:
        "usajobs: USAJOBS_AUTHORIZATION_KEY is not set. USAJOBS rejects unauthenticated " +
        "searches with the same 403 it returns for a bad key, so this is checked up front.",
    });
  }
  return key;
}

export const usajobsConnector: SourceConnector = {
  kind: "api_usajobs",
  costClass: "free",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const key = authorizationKey();
    const maxPages = cfg.maxPages ?? DEFAULT_MAX_PAGES;

    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(joinUrl(base, "/api/search"));
      if (cfg.query) url.searchParams.set("Keyword", cfg.query);
      url.searchParams.set("ResultsPerPage", String(RESULTS_PER_PAGE));
      url.searchParams.set("Page", String(page));

      const payload = await fetchJson<unknown>(url.toString(), ctx, {
        label: `usajobs:p${page}`,
        timeoutMs: JOB_API_TIMEOUT_MS,
        headers: {
          // All three are required by USAJOBS, not merely by us.
          Host: "data.usajobs.gov",
          "Authorization-Key": key,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });

      const parsed = searchSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("scrape_parse_failed", {
          message: `usajobs: page ${page} did not match the search schema`,
          cause: parsed.error,
        });
      }

      const items = parsed.data.SearchResult?.SearchResultItems ?? [];

      for (const item of items) {
        const descriptor = item.MatchedObjectDescriptor;
        const remuneration = descriptor.PositionRemuneration?.[0];
        // USAJOBS has several roles per posting; the department is the closest thing to a
        // company name the API offers, so it is used rather than inventing an agency name.
        const companyName = cfg.companyName ?? descriptor.DepartmentName ?? "USAJOBS";

        yield {
          externalId: item.MatchedObjectId,
          sourceUrl: `https://www.usajobs.gov/job/${item.MatchedObjectId}`,
          applyUrl: `https://www.usajobs.gov/job/${item.MatchedObjectId}`,
          companyName,
          companyDomain: null,
          title: descriptor.PositionTitle ?? "",
          descriptionText: null,
          descriptionHtml: null,
          locationRaw: descriptor.PositionLocationDisplay?.join("; ") ?? null,
          workMode: null,
          employmentType: null,
          seniority: null,
          salaryRaw: remuneration?.Value ?? null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          // `RateIntervalCode` is "Year"/"Hour"; the enum is closed, so only "Year" is
          // claimed. Everything else stays null and BE-106 decides.
          salaryPeriod: remuneration?.RateIntervalCode === "Year" ? "year" : null,
          skills: [],
          postedAt: descriptor.DatePosted ?? null,
          raw: item,
        };
      }

      // Stop when a page comes back short: the API returns fewer than a full page only when
      // there is nothing left to fetch.
      if (items.length < RESULTS_PER_PAGE) return;
      if (items.length === 0) return;
    }
  },
};