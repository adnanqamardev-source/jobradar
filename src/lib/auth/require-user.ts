/**
 * require-user.ts — session guard (BE-302).
 *
 * Every user-scoped Server Action must resolve the caller's identity *before* touching
 * the database, so that RLS is evaluating a real JWT rather than a trusted key. This
 * module is that seam. It fails closed: no session, or an unverifiable one, rejects.
 *
 * ## Import-time env safety
 *
 * This module does NOT import `@/lib/env` at the top level. That binding throws at
 * module load when configuration is missing, which would make every importer — including
 * the guard tests — fail before reaching the assertion that matters. `@/lib/env` is
 * therefore imported lazily, inside the function body: importing this module is always
 * safe, and a misconfigured deployment still throws the full Zod report, just one tick
 * later, at call time.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { AppError } from "@/lib/errors";

/** A verified caller identity. */
export interface AuthenticatedUser {
  /** `auth.uid()` — the value every RLS policy compares against. */
  id: string;
  /** The caller's JWT, to be used with the anon key so RLS applies. */
  accessToken: string;
  /** `profiles.role` mirrored into `app_metadata.role` by `sync_profile_role_to_jwt()`. */
  role: "user" | "admin";
}

async function sessionClient() {
  const { env } = await import("@/lib/env");
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

/**
 * Resolve the caller's authenticated identity from the SSR cookie session.
 *
 * @throws {AppError} `unauthenticated` when there is no valid session or token.
 */
export async function requireUser(): Promise<AuthenticatedUser> {
  const supabase = await sessionClient();

  // `getUser()` revalidates the token against the Auth server — a JWT that merely
  // parses is not enough. `getSession()` alone would trust an unverified cookie.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    throw new AppError("unauthenticated");
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new AppError("unauthenticated");
  }

  const appMeta = user.app_metadata as { role?: unknown } | null | undefined;
  const role = appMeta?.role === "admin" ? "admin" : "user";

  return { id: user.id, accessToken: session.access_token, role };
}

/**
 * Resolve the caller and require the `admin` role.
 *
 * @throws {AppError} `unauthenticated` with no session, `forbidden` without the role.
 */
export async function requireAdmin(): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new AppError("forbidden");
  }
  return user;
}
