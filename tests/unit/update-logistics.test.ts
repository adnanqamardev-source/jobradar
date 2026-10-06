/**
 * update-logistics.test.ts — unit tests for the ONB-004 Server Action.
 *
 * The pin that matters here is the three-state salary floor. A previous revision
 * guarded `minSalary !== undefined && minSalary !== null`, which silently dropped
 * the only input that can clear a floor — so a user could set a minimum salary and
 * never remove it. ONB-004 requires `NULL` = no floor, so `null` must write `NULL`.
 *
 * This file also pins the `pick()` allow-list (the action's whole contract with the
 * DB): only supplied columns are written, and omitted columns are left untouched.
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

const mockFrom = vi.hoisted(() => vi.fn());
const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { updateLogistics } from "@/app/api/actions/profile/update-logistics";

/** Captures the payload handed to `.update()`. */
let updatePayload: Record<string, unknown> | undefined;

beforeEach(() => {
  getUserMock.mockReset();
  getSessionMock.mockReset();
  mockFrom.mockReset();
  createClientMock.mockReset();
  updatePayload = undefined;
  createClientMock.mockReturnValue({ from: mockFrom });
});

function signIn() {
  getUserMock.mockResolvedValue({
    data: { user: { id: "u1", app_metadata: {} } },
    error: null,
  });
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: "user-jwt" } },
  });
}

/** A `profiles` update chain that records its payload. */
function profileUpdateChain(result: { data: unknown; error: unknown }) {
  const update = vi.fn((payload: Record<string, unknown>) => {
    updatePayload = payload;
    return {
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(result),
        }),
      }),
    };
  });
  return { update };
}

describe("updateLogistics — salary floor", () => {
  it("writes a positive floor as given", async () => {
    signIn();
    mockFrom.mockReturnValue(profileUpdateChain({ data: { id: "u1" }, error: null }));

    const res = await updateLogistics({ minSalary: 120000 });

    expect(res.ok).toBe(true);
    expect(updatePayload).toEqual({ min_salary: 120000 });
  });

  it("clears the floor when minSalary is explicitly null", async () => {
    signIn();
    mockFrom.mockReturnValue(profileUpdateChain({ data: { id: "u1" }, error: null }));

    const res = await updateLogistics({ minSalary: null });

    expect(res.ok).toBe(true);
    // The regression: this key was absent entirely before the fix.
    expect(updatePayload).toEqual({ min_salary: null });
    expect(updatePayload).toHaveProperty("min_salary");
  });

  it("leaves min_salary untouched when minSalary is omitted", async () => {
    signIn();
    mockFrom.mockReturnValue(profileUpdateChain({ data: { id: "u1" }, error: null }));

    const res = await updateLogistics({ city: "Bengaluru" });

    expect(res.ok).toBe(true);
    expect(updatePayload).toEqual({ city: "Bengaluru" });
    expect(updatePayload).not.toHaveProperty("min_salary");
  });

  it("rejects 0 — the schema is .positive(), so 'no floor' is null, never 0", async () => {
    const res = await updateLogistics({ minSalary: 0 });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a currency that is not 3 characters", async () => {
    const res = await updateLogistics({ salaryCurrency: "DOLLAR" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unknown salary period", async () => {
    const res = await updateLogistics({
      salaryPeriod: "fortnight",
    } as unknown as { salaryPeriod: "year" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("updateLogistics — guard and column map", () => {
  it("requires a verified session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(updateLogistics({ city: "Bengaluru" })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("rejects an empty payload as NO_FIELDS", async () => {
    signIn();

    const res = await updateLogistics({});

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NO_FIELDS");
  });

  it("maps camelCase input to snake_case columns", async () => {
    signIn();
    mockFrom.mockReturnValue(profileUpdateChain({ data: { id: "u1" }, error: null }));

    const res = await updateLogistics({
      workModes: ["remote", "hybrid"],
      hybridDaysMax: 2,
      countryCode: "IN",
      timeZone: "Asia/Kolkata",
      salaryCurrency: "INR",
      salaryPeriod: "year",
      visaRequired: true,
    });

    expect(res.ok).toBe(true);
    expect(updatePayload).toEqual({
      work_modes: ["remote", "hybrid"],
      hybrid_days_max: 2,
      country_code: "IN",
      time_zone: "Asia/Kolkata",
      salary_currency: "INR",
      salary_period: "year",
      visa_required: true,
    });
  });

  it("returns DATABASE_ERROR when the update fails", async () => {
    signIn();
    mockFrom.mockReturnValue(profileUpdateChain({ data: null, error: { message: "rls" } }));

    const res = await updateLogistics({ city: "Bengaluru" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("DATABASE_ERROR");
  });
});