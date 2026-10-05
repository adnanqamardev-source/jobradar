/**
 * bootstrap.ts — map extracted resume profile to onboarding preferences (BE-316).
 *
 * Takes an ExtractedProfile and produces a BootstrapProfile that can prefill
 * the onboarding wizard (ONB-002–005). The user reviews and confirms before
 * this is saved to their profile.
 *
 * Mapping rules:
 * - titles → targetTitles (ONB-002)
 * - seniority → seniority (ONB-002)
 * - yearsExperience → years_experience (ONB-002)
 * - skills → skills (ONB-003)
 * - workModes → work_modes (ONB-004)
 * - location → country_code, city (ONB-004)
 * - salary → min_salary, salary_currency, salary_period (ONB-004/005)
 */

import type { ExtractedProfile, BootstrapProfile } from "@/types/resume";

// ---------------------------------------------------------------------------
// Mapping functions
// ---------------------------------------------------------------------------

/**
 * Map an extracted profile to a bootstrap profile.
 *
 * This is a pure function — same input always produces same output.
 * No external calls, no side effects.
 */
export function mapExtractedToBootstrap(
  extracted: ExtractedProfile,
): BootstrapProfile {
  return {
    // ONB-002: Titles & seniority
    targetTitles: extracted.titles.slice(0, 10),
    seniority: extracted.seniority,
    yearsExperience: extracted.yearsExperience,

    // ONB-003: Skills
    skills: extracted.skills.slice(0, 30),

    // ONB-004: Logistics
    workModes: extracted.workModes,
    countryCode: extracted.location.countryCode,
    city: extracted.location.city,

    // ONB-004/005: Salary expectations
    minSalary: extracted.minSalary,
    salaryCurrency: extracted.salaryCurrency,
    salaryPeriod: extracted.salaryPeriod,
  };
}

/**
 * Merge a bootstrap profile with existing profile data.
 *
 * Used when the user has already started onboarding and wants to
 * update specific fields from their resume without overwriting
 * everything they've already entered.
 *
 * Only non-null/undefined values from the bootstrap profile are applied.
 */
export function mergeBootstrapWithExisting(
  existing: Partial<BootstrapProfile>,
  bootstrap: BootstrapProfile,
): BootstrapProfile {
  return {
    targetTitles: bootstrap.targetTitles.length > 0
      ? bootstrap.targetTitles
      : (existing.targetTitles ?? []),
    seniority: bootstrap.seniority ?? existing.seniority ?? null,
    yearsExperience: bootstrap.yearsExperience ?? existing.yearsExperience ?? null,
    skills: bootstrap.skills.length > 0
      ? bootstrap.skills
      : (existing.skills ?? []),
    workModes: bootstrap.workModes.length > 0
      ? bootstrap.workModes
      : (existing.workModes ?? []),
    countryCode: bootstrap.countryCode ?? existing.countryCode ?? null,
    city: bootstrap.city ?? existing.city ?? null,
    minSalary: bootstrap.minSalary ?? existing.minSalary ?? null,
    salaryCurrency: bootstrap.salaryCurrency ?? existing.salaryCurrency ?? null,
    salaryPeriod: bootstrap.salaryPeriod ?? existing.salaryPeriod ?? null,
  };
}

/**
 * Validate that a bootstrap profile is ready to be applied.
 *
 * Returns true if the profile has enough data to be useful for onboarding.
 * A profile with no titles, no skills, and no location is probably not worth
 * applying.
 */
export function isBootstrapReady(profile: BootstrapProfile): boolean {
  return (
    profile.targetTitles.length > 0 ||
    profile.skills.length > 0 ||
    profile.countryCode !== null ||
    profile.workModes.length > 0
  );
}
