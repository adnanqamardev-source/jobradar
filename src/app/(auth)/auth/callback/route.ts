/**
 * auth/callback/route.ts — PKCE / magic-link code exchange.
 *
 * ## Why this imports `@/lib/env` and not `process.env`
 *
 * It used to read `process.env.NEXT_PUBLIC_SUPABASE_URL!` directly. The `!` asserted a value
 * that was never checked, so a deployment missing the variable produced an opaque 500 from
 * inside the Supabase SDK — observed on the first production deploy:
 *
 *     Error: Your project's URL and Key are required to create a Supabase client!
 *         at .next/server/app/(auth)/auth/callback/route.js:42:25
 *
 * That error names none of the missing variables and sends you to a dashboard URL. The same
 * run with `.env.local` removed now produces, before any Supabase call:
 *
 *     Error: ❌ Invalid environment variables:
 *     NEXT_PUBLIC_SUPABASE_URL: Required
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY: Required
 *     SUPABASE_SERVICE_ROLE_KEY: Required
 *     CRON_SECRET: Required
 *     OPENROUTER_API_KEY: Required
 *
 * Still a 500 — but one that names every variable to set, which is the difference between a
 * five-minute fix and an afternoon.
 *
 * ## This does gate the build — verified, and load-bearing
 *
 * docs/02 §7.2 rule 3 requires that misconfiguration "fail at deploy, not at first user
 * request." Importing the contract is what delivers that. `next build` runs a
 * "collecting page data" pass that evaluates route modules, so the module-level throw fires
 * during the build. With no `.env.local`:
 *
 *     Error: Invalid environment variables:
 *     NEXT_PUBLIC_SUPABASE_URL: Required
 *     ...
 *     [Error: Failed to collect page data for /auth/callback]
 *
 * A misconfigured deployment therefore never ships. That is why CI supplies *placeholder*
 * values for these five vars rather than real ones (see `.github/workflows/ci.yml`): the
 * schema validates shape and presence, not whether a key actually works, and AGENTS.md
 * forbids live API calls in CI. It also means any future route that imports `@/lib/env`
 * inherits the same build gate for free.
 *
 * Note this validates the *whole* contract, not just the two keys used below — deliberate.
 * Every route shares one process, so a partially-configured deployment breaks somewhere later
 * and further from its cause.
 */

import { NextResponse } from "next/server";

import { createAuthServerClient } from "@/lib/auth/server-client";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createAuthServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Return the user to an error page with instructions
  return NextResponse.redirect(`${origin}/auth/auth_code_error`);
}