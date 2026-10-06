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
 * ## Known phase-rule exception
 *
 * AGENTS.md says Phase 1 has "no page files". This one is a deliberate, documented exception:
 * it is the only page in the tree that is not Phase 2 work, and it carries no design
 * opinions — no colours, no spacing decisions beyond the structural minimum. The alternative
 * was leaving every successful sign-in on a 404.
 *
 * ## Why it reads the database
 *
 * Rendering "signed in as <email>" from a claim proves nothing. Reading the user's own
 * `profiles` row through the RLS-scoped client exercises the whole chain in one screen:
 * cookie session → `requireUser()` → user-scoped anon client → RLS allowing exactly that
 * row and nothing else. If BE-302 or BE-304 were broken, this page breaks, which is the point.
 */

import { redirect } from "next/navigation";

import { requireUser, type AuthenticatedUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { getOwnProfileSummary } from "@/lib/db/queries/profile";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let user: AuthenticatedUser;
  try {
    user = await requireUser();
  } catch (error) {
    // docs/05b AUT-003: an unauthenticated hit on an (app) route goes to /login with a return
    // path, never an error wall. Anything else is a real failure and propagates.
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      redirect(`/login?next=${encodeURIComponent("/dashboard")}`);
    }
    throw error;
  }

  const supabase = await createUserClient(user.accessToken);
  const profile = await getOwnProfileSummary(supabase, user.id);

  const trimmedName = profile?.full_name?.trim();
  const displayName =
    trimmedName !== undefined && trimmedName.length > 0 ? trimmedName : user.id;

  return (
    <main>
      <h1>Dashboard</h1>

      {/*
        A missing profile row here means BE-304's `handle_new_user()` trigger did not fire for
        this signup. Say so explicitly rather than rendering an empty shell: a silent blank
        dashboard is the exact failure this page exists to make visible.
      */}
      {profile === null ? (
        <section aria-labelledby="profile-missing">
          <h2 id="profile-missing">Profile not created</h2>
          <p>
            Your sign-in worked, but no profile row exists for <code>{displayName}</code>. This is
            a server-side bug, not something you did wrong.
          </p>
        </section>
      ) : (
        <section aria-labelledby="account">
          <h2 id="account">Account</h2>
          <dl>
            <dt>Email</dt>
            <dd>{profile.email}</dd>
            <dt>Name</dt>
            <dd>{displayName}</dd>
            <dt>Role</dt>
            <dd>{user.role}</dd>
            <dt>Plan</dt>
            <dd>{profile.plan}</dd>
            <dt>Onboarding</dt>
            <dd>
              {profile.onboarding_completed
                ? "Complete"
                : `In progress — step ${profile.onboarding_step} of 4`}
            </dd>
          </dl>
        </section>
      )}
      <form action="/api/auth/logout" method="POST" className="mt-8">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}