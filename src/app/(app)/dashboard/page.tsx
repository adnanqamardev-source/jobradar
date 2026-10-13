/**
 * /dashboard — the ranked job feed (FE-105, FED-001).
 *
 * ## What this page is
 *
 * The post-auth landing route *and* the feed: `/auth/callback` redirects here,
 * and what the user sees is their ranked jobs, not an account summary. The
 * server component reads `v_ranked_jobs` in one round-trip (BE-306) and renders
 * the cards — no client-side fetch waterfall (FED-001: LCP p95 < 2.0s).
 *
 * ## What it keeps from the previous version
 *
 * The profile-missing branch. A missing `profiles` row means signup's
 * `handle_new_user()` trigger did not fire — a server-side bug, and a silent
 * blank dashboard is exactly what this page exists to make visible.
 *
 * ## Pagination
 *
 * Cursor-based and server-driven: "Next page" is a plain link to
 * `/dashboard?cursor=…`, so it works without JS and survives reload. Filter
 * state is in the URL (FED-003) — the cursor link preserves it because the
 * whole query string is rebuilt from the parsed params.
 */

import { redirect } from "next/navigation";
import Link from "next/link";

import { JobCard } from "@/components/feed/job-card";
import { requireUser, type AuthenticatedUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { getOwnProfileSummary } from "@/lib/db/queries/profile";
import {
  queryResumeVersions,
  type ResumeVersion,
} from "@/lib/db/queries/resume-versions";
import { feedParamsFromSearchParams, queryFeed } from "@/lib/db/queries/feed";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  if (profile === null) {
    return (
      <>
        <h1>Dashboard</h1>
        <section aria-labelledby="profile-missing">
          <h2 id="profile-missing">Profile not created</h2>
          <p>
            Your sign-in worked, but no profile row exists for <code>{displayName}</code>. This is
            a server-side bug, not something you did wrong.
          </p>
        </section>
      </>
    );
  }

  let params;
  try {
    params = feedParamsFromSearchParams(await searchParams);
  } catch {
    // A hand-edited URL with an invalid enum/number is a client error, not a
    // server failure — say so and offer the way back (never a 500).
    return (
      <>
        <h1>Your feed</h1>
        <section aria-labelledby="bad-params">
          <h2 id="bad-params">Those filters could not be read</h2>
          <p>The URL contains a filter value this page does not understand.</p>
          <p>
            <Link href="/dashboard">Back to your feed</Link>
          </p>
        </section>
      </>
    );
  }

  const result = await queryFeed(supabase, {
    ...params,
    lastSeenFeedAt: profile.last_seen_feed_at,
  });

  // One résumé query for the whole page, not one per card (FE-110 / JOB-003). The picker
  // only appears inside a dialog that is closed by default, and a query per card would be
  // N round-trips for a list the user may never open. A failure here is non-blocking —
  // JOB-003 requires the picker to degrade to an empty state, not to block the feed.
  let resumeVersions: ResumeVersion[] = [];
  try {
    resumeVersions = await queryResumeVersions(supabase);
  } catch {
    resumeVersions = [];
  }

  if ("error" in result) {
    return (
      <>
        <h1>Your feed</h1>
        <section aria-labelledby="bad-cursor">
          <h2 id="bad-cursor">That page link is no longer valid</h2>
          <p>The pagination link could not be decoded — it may have been truncated.</p>
          <p>
            <Link href="/dashboard">Back to your feed</Link>
          </p>
        </section>
      </>
    );
  }

  // The cursor link must carry the active filters forward, not just the cursor.
  const nextPageHref =
    result.nextCursor != null
      ? `/dashboard?${new URLSearchParams({
          ...(params.search ? { search: params.search } : {}),
          ...(params.workModes ? { workModes: params.workModes.join(",") } : {}),
          ...(params.seniority ? { seniority: params.seniority.join(",") } : {}),
          ...(params.minSalary != null ? { minSalary: String(params.minSalary) } : {}),
          ...(params.countryCode ? { countryCode: params.countryCode } : {}),
          ...(params.remoteScope ? { remoteScope: params.remoteScope } : {}),
          ...(params.newSinceLastVisit ? { newSinceLastVisit: "true" } : {}),
          cursor: result.nextCursor,
        }).toString()}`
      : null;

  return (
    <>
      <h1>Your feed</h1>

      {result.jobs.length === 0 ? (
        <section aria-labelledby="feed-empty">
          <h2 id="feed-empty">No jobs match your filters</h2>
          <p>
            {profile.onboarding_completed
              ? "Try widening your filters, or check back after the next scrape run."
              : "Finish setting up your profile so the scorer knows what to look for."}
          </p>
          <p>
            {profile.onboarding_completed ? (
              <Link href="/dashboard">Clear filters</Link>
            ) : (
              <Link href="/onboarding">Continue setup</Link>
            )}
          </p>
        </section>
      ) : (
        <>
          <p role="status">
            {result.total} {result.total === 1 ? "job" : "jobs"}
          </p>
          <ul>
            {result.jobs.map((job) => (
              <li key={job.id}>
                <JobCard job={job} resumeVersions={resumeVersions} />
              </li>
            ))}
          </ul>
          {nextPageHref != null && (
            <p>
              <Link href={nextPageHref}>Next page</Link>
            </p>
          )}
        </>
      )}
    </>
  );
}
