/**
 * auth-routes.test.ts — the BE-301 login endpoints.
 *
 * Both routes are thin: HTML form in → redirect out, JSON in → JSON out, and the
 * Supabase SSR client sees the expected arguments. The provider SDK is mocked —
 * what matters is the contract (email validation, redirect targets, that the
 * OTP/OAuth calls fire with the right emailRedirectTo), not GoTrue itself.
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

const signInWithOtp = vi.fn(() => Promise.resolve({ error: null }));
const signInWithOAuth = vi.fn(() =>
  Promise.resolve({
    data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
    error: null,
  }),
);

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { signInWithOtp, signInWithOAuth } }),
}));

import { POST as magicLinkPOST } from "@/app/api/auth/magic-link/route";
import { POST as googlePOST } from "@/app/api/auth/google/route";

beforeEach(() => {
  signInWithOtp.mockClear();
  signInWithOAuth.mockClear();
});

function formRequest(email: string): Request {
  const body = new URLSearchParams({ email });
  return new Request("https://jobradar.test/api/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("POST /api/auth/magic-link", () => {
  it("redirects a form post back to /login?sent=1 after sending the link", async () => {
    const res = await magicLinkPOST(formRequest("user@example.com"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobradar.test/login?sent=1");
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: { emailRedirectTo: "https://jobradar.test/auth/callback" },
    });
  });

  it("rejects an invalid email on a form post with a redirect, not a 500", async () => {
    const res = await magicLinkPOST(formRequest("not-an-email"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobradar.test/login?error=invalid_email");
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("answers a JSON post with JSON and 400 on invalid input", async () => {
    const res = await magicLinkPOST(
      new Request("https://jobradar.test/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nope" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_email" });
  });

  it("still redirects to ?sent=1 when the email is unknown (no account-existence leak)", async () => {
    // signInWithOtp resolves successfully for unknown accounts by design; the
    // route adds no account-existence signal of its own.
    const res = await magicLinkPOST(formRequest("ghost@example.com"));
    expect(res.headers.get("location")).toBe("https://jobradar.test/login?sent=1");
  });
});

describe("POST /api/auth/google", () => {
  it("redirects to the provider URL with the callback in redirectTo", async () => {
    const res = await googlePOST(
      new Request("https://jobradar.test/api/auth/google", { method: "POST" }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://jobradar.test/auth/callback" },
    });
  });
});
