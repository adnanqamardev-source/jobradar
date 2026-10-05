/**
 * POST /api/auth/google — start the Google OAuth flow.
 *
 * The login page posts here from a plain form. Supabase returns the provider's
 * authorisation URL; we 303 the browser to it. The provider eventually returns
 * to `/auth/callback`, which exchanges the code for a session.
 */

import { NextResponse } from "next/server";

import { createAuthServerClient } from "@/lib/auth/server-client";

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  const supabase = await createAuthServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });

  if (error || !data.url) {
    return NextResponse.redirect(new URL("/login?error=oauth_start_failed", request.url), 303);
  }
  return NextResponse.redirect(data.url, 303);
}
