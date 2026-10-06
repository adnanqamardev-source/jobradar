/**
 * POST /api/auth/logout — end the session.
 *
 * ## Both halves are required
 *
 * docs/03 §2.2: "Server-side sign-out **and** cookie clear — local-only logout leaves a usable
 * token." Clearing the cookie alone would leave the refresh token valid for its full 30-day
 * lifetime, so anyone holding it could mint a new session after the user believes they signed out.
 * `supabase.auth.signOut()` does both: it revokes the refresh token on the server *and* clears the
 * cookies through the SSR client's cookie adapter (`setAll` with `maxAge: 0`).
 *
 * ## Why not `requireUser()`
 *
 * `requireUser()` throws `unauthenticated` when there's no session, and a logout with no session
 * is a success, not an error — the caller is already signed out. Treating that as a failure would
 * make a double-logout (two tabs, a stale button) an error page.
 *
 * ## Scope
 *
 * `signOut()` with the default `scope: 'local'` ends only this session's session. docs/03 §2.2
 * allows concurrent sessions with no cap, so a logout in one tab must not end the session in
 * another.
 */

import { NextResponse } from "next/server";

import { createAuthServerClient } from "@/lib/auth/server-client";

export async function POST(request: Request) {
  const supabase = await createAuthServerClient();

  const { error } = await supabase.auth.signOut();

  // HTML form posts (the "Sign out" button) get a redirect to /login; fetch/JSON callers get JSON.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return error
      ? NextResponse.json({ ok: false }, { status: 500 })
      : NextResponse.json({ ok: true });
  }

  if (error) {
    return NextResponse.redirect(new URL("/login?error=signout_failed", request.url), 303);
  }
  return NextResponse.redirect(new URL("/login?signed_out=1", request.url), 303);
}