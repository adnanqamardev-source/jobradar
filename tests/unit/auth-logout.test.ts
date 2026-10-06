/**
 * logout route tests — the endpoint must end the session server-side, not just locally.
 *
 * The contract (docs/03 §2.2): `signOut()` is called so the refresh token is revoked server-side,
 * and the SSR client clears its own cookies. A logout that only cleared cookies would leave a
 * usable refresh token for its full 30-day lifetime.
 *
 * Supabase and `next/headers` are mocked — this tests the route's contract, not GoTrue.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: () => [], set: () => undefined }),
}));

const signOut = vi.fn(() => Promise.resolve({ error: null as Error | null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { signOut } }),
}));

import { POST } from "@/app/api/auth/logout/route";

beforeEach(() => {
  signOut.mockReset();
  signOut.mockImplementation(() => Promise.resolve({ error: null }));
});

function jsonReq(): Request {
  return new Request("https://jobradar.test/api/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/auth/logout", () => {
  it("calls server-side signOut, not a local-only cookie clear", async () => {
    const res = await POST(jsonReq());

    expect(signOut).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 500 JSON when server-side sign-out fails", async () => {
    signOut.mockResolvedValueOnce({ error: new Error("gotrue unreachable") });

    const res = await POST(jsonReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("redirects a form post to /login on success", async () => {
    const form = new Request("https://jobradar.test/api/auth/logout", { method: "POST" });

    const res = await POST(form);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobradar.test/login?signed_out=1");
  });

  it("redirects a failed form post back with an errormarker", async () => {
    signOut.mockResolvedValueOnce({ error: new Error("gotrue unreachable") });
    const form = new Request("https://jobradar.test/api/auth/logout", { method: "POST" });

    const res = await POST(form);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobradar.test/login?error=signout_failed");
  });
});