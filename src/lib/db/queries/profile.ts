/**
 * queries/profile.ts — every read of `profiles` goes through here.
 *
 * ## Why this module exists
 *
 * docs/06 §8.1: "Components never call PostgREST directly — only `lib/db/queries/` and Server
 * Actions. One direct call inside a component and the boundary is gone." The first version of
 * `/dashboard` called `supabase.from("profiles")` inline; a code review caught it. The boundary is
 * cheap to keep and expensive to lose, so the call lives here and the page asks for it.
 *
 * ## Every function here takes the caller's client
 *
 * There is no client construction in this file, and no import of the service-role factory. The
 * caller passes the RLS-scoped client from `createUserClient(user.accessToken)`, so these reads are
 * constrained by that user's JWT. A helper that built its own client would have to choose a key,
 * and choosing the service-role key here would silently disable the owner-scoped policies.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";
import { planTierSchema } from "@/types/db";

/**
 * The projection `/dashboard` needs. Zod first, type derived — docs/06 §8.1. An earlier hand-written
 * interface was a second, unsourced definition that would drift from the row shape silently.
 */
export const profileSummarySchema = z.object({
  email: z.string(),
  full_name: z.string().nullable(),
  plan: planTierSchema,
  onboarding_completed: z.boolean(),
  onboarding_step: z.number(),
});

export type ProfileSummary = z.infer<typeof profileSummarySchema>;

/** The column list, derived from the schema so the two cannot disagree. */
const PROFILE_SUMMARY_COLUMNS = Object.keys(profileSummarySchema.shape).join(", ");

/**
 * Read the caller's own profile summary.
 *
 * Scoped by `id` as well as by RLS: the policy would already refuse another user's row, but an
 * explicit `eq("id", userId)` means a policy regression surfaces as zero rows rather than as
 * another user's data. Defence in depth on a row that holds someone's email and salary floor.
 *
 * @returns The validated summary, or `null` when no profile row exists (e.g. the signup trigger
 *          has not fired) or when the stored row fails validation.
 */
export async function getOwnProfileSummary(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProfileSummary | null> {
  const result = await supabase
    .from("profiles")
    .select(PROFILE_SUMMARY_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (result.error || !result.data) return null;

  const parsed = profileSummarySchema.safeParse(result.data);
  return parsed.success ? parsed.data : null;
}