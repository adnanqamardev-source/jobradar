/**
 * require-user.ts — session guard (BE-302, NOT YET IMPLEMENTED).
 *
 * Every user-scoped Server Action must resolve the caller's identity *before* touching
 * the database, so that RLS is evaluating a real JWT rather than a trusted key. This
 * module is the seam for that, and it currently fails closed.
 *
 * ## Why this throws instead of returning a placeholder
 *
 * The only way to make these actions "work" today would be to hand them the service-role
 * key. That key bypasses RLS entirely, which would silently disable the `resumes_*_own`
 * policies that `0002_resumes.sql` installs, and no test would catch it: the queries would
 * succeed, just without the ownership check that makes them safe. A resume file is about
 * as sensitive as user data gets, so the guard throws until the real thing exists.
 *
 * ## To implement (BE-302)
 *
 * 1. Read the Supabase SSR cookie session (`@supabase/ssr` is already a dependency).
 * 2. Return the caller's verified `id` and `access_token`, or throw a 401-mapped error.
 * 3. Add `requireAdmin()` alongside it, gated on `is_admin()` from docs/03 §4.1a.
 *
 * `id` and `accessToken` are returned together deliberately: a caller that derives the
 * user id from an unverified token would defeat the point of the guard.
 */

/** A verified caller identity. */
export interface AuthenticatedUser {
  /** `auth.uid()` — the value every RLS policy compares against. */
  id: string;
  /** The caller's JWT, to be used with the anon key so RLS applies. */
  accessToken: string;
}

/**
 * Resolve the caller's authenticated identity.
 *
 * @throws Always, until BE-302 lands. Callers must not catch this and continue with a
 *         service-role client — that is the exact failure this module exists to prevent.
 */
export function requireUser(): Promise<AuthenticatedUser> {
  return Promise.reject(
    new Error(
      "requireUser is not implemented (BE-302). A user-scoped action cannot run without " +
        "the caller's verified JWT, and falling back to the service-role key would bypass " +
        "row-level security on the resumes table.",
    ),
  );
}