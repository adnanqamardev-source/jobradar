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
 * ## What this does NOT do — measured, not assumed
 *
 * docs/02 §7.2 rule 3 wants misconfiguration to "fail at deploy, not at first user request."
 * This does not achieve that. `pnpm build` **succeeds** with all five required vars absent:
 * Next.js does not evaluate dynamic route modules during build, so the module-level throw
 * never fires until the first request reaches it on the server.
 *
 * Getting the build itself to gate on env would mean validating in a place the build *does*
 * execute. The candidate is `src/instrumentation.ts` `register()`, which runs on server
 * start — that would make a bad deploy refuse to serve rather than serve 500s. Not done here
 * because it fails every route on any partial `.env.local`, which is a larger behavioural
 * change than this route warrants on its own. Recorded as a follow-up, not quietly claimed.
 *
 * Note this validates the *whole* contract, not just the two keys used below — deliberate.
 * Every route shares one process, so a partially-configured deployment breaks somewhere later
 * and further from its cause.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { env } from "@/lib/env";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {
              // The `setAll` method was called from a Server Component.
              // This can be ignored if you have middleware refreshing
              // user sessions.
            }
          },
        },
      }
    );
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Return the user to an error page with instructions
  return NextResponse.redirect(`${origin}/auth/auth_code_error`);
}