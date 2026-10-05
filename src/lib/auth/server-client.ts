/**
 * server-client.ts — the shared SSR Supabase client for auth Route Handlers.
 *
 * Both `auth/callback/route.ts` and the new `api/auth/*` routes need the same
 * cookie-bound client. One factory, one home for the cookie plumbing.
 *
 * `@/lib/env` is imported eagerly on purpose: route modules are evaluated during
 * `next build`'s page-data collection, so a misconfigured deployment fails at
 * deploy time, not at first request (docs/02 §7.2 rule 3). Unit tests mock
 * `@/lib/env` rather than relying on a side effect.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { env } from "@/lib/env";

export async function createAuthServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
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
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component; middleware refreshes sessions.
          }
        },
      },
    },
  );
}
