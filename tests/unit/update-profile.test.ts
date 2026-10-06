/**
 * update-profile.test.ts — unit tests for the ONB-002 Server Action.
 *
 * Pins the contract: `requireUser()` resolves the caller, the write uses the
 * caller's JWT (anon key + Bearer token), validation and database errors map
 * to the typed error shape, and a Zod failure returns `VALIDATION_ERROR`.
 * `AppError` throws (unauthenticated / forbidden) and propagates to the
 * framework rather than being swallowed.
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

import { updateProfile } from "@/app/api/actions/profile/update-profile";
import { AppError } from "@/lib/errors";

beforeEach(() => {
  getUserMock.mockReset();
  getSessionMock.mockReset();
  mockFrom.mockReset();
  createClientMock.mockReset();
  createClientMock.mockReturnValue({ from: mockFrom });
});

function profileChain(result: { data: unknown; error: unknown }) {
  return {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
  };
}

describe("updateProfile", () => {
  it("requires a verified session — no user → throws unauthenticated", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(updateProfile({ targetTitles: ["Engineer"] })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("writes only the supplied fields under the caller's identity", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
    });
    mockFrom.mockReturnValue(profileChain({ data: { id: "u1", target_titles: ["Engineer"] }, error: null }));

    const res = await updateProfile({ targetTitles: ["Engineer"] });

    expect(res.ok).toBe(true);
    expect(createClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
      expect.any(Object),
    );
    expect(mockFrom).toHaveBeenCalledWith("profiles");
  });

  it("returns VALIDATION_ERROR for bad input", async () => {
    const res = await updateProfile({ targetTitles: 123 } as unknown as { targetTitles: string[] });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("returns DATABASE_ERROR when the update fails", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
    });
    mockFrom.mockReturnValue(profileChain({ data: null, error: { message: "rls denied" } }));

    const res = await updateProfile({ targetTitles: ["Engineer"] });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("DATABASE_ERROR");
  });

  it("propagates AppError (unauthenticated) rather than swallowing it", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(updateProfile({ targetTitles: ["Engineer"] })).rejects.toBeInstanceOf(AppError);
  });
});