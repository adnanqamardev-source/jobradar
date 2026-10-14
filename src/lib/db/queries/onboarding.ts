/**
 * queries/onboarding.ts — the reads the setup wizard needs (FE-102, ONB-001).
 *
 * ## Why a query module and not `.from()` in the page
 *
 * docs/06 §8.1: "Components never call PostgREST directly — only `lib/db/queries/` and Server
 * Actions." `/onboarding` was reaching for `.from("profiles")`, `.from("skills")` and
 * `.from("profile_skills")` inline, which broke the boundary and — because the Supabase client
 * is untyped — handed the page `any` for every column. Zod here restores the type and the
 * boundary in one move, the same way `queries/profile.ts` does it.
 *
 * ## `profiles` is read in full, deliberately
 *
 * The wizard's four steps read between them almost every scoring-relevant column, and a partial
 * projection would mean a second schema the moment step 5 exists. Selecting `*` and validating
 * against a schema that mirrors `ProfileRow` means a new column is a *type* change, not a silent
 * `any` that fails somewhere else.
 *
 * The security story is unchanged: `profiles` is owner-only under RLS and the query is scoped by
 * `id` as well, so a policy regression surfaces as zero rows rather than as another user's row.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";
import {
  planTierSchema,
  profLevelSchema,
  senioritySchema,
  userRoleSchema,
  workModeSchema,
} from "@/types/db";

/**
 * One `profiles` row, mirroring `ProfileRow`.
 *
 * `country_code` is `char(2)` in the database, which Postgres pads — a value written as `"de"`
 * comes back as `"de"`, and the wizard uppercases it before saving, so the display value is
 * normalised here too. `salary_currency` is `char(3)`: a longer value would be silently
 * truncated by Postgres rather than rejected, so it is `.max(3)` rather than open-ended.
 */
export const onboardingProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  full_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role: userRoleSchema,
  plan: planTierSchema,
  target_titles: z.array(z.string()),
  seniority: senioritySchema,
  years_experience: z.number().nullable(),
  headline: z.string().nullable(),
  country_code: z.string().nullable(),
  city: z.string().nullable(),
  time_zone: z.string().nullable(),
  work_modes: z.array(workModeSchema),
  hybrid_days_max: z.number().nullable(),
  min_salary: z.number().nullable(),
  salary_currency: z.string().max(3),
  salary_period: z.enum(["year", "month", "hour"]).nullable(),
  visa_required: z.boolean().nullable(),
  blocked_companies: z.array(z.string()),
  excluded_keywords: z.array(z.string()),
  preferred_companies: z.array(z.string()),
  onboarding_completed: z.boolean(),
  onboarding_step: z.number(),
  last_digest_at: z.string().nullable(),
  last_seen_feed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type OnboardingProfile = z.infer<typeof onboardingProfileSchema>;

/** A row of the canonical `skills` catalogue (step 2's picker). */
const skillOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  aliases: z.array(z.string()).nullable(),
});

export type OnboardingSkillOption = Omit<z.infer<typeof skillOptionSchema>, "aliases"> & {
  aliases: string[];
};

/** The caller's existing `profile_skills`, so step 2 opens showing what is already set. */
const selectedSkillSchema = z.object({
  skill_id: z.string().uuid(),
  level: profLevelSchema.nullable(),
});

export interface OnboardingData {
  profile: OnboardingProfile;
  skills: OnboardingSkillOption[];
  selectedSkills: { skillId: string; level: "familiar" | "proficient" | "expert" }[];
}

/**
 * Load the caller's profile, the skill catalogue and their selected skills.
 *
 * @returns `null` when there is no profile row — the signup trigger did not fire, which the
 *          dashboard reports as its own "Profile not created" state.
 *
 * The three reads are independent and run concurrently: one render, one waterfall.
 */
export async function queryOnboardingData(
  supabase: SupabaseClient,
  userId: string,
): Promise<OnboardingData | null> {
  const [profileResult, skillsResult, selectionResult] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
    supabase.from("skills").select("id, name, slug, aliases").order("name"),
    supabase.from("profile_skills").select("skill_id, level").eq("profile_id", userId),
  ]);

  if (profileResult.error || !profileResult.data) return null;

  const profile = onboardingProfileSchema.safeParse(profileResult.data);
  if (!profile.success) return null;

  const skills = z.array(skillOptionSchema).safeParse(skillsResult.data ?? []);
  const selection = z.array(selectedSkillSchema).safeParse(selectionResult.data ?? []);

  return {
    // A catalogue that fails to validate is an empty picker, not a crashed wizard: step 2's
    // only hard requirement is the 3-skill minimum, which an empty list simply cannot meet.
    skills:
      skills.success === true
        ? skills.data.map((skill) => ({ ...skill, aliases: skill.aliases ?? [] }))
        : [],
    selectedSkills:
      selection.success === true
        ? selection.data.map((row) => ({
            skillId: row.skill_id,
            // `prof_level` is nullable; `proficient` matches the column default, so an unset
            // level reads as the neutral middle rather than as a deliberate "barely knows it".
            level:
              row.level === "familiar" || row.level === "expert"
                ? row.level
                : ("proficient" as const),
          }))
        : [],
    profile: profile.data,
  };
}
