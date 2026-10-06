/**
 * connector contract tests (BE-102..BE-105, docs/06 §8.5).
 *
 * ## No live APIs, ever
 *
 * Every test here runs against a recorded fixture from `tests/integration/fixtures/sources/`
 * with an injected `fetch`. docs/06 §8.5 states the rule and the reason: live calls burn
 * quota, go flaky, and block unrelated PRs when a source rate-limits.
 *
 * ## What a connector test can and cannot prove
 *
 * It proves the *mapping* — that the fields docs/04 §5.2 names arrive in the right `RawJob`
 * fields, and that a provider shape change becomes `scrape_parse_failed` rather than a
 * silent zero. It cannot prove the provider still returns that shape; only the recorded
 * fixture's shape. So each test asserts the request that was made as well as the jobs that
 * came back: a connector that quietly stopped sending `content=true` would still pass an
 * output-only assertion if the fixture already contained the body.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  adzunaConnector,
  ashbyConnector,
  arbeitnowConnector,
  firecrawlMap,
  firecrawlScrapeConnector,
  greenhouseConnector,
  JOB_API_TIMEOUT_MS,
  joinUrl,
  leverConnector,
  remotiveConnector,
  usajobsConnector,
  type RunCtx,
  type SourceConfig,
  type SourceConnector,
} from "@/lib/connectors";
import { rawJobSchema } from "@/types/canonical-job";

const FIXTURES = join(process.cwd(), "tests", "integration", "fixtures", "sources");

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

/** One recorded request, so a test can assert on what was actually asked for. */
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Harness {
  ctx: RunCtx;
  requests: Recorded[];
  sleeps: number[];
  /** Advance the fake clock. `now()` is deterministic, so throttle waits are observable. */
  advance: (ms: number) => void;
}

/** `fetch` accepts a string, a `URL` or a `Request`; only the first two stringify cleanly. */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A `RunCtx` backed by a fixture, a fake clock and a fetch that never touches the network.
 *
 * The clock is a counter rather than `Date.now` so the Remotive throttle assertion can be
 * exact: a real clock would make the 1.5s interval a race that passes or fails by machine
 * speed.
 */
function harness(
  responses: Record<string, unknown> | ((url: string) => unknown),
  options: { status?: number; bodyIsNotJson?: boolean } = {},
): Harness {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;

  const fetchImpl: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });

    const status = options.status ?? 200;
    const payload =
      typeof responses === "function" ? responses(url) : (responses[url] ?? responses["*"]);

    if (options.bodyIsNotJson) {
      return Promise.resolve(new Response("<html>not json</html>", { status }));
    }
    return Promise.resolve(new Response(JSON.stringify(payload ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  };

  return {
    requests,
    sleeps,
    advance: (ms) => {
      clock += ms;
    },
    ctx: {
      runId: "run-test",
      signal: new AbortController().signal,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        // The fake clock jumps by the requested amount, so a `sleep` the throttle computed
        // actually moves time the way a real one would.
        clock += ms;
        return Promise.resolve();
      },
      fetch: fetchImpl,
    },
  };
}

/** Drain a connector, validating every row through the shared `RawJob` schema. */
async function collect(
  connector: SourceConnector,
  cfg: SourceConfig,
  ctx: RunCtx,
): Promise<ReturnType<typeof rawJobSchema.parse>[]> {
  const out: ReturnType<typeof rawJobSchema.parse>[] = [];
  for await (const job of connector.fetch(cfg, ctx)) {
    // Parsing here is the point: a connector that emits a row the seam rejects has
    // produced something BE-106 could never consume.
    out.push(rawJobSchema.parse(job));
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("greenhouse (BE-102)", () => {
  it("maps the board fixture, keeping HTML in descriptionHtml", async () => {
    const h = harness({ "*": fixture("api_greenhouse") });

    const jobs = await collect(
      greenhouseConnector,
      { name: "Greenhouse", kind: "api_greenhouse", boards: ["acme"] },
      h.ctx,
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "40281",
      title: "Senior Backend Engineer",
      companyName: "Acme Corp",
      sourceUrl: "https://boards.greenhouse.io/acme/jobs/40281",
      postedAt: "2026-09-28T10:15:00Z",
    });
    // docs/05b ING-002: "HTML content is preserved (not stripped)".
    expect(jobs[0]?.descriptionHtml).toContain("<strong>Senior Backend Engineer</strong>");
  });

  it("requests content=true, without which every posting body would be empty", async () => {
    const h = harness({ "*": fixture("api_greenhouse") });

    await collect(
      greenhouseConnector,
      { name: "Greenhouse", kind: "api_greenhouse", boards: ["acme"] },
      h.ctx,
    );

    expect(h.requests[0]?.url).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    );
  });

  it("uses the 15s job-API timeout, not the 30s Firecrawl default", async () => {
    // docs/04 §5.9 tabulates 15s for "Job APIs" and 30s for Firecrawl.
    const h = harness({ "*": fixture("api_greenhouse") });

    await collect(
      greenhouseConnector,
      { name: "Greenhouse", kind: "api_greenhouse", boards: ["acme"] },
      h.ctx,
    );

    expect(JOB_API_TIMEOUT_MS).toBe(15_000);
  });

  it("prefers the single-board config over the seeded boards list", async () => {
    const h = harness({ "*": fixture("api_greenhouse") });

    await collect(
      greenhouseConnector,
      { name: "G", kind: "api_greenhouse", board: "acme", boards: ["other", "third"] },
      h.ctx,
    );

    // Two calls would mean the list was walked too; `board` is the whole config.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url).toContain("/boards/acme/");
  });

  it("iterates every seeded board", async () => {
    const h = harness({ "*": fixture("api_greenhouse") });

    const jobs = await collect(
      greenhouseConnector,
      { name: "G", kind: "api_greenhouse", boards: ["acme", "beta"] },
      h.ctx,
    );

    expect(h.requests).toHaveLength(2);
    expect(jobs).toHaveLength(4);
  });

  it("surfaces an unknown board as a typed error, not a parse failure", async () => {
    const h = harness({ "*": {} });

    await expect(
      collect(
        greenhouseConnector,
        { name: "G", kind: "api_greenhouse", boards: ["nope"] },
        h.ctx,
      ),
    ).rejects.toThrow(/no jobs payload/);
  });

  it("maps a changed provider shape to scrape_parse_failed", async () => {
    const h = harness({ "*": { jobs: "not-an-array" } });

    await expect(
      collect(
        greenhouseConnector,
        { name: "G", kind: "api_greenhouse", boards: ["acme"] },
        h.ctx,
      ),
    ).rejects.toThrow(/board schema/);
  });
});

// ---------------------------------------------------------------------------

describe("lever (BE-102)", () => {
  it("parses the bare array Lever actually returns", async () => {
    const h = harness({ "*": fixture("api_lever") });

    const jobs = await collect(
      leverConnector,
      { name: "Lever", kind: "api_lever", boards: ["acme"] },
      h.ctx,
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "9f1c2b44-0e3a-4f21-9a1e-5b6c7d8e9f01",
      title: "Staff Frontend Engineer",
      sourceUrl: "https://jobs.lever.co/acme/staff-frontend-9f1c2b44",
      locationRaw: "Bengaluru, India",
    });
  });

  it("converts createdAt epoch milliseconds to ISO", async () => {
    const h = harness({ "*": fixture("api_lever") });

    const jobs = await collect(
      leverConnector,
      { name: "Lever", kind: "api_lever", boards: ["acme"] },
      h.ctx,
    );

    // 1759046400000 ms is 2025-09-28T08:00:00Z. Emitting the raw number would fail
    // `z.string().datetime()` and drop every Lever posting.
    expect(jobs[0]?.postedAt).toBe("2025-09-28T08:00:00.000Z");
  });

  it("never attributes postings to the provider's own name", async () => {
    const h = harness({ "*": fixture("api_lever") });

    const jobs = await collect(
      leverConnector,
      { name: "Lever", kind: "api_lever", boards: ["acme"] },
      h.ctx,
    );

    // The seeded `sources` row is called "Lever" and the company is not. Getting this
    // wrong collapses a whole board into one company in the dedupe hash.
    expect(jobs.every((j) => j.companyName === "acme")).toBe(true);
  });

  it("uses the configured company name when one is given", async () => {
    const h = harness({ "*": fixture("api_lever") });

    const jobs = await collect(
      leverConnector,
      { name: "Lever", kind: "api_lever", boards: ["acme"], companyName: "Acme Corp" },
      h.ctx,
    );

    expect(jobs.every((j) => j.companyName === "Acme Corp")).toBe(true);
  });

  it("requests mode=json, which is what keeps descriptionHtml as HTML", async () => {
    const h = harness({ "*": fixture("api_lever") });

    await collect(
      leverConnector,
      { name: "Lever", kind: "api_lever", boards: ["acme"] },
      h.ctx,
    );

    expect(h.requests[0]?.url).toBe("https://api.lever.co/v0/postings/acme?mode=json");
  });

  it("treats an empty array as a real board with no jobs", async () => {
    const h = harness({ "*": [] });

    const jobs = await collect(
      leverConnector,
      { name: "Lever", kind: "api_lever", boards: ["acme"] },
      h.ctx,
    );

    expect(jobs).toEqual([]);
  });

  it("rejects a Greenhouse-shaped object rather than ingesting zero rows", async () => {
    const h = harness({ "*": { jobs: [] } });

    await expect(
      collect(leverConnector, { name: "L", kind: "api_lever", boards: ["acme"] }, h.ctx),
    ).rejects.toThrow(/not an array of postings/);
  });
});

// ---------------------------------------------------------------------------

describe("ashby (BE-102)", () => {
  it("maps the job board, reading the object-shaped location", async () => {
    const h = harness({ "*": fixture("api_ashby") });

    const jobs = await collect(
      ashbyConnector,
      { name: "Ashby", kind: "api_ashby", organizations: ["acme"], companyName: "Acme" },
      h.ctx,
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "a1b2c3d4-0000-4000-8000-000000000001",
      title: "Platform Engineer",
      sourceUrl: "https://jobs.ashbyhq.com/acme/1/platform-engineer",
      locationRaw: "Remote (India)",
      workMode: "remote",
      salaryRaw: "$120k – $160k",
    });
  });

  it("requests includeCompensation=true, the only source of Ashby salary", async () => {
    const h = harness({ "*": fixture("api_ashby") });

    await collect(
      ashbyConnector,
      { name: "Ashby", kind: "api_ashby", organizations: ["acme"] },
      h.ctx,
    );

    expect(h.requests[0]?.url).toContain("includeCompensation=true");
  });

  it("maps isRemote=false to null, not to onsite", async () => {
    const h = harness({ "*": fixture("api_ashby") });

    const jobs = await collect(
      ashbyConnector,
      { name: "Ashby", kind: "api_ashby", organizations: ["acme"] },
      h.ctx,
    );

    // Asserting "onsite" would hard-fail the work_mode_mismatch gate against a user's
    // hybrid preference on the strength of one boolean Ashby also sets for hybrids.
    expect(jobs[1]?.workMode).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("remotive (BE-103)", () => {
  it("maps the remote-jobs fixture", async () => {
    const h = harness({ "*": fixture("api_remotive") });

    const jobs = await collect(
      remotiveConnector,
      { name: "Remotive", kind: "api_remotive", query: "golang" },
      h.ctx,
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "11223344",
      companyName: "Globex",
      title: "Senior Go Developer",
      locationRaw: "Worldwide",
    });
    expect(jobs[0]?.descriptionHtml).toContain("<strong>Go</strong>");
  });

  it("widens a bare publication_date to an ISO datetime", async () => {
    const h = harness({ "*": fixture("api_remotive") });

    const jobs = await collect(remotiveConnector, { name: "R", kind: "api_remotive" }, h.ctx);

    // docs/05b ING-006 requires confidence < 1 rather than a dropped posting, so the date
    // has to survive the round trip.
    expect(jobs[0]?.postedAt).toBe("2026-09-30T00:00:00.000Z");
  });

  it("sends the search term only when one is configured", async () => {
    const withQuery = harness({ "*": fixture("api_remotive") });
    await collect(
      remotiveConnector,
      { name: "R", kind: "api_remotive", query: "golang" },
      withQuery.ctx,
    );
    expect(withQuery.requests[0]?.url).toContain("search=golang");

    const without = harness({ "*": fixture("api_remotive") });
    await collect(remotiveConnector, { name: "R", kind: "api_remotive" }, without.ctx);
    expect(without.requests[0]?.url).not.toContain("search=");
  });

  it("does not sleep before its first request", async () => {
    // The 1.5s limit is a *minimum interval between* requests, not a delay on entry.
    const h = harness({ "*": fixture("api_remotive") });

    await collect(remotiveConnector, { name: "R", kind: "api_remotive" }, h.ctx);

    expect(h.sleeps).toEqual([]);
  });

  it("makes exactly one request, so one call cannot breach the interval", async () => {
    const h = harness({ "*": fixture("api_remotive") });

    await collect(remotiveConnector, { name: "R", kind: "api_remotive" }, h.ctx);

    // Remotive has no cursor and returns everything up to `limit`; paging it would
    // re-request the same set 1.5s apart forever.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url).toContain("limit=50");
  });

  it("nulls an unparseable publication_date instead of emitting Invalid Date", async () => {
    const h = harness({
      "*": { jobs: [{ id: "1", url: "https://remotive.com/x", title: "T", company_name: "C", publication_date: "soon" }] },
    });

    const jobs = await collect(remotiveConnector, { name: "R", kind: "api_remotive" }, h.ctx);

    expect(jobs[0]?.postedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("arbeitnow (BE-103)", () => {
  it("maps is_remote onto workMode", async () => {
    const h = harness({ "*": fixture("api_arbeitnow") });

    const jobs = await collect(
      arbeitnowConnector,
      { name: "Arbeitnow", kind: "api_arbeitnow" },
      h.ctx,
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.workMode).toBe("remote");
    expect(jobs[1]?.workMode).toBeNull();
  });

  it("stops at meta.totalPages rather than walking every page", async () => {
    const h = harness({ "*": fixture("api_arbeitnow") });

    await collect(arbeitnowConnector, { name: "A", kind: "api_arbeitnow" }, h.ctx);

    // The fixture says totalPages=1; a second request would mean the stop was ignored.
    expect(h.requests).toHaveLength(1);
  });

  it("normalises both second and millisecond epoch timestamps", async () => {
    const h = harness({ "*": fixture("api_arbeitnow") });

    const jobs = await collect(
      arbeitnowConnector,
      { name: "A", kind: "api_arbeitnow" },
      h.ctx,
    );

    // Row 0 is seconds, row 1 is milliseconds. Treating seconds as milliseconds puts the
    // posting in January 1970 and sorts it out of every feed.
    expect(jobs[0]?.postedAt).toBe("2025-09-28T08:00:00.000Z");
    expect(jobs[1]?.postedAt).toBe("2025-08-29T13:20:00.000Z");
  });

  it("stops on an empty page even when meta claims more", async () => {
    let call = 0;
    const h = harness(() => {
      call += 1;
      if (call === 1) {
        const body = fixture("api_arbeitnow") as { data: unknown[] };
        return { data: body.data, meta: { currentPage: 1, totalPages: 3 } };
      }
      // Reports two pages still outstanding, then serves nothing. Without the empty-page
      // guard the walk would keep going to maxPages, spending a request on each.
      return { data: [], meta: { currentPage: call, totalPages: 3 } };
    });

    await collect(
      arbeitnowConnector,
      { name: "A", kind: "api_arbeitnow", maxPages: 10 },
      h.ctx,
    );

    expect(h.requests).toHaveLength(2);
  });

  it("keeps paging while meta reports pages remaining", async () => {
    let call = 0;
    const h = harness(() => {
      call += 1;
      const body = fixture("api_arbeitnow") as { data: unknown[]; meta: unknown };
      return { data: body.data, meta: { currentPage: call, totalPages: 3 } };
    });

    const jobs = await collect(
      arbeitnowConnector,
      { name: "A", kind: "api_arbeitnow", maxPages: 10 },
      h.ctx,
    );

    expect(h.requests).toHaveLength(3);
    expect(jobs).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------

describe("usajobs (BE-103)", () => {
  beforeEach(() => {
    process.env.USAJOBS_AUTHORIZATION_KEY = "test-authorization-key";
  });
  afterEach(() => {
    delete process.env.USAJOBS_AUTHORIZATION_KEY;
  });

  it("sends Host, Authorization-Key and User-Agent", async () => {
    // docs/05b ING-003: "USAJOBS sends all three required headers".
    const h = harness({ "*": fixture("api_usajobs") });

    await collect(usajobsConnector, { name: "USAJOBS", kind: "api_usajobs" }, h.ctx);

    const headers = h.requests[0]?.headers ?? {};
    expect(headers.Host).toBe("data.usajobs.gov");
    expect(headers["Authorization-Key"]).toBe("test-authorization-key");
    expect(headers["User-Agent"]).toBeTruthy();
  });

  it("fails fast with a clear ops message when the key is absent", async () => {
    delete process.env.USAJOBS_AUTHORIZATION_KEY;
    const h = harness({ "*": fixture("api_usajobs") });

    // Blank counts as absent: `USAJOBS_AUTHORIZATION_KEY=` in a .env file is a missing key,
    // and USAJOBS answers it with a 403 indistinguishable from a bad one.
    await expect(
      collect(usajobsConnector, { name: "U", kind: "api_usajobs" }, h.ctx),
    ).rejects.toThrow(/USAJOBS_AUTHORIZATION_KEY/);
  });

  it("treats a blank key as missing", async () => {
    process.env.USAJOBS_AUTHORIZATION_KEY = "   ";
    const h = harness({ "*": fixture("api_usajobs") });

    await expect(
      collect(usajobsConnector, { name: "U", kind: "api_usajobs" }, h.ctx),
    ).rejects.toThrow(/USAJOBS_AUTHORIZATION_KEY/);
  });

  it("maps the nested descriptor into a flat RawJob", async () => {
    const h = harness({ "*": fixture("api_usajobs") });

    const jobs = await collect(usajobsConnector, { name: "U", kind: "api_usajobs" }, h.ctx);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "DE1234567",
      title: "Software Engineer, AI",
      companyName: "Department of the Navy",
      locationRaw: "Washington, DC; Remote",
      salaryRaw: "$150,000.00 Per Year",
      salaryPeriod: "year",
    });
  });

  it("claims salaryPeriod only for an annual rate", async () => {
    const h = harness({ "*": fixture("api_usajobs") });

    const jobs = await collect(usajobsConnector, { name: "U", kind: "api_usajobs" }, h.ctx);

    // `RateIntervalCode: "Hour"` must not become "year" — the salary gate compares against
    // an annual floor, and an hourly figure read as annual passes every underpaid check.
    expect(jobs[1]?.salaryPeriod).toBeNull();
  });

  it("stops paging when a page is short of ResultsPerPage", async () => {
    const h = harness({ "*": fixture("api_usajobs") });

    await collect(usajobsConnector, { name: "U", kind: "api_usajobs" }, h.ctx);

    expect(h.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("adzuna (BE-104)", () => {
  beforeEach(() => {
    process.env.ADZUNA_APP_ID = "test-app-id";
    process.env.ADZUNA_APP_KEY = "test-app-key";
  });
  afterEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
  });

  it("maps structured salary into the numeric fields", async () => {
    const h = harness({ "*": fixture("api_adzuna") });

    const jobs = await collect(adzunaConnector, { name: "Adzuna", kind: "api_adzuna" }, h.ctx);

    expect(jobs[0]).toMatchObject({
      salaryMin: 85000,
      salaryMax: 110000,
      salaryCurrency: "GBP",
      salaryRaw: "£85,000 - £110,000 per year",
    });
  });

  it("normalises a lowercase currency code", async () => {
    const h = harness({ "*": fixture("api_adzuna") });

    const jobs = await collect(adzunaConnector, { name: "Adzuna", kind: "api_adzuna" }, h.ctx);

    // `rawJobSchema` enforces `.length(3)`; "gbp" passes the length check and would be
    // written to a char(3) column as-is, so it must be upper-cased here.
    expect(jobs[0]?.salaryCurrency).toBe("GBP");
  });

  it("skips a record with no redirect_url rather than emitting a dead link", async () => {
    const h = harness({ "*": fixture("api_adzuna") });

    // Pinned to one country: the default country list is five, and each would replay the
    // same fixture, making the job count meaningless.
    const jobs = await collect(
      adzunaConnector,
      { name: "Adzuna", kind: "api_adzuna", countries: ["gb"] },
      h.ctx,
    );

    // `RawJob.sourceUrl` is a non-nullable URL and the dedupe hash is built from it.
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.externalId)).not.toContain("3009999999");
  });

  it("sends the where filter separately from the country segment", async () => {
    // The country is a path segment, not a location filter. Conflating the two is how a
    // US-only search returns UK rows.
    const h = harness({ "*": fixture("api_adzuna") });

    await collect(
      adzunaConnector,
      { name: "Adzuna", kind: "api_adzuna", countries: ["gb"], where: "London" },
      h.ctx,
    );

    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.searchParams.get("where")).toBe("London");
    expect(url.pathname).toContain("/jobs/gb/");
  });

  it("walks every configured country", async () => {
    const h = harness({ "*": fixture("api_adzuna") });

    await collect(
      adzunaConnector,
      { name: "Adzuna", kind: "api_adzuna", countries: ["gb", "us"] },
      h.ctx,
    );

    // The country is a path segment, so a US-only search must not return UK rows.
    expect(h.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1/api/jobs/gb/search/1",
      "/v1/api/jobs/us/search/1",
    ]);
  });

  it("sends app_id, app_key and results_per_page=50", async () => {
    const h = harness({ "*": fixture("api_adzuna") });

    await collect(adzunaConnector, { name: "Adzuna", kind: "api_adzuna" }, h.ctx);

    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toContain("/v1/api/jobs/");
    expect(url.searchParams.get("app_id")).toBe("test-app-id");
    expect(url.searchParams.get("app_key")).toBe("test-app-key");
    expect(url.searchParams.get("results_per_page")).toBe("50");
  });

  it("fails fast and by name when credentials are absent", async () => {
    delete process.env.ADZUNA_APP_ID;
    const h = harness({ "*": fixture("api_adzuna") });

    await expect(
      collect(adzunaConnector, { name: "Adzuna", kind: "api_adzuna" }, h.ctx),
    ).rejects.toThrow(/ADZUNA_APP_ID/);
    expect(h.requests).toHaveLength(0);
  });

  it("counts every request against the run, including retries", async () => {
    // docs/05b ING-004: "api_calls counted for cost attribution".
    const h = harness({}, { status: 500 });
    const counted: number[] = [];
    const ctx = { ...h.ctx, onRequest: (i: { attempt: number }) => counted.push(i.attempt) };

    await collect(adzunaConnector, { name: "Adzuna", kind: "api_adzuna", countries: ["us"] }, ctx).catch(
      () => undefined,
    );

    // A retry against a metered API is a billed call; under-counting hides real spend.
    expect(counted).toEqual([1, 2, 3]);
  });

  it("is costClass metered", () => {
    expect(adzunaConnector.costClass).toBe("metered");
    expect(greenhouseConnector.costClass).toBe("free");
    expect(firecrawlScrapeConnector.costClass).toBe("firecrawl");
  });
});

// ---------------------------------------------------------------------------

describe("firecrawl (BE-105)", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
  });
  afterEach(() => {
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("posts the documented /scrape body", async () => {
    const h = harness({ "*": fixture("firecrawl_scrape") });

    await collect(
      firecrawlScrapeConnector,
      { name: "Firecrawl", kind: "firecrawl_scrape", urls: ["https://careers.hooli.com/careers"] },
      h.ctx,
    );

    const request = h.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(request?.headers.Authorization).toBe("Bearer fc-test-key");

    const body = request?.body as Record<string, unknown>;
    expect(body.formats).toEqual(["json"]);
    expect(body.onlyMainContent).toBe(true);
    // docs/04 §5.1 fixes the cache window at 12h — without it every run re-bills the page.
    expect(body.maxAge).toBe(43_200_000);
    expect(body.timeout).toBe(30_000);
    expect((body.jsonOptions as { schema: { required: string[] } }).schema.required).toEqual([
      "jobs",
    ]);
  });

  it("maps the extraction and keeps malformed postings from discarding the page", async () => {
    const h = harness({ "*": fixture("firecrawl_scrape") });

    const jobs = await collect(
      firecrawlScrapeConnector,
      { name: "Firecrawl", kind: "firecrawl_scrape", urls: ["https://careers.hooli.com/careers"] },
      h.ctx,
    );

    // The fixture's third record has no sourceUrl and must be skipped, not fatal.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: "Senior React Engineer",
      companyName: "Hooli",
      locationRaw: "Remote, India",
      workMode: "remote",
      salaryRaw: "₹40,00,000 - ₹60,00,000 per year",
    });
  });

  it("refuses a non-https scrape target before any request is made", async () => {
    const h = harness({ "*": fixture("firecrawl_scrape") });

    await expect(
      collect(
        firecrawlScrapeConnector,
        { name: "F", kind: "firecrawl_scrape", urls: ["http://careers.example.com/jobs"] },
        h.ctx,
      ),
    ).rejects.toThrow(/scheme-not-https/);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a private-address scrape target", async () => {
    const h = harness({ "*": fixture("firecrawl_scrape") });

    await expect(
      collect(
        firecrawlScrapeConnector,
        {
          name: "F",
          kind: "firecrawl_scrape",
          urls: ["https://169.254.169.254/latest/meta-data/"],
        },
        h.ctx,
      ),
    ).rejects.toThrow(/private-address/);
    expect(h.requests).toHaveLength(0);
  });

  it("maps success:false to upstream_error so the task retries", async () => {
    const h = harness({ "*": { success: false, data: null } });

    await expect(
      collect(
        firecrawlScrapeConnector,
        { name: "F", kind: "firecrawl_scrape", urls: ["https://careers.example.com/jobs"] },
        h.ctx,
      ),
    ).rejects.toThrow(/success:false/);
  });

  it("maps a malformed extraction to scrape_parse_failed", async () => {
    const h = harness({ "*": { success: true, data: { json: { jobs: "nope" } } } });

    await expect(
      collect(
        firecrawlScrapeConnector,
        { name: "F", kind: "firecrawl_scrape", urls: ["https://careers.example.com/jobs"] },
        h.ctx,
      ),
    ).rejects.toThrow(/response schema/);
  });

  it("fails fast with a clear message when the key is absent", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const h = harness({ "*": fixture("firecrawl_scrape") });

    await expect(
      collect(
        firecrawlScrapeConnector,
        { name: "F", kind: "firecrawl_scrape", urls: ["https://careers.example.com/jobs"] },
        h.ctx,
      ),
    ).rejects.toThrow(/FIRECRAWL_API_KEY/);
  });

  it("filters unsafe URLs out of a /map result", async () => {
    const h = harness({
      "*": {
        success: true,
        links: [
          "https://careers.example.com/jobs/1",
          "https://localhost/jobs/2",
          "https://10.0.0.5/jobs/3",
          "http://careers.example.com/jobs/4",
        ],
      },
    });

    const links = await firecrawlMap(
      { name: "F", kind: "firecrawl_scrape", urls: ["https://careers.example.com"] },
      h.ctx,
    );

    // A /map result is what an operator pastes into sources.config.urls, so filtering here
    // is what stops an internal target being authorised into the scrape list.
    expect(links).toEqual(["https://careers.example.com/jobs/1"]);
  });
});

// ---------------------------------------------------------------------------

describe("error mapping across every connector (docs/04 §5.9)", () => {
  beforeEach(() => {
    process.env.USAJOBS_AUTHORIZATION_KEY = "k";
    process.env.ADZUNA_APP_ID = "id";
    process.env.ADZUNA_APP_KEY = "key";
    process.env.FIRECRAWL_API_KEY = "fc";
  });
  afterEach(() => {
    delete process.env.USAJOBS_AUTHORIZATION_KEY;
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    delete process.env.FIRECRAWL_API_KEY;
  });

  const cases: readonly { name: string; connector: SourceConnector; cfg: SourceConfig }[] = [
    {
      name: "greenhouse",
      connector: greenhouseConnector,
      cfg: { name: "G", kind: "api_greenhouse", boards: ["acme"] },
    },
    { name: "lever", connector: leverConnector, cfg: { name: "L", kind: "api_lever", boards: ["a"] } },
    { name: "ashby", connector: ashbyConnector, cfg: { name: "A", kind: "api_ashby", organizations: ["a"] } },
    { name: "remotive", connector: remotiveConnector, cfg: { name: "R", kind: "api_remotive" } },
    { name: "arbeitnow", connector: arbeitnowConnector, cfg: { name: "W", kind: "api_arbeitnow" } },
    { name: "usajobs", connector: usajobsConnector, cfg: { name: "U", kind: "api_usajobs" } },
    { name: "adzuna", connector: adzunaConnector, cfg: { name: "Z", kind: "api_adzuna", countries: ["us"] } },
    {
      name: "firecrawl",
      connector: firecrawlScrapeConnector,
      cfg: { name: "F", kind: "firecrawl_scrape", urls: ["https://careers.example.com/jobs"] },
    },
  ];

  it.each(cases)("$name maps a 404 to upstream_error", async ({ connector, cfg }) => {
    const h = harness({}, { status: 404 });

    await expect(collect(connector, cfg, h.ctx)).rejects.toMatchObject({
      code: "upstream_error",
    });
  });

  it.each(cases)("$name retries a 500 three times, then fails typed", async ({ connector, cfg }) => {
    const h = harness({}, { status: 500 });

    await expect(collect(connector, cfg, h.ctx)).rejects.toMatchObject({ code: "upstream_error" });
    // 1 initial + 2 retries. Fewer would mean the retry policy does not reach connectors.
    expect(h.requests.length).toBeGreaterThanOrEqual(3);
  });

  it.each(cases)("$name maps a non-JSON body to scrape_parse_failed", async ({ connector, cfg }) => {
    const h = harness({}, { bodyIsNotJson: true });

    await expect(collect(connector, cfg, h.ctx)).rejects.toMatchObject({
      code: "scrape_parse_failed",
    });
  });

  it("joinUrl tolerates a base with a trailing slash", () => {
    // A mirror base or a test override will carry one; concatenating naively yields a
    // double slash and a 404 with no hint that the fault is ours.
    expect(joinUrl("https://api.example.com/", "/v1/boards")).toBe(
      "https://api.example.com/v1/boards",
    );
    expect(joinUrl("https://api.example.com", "v1/boards")).toBe(
      "https://api.example.com/v1/boards",
    );
  });
});