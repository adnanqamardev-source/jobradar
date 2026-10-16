/**
 * /applications — the application tracker (FE-111, FE-112).
 *
 * The dashboard's nav has linked here since Phase 0 with `built: false`, and `app-nav.tsx`
 * explains why the link stayed: removing it would hide planned work, and the prefetch 404s it
 * caused were fixed with `prefetch={false}` rather than by deleting the destination. This is that
 * destination.
 *
 * ## One render, no client fetch
 *
 * The cards and their histories load here and arrive as props. The drawer's timeline comes from
 * the same read rather than a fetch on open, so opening a drawer is instant and a failed history
 * load cannot appear as an empty timeline that looks like "no history recorded".
 *
 * RLS scopes both reads to the caller; `queryApplications` additionally filters by `user_id` so a
 * policy regression surfaces as an empty board rather than as someone else's applications.
 */

import { redirect } from "next/navigation";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { queryApplicationEvents, queryApplications } from "@/lib/db/queries/applications";
import { TrackerBoard } from "@/components/tracker/tracker";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      redirect(`/login?next=${encodeURIComponent("/applications")}`);
    }
    throw error;
  }

  const supabase = await createUserClient(user.accessToken);
  const cards = await queryApplications(supabase, user.id);

  // Histories are fetched per application rather than in one joined read: a single select across
  // both tables is a cartesian product when an application has several events, and the board
  // renders one card per application, not one card per event.
  const histories = await Promise.all(
    cards.map(async (card) => [card.applicationId, await queryApplicationEvents(supabase, card.applicationId)] as const),
  );

  return (
    <TrackerBoard
      cards={cards}
      events={Object.fromEntries(histories)}
    />
  );
}