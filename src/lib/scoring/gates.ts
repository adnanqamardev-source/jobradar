/**
 * gates.ts — hard filters (SCR-001, BE-201).
 *
 * docs/02b §6.3: "gates (hard filters) → any hit? `final_score = 0`,
 * `gate_result.reasons`, **HIDE from feed**".
 *
 * ## A gate is not a low score
 *
 * A gate is binary and comes first. Something the user explicitly blocked, or that
 * violates a stated requirement, is *not* a poor match to be ranked at the bottom —
 * it is a result that should not exist in their feed. So a gated job gets
 * `final_score = 0` **and** is excluded from the feed query, rather than shown at
 * rank 1000.
 *
 * Two obligations follow from that, and both are easy to get wrong:
 *
 *  1. **Every hit needs a machine-readable reason.** `gate_result.reasons` is what the
 *     UI and any future "why am I not seeing this?" debugging will read. docs/02a §5.5
 *     pins the shape: `{ "passed": false, "reasons": ["salary_below_floor"] }`.
 *  2. **A gate must not fire on missing data.** docs/03 §6.1 X-09 is explicit that an
 *     undisclosed salary is neutral, never penalised. The same reasoning applies to
 *     every gate here: an unknown work mode, an unknown seniority, or a missing
 *     description must never *exclude* a job. Silently dropping jobs is the failure
 *     mode that hurts a user who cannot see the cost of the decision.
 *
 * ## Purity
 *
 * Everything here is a pure function of its arguments. There is no clock, no
 * database, no I/O — which is what lets the whole gate set be unit-tested without
 * Postgres, and what makes "same inputs → same decision" checkable.
 */

import { companySlugCandidates } from "@/lib/utils/company-slug";
import type { Seniority, WorkMode } from "@/types/db";

// ---------------------------------------------------------------------------
// Inputs — the minimum a gate needs, not whole rows
// ---------------------------------------------------------------------------

/**
 * The scoring-relevant slice of a `jobs` row.
 *
 * Gates take this rather than `JobRow` so that a caller cannot accidentally make a
 * gate depend on a field it has no business reading, and so tests build fixtures
 * without satisfying 34 columns.
 */
export interface GateJob {
  title: string;
  companyName: string | null;
  companyDomain: string | null;
  descriptionText: string | null;
  workMode: WorkMode;
  seniority: Seniority;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
}

/** The scoring-relevant slice of a `profiles` row. */
export interface GateProfile {
  blockedCompanies: string[];
  excludedKeywords: string[];
  workModes: WorkMode[];
  minSalary: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
  seniority: Seniority;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Stable reason codes. These are stored in `job_scores.gate_result.reasons`, so they
 * are part of the data contract — renaming one invalidates historical rows.
 *
 * `salary_below_floor` is verbatim from docs/02a §5.5. The other four follow its
 * naming (`<subject>_<failure>`) because docs list the gates by concept, not by
 * string, and a stored code has to come from somewhere.
 */
export const GATE_REASONS = {
  blockedCompany: "blocked_company",
  excludedKeyword: "excluded_keyword",
  workModeMismatch: "work_mode_mismatch",
  salaryBelowFloor: "salary_below_floor",
  seniorityOverBand: "seniority_over_band",
} as const;

export type GateReason = (typeof GATE_REASONS)[keyof typeof GATE_REASONS];

/**
 * Which gates fired.
 *
 * `reasons` is a list rather than a single code because gates are independent: a job
 * can be both at a blocked company and below the salary floor, and reporting only the
 * first would misrepresent why it was dropped.
 */
export interface GateResult {
  passed: boolean;
  reasons: GateReason[];
}

// ---------------------------------------------------------------------------
// Seniority ranking
// ---------------------------------------------------------------------------

/**
 * Ordered seniority bands, junior → executive.
 *
 * The `seniority` Postgres enum has no defined sort order (`create type seniority as
 * enum (...)` fixes the labels, not their order), and `unknown` is the default for
 * most rows, so the ranking the `seniority_over_band` gate needs cannot come from the
 * database. It is declared here.
 *
 * docs/02b §6.3 says "seniority above `target` by >1 band", so the gap is measured in
 * steps of this list. `unknown` is deliberately **absent**: a rank for it would be an
 * invention, and the gate must not fire on it anyway.
 */
const SENIORITY_RANK: Record<Exclude<Seniority, "unknown">, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  staff: 5,
  principal: 6,
  director: 7,
  exec: 8,
};

/** Rank a seniority band, or `null` when it is `unknown` / outside the enum. */
export function seniorityRank(seniority: Seniority | null | undefined): number | null {
  if (!seniority || seniority === "unknown") return null;
  return SENIORITY_RANK[seniority] ?? null;
}

// ---------------------------------------------------------------------------
// Salary comparability
// ---------------------------------------------------------------------------

/** Multipliers that bring a figure to an annual amount. */
const ANNUAL_MULTIPLIER: Record<"year" | "month", number> = { year: 1, month: 12 };

/**
 * Bring a salary figure to an annual amount, or `null` when that is not possible.
 *
 * ## The decisions, and why they are not arbitrary
 *
 * - **`hour` returns `null`.** An hourly rate cannot be annualised without inventing
 *   an hours-per-week and weeks-per-year assumption. Guessing would gate real jobs on
 *   a fabricated number, so the gate declines instead.
 * - **A `null` period is treated as `year`.** Most postings state no period at all;
 *   `jobs.salary_period` is nullable and there is no CHECK on it. Treating null as
 *   "unknown → don't gate" would mean the salary gate essentially never fires, which
 *   makes the feature decorative. Year is the overwhelmingly common default, so
 *   assuming it is the reading that makes a stated floor mean anything.
 * - **Currencies must match.** No FX table exists and inventing exchange rates would
 *   change which jobs clear a floor on a number nobody can audit. A mismatch returns
 *   `null` → no gate.
 */
export function toAnnualSalary(
  amount: number | null,
  period: "year" | "month" | "hour" | null,
): number | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  const effective = period ?? "year";
  if (effective === "hour") return null;
  return amount * ANNUAL_MULTIPLIER[effective];
}

/**
 * Whether the job's advertised ceiling falls below the user's floor.
 *
 * Compares `salary_max`, per docs/02b §6.3 (`salary_max < min_salary`), falling back
 * to `salary_min` when only a single figure was advertised — a job stating "from 90k"
 * against a 120k floor is below it, and gating on `salary_max` alone would miss that.
 *
 * Returns `false` — never fires — when the job discloses no salary, when the user's
 * floor is unset, or when the two are not comparable.
 */
function hitsSalaryFloor(job: GateJob, profile: GateProfile): boolean {
  if (profile.minSalary === null) return false;

  const advertised = job.salaryMax ?? job.salaryMin;
  if (advertised === null) return false;

  const jobCurrency = job.salaryCurrency?.toUpperCase() ?? null;
  const profileCurrency = profile.salaryCurrency?.toUpperCase() ?? null;
  // Different currencies are not comparable without an FX table, which does not exist.
  if (jobCurrency === null || profileCurrency === null || jobCurrency !== profileCurrency) {
    return false;
  }

  const jobAnnual = toAnnualSalary(advertised, job.salaryPeriod);
  const floorAnnual = toAnnualSalary(profile.minSalary, profile.salaryPeriod);
  if (jobAnnual === null || floorAnnual === null) return false;

  return jobAnnual < floorAnnual;
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/** Fires when the job's company is on `profiles.blocked_companies`. */
function hitsBlockedCompany(job: GateJob, profile: GateProfile): boolean {
  if (profile.blockedCompanies.length === 0) return false;

  const candidates = companySlugCandidates({
    companyName: job.companyName,
    companyDomain: job.companyDomain,
  });
  if (candidates.length === 0) return false;

  return candidates.some((c) => profile.blockedCompanies.includes(c));
}

/**
 * Match a keyword as a whole phrase against text that is already lowercase.
 *
 * Word boundaries are applied **independently at each end**, based on whether the
 * keyword actually starts/ends with a word character. A blanket `\b…\b` looks correct
 * and is not: for "c++" the trailing `\b` requires a word character after the final
 * `+`, so it could never match anything. Conditioning each end separately means
 * "c++" matches inside "strong c++ required" while "ai" still refuses to match
 * "maintain".
 */
function matchesPhrase(haystackLower: string, keywordLower: string): boolean {
  const escaped = keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^\w/.test(keywordLower) ? "\\b" : "";
  const suffix = /\w$/.test(keywordLower) ? "\\b" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`).test(haystackLower);
}

/**
 * Fires when an excluded keyword appears in the title or description.
 *
 * Matched as a whole phrase, not a substring: a user excluding "golang" does not mean
 * a posting containing "GolangPro" should be dropped, and more importantly substring
 * matching makes short dealbreakers dangerously broad — excluding "ai" would remove
 * every job containing the letters "ai" in "maintain", "training" or "email".
 */
function hitsExcludedKeyword(job: GateJob, profile: GateProfile): boolean {
  if (profile.excludedKeywords.length === 0) return false;

  const haystack = `${job.title} ${job.descriptionText ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;

  return profile.excludedKeywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return false;
    return matchesPhrase(haystack, needle);
  });
}

/**
 * Fires when the job's work mode is not among the modes the user accepts.
 *
 * An empty `work_modes` means "no preference stated", not "nothing acceptable" — the
 * column defaults to `'{}'`, so gating on it would hide the entire feed for any user
 * who has not finished onboarding. Same for `job.workMode === 'unknown'`: undisclosed
 * is not a mismatch (docs/03 §6.1 X-09's reasoning, applied to work mode).
 */
function hitsWorkModeMismatch(job: GateJob, profile: GateProfile): boolean {
  if (profile.workModes.length === 0) return false;
  if (job.workMode === "unknown") return false;
  return !profile.workModes.includes(job.workMode);
}

/**
 * Fires when the job's seniority sits more than one band above the user's target.
 *
 * One band of slack is deliberate: a `mid` user is a plausible match for a `senior`
 * posting and vice versa, and gating both directions would gut the feed. Only the
 * *over*-qualified direction is specified (docs/02b §6.3), and being under-level is a
 * scoring matter, not an exclusion — it belongs to the seniority sub-score.
 */
function hitsSeniorityOverBand(job: GateJob, profile: GateProfile): boolean {
  const jobRank = seniorityRank(job.seniority);
  const targetRank = seniorityRank(profile.seniority);
  if (jobRank === null || targetRank === null) return false;

  return jobRank > targetRank + 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every gate and report which fired.
 *
 * Returns `passed: true` with an empty `reasons` array when nothing matched. Gates are
 * evaluated independently and **all** reasons are collected — no early return — so a
 * caller can explain a full exclusion rather than the first cause it happened to hit.
 */
export function evaluateGates(job: GateJob, profile: GateProfile): GateResult {
  const reasons: GateReason[] = [];

  if (hitsBlockedCompany(job, profile)) reasons.push(GATE_REASONS.blockedCompany);
  if (hitsExcludedKeyword(job, profile)) reasons.push(GATE_REASONS.excludedKeyword);
  if (hitsWorkModeMismatch(job, profile)) reasons.push(GATE_REASONS.workModeMismatch);
  if (hitsSalaryFloor(job, profile)) reasons.push(GATE_REASONS.salaryBelowFloor);
  if (hitsSeniorityOverBand(job, profile)) reasons.push(GATE_REASONS.seniorityOverBand);

  return { passed: reasons.length === 0, reasons };
}

/**
 * Whether a job should appear in the feed at all.
 *
 * Split out from {@link evaluateGates} because the two obligations are different and
 * are enforced in different places: scoring must still *write* a `final_score = 0` row
 * with a populated `gate_result` (SCR-004), while only the feed query may act on the
 * exclusion. Keeping them as separate functions stops a scorer from quietly deciding
 * not to persist a gated job, which would make the reason unrecoverable.
 */
export function shouldAppearInFeed(gate: GateResult): boolean {
  return gate.passed;
}