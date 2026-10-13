/**
 * feed-query.test.ts — the ranked feed read path (BE-306).
 *
 * The feed is the one query the whole product depends on (docs/04 §5.4), so
 * the properties pinned here are the ones that would silently break it:
 *
 *   1. the score cutoff and the dismissed/applied exclusions are always applied
 *   2. search goes through `textSearch` websearch/english — never raw SQL
 *   3. cursor pagination is keyset on (final_score, id), not offset
 *   4. nextCursor is derived from the extra row, and is null on a full page
 *   5. an undecodable cursor is rejected, not ignored
 *
 * The client is a double that records every filter — same convention as
 * `profile-update.test.ts`. No database: the SQL itself is covered by the
 * migration and the integration suite.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { dbTimestampSchema } from "@/types/db";
import {
  queryFeed,
  encodeFeedCursor,
  decodeFeedCursor,
  feedParamsFromSearchParams,
  MIN_FEED_SCORE,
  type FeedRow,
} from "@/lib/db/queries/feed";

// ---------------------------------------------------------------------------
// Supabase double
// ---------------------------------------------------------------------------

interface RecordedCalls {
  gt: unknown[][];
  gte: unknown[][];
  eq: unknown[][];
  or: unknown[][];
  textSearch: unknown[][];
  in: unknown[][];
  order: unknown[][];
  limit: unknown[][];
}

function makeClient(result: { data: unknown[] | null; error?: unknown; count?: number | null }) {
  const calls: RecordedCalls = { gt: [], gte: [], eq: [], or: [], textSearch: [], in: [], order: [], limit: [] };

  const chain: Record<string, unknown> = {};
  const record =
    (name: keyof RecordedCalls) =>
    (...args: unknown[]) => {
      calls[name].push(args);
      return chain;
    };

  chain.gt = record("gt");
  chain.gte = record("gte");
  chain.eq = record("eq");
  chain.or = record("or");
  chain.textSearch = record("textSearch");
  chain.in = record("in");
  chain.order = record("order");
  chain.limit = record("limit");
  // `await query` — the chain is the thenable that resolves the final result.
  chain.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled(result));

  const select = vi.fn(() => chain);
  const from = vi.fn(() => ({ select }));

  return { from, select, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(id: string, finalScore: number): FeedRow {
  return {
    id,
    title: "Senior Frontend Engineer",
    company_name: "Acme Corp",
    company_domain: "acme.example",
    location: "Remote (US)",
    city: null,
    region: null,
    country_code: "US",
    work_mode: "remote",
    remote_scope: "global",
    employment_type: "full_time",
    seniority: "senior",
    salary_min: 160000,
    salary_max: 190000,
    salary_currency: "USD",
    salary_period: "year",
    // The format **PostgREST actually returns** for a `timestamptz`: microsecond precision
    // and a numeric offset, no `Z`. This fixture used to carry `.000Z`, which is the exact
    // reason 26 green unit tests sat on top of a schema that rejected 100% of real rows —
    // the double was returning the timestamp format the author imagined. Line 286's
    // expectation is a literal from the test's own input, not from this row, so it is
    // unaffected. `tests/integration/feed-query.db.test.ts` pins the real shape.
    posted_at: "2026-10-01T00:00:00.000000+00:00",
    first_seen_at: "2026-10-01T00:00:00.000000+00:00",
    last_seen_at: "2026-10-02T00:00:00.000000+00:00",
    sighting_count: 1,
    skills: ["react", "typescript"],
    final_score: finalScore,
    rule_score: 62.5,
    semantic_score: 71.3,
    breakdown: [
      { key: "skills", weight: 35, raw: 0.71, points: 24.9, known: true },
    ],
    explanation: null,
    saved: false,
    dismissed: false,
    applied: false,
  };
}

const baseParams = {
  limit: 2,
  lastSeenFeedAt: null,
};

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

describe("feed cursor", () => {
  it("round-trips score and id", () => {
    const cursor = { score: 78.42, id: "3f2a9c1e-0000-4000-8000-000000000001" };
    expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor);
  });

  it("returns null for absent cursor", () => {
    expect(decodeFeedCursor(null)).toBeNull();
    expect(decodeFeedCursor(undefined)).toBeNull();
  });

  it("returns null for a string without a separator", () => {
    expect(decodeFeedCursor("not-a-cursor")).toBeNull();
  });

  it("returns null for a non-numeric score", () => {
    const encoded = Buffer.from("abc:3f2a9c1e", "utf8").toString("base64url");
    expect(decodeFeedCursor(encoded)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Base query shape
// ---------------------------------------------------------------------------

describe("queryFeed — base filters (FED-001, FED-002)", () => {
  it("applies the score cutoff and the dismissed/applied exclusions", async () => {
    const client = makeClient({ data: [makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42)], count: 1 });

    const result = await queryFeed(client as never, baseParams);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(client.calls.gte).toEqual([["final_score", MIN_FEED_SCORE]]);
    expect(client.calls.eq).toEqual([
      ["dismissed", false],
      ["applied", false],
    ]);
    expect(result.total).toBe(1);
    expect(result.jobs).toHaveLength(1);
  });

  it("orders by final_score desc with id as tiebreaker and fetches limit + 1", async () => {
    const client = makeClient({ data: [], count: 0 });

    await queryFeed(client as never, { ...baseParams, limit: 20 });

    expect(client.calls.order).toEqual([
      ["final_score", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(client.calls.limit).toEqual([[21]]);
  });

  it("rejects an undecodable cursor instead of ignoring it", async () => {
    const client = makeClient({ data: [], count: 0 });

    const result = await queryFeed(client as never, { ...baseParams, cursor: "not-a-cursor" });

    expect(result).toEqual({ error: "invalid_cursor" });
    expect(client.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Keyset pagination
// ---------------------------------------------------------------------------

describe("queryFeed — cursor pagination", () => {
  it("expresses the cursor as a (score, id) keyset filter", async () => {
    const client = makeClient({ data: [], count: 0 });
    const cursor = encodeFeedCursor({ score: 78.42, id: "3f2a9c1e-0000-4000-8000-000000000001" });

    await queryFeed(client as never, { ...baseParams, cursor });

    expect(client.calls.or).toEqual([
      ["final_score.lt.78.42,final_score.eq.78.42,and(id.lt.3f2a9c1e-0000-4000-8000-000000000001)"],
    ]);
  });

  it("encodes nextCursor from the extra row when more results exist", async () => {
    const client = makeClient({
      data: [makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42), makeRow("3f2a9c1e-0000-4000-8000-000000000002", 71.1)],
      count: 5,
    });

    const result = await queryFeed(client as never, { ...baseParams, limit: 1 });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.jobs).toHaveLength(1);
    expect(result.nextCursor).toBe(
      encodeFeedCursor({ score: 78.42, id: "3f2a9c1e-0000-4000-8000-000000000001" }),
    );
  });

  it("returns a null nextCursor when the page is exactly full", async () => {
    const client = makeClient({
      data: [makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42)],
      count: 1,
    });

    const result = await queryFeed(client as never, { ...baseParams, limit: 2 });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filters & search
// ---------------------------------------------------------------------------

describe("queryFeed — filters (FED-003)", () => {
  it("searches via textSearch websearch/english, never raw SQL", async () => {
    const client = makeClient({ data: [], count: 0 });

    await queryFeed(client as never, { ...baseParams, search: "react typescript" });

    expect(client.calls.textSearch).toEqual([
      ["search_vector", "react typescript", { type: "websearch", config: "english" }],
    ]);
  });

  it("applies work-mode, seniority, salary, country and remote-scope filters", async () => {
    const client = makeClient({ data: [], count: 0 });

    await queryFeed(client as never, {
      ...baseParams,
      workModes: ["remote", "hybrid"],
      seniority: ["senior", "lead"],
      minSalary: 100000,
      countryCode: "IN",
      remoteScope: "india",
    });

    expect(client.calls.in).toEqual([
      ["work_mode", ["remote", "hybrid"]],
      ["seniority", ["senior", "lead"]],
    ]);
    expect(client.calls.gte).toEqual([
      ["final_score", MIN_FEED_SCORE],
      ["salary_max", 100000],
    ]);
    expect(client.calls.eq).toEqual([
      ["dismissed", false],
      ["applied", false],
      ["country_code", "IN"],
      ["remote_scope", "india"],
    ]);
  });

  it("filters first_seen_at when newSinceLastVisit is set", async () => {
    const client = makeClient({ data: [], count: 0 });

    const result = await queryFeed(client as never, {
      ...baseParams,
      newSinceLastVisit: true,
      lastSeenFeedAt: "2026-10-08T00:00:00.000Z",
    });

    expect("error" in result).toBe(false);
    expect(client.calls.gte).toEqual([["final_score", MIN_FEED_SCORE]]);
    expect(client.calls.gt).toEqual([["first_seen_at", "2026-10-08T00:00:00.000Z"]]);
  });

  it("ignores newSinceLastVisit when the caller has no last_seen_feed_at", async () => {
    const client = makeClient({ data: [], count: 0 });

    await queryFeed(client as never, { ...baseParams, newSinceLastVisit: true, lastSeenFeedAt: null });

    expect(client.calls.gte).toEqual([["final_score", MIN_FEED_SCORE]]);
  });
});

// ---------------------------------------------------------------------------
// URL → query params
// ---------------------------------------------------------------------------

describe("feedParamsFromSearchParams", () => {
  it("applies defaults for an empty query string", () => {
    const params = feedParamsFromSearchParams({});
    expect(params.limit).toBe(20);
    expect(params.cursor).toBeUndefined();
    expect(params.search).toBeUndefined();
  });

  it("parses comma-separated lists and scalar filters", () => {
    const params = feedParamsFromSearchParams({
      workModes: "remote,hybrid",
      seniority: "senior",
      minSalary: "100000",
      countryCode: "IN",
      remoteScope: "india",
      newSinceLastVisit: "true",
      limit: "5",
    });
    expect(params.workModes).toEqual(["remote", "hybrid"]);
    expect(params.seniority).toEqual(["senior"]);
    expect(params.minSalary).toBe(100000);
    expect(params.countryCode).toBe("IN");
    expect(params.remoteScope).toBe("india");
    expect(params.newSinceLastVisit).toBe(true);
    expect(params.limit).toBe(5);
  });

  it("treats newSinceLastVisit other than \"true\" as unset", () => {
    expect(feedParamsFromSearchParams({ newSinceLastVisit: "false" }).newSinceLastVisit).toBeUndefined();
    expect(feedParamsFromSearchParams({ newSinceLastVisit: "1" }).newSinceLastVisit).toBeUndefined();
  });

  it("drops non-numeric limit and minSalary instead of throwing", () => {
    expect(feedParamsFromSearchParams({ limit: "abc" }).limit).toBe(20);
    expect(feedParamsFromSearchParams({ minSalary: "abc" }).minSalary).toBeUndefined();
  });

  it("ignores unknown keys", () => {
    expect(() => feedParamsFromSearchParams({ evil: "x", limit: "3" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

describe("queryFeed — row validation", () => {
  it("parses rows through the feed schema", async () => {
    const client = makeClient({ data: [makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42)], count: 1 });

    const result = await queryFeed(client as never, baseParams);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const [first] = result.jobs;
    expect(first?.company_name).toBe("Acme Corp");
    expect(first?.saved).toBe(false);
  });

  it("fails the whole query on a row that does not match the schema", async () => {
    const client = makeClient({ data: [{ id: "not-a-uuid" }], count: 1 });

    await expect(queryFeed(client as never, baseParams)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // PostgREST failures (the crash that shipped)
  // -------------------------------------------------------------------------

  it("returns a typed error instead of throwing when PostgREST fails", async () => {
    // The regression this file exists beside. `queryFeed` rethrew the raw PostgREST error,
    // and `/dashboard` only handled `invalid_cursor` — so a `42703 undefined_column` (a
    // migration never pushed to the database the app points at) escaped the server
    // component and rendered Next's production message: "An error occurred in the Server
    // Components render", with a digest and nothing else.
    const client = makeClient({
      data: null,
      count: null,
      error: {
        code: "42703",
        message: 'column v_ranked_jobs.first_seen_at does not exist',
        details: null,
        hint: null,
      },
    });

    const result = await queryFeed(client as never, baseParams);

    expect(result).toEqual({ error: "query_failed" });
  });

  it("logs the PostgREST code so the cause is not a bare digest", async () => {
    // The server-side log is the only place `code`/`details`/`hint` appear; the client gets
    // a code (docs/03 §5.3). `logger` redacts, so this cannot print a key.
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const client = makeClient({
        data: null,
        count: null,
        error: { code: "PGRST205", message: "Could not find the table", details: null, hint: null },
      });

      await queryFeed(client as never, baseParams);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [, meta] = errorSpy.mock.calls[0] ?? [];
      expect(meta).toMatchObject({ code: "PGRST205", message: "Could not find the table" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs which field failed when a row does not validate", async () => {
    // A row mismatch still throws (it is a bug in this code, and the error boundary plus
    // Sentry should see it), but the cause is no longer only a digest.
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const client = makeClient({ data: [{ ...makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42), id: "not-a-uuid" }], count: 1 });

      await expect(queryFeed(client as never, baseParams)).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = errorSpy.mock.calls[0] ?? [];
      expect(message).toBe("feed row failed validation");
      expect(String((meta as { issues?: string })?.issues)).toContain("id");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("accepts a row whose skills column is NULL", async () => {
    // `jobs.skills` is `text[]` with no default (0001_init.sql:256). The schema demanded an
    // array, so the most common real-world row shape — a job ingested before the skill
    // matcher existed, or from a posting that named no skills — was the one that crashed.
    const client = makeClient({ data: [{ ...makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42), skills: null }], count: 1 });

    const result = await queryFeed(client as never, baseParams);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.jobs[0]?.skills).toBeNull();
  });

  it("accepts the timestamp format PostgREST returns", () => {
    // `makeRow` now carries `…+00:00` with microseconds, so merely reaching this assertion
    // is the proof; the explicit parse states the contract so a future fixture change that
    // reintroduces `.000Z` fails here rather than silently hiding the bug again.
    const row = makeRow("3f2a9c1e-0000-4000-8000-000000000001", 78.42);
    expect(z.string().datetime().safeParse(row.first_seen_at).success).toBe(false);
    expect(dbTimestampSchema.safeParse(row.first_seen_at).success).toBe(true);
  });
});
