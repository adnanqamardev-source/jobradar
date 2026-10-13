/**
 * feed-actions.test.ts — the feed's three Server Actions (BE-305, FED-002).
 *
 * Pins the contract that matters:
 *
 *   1. `requireUser()` before any database access — no session → AppError
 *      propagates (the caller maps it to a status), never a swallowed 500.
 *   2. Zod failure → typed `validation_failed`, not a throw.
 *   3. Save/Dismiss are idempotent: an existing event row means no insert.
 *   4. The writes are scoped to the caller — `user_id` comes from the session,
 *      never from the input (docs/03 §2.2).
 *   5. markApplied snapshots the job (X-16) and writes the initial
 *      `application_events` row with `from_stage = null` (TRK-001).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: () => [], set: () => undefined }),
}));

const getUserMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: getUserMock, getSession: getSessionMock },
  }),
}));

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { saveJob } from "@/app/api/actions/feed/save-job";
import { dismissJob } from "@/app/api/actions/feed/dismiss-job";
import { markApplied } from "@/app/api/actions/feed/mark-applied";
import { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Client double
// ---------------------------------------------------------------------------

interface ClientOpts {
  /** The existing job_events row for (user, job, event), if any. */
  existingEvent?: { id: string } | null;
  /**
   * Model a race that left duplicate `job_events` rows: two clicks pass the
   * existence check together and both insert, because the PK includes `at`.
   */
  duplicateEvents?: boolean;
  /** The job row for the snapshot, or null for "not found". */
  job?: Record<string, unknown> | null;
  insertError?: { message: string } | null;
  upsertError?: { message: string } | null;
  /** Whether the upsert returns the created row (false models an ignored duplicate). */
  upsertCreatesRow?: boolean;
  /**
   * Whether an initial `application_events` row already exists (for repair
   * idempotency tests).
   */
  existingApplicationEvent?: boolean;
  eventInsertError?: { message: string } | null;
}

function makeClient(opts: ClientOpts) {
  const eqFilters: [string, unknown][] = [];
  const inserts: Record<string, unknown>[] = [];
  const eventInserts: Record<string, unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];

  const existingRow = opts.existingEvent === undefined ? null : opts.existingEvent;
  const existingArray = opts.duplicateEvents && existingRow ? [existingRow, { id: "evt-1b" }] : existingRow ? [existingRow] : [];

  /**
   * A filter builder that accepts `eq`/`is` in any order and any count, so the
   * double cannot drift from the production call chain (the previous
   * hand-rolled one only exposed `is` one level down, and a reorder turned into
   * a TypeError that surfaced as `internal_error`).
   */
  function filter(result: () => { data: unknown; error: { message: string } | null }) {
    // Mirrors supabase-js: the builder is both awaitable and chainable, and the
    // terminal that was called (`maybeSingle`/`single`) decides whether the
    // awaited `data` is a row or an array. Modelling that is the whole point —
    // an earlier version hard-wired `.limit()` to a terminal, so
    // `.limit(1).maybeSingle()` was simply missing and failed as a TypeError.
    function build(mode: "none" | "maybeSingle" | "single"): Record<string, unknown> {
      const value = () => {
        const { data, error } = result();
        if (mode === "none") return { data, error };
        const row = Array.isArray(data) ? (data[0] ?? null) : data;
        // `.single()` is PGRST116 on zero rows; `.maybeSingle()` is not. The
        // difference is the whole reason the markApplied test below exists, so
        // a double that conflates them would make that test unfalsifiable.
        if (mode === "single" && row === null) {
          return {
            data: null,
            error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
          };
        }
        return { data: row, error };
      };
      return {
        eq: (column: string, v: unknown) => {
          eqFilters.push([column, v]);
          return build(mode);
        },
        is: (column: string, v: unknown) => {
          eqFilters.push([column, v]);
          return build(mode);
        },
        limit: () => build(mode),
        maybeSingle: () => build("maybeSingle"),
        single: () => build("single"),
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(value()).then(onFulfilled, onRejected),
      };
    }
    return build("none");
  }

  const from = (table: string) => {
    if (table === "job_events") {
      return {
        select: () => filter(() => ({ data: existingArray, error: null })),
        insert: (values: Record<string, unknown>) => {
          inserts.push(values);
          return { error: opts.insertError ?? null };
        },
      };
    }
    if (table === "jobs") {
      return {
        select: () => filter(() => ({ data: opts.job ?? null, error: null })),
      };
    }
    if (table === "applications") {
      return {
        select: () => filter(() => ({ data: { id: "app-1" }, error: null })),
        upsert: (values: Record<string, unknown>) => {
          upserts.push(values);
          return {
            select: () => filter(() => ({
              data: opts.upsertError || opts.upsertCreatesRow === false ? null : { id: "app-1" },
              error: opts.upsertError ?? null,
            })),
          };
        },
      };
    }
    if (table === "application_events") {
      return {
        select: () =>
          filter(() => ({ data: opts.existingApplicationEvent ? { id: "evt-0" } : null, error: null })),
        insert: (values: Record<string, unknown>) => {
          eventInserts.push(values);
          return { error: opts.eventInsertError ?? null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { from, eqFilters, inserts, eventInserts, upserts };
}

/** Session helpers — the actions resolve the caller the same way. */
function signedIn(userId = "u1") {
  getUserMock.mockResolvedValue({ data: { user: { id: userId, app_metadata: {} } }, error: null });
  getSessionMock.mockResolvedValue({ data: { session: { access_token: "user-jwt" } } });
}

function signedOut() {
  getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
  getSessionMock.mockResolvedValue({ data: { session: null } });
}

function withClient(client: { from: (table: string) => unknown }) {
  createClientMock.mockReturnValue({ from: client.from });
}

const JOB_ID = "3f2a9c1e-0000-4000-8000-000000000001";

const SNAPSHOT_JOB = {
  title: "Senior Frontend Engineer",
  company_name: "Acme Corp",
  company_domain: "acme.example",
  location_raw: "Remote (US)",
  salary_min: 160000,
  salary_max: 190000,
  salary_currency: "USD",
  salary_period: "year",
  posted_at: "2026-10-01T00:00:00.000Z",
  seniority: "senior",
  employment_type: "full_time",
  work_mode: "remote",
  skills: ["react"],
  source_url: "https://acme.example/jobs/123",
};

beforeEach(() => {
  getUserMock.mockReset();
  getSessionMock.mockReset();
  createClientMock.mockReset();
  createClientMock.mockClear();
});

// ---------------------------------------------------------------------------
// saveJob
// ---------------------------------------------------------------------------

describe("saveJob", () => {
  it("propagates unauthenticated instead of writing", async () => {
    signedOut();
    const client = makeClient({});
    withClient(client);

    await expect(saveJob({ jobId: JOB_ID })).rejects.toBeInstanceOf(AppError);
    expect(client.inserts).toHaveLength(0);
  });

  it("returns validation_failed for a non-uuid jobId", async () => {
    signedIn();
    const res = await saveJob({ jobId: "not-a-uuid" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("validation_failed");
  });

  it("inserts a save event scoped to the caller", async () => {
    signedIn();
    const client = makeClient({});
    withClient(client);

    const res = await saveJob({ jobId: JOB_ID });

    expect(res).toEqual({ ok: true, saved: true });
    expect(client.inserts).toHaveLength(1);
    expect(client.inserts[0]).toMatchObject({ user_id: "u1", job_id: JOB_ID, event: "save" });
    expect(client.eqFilters).toContainEqual(["user_id", "u1"]);
    expect(client.eqFilters).toContainEqual(["job_id", JOB_ID]);
    expect(client.eqFilters).toContainEqual(["event", "save"]);
  });

  it("is idempotent — an existing save event means no insert", async () => {
    signedIn();
    const client = makeClient({ existingEvent: { id: "evt-1" } });
    withClient(client);

    const res = await saveJob({ jobId: JOB_ID });

    expect(res.ok).toBe(true);
    expect(client.inserts).toHaveLength(0);
  });

  it("treats several duplicate event rows as saved, not an error", async () => {
    // A double-click straddling the check/insert leaves two rows (the PK
    // includes `at`). `maybeSingle()` on two rows is a PostgREST error, so the
    // read must be `.limit(1)`.
    signedIn();
    const client = makeClient({ existingEvent: { id: "evt-1" }, duplicateEvents: true });
    withClient(client);

    const res = await saveJob({ jobId: JOB_ID });

    expect(res).toEqual({ ok: true, saved: true });
    expect(client.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dismissJob
// ---------------------------------------------------------------------------

describe("dismissJob", () => {
  it("propagates unauthenticated instead of writing", async () => {
    signedOut();
    const client = makeClient({});
    withClient(client);

    await expect(dismissJob({ jobId: JOB_ID })).rejects.toBeInstanceOf(AppError);
    expect(client.inserts).toHaveLength(0);
  });

  it("inserts a dismiss event scoped to the caller", async () => {
    signedIn();
    const client = makeClient({});
    withClient(client);

    const res = await dismissJob({ jobId: JOB_ID });

    expect(res).toEqual({ ok: true, dismissed: true });
    expect(client.inserts[0]).toMatchObject({ user_id: "u1", job_id: JOB_ID, event: "dismiss" });
  });

  it("is idempotent — an existing dismiss event means no insert", async () => {
    signedIn();
    const client = makeClient({ existingEvent: { id: "evt-2" } });
    withClient(client);

    const res = await dismissJob({ jobId: JOB_ID });

    expect(res.ok).toBe(true);
    expect(client.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// markApplied
// ---------------------------------------------------------------------------

describe("markApplied", () => {
  it("propagates unauthenticated instead of writing", async () => {
    signedOut();
    const client = makeClient({});
    withClient(client);

    await expect(
      markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(client.upserts).toHaveLength(0);
  });

  it("returns validation_failed for a bad payload", async () => {
    signedIn();
    const res = await markApplied({ jobId: JOB_ID, appliedAt: "not-a-date" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("validation_failed");
  });

  it("returns not_found when the job does not exist", async () => {
    signedIn();
    const client = makeClient({ job: null });
    withClient(client);

    const res = await markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
    expect(client.upserts).toHaveLength(0);
  });

  it("snapshots the job and writes the initial event (TRK-001, X-16)", async () => {
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB });
    withClient(client);

    const res = await markApplied({
      jobId: JOB_ID,
      appliedAt: "2026-10-11T00:00:00.000Z",
      notes: "Applied via company site",
    });

    expect(res).toEqual({ ok: true, applied: true, applicationId: "app-1" });
    expect(client.upserts).toHaveLength(1);
    const [upsert] = client.upserts;
    if (upsert === undefined) throw new Error("expected an application upsert");
    expect(upsert).toMatchObject({
      user_id: "u1",
      job_id: JOB_ID,
      stage: "applied",
      source: "manual",
      applied_at: "2026-10-11T00:00:00.000Z",
      notes: "Applied via company site",
    });
    // X-16: the snapshot carries the display fields, not the whole row.
    expect(upsert.job_snapshot).toMatchObject({
      title: "Senior Frontend Engineer",
      company_name: "Acme Corp",
      salary_max: 190000,
      source_url: "https://acme.example/jobs/123",
    });
    // TRK-001: the initial event row has from_stage = null.
    expect(client.eventInserts).toHaveLength(1);
    expect(client.eventInserts[0]).toMatchObject({
      application_id: "app-1",
      from_stage: null,
      to_stage: "applied",
    });
  });

  it("resolves the id through a second read when the upsert ignores the duplicate", async () => {
    // PostgREST's `resolution=ignore-duplicates` drops the conflicting row from
    // the returned representation, so `.single()` on the upsert is PGRST116 —
    // the action must not treat a second apply as a failure.
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB, upsertCreatesRow: false });
    withClient(client);

    const res = await markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" });

    expect(res).toEqual({ ok: true, applied: true, applicationId: "app-1" });
    expect(client.eqFilters).toContainEqual(["user_id", "u1"]);
    expect(client.eqFilters).toContainEqual(["job_id", JOB_ID]);
  });

  it("does not duplicate the initial event when it already exists", async () => {
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB, existingApplicationEvent: true });
    withClient(client);

    const res = await markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" });

    expect(res.ok).toBe(true);
    expect(client.eventInserts).toHaveLength(0);
  });

  it("repairs a missing initial event on an already-applied job", async () => {
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB, upsertCreatesRow: false });
    withClient(client);

    const res = await markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" });

    expect(res.ok).toBe(true);
    expect(client.eventInserts).toHaveLength(1);
    expect(client.eventInserts[0]).toMatchObject({ application_id: "app-1", from_stage: null, to_stage: "applied" });
  });

  it("writes the follow-up date JOB-003 collects", async () => {
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB });
    withClient(client);

    const res = await markApplied({
      jobId: JOB_ID,
      appliedAt: "2026-10-11T00:00:00.000Z",
      nextActionAt: "2026-10-25T00:00:00.000Z",
    });

    expect(res.ok).toBe(true);
    const [upsert] = client.upserts;
    if (upsert === undefined) throw new Error("expected an application upsert");
    expect(upsert).toMatchObject({ next_action_at: "2026-10-25T00:00:00.000Z" });
  });

  it("writes a null follow-up date when the dialog left it blank", async () => {
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB });
    withClient(client);

    await markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" });

    const [upsert] = client.upserts;
    if (upsert === undefined) throw new Error("expected an application upsert");
    expect(upsert).toMatchObject({ next_action_at: null });
  });

  it("returns internal_error when the application upsert fails", async () => {
    signedIn();
    const client = makeClient({ job: SNAPSHOT_JOB, upsertError: { message: "rls denied" } });
    withClient(client);

    const res = await markApplied({ jobId: JOB_ID, appliedAt: "2026-10-11T00:00:00.000Z" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal_error");
  });
});
