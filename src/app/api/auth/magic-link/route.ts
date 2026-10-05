/**
 * POST /api/auth/magic-link — email the caller a sign-in link.
 *
 * HTML-form posts (the login page) get a redirect back to /login with a
 * `?sent=1` or `?error=...` marker; JSON posts get the same outcome as JSON.
 *
 * Existence of an account is never revealed: Supabase returns success for
 * unknown emails on the OTP endpoint, and this route mirrors that — both
 * outcomes redirect to `?sent=1`.
 *
 * There is deliberately no rate-limit here yet (BE-303 owns that). Do not add
 * one inline — it needs a shared counter, not a per-route hack.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { createAuthServerClient } from "@/lib/auth/server-client";

const bodySchema = z.object({ email: z.string().trim().email() });

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  let raw: unknown;
  if (contentType.includes("application/json")) {
    raw = await request.json().catch(() => null);
  } else {
    const form = await request.formData().catch(() => null);
    raw = form ? { email: form.get("email") } : null;
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    if (contentType.includes("application/json")) {
      return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
    }
    return NextResponse.redirect(new URL("/login?error=invalid_email", request.url), 303);
  }

  const origin = new URL(request.url).origin;
  const supabase = await createAuthServerClient();
  await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  // Error details are deliberately not forwarded — see the header note.

  if (contentType.includes("application/json")) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.redirect(new URL("/login?sent=1", request.url), 303);
}
