/**
 * /dashboard — the post-auth landing route.
 *
 * ## This is NOT FE-105
 *
 * FE-105 is the ranked job feed and belongs to Phase 2. This page exists only because
 * `/auth/callback` redirects here after a successful sign-in, and until this route
 * existed every successful login landed on a 404 — which reads as "auth is broken" even
 * though auth worked. Its only job is to terminate the redirect honestly: prove the
 * session is real, show what is in the user's own row, and get out of the way.
 *
 * It is deliberately unstyled and it adds no design opinions (Phase 3 owns those).
 *
 * ## Why it is a Server Component that reads the database
 *
 * Rendering "signed in as <email>" from a claim proves nothing. Reading the user's own
 * `profiles` row through `createUserClient` exercises the whole chain in one screen:
 * cookie session → `requireUser()` → user-scoped anon client → RLS allowing exactly
 * that row and nothing else. If BE-302 or BE-304 were broken, this page breaks, which is
 * the point — a green login screen with an empty database behind it hid this for days.
 */

import { redirect } from "next/navigation";

import { requireUser, type AuthenticatedUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Narrow shape — the client is untyped, so `any` is cast once, here. */
interface ProfileSummary {
  email: string | null;
  full_name: string | null;
  onboarding_completed: boolean | null;
  onboarding_step: number | null;
}

export default async function DashboardPage() {
  let user: AuthenticatedUser;
  try {
    user = await requireUser();
  } catch (error) {
    // docs/05b AUT-003: an unauthenticated hit on an (app) route goes to /login with a
    // return path, never an error wall. Anything else is a real failure and propagates.
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      redirect("/login?next=/dashboard");
    }
    throw error;
  }

  const supabase = await createUserClient(user.accessToken);
  const result = (await supabase
    .from("profiles")
    .select("email, full_name, onboarding_completed, onboarding_step")
    .eq("id", user.id)
    .maybeSingle()) as { data: ProfileSummary | null; error: { message: string } | null };

  const profile = result.data;
  // An empty or whitespace-only name is not a display name, so it falls back to the id.
  // Written as an explicit length check rather than `||`: `||` is correct here but
  // `@typescript-eslint/prefer-nullish-coalescing` bans it on a nullable string, and
  // `??` would keep the empty string and render a blank heading.
  const trimmedName = profile?.full_name?.trim();
  const displayName = trimmedName !== undefined && trimmedName.length > 0 ? trimmedName : user.id;

  return (
    <main className="p-6">
      <h1 className="text-h1 font-sans font-semibold">Dashboard</h1>

      {/*
        A missing profile row here means BE-304's trigger did not fire for this signup.
        Say so explicitly rather than rendering an empty shell: a silent blank dashboard is
        the exact failure this page exists to make visible.
      */}
      {result.error || !profile ? (
        <section aria-labelledby="profile-missing">
          <h2 id="profile-missing" className="text-h2 font-sans font-medium mt-6">
            Profile not created
          </h2>
          <p className="text-body text-ink-2 mt-2">
            Your sign-in worked, but no profile row exists for <code>{displayName}</code>. This
            is a server-side bug in <code>handle_new_user()</code>, not something you did wrong.
          </p>
        </section>
      ) : (
        <section aria-labelledby="account">
          <h2 id="account" className="text-h2 font-sans font-medium mt-6">
            Account
          </h2>
          <dl className="mt-2 grid gap-2">
            <dt className="label">Email</dt>
            <dd className="text-body">{profile.email}</dd>
            <dt className="label">Role</dt>
            <dd className="text-body">{user.role}</dd>
            <dt className="label">Plan</dt>
            <dd className="text-body">Onboarding {profile.onboarding_completed ? "complete" : "in progress"}</dd>
          </dl>
        </section>
      )}

      <section aria-labelledby="next" className="mt-8">
        <h2 id="next" className="text-h2 font-sans font-medium">
          What is not built yet
        </h2>
        <p className="text-body text-ink-2 mt-2">
          The ranked job feed (<code>FE-105</code>) and the onboarding wizard (
          <code>FE-102</code>) are Phase 2. This page is a placeholder landing target, not
          the dashboard you will use.
        </p>
      </section>
    </main>
  );
}