/**
 * adzuna.ts — Adzuna aggregator API (BE-104 / docs/04 §5.2).
 *
 * `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?app_id=&app_key=&what=&where=&results_per_page=50`
 *
 * ## The one aggregator connector, because it is the only one with a salary
 *
 * Every other source in this directory must have its salary scraped out of a display string
 * by BE-106. Adzuna hands over `salary_min`, `salary_max` and `salary_currency` as numbers,
 * so they land in the structured fields directly and `salaryRaw` is only a fallback for the
 * human-readable `salary_label` — which is what the docs call for ("salary fields map into
 * `salary_min`/`salary_max`/`salary_currency` when present").
 *
 * That asymmetry is why the numbers are trusted and the label is not: mixing them would let
 * a label override a number it should merely corroborate.
 *
 * ## Quota
 *
 * Adzuna bills per request and caps `results_per_page` at 50. `RunCtx.onRequest` counts every
 * attempt including retries, because a retry is a billed call — that is the `api_calls`
 * figure `scrape_runs` records for cost attribution (docs/04 §5.1).
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://api.adzuna.com";

/** Adzuna rejects anything above 50. */
const RESULTS_PER_PAGE = 50;

/** The seeded countries. An empty list would otherwise silently ingest nothing. */
const DEFAULT_COUNTRIES = ["us", "gb", "ca", "au", "de"] as const;

const searchSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string(),
        // `redirect_url` is Adzuna's own link to the posting. `id` is a bare numeric
        // string, and `RawJob.sourceUrl` is `z.string().url()`, so a URL has to come from
        // the provider rather than be guessed from the id.
        redirect_url: z.string().url().nullish(),
        title: z.string(),
        display_title: z.string().nullish(),
        description: z.string().nullish(),
        created: z.string().nullish(),
        // Adzuna omits salary fields entirely rather than sending null, so they are all
        // nullish and validated as numbers when present — a string here would poison
        // `salary_min` on its way into a numeric(12,0) column.
        salary_min: z.number().nullish(),
        salary_max: z.number().nullish(),
        salary_currency: z.string().nullish(),
        salary_label: z.string().nullish(),
        company: z
          .object({ display_name: z.string().nullish() })
          .nullish(),
        location: z
          .object({
            display_name: z.string().nullish(),
            country: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
});

/**
 * Read credentials from the environment, failing fast and by name.
 *
 * docs/05b ING-004: "Credentials read from env only; missing creds fail fast". A missing key
 * is `validation_failed`, not `upstream_error` — retrying a request that can never succeed
 * burns quota that would otherwise be spent on real results.
 */
function credentials(): { appId: string; appKey: string } {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const missing = [
    appId ? null : "ADZUNA_APP_ID",
    appKey ? null : "ADZUNA_APP_KEY",
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new AppError("validation_failed", {
      message: `adzuna: missing ${missing.join(" and ")}. Adzuna returns HTTP 401 without them.`,
    });
  }
  // `missing.length > 0` implies both are non-empty strings, but the compiler cannot see
  // that through the filter. Returning the locals directly would make `string | undefined`
  // leak into the URL, where it becomes the literal text "undefined".
  return { appId: appId!, appKey: appKey! };
}

/** An ISO-8601 currency code, or null. `rawJobSchema` enforces `.length(3)`. */
function currencyCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export const adzunaConnector: SourceConnector = {
  kind: "api_adzuna",
  costClass: "metered",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const { appId, appKey } = credentials();
    const countries = cfg.countries?.length ? cfg.countries : [...DEFAULT_COUNTRIES];
    const maxPages = cfg.maxPages ?? 1;

    for (const country of countries) {
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(
          joinUrl(base, `/v1/api/jobs/${encodeURIComponent(country)}/search/${page}`),
        );
        url.searchParams.set("app_id", appId);
        url.searchParams.set("app_key", appKey);
        url.searchParams.set("results_per_page", String(RESULTS_PER_PAGE));
        if (cfg.query) url.searchParams.set("what", cfg.query);
        // `where` comes from config when set; the country path segment is not a location
        // filter, and conflating the two is how a US-only search returns UK rows.
        if (cfg.where) url.searchParams.set("where", cfg.where);

        const payload = await fetchJson<unknown>(url.toString(), ctx, {
          label: `adzuna:${country}:p${page}`,
          timeoutMs: JOB_API_TIMEOUT_MS,
        });

        const parsed = searchSchema.safeParse(payload);
        if (!parsed.success) {
          throw new AppError("scrape_parse_failed", {
            message: `adzuna: ${country} page ${page} did not match the search schema`,
            cause: parsed.error,
          });
        }

        for (const result of parsed.data.results) {
          // `redirect_url` is absent on some aggregated records. `sourceUrl` is
          // `z.string().url()` and non-nullable, so a record with neither is *skipped*:
          // emitting a placeholder URL would put a dead link in the feed and defeat the
          // dedupe hash, which is computed from it.
          const sourceUrl = result.redirect_url;
          if (!sourceUrl) continue;

          yield {
            externalId: result.id,
            sourceUrl,
            applyUrl: sourceUrl,
            companyName: result.company?.display_name ?? "",
            companyDomain: null,
            // `display_title` carries the location suffix Adzuna appends ("Engineer,
            // London"); `title` is the clean one.
            title: result.title,
            descriptionText: null,
            // Adzuna returns HTML here (docs/04 §5.2: "`descriptionHtml` handled (Adzuna
            // returns HTML)").
            descriptionHtml: result.description ?? null,
            locationRaw: result.location?.display_name ?? null,
            workMode: null,
            employmentType: null,
            seniority: null,
            // The label is carried for BE-106 either way, but never as an override: it is
            // a formatted string, and the structured numbers below are authoritative. A
            // record with structured salary and no label keeps `salaryRaw` null rather
            // than inventing one — `salaryMin`/`salaryMax` already carry the range.
            salaryRaw: result.salary_label ?? null,
            salaryMin: result.salary_min ?? null,
            salaryMax: result.salary_max ?? null,
            salaryCurrency: currencyCode(result.salary_currency),
            salaryPeriod: null,
            skills: [],
            postedAt: result.created ?? null,
            raw: result,
          };
        }

        if (parsed.data.results.length < RESULTS_PER_PAGE) break;
      }
    }
  },
};