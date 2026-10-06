/**
 * lever.ts — Lever public postings API (BE-102 / docs/04 §5.2).
 *
 * `GET https://api.lever.co/v0/postings/{slug}?mode=json`
 *
 * Three provider quirks this file exists to handle:
 *
 * 1. **The response is a bare array**, not an object. `{ jobs: [...] }` is Greenhouse's
 *    shape and Lever's is not; parsing both as one is how a board silently ingests zero
 *    jobs.
 * 2. **`createdAt` is epoch milliseconds**, not ISO. Written straight into
 *    `rawJobSchema.postedAt` it fails `.datetime()` and every posting is dropped.
 * 3. **No company name.** The slug is the only company signal, so it comes from config.
 *
 * Location is `categories.location`, and Lever nests the commitment type in
 * `categories.commitment` — both are extracted, but left as raw strings: parsing them is
 * BE-106's job, not the connector's.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://api.lever.co";

const postingSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  text: z.string(),
  hostedUrl: z.string().url(),
  applyUrl: z.string().url().nullish(),
  createdAt: z.number().nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      commitment: z.string().nullish(),
      team: z.string().nullish(),
    })
    .nullish(),
});

/** Lever answers a bare `[]` for a slug with no postings — valid, and correctly zero rows. */
const boardSchema = z.array(postingSchema);

function boardTokens(cfg: SourceConfig): string[] {
  if (cfg.board) return [cfg.board];
  return cfg.boards ?? [];
}

/** Epoch ms → ISO 8601, or null when the provider omitted it. */
function createdAtToIso(createdAt: number | null | undefined): string | null {
  if (createdAt === null || createdAt === undefined) return null;
  // A provider that sends 0 or a negative value has no date, not a date in 1970.
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  const iso = new Date(createdAt).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export const leverConnector: SourceConnector = {
  kind: "api_lever",
  costClass: "free",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;

    for (const board of boardTokens(cfg)) {
      const url = joinUrl(base, `/v0/postings/${encodeURIComponent(board)}`) + "?mode=json";

      const payload = await fetchJson<unknown>(url, ctx, {
        label: `lever:${board}`,
        timeoutMs: JOB_API_TIMEOUT_MS,
      });

      const parsed = boardSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("scrape_parse_failed", {
          message: `lever:${board}: response was not an array of postings`,
          cause: parsed.error,
        });
      }

      // Without this, every posting is attributed to "Lever" and the dedupe hash — which
      // is built from the company domain/name — collapses the whole board into one company.
      const companyName = cfg.companyName ?? board;

      for (const posting of parsed.data) {
        yield {
          externalId: posting.id,
          sourceUrl: posting.hostedUrl,
          applyUrl: posting.applyUrl ?? posting.hostedUrl,
          companyName,
          companyDomain: null,
          title: posting.text,
          descriptionText: posting.descriptionPlain ?? null,
          descriptionHtml: posting.descriptionHtml ?? null,
          locationRaw: posting.categories?.location ?? null,
          workMode: null,
          employmentType: null,
          seniority: null,
          salaryRaw: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: null,
          skills: [],
          postedAt: createdAtToIso(posting.createdAt),
          raw: posting,
        };
      }
    }
  },
};