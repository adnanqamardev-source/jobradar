/**
 * user-client.ts — the RLS-enforcing Supabase client (BE-302).
 *
 * ## Why this is a separate module from `client.ts`
 *
 * It deliberately does not import `@/lib/env` or `./admin` at the top level. Those
 * bind `process.env` at import time and throw when the variables are absent, so a
 * module that only needs env at call time would become untestable — the test would
 * fail at module load rather than at the assertion that matters. `@/lib/env` is
 * imported lazily inside the function body.
 *
 * ## This is NOT the service-role client
 *
 * The client is created with the **anon key** plus the caller's own JWT in the
 * `Authorization` header, so Postgres evaluates every RLS policy with that user's
 * claims. The service-role key never enters this file.
 */

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { SupabaseClient } from "./admin";

/**
 * Create a Supabase client scoped to one user's access token. RLS applies.
 *
 * @param accessToken The user's access token, from the verified Supabase Auth session
 *                    (`requireUser()`). Never log it: it is a credential.
 */
export async function createUserClient(accessToken: string): Promise<SupabaseClient> {
  const { env } = await import("@/lib/env");
  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  );
}
