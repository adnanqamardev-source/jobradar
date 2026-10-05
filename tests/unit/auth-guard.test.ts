/**
 * auth-guard.test.ts — the resume actions' access-control seam (BE-302).
 *
 * History: until BE-302 landed, `requireUser()` and `createUserClient()` existed only
 * to *refuse* — the pinned behaviour was "throws rather than fall back to the
 * service-role client". That refusal is what kept a green-looking path straight past
 * the `resumes_*_own` RLS policies from being wired up.
 *
 * BE-302 is now implemented, so the pins move to the property that actually
 * matters:
 *   - no verifiable session  → reject (`unauthenticated`), never a guessed identity;
 *   - a user-scoped client   → built from the anon key + the caller's JWT, never the
 *                              service-role key.
 *
 * `@/lib/env`, `next/headers` and `@supabase/ssr` are mocked: this is a unit test of
 * the decision logic, not of Supabase. The env mock keeps the lazy `await import`
 * inside the module under test from throwing on missing variables.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    getAll: () => [],
    set: () => undefined,
  }),
}));

const getUserMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: getUserMock,
      getSession: getSessionMock,
    },
  }),
}));

const createClientMock = vi.hoisted(() => vi.fn(() => ({ from: () => undefined, auth: {} })));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { requireUser, requireAdmin } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";

beforeEach(() => {
  getUserMock.mockReset();
  getSessionMock.mockReset();
});

describe("requireUser", () => {
  it("rejects with unauthenticated when there is no verified user", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(requireUser()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects when the session has no token, even with a verified user", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(requireUser()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("resolves to id, token and role from the verified session", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: { role: "admin" } } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "tok-123" } },
    });

    await expect(requireUser()).resolves.toEqual({
      id: "u1",
      accessToken: "tok-123",
      role: "admin",
    });
  });

  it("treats a missing app_metadata role as a regular user", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u2", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "tok-xyz" } },
    });

    await expect(requireUser()).resolves.toMatchObject({ role: "user" });
  });
});

describe("requireAdmin", () => {
  it("rejects non-admins with forbidden", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u2", app_metadata: { role: "user" } } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "tok-xyz" } },
    });

    await expect(requireAdmin()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("resolves for admins", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: { role: "admin" } } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "tok-123" } },
    });

    await expect(requireAdmin()).resolves.toMatchObject({ id: "u1", role: "admin" });
  });
});

describe("createUserClient", () => {
  it("returns a client without throwing, scoped by the caller's token", async () => {
    const client = await createUserClient("user-jwt");
    expect(typeof client.from).toBe("function");
    expect(typeof client.auth).toBe("object");
  });

  it("builds the client with the anon key and the caller's JWT, never the service key", async () => {
    createClientMock.mockClear();
    await createUserClient("user-jwt");

    expect(createClientMock).toHaveBeenCalledOnce();
    const [url, key, options] = createClientMock.mock.calls[0] as unknown as [
      string,
      string,
      { global: { headers: { Authorization: string } } },
    ];
    expect(url).toBe("https://example.supabase.co");
    expect(key).toBe("anon-key");
    expect(key).not.toMatch(/service/i);
    expect(options.global.headers.Authorization).toBe("Bearer user-jwt");
  });
});
