/**
 * queries/feed.ts — the ranked feed read path (BE-306).
 *
 * ## Why this module exists
 *
 * docs/06 §8.1: components never call PostgREST directly — reads go through
 * `lib/db/queries/`. The feed is the highest-traffic read in the product
 * (docs/04 §5.4 calls it "the one query that matters"), so it gets the same
 * boundary as `queries/profile.ts`: Zod first, columns derived from the schema,
 * caller passes the RLS-scoped client.
 *
 * ## Read path
 *
 * Everything comes from `v_ranked_jobs` (migration 0011): jobs ⨝ job_scores,
 * `security_invoker`, so RLS applies — `jobs` is readable by any authenticated
 * user, `job_scores` only by the scoring user, and the `saved`/`dismissed`/
 * `applied` EXISTS subqueries run as the caller via `auth.uid()`.
 *
 * ## Score cutoff
 *
 * `MIN_FEED_SCORE` is 60, matching the partial index
 * `idx_jobs_user_final ... where final_score >= 60` (0001_init.sql) and the
 * docs/04 §5.4 example query. Gated and weak jobs (bands below "Fair") do
 * not appear — FED-001.
 *
 * ## Search
 *
 * `search` goes through PostgREST's `textSearch` with `type: "websearch"`,
 * which is `websearch_to_tsquery` (FED-003 / docs/03 §6.2 S-01) — the input
 * is parsed by Postgres as a web-search string, never concatenated into SQL.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";
import { dbTimestampSchema } from "@/types/db";
import { feedQueryRequestSchema } from "@/types/api";
import { logger } from "@/lib/logger";

/** Jobs below this score never enter the feed. See the comment above. */
export const MIN_FEED_SCORE = 60;

// ---------------------------------------------------------------------------
// Row schema — one row of v_ranked_jobs as PostgREST returns it
// ---------------------------------------------------------------------------

/**
 * One row of `job_scores.breakdown` (docs/02a §5.5, shape pinned by
 * `scoring/rules.ts`). Always present for scored jobs (C3).
 */
export const breakdownEntrySchema = z.object({
  key: z.string(),
  weight: z.number(),
  raw: z.number(),
  points: z.number(),
  known: z.boolean(),
});

/** The feed row. Keys are the view's column names — one mapping, no drift. */
export const feedRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  company_name: z.string(),
  company_domain: z.string().nullable(),
  location: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country_code: z.string().length(2).nullable(),
  work_mode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  remote_scope: z.enum(["india", "global", "unknown"]),
  employment_type: z.string(),
  seniority: z.string(),
  salary_min: z.number().nullable(),
  salary_max: z.number().nullable(),
  salary_currency: z.string().length(3).nullable(),
  salary_period: z.string().nullable(),
  posted_at: dbTimestampSchema.nullable(),
  first_seen_at: dbTimestampSchema,
  last_seen_at: dbTimestampSchema,
  sighting_count: z.number(),
  /**
   * `jobs.skills` is `text[]` with **no default and no NOT NULL** (0001_init.sql:256), so
   * NULL is the normal state for a job ingested before the skill matcher existed, or from a
   * source whose posting named no skills. It was declared `z.array(z.string())`, which made
   * every such job a validation failure and took the whole page down — see the note on
   * `dbTimestampSchema` for why the unit tests could not see it.
   */
  skills: z.array(z.string()).nullable(),
  /**
   * Non-nullable on purpose. The view LEFT JOINs `job_scores`, so an unscored job *is* NULL
   * in the view — but the query's `.gte("final_score", MIN_FEED_SCORE)` drops NULLs in SQL,
   * so a null here can only mean that predicate stopped applying. An earlier comment here
   * claimed this was nullable "so one unexpected null must not fail the whole page" — that
   * tolerance was illusory: `scoreBand(null)` is `NaN` and renders a broken meter, so the
   * strict schema fails loudly at the boundary where the bug actually is.
   */
  final_score: z.number(),
  rule_score: z.number().nullable(),
  semantic_score: z.number().nullable(),
  // Nullable because a gated job is still written with a row (final_score 0 + gate_result);
  // `breakdown` is always populated for scored jobs (C3), but one null must not fail the page.
  breakdown: z.array(breakdownEntrySchema).nullable(),
  explanation: z.string().nullable(),
  saved: z.boolean(),
  dismissed: z.boolean(),
  applied: z.boolean(),
});

export type FeedRow = z.infer<typeof feedRowSchema>;

/** The select list, derived from the schema so the two cannot disagree. */
const FEED_COLUMNS = Object.keys(feedRowSchema.shape).join(", ");

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * The cursor is `final_score:id`, base64url-encoded. Ordering is
 * `(final_score DESC, id DESC)` — the id tiebreaker keeps pagination stable
 * when two jobs share a score, which is common because scores are rounded to
 * 2dp.
 */
export interface FeedCursor {
  score: number;
  id: string;
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(`${cursor.score}:${cursor.id}`, "utf8").toString("base64url");
}

export function decodeFeedCursor(cursor: string | null | undefined): FeedCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf(":");
    if (sep <= 0) return null;
    const score = Number(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (!Number.isFinite(score) || !id) return null;
    return { score, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL → query params (FED-003: filter state lives in the URL)
// ---------------------------------------------------------------------------

/**
 * Parse Next.js `searchParams` into the feed query schema.
 *
 * Filter state is URL-synced so feeds are shareable and back/forward works
 * (FED-003). This is the only place that knows about the wire format:
 * comma-separated lists, `limit` as a string, `newSinceLastVisit` as "true".
 * Everything downstream gets a typed, validated object.
 *
 * Unknown keys are ignored — a stale or hand-edited URL must not 500.
 */
export function feedParamsFromSearchParams(
  input: Record<string, string | string[] | undefined>,
): z.infer<typeof feedQueryRequestSchema> {
  const get = (key: string): string | undefined => {
    const value = input[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const list = (key: string): string[] | undefined => {
    const value = get(key);
    if (!value) return undefined;
    const items = value.split(",").filter(Boolean);
    return items.length > 0 ? items : undefined;
  };

  const limitRaw = get("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  const minSalaryRaw = get("minSalary");
  const minSalary = minSalaryRaw !== undefined ? Number(minSalaryRaw) : undefined;

  return feedQueryRequestSchema.parse({
    cursor: get("cursor"),
    limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    search: get("search"),
    workModes: list("workModes"),
    seniority: list("seniority"),
    minSalary: minSalary !== undefined && Number.isFinite(minSalary) ? minSalary : undefined,
    countryCode: get("countryCode"),
    remoteScope: get("remoteScope"),
    newSinceLastVisit: get("newSinceLastVisit") === "true" ? true : undefined,
  });
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface FeedQueryParams extends z.infer<typeof feedQueryRequestSchema> {
  /**
   * The caller's `profiles.last_seen_feed_at`. Only read when
   * `newSinceLastVisit` is set (FED-004); passing it always keeps the read in
   * one place instead of the page guessing.
   */
  lastSeenFeedAt: string | null;
}

export interface FeedQueryResult {
  jobs: FeedRow[];
  nextCursor: string | null;
  total: number;
}

/**
 * Why a feed read produced nothing renderable.
 *
 * `invalid_cursor` is the caller's fault (a truncated link). `query_failed` is ours or the
 * database's — a missing migration, a policy regression, a dropped connection. The page
 * renders a different message for each, because telling a user their link is stale when the
 * database is unreachable sends them to fix the wrong thing.
 */
export type FeedQueryError = "invalid_cursor" | "query_failed";

/**
 * Query the ranked feed for the caller.
 *
 * The client must be the caller's RLS-scoped client (`createUserClient`) — the
 * view's per-user columns and the `job_scores` join are only correct under the
 * caller's JWT.
 *
 * @returns The page of rows (already validated), the cursor for the next page, or a typed
 *          error the page renders as an explicit state.
 *
 * ## Why this returns instead of throwing
 *
 * It used to rethrow the raw PostgREST error. `/dashboard` only handled `invalid_cursor`, so
 * any other failure — including `42703 undefined_column` from a migration that was never
 * pushed to the database the app is actually pointed at — propagated out of the server
 * component and produced Next's production message, *"An error occurred in the Server
 * Components render"*, with a digest and no other symptom. The raw details stay server-side
 * in the log; the client gets a code (docs/03 §5.3).
 */
export async function queryFeed(
  client: SupabaseClient,
  params: FeedQueryParams,
): Promise<FeedQueryResult | { error: FeedQueryError }> {
  const cursor = decodeFeedCursor(params.cursor);
  if (params.cursor != null && cursor === null) {
    return { error: "invalid_cursor" };
  }

  let query = client
    .from("v_ranked_jobs")
    .select(FEED_COLUMNS, { count: "exact" })
    // FED-001: gated/zero-score jobs do not appear.
    .gte("final_score", MIN_FEED_SCORE)
    // FED-002: dismissed jobs never resurface. Applied jobs live in the
    // tracker, not the feed (docs/04 §5.4: `.is('application', null)`).
    .eq("dismissed", false)
    .eq("applied", false)
    .order("final_score", { ascending: false })
    .order("id", { ascending: false })
    // Fetch one extra row to compute nextCursor without a second query.
    .limit(params.limit + 1);

  // Keyset pagination: (score, id) < (cursor.score, cursor.id), expressed in
  // PostgREST's row-filter syntax. `id` is a UUID (no commas), so the nested
  // `and(...)` is safe unencoded.
  if (cursor) {
    query = query.or(
      `final_score.lt.${cursor.score},final_score.eq.${cursor.score},and(id.lt.${cursor.id})`,
    );
  }

  // FED-003: websearch_to_tsquery via PostgREST's wfts — never raw SQL.
  if (params.search) {
    query = query.textSearch("search_vector", params.search, {
      type: "websearch",
      config: "english",
    });
  }

  if (params.workModes && params.workModes.length > 0) {
    query = query.in("work_mode", params.workModes);
  }
  if (params.seniority && params.seniority.length > 0) {
    query = query.in("seniority", params.seniority);
  }
  // A job satisfies a salary floor if its range reaches it: `salary_max >= min`.
  // Jobs with no parsed salary are excluded — they cannot be verified to meet
  // the floor, and "min salary" is a promise about pay, not a request to
  // guess. (PostgREST `gte` drops NULLs, which is exactly this rule.)
  if (params.minSalary != null) {
    query = query.gte("salary_max", params.minSalary);
  }
  if (params.countryCode) {
    query = query.eq("country_code", params.countryCode);
  }
  if (params.remoteScope) {
    query = query.eq("remote_scope", params.remoteScope);
  }
  // FED-004: "new since last visit" = first seen after the caller's last feed view.
  if (params.newSinceLastVisit && params.lastSeenFeedAt) {
    query = query.gt("first_seen_at", params.lastSeenFeedAt);
  }

  const { data, error, count } = await query;
  if (error) {
    // The server-side log is the only place the PostgREST code, hint and details appear.
    // `logger` redacts, so a failure cannot print a key or a bearer token.
    logger.error("feed query failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      search: params.search ?? null,
    });
    return { error: "query_failed" };
  }

  let rows: FeedRow[];
  try {
    rows = feedRowSchema.array().parse(data ?? []);
  } catch (err) {
    // Deliberately still throws, unlike a PostgREST error: a row that does not match the
    // schema is a bug in *this* code (a renamed column, a new nullability), not a transient
    // fault, and it should reach the error boundary and Sentry rather than be rendered as a
    // friendly empty state. What changes is that the cause is logged here — previously the
    // only trace was Next's production digest, which says nothing about which field failed.
    const issues =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : String(err);
    logger.error("feed row failed validation", { issues });
    throw err;
  }
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page[page.length - 1];

  return {
    jobs: page,
    nextCursor: hasMore && last ? encodeFeedCursor({ score: last.final_score, id: last.id }) : null,
    total: count ?? 0,
  };
}
