/**
 * greenhouse.ts — Greenhouse public board API (BE-102 / docs/04 §5.2).
 *
 * `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
 *
 * Public, no key, no pagination — the endpoint returns a company's entire board in one
 * response, so "large boards handled without truncation" means not truncating *this* array,
 * not paging it.
 *
 * `content=true` is what asks for the posting body. Without it Greenhouse returns every
 * job with `content: ""`, and the connector would look like it worked while producing
 * `description_html = ""` for every row — the kind of quiet data-quality loss the Zod
 * validation in `connectors/types.ts` exists to prevent.
 */

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { fetchJson, JOB_API_TIMEOUT_MS, joinUrl } from "./http";
import type { RunCtx, SourceConfig, SourceConnector } from "./types";

const DEFAULT_BASE_URL = "https://boards-api.greenhouse.io";

/**
 * The provider payload. Deliberately permissive about fields we do not use and strict
 * about the ones `RawJob` requires — an over-tight schema here would fail a whole board
 * because one posting added a field.
 */
const boardSchema = z.object({
  company: z
    .object({ name: z.string() })
    .nullish(),
  jobs: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      title: z.string(),
      absolute_url: z.string().url(),
      content: z.string().nullish(),
      updated_at: z.string().nullish(),
    }),
  ),
});

/** Every board token on this source: `board` wins, else the seeded `boards` list. */
function boardTokens(cfg: SourceConfig): string[] {
  if (cfg.board) return [cfg.board];
  return cfg.boards ?? [];
}

/**
 * Greenhouse rejects an unknown board with 404. That is a misconfiguration on our side, not
 * a transient upstream blip, so it is `upstream_error` with the board named — retrying it
 * three times would just fail three times and cost the run's time budget.
 */
function missingBoardMessage(board: string): AppError {
  return new AppError("upstream_error", {
    message: `greenhouse: board "${board}" returned no jobs payload`,
  });
}

export const greenhouseConnector: SourceConnector = {
  kind: "api_greenhouse",
  costClass: "free",

  async *fetch(cfg: SourceConfig, ctx: RunCtx) {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const boards = boardTokens(cfg);

    for (const board of boards) {
      const url = joinUrl(base, `/v1/boards/${encodeURIComponent(board)}/jobs`) + "?content=true";

      const payload = await fetchJson<unknown>(url, ctx, {
        label: `greenhouse:${board}`,
        timeoutMs: JOB_API_TIMEOUT_MS,
      });

      // A board that is not a board returns an HTML error page or `{}`; both fail Zod and
      // become `scrape_parse_failed`, which is the honest classification.
      const parsed = boardSchema.safeParse(payload);
      if (!parsed.success) {
        // `{}` parses as "no company, no jobs", so check emptiness before blaming the shape.
        const asEmpty = z.object({ jobs: z.array(z.unknown()).optional() }).safeParse(payload);
        if (asEmpty.success && !asEmpty.data.jobs) throw missingBoardMessage(board);
        throw new AppError("scrape_parse_failed", {
          message: `greenhouse:${board}: response did not match the board schema`,
          cause: parsed.error,
        });
      }

      const companyName = cfg.companyName ?? parsed.data.company?.name ?? board;

      for (const job of parsed.data.jobs) {
        yield {
          externalId: job.id,
          sourceUrl: job.absolute_url,
          applyUrl: job.absolute_url,
          companyName,
          companyDomain: null,
          title: job.title,
          descriptionText: null,
          descriptionHtml: job.content ?? null,
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
          postedAt: job.updated_at ?? null,
          raw: job,
        };
      }
    }
  },
};