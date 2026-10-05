/**
 * user-client.ts — the RLS-enforcing Supabase client (BE-302, NOT YET IMPLEMENTED).
 *
 * ## Why this is a separate module from `client.ts`
 *
 * It deliberately does not import `@/lib/env` or `./admin`. Those bind `process.env` at
 * import time and throw when the variables are absent, so a guard that only ever needs to
 * *refuse* would become untestable — the test would fail at module load rather than at the
 * assertion that matters. Keeping the guard free of the env binding means it can be proven
 * to fail closed with a plain import.
 *
 * ## Why it throws instead of returning a service-role client
 *
 * RLS enforcement is entirely a property of which key the client holds. A user-scoped
 * client needs the caller's real JWT, via `@supabase/ssr`, which depends on the session
 * helper in BE-302 (`requireUser()`).
 *
 * The tempting shortcut is to return the service-role client "for now". That must not
 * happen: service-role bypasses RLS, so every `resumes_*_own` policy in `0002_resumes.sql`
 * would be silently inert while the queries still succeeded — a green path straight past
 * the ownership check that makes uploaded resume files safe. Failing loudly is the safe
 * state.
 */

import type { SupabaseClient } from "./admin";

/**
 * Create a Supabase client that enforces RLS for a specific user.
 *
 * @param accessToken The user's access token, from the verified Supabase Auth session.
 * @throws Always, until BE-302 lands. Do not catch this and retry with a privileged
 *         client — that is the exact failure this function exists to prevent.
 */
export function createUserClient(accessToken: string): SupabaseClient {
  throw new Error(
    "createUserClient is not implemented: it needs the BE-302 session helper to resolve a " +
      "real user JWT. Refusing to fall back to the service-role client, which would bypass " +
      `RLS. (called with a ${accessToken.length}-char token)`,
  );
}