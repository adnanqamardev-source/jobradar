/**
 * /onboarding — the setup wizard (FE-102, ONB-001..005).
 *
 * The dashboard has linked here since the feed landed ("Continue setup" on the incomplete
 * profile) and the route was a `.gitkeep`, so that link has been a 404. This is the page that
 * makes a populated profile reachable — which is the last thing standing between a new signup
## and a non-empty feed, since `profiles` is created by the signup trigger with every
 * scoring-relevant column empty.
 *
 * ## One render, no client fetch
 *
 * The profile and the skill catalogue load here and arrive as props. `skills` is
 * authenticated-readable (0001:665) and small, so the whole catalogue ships down and step 2
 * filters in memory — no round-trip per keystroke.
 *
 * ## Resume
 *
 * `onboarding_step` decides the opening step (ONB-001). It was read here but never written
 * until `setOnboardingStep` landed in the same slice, so it was permanently 1 and "resume where
 * you left off" could not work.
 *
 * ## Already-finished users are sent to the feed
 *
 * Not a guard for its own sake: a finished user reaching `/onboarding` is either editing (which
 * is FE-116 / ONB-006, a different route) or back after clearing their profile. Sending them to
 * the dashboard is the honest answer either way, and it stops the wizard re-announcing
 * "let's find out what a good job looks like for you" to someone who already has a feed.
 */

import { redirect } from "next/navigation";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { queryOnboardingData } from "@/lib/db/queries/onboarding";
import { Wizard } from "@/components/onboarding/wizard";
import { ONBOARDING_STEPS } from "@/lib/onboarding/constants";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      redirect(`/login?next=${encodeURIComponent("/onboarding")}`);
    }
    throw error;
  }

  const supabase = await createUserClient(user.accessToken);

  const data = await queryOnboardingData(supabase, user.id);

  // `null` means no profile row, or one that failed validation. Either way there is nothing for
  // the wizard to edit — the dashboard renders a dedicated "Profile not created" state for
  // exactly this case, so redirecting rather than inventing a second, different explanation
  // keeps one bug to one message.
  if (data === null) {
    redirect("/dashboard");
  }

  if (data.profile.onboarding_completed) {
    redirect("/dashboard");
  }

  // Clamped: `onboarding_step` is a `smallint` a user could have set to anything by hand, and
  // an out-of-range value must not index past the end of WIZARD_STEPS.
  const initialStep = Math.min(
    Math.max(data.profile.onboarding_step ?? 1, 1),
    ONBOARDING_STEPS,
  );

  return (
    <Wizard
      profile={data.profile}
      skills={data.skills}
      selectedSkills={data.selectedSkills}
      initialStep={initialStep}
    />
  );
}
