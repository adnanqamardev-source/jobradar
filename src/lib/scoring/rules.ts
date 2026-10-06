/**
 * rules.ts — the deterministic rule-based fit score (SCR-002, BE-202).
 *
 * docs/02b §6.3: a 0–100 score weighted skills 35 · seniority 15 · compensation 15 ·
 * location/work-mode 15 · recency 10 · company preference 10, emitting a `breakdown`
 * array rendered by docs/04 §3.4.
 *
 * ## Determinism is a requirement, not a nicety
 *
 * "Same inputs → same score" is an explicit SCR-002 acceptance criterion, and this
 * module is why: there is no clock, no database, and no randomness. The only way time
 * enters is the injected `now`. That is what makes a score reproducible months later,
 * which is what makes `job_scores.model_version` meaningful.
 *
 * ## The invariant: unknown is never 0
 *
 * Every sub-score returns `{ raw, known }`. A component that does not know scores
 * {@link NEUTRAL_RAW} (0.5), not 0. docs/03 §6.1 X-09 requires it for salary; it holds
 * for every component because a ranking computed on absent data is a ranking that
 * systematically buries the jobs a source published least about — which is exactly
 * backwards for a job seeker.
 *
 * The distinction is kept visible rather than folded away, because it is the difference
 * between "this job scores badly" and "we have no idea", and a user shown a confident
 * number for the second case is being misled.
 */

import { companySlugCandidates } from "@/lib/utils/company-slug";
import { seniorityRank, toAnnualSalary } from "@/lib/scoring/gates";
import {
  NEUTRAL_RAW,
  RULE_MODEL_VERSION,
  RULE_WEIGHTS,
  type RuleComponentKey,
} from "@/lib/scoring/weights";
import type { Seniority, WorkMode } from "@/types/db";
import type { RemoteScope } from "@/types/canonical-job";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One row of `job_skills`. `weight` is the strength of mention. */
export interface JobSkillInput {
  skillId: string;
  weight: number | null;
}

/** One row of `profile_skills`. `level` is the candidate's stated proficiency. */
export interface ProfileSkillInput {
  skillId: string;
  level: "familiar" | "proficient" | "expert" | null;
}

/** The scoring-relevant slice of a `jobs` row. */
export interface RuleJob {
  title: string;
  companyName: string | null;
  companyDomain: string | null;
  countryCode: string | null;
  workMode: WorkMode;
  remoteScope: RemoteScope;
  seniority: Seniority;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
  postedAt: string | null;
}

/** The scoring-relevant slice of a `profiles` row. */
export interface RuleProfile {
  targetTitles: string[];
  seniority: Seniority;
  yearsExperience: number | null;
  countryCode: string | null;
  workModes: WorkMode[];
  minSalary: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
  preferredCompanies: string[];
}

export interface RuleScoreInput {
  job: RuleJob;
  profile: RuleProfile;
  jobSkills: JobSkillInput[];
  profileSkills: ProfileSkillInput[];
  /** Injected clock. Never `new Date()` inside this module — determinism depends on it. */
  now: Date;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * One row of `job_scores.breakdown`.
 *
 * Shape is pinned by docs/02a §5.5:
 * `[{ "key":"skills","weight":35,"raw":0.71,"points":24.9}, …]`
 * and rendered by docs/04 §3.4, so it is **always present** (C3) — the UI never renders
 * a bare score with no explanation.
 */
export interface BreakdownEntry {
  key: RuleComponentKey;
  weight: number;
  /** Normalised 0–1 sub-score. */
  raw: number;
  /** `raw × weight`, rounded to 2dp. What the FE prints. */
  points: number;
  /**
   * Whether the component had the data to judge. False means `raw` is the neutral
   * default, not a finding — surfaced so the FE can label it rather than imply
   * confidence it does not have.
   */
  known: boolean;
}

export interface RuleScoreResult {
  /** 0–100, rounded to 2dp. */
  score: number;
  breakdown: BreakdownEntry[];
  modelVersion: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Round to 2dp, avoiding `-0` and float dust like 24.899999999999998. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A sub-score's verdict: a normalised value, and whether it had the data to judge. */
interface SubScore {
  raw: number;
  known: boolean;
}

const unknown = (): SubScore => ({ raw: NEUTRAL_RAW, known: false });

// ---------------------------------------------------------------------------
// Component 1 — skills (35)
// ---------------------------------------------------------------------------

/**
 * How much a matched skill is worth at each stated proficiency.
 *
 * A skill the candidate is only `familiar` with still counts — omitting it entirely
 * would treat "I have used this" as "I have never heard of it", which is not what
 * `prof_level` records. But it counts less than the same skill at `expert`.
 */
const LEVEL_MULTIPLIER: Record<NonNullable<ProfileSkillInput["level"]>, number> = {
  familiar: 0.6,
  proficient: 0.85,
  expert: 1.0,
};

/**
 * Skills sub-score: how much of what the job asks for the candidate actually has.
 *
 * ## Why the weights are self-normalising
 *
 * `job_skills.weight` is `numeric(3,2)` with **no CHECK constraint**, defaulting to
 * `1.0`. So the column carries no guarantee about its own range, and connectors may
 * write anything the type width allows. Clamping to 0–1 would silently flatten a
 * connector that writes 1.0/2.0/3.0 for weak/medium/strong; trusting the raw value
 * would let one malformed row dominate the score.
 *
 * Instead each job's weights are divided by that job's own maximum. The result is a
 * relative importance in `(0, 1]`, correct under either convention, and a job with a
 * single skill still normalises to 1.0 rather than dividing by zero.
 *
 * Unmatched job skills stay in the denominator: a job asking for eight things the
 * candidate has two of should score poorly, which means the ones they lack must count
 * against them.
 */
function scoreSkills(jobSkills: JobSkillInput[], profileSkills: ProfileSkillInput[]): SubScore {
  if (jobSkills.length === 0 || profileSkills.length === 0) return unknown();

  const levelBySkill = new Map<string, NonNullable<ProfileSkillInput["level"]>>();
  for (const s of profileSkills) {
    // `level` is nullable with a default, so a row written without one still means
    // "proficient" as far as the database is concerned.
    levelBySkill.set(s.skillId, s.level ?? "proficient");
  }

  // A job whose weights are all zero or negative has no relative ordering to give.
  const maxWeight = Math.max(...jobSkills.map((s) => s.weight ?? 1));
  if (!Number.isFinite(maxWeight) || maxWeight <= 0) return unknown();

  let earned = 0;
  let possible = 0;

  for (const js of jobSkills) {
    const relative = clamp01((js.weight ?? 1) / maxWeight);
    possible += relative;
    const level = levelBySkill.get(js.skillId);
    if (level !== undefined) {
      earned += relative * (LEVEL_MULTIPLIER[level] ?? LEVEL_MULTIPLIER.proficient);
    }
  }

  if (possible === 0) return unknown();
  return { raw: clamp01(earned / possible), known: true };
}

// ---------------------------------------------------------------------------
// Component 2 — seniority (15)
// ---------------------------------------------------------------------------

/** Bands of distance at which the seniority sub-score reaches zero. */
const SENIORITY_SPAN = 4;

/**
 * Seniority sub-score: symmetric falloff from the candidate's target band.
 *
 * Symmetric because being *under* the target is a real mismatch too — a principal
 * applying to an intern posting is a poor fit, and scoring it as a perfect match would
 * rank it at the top of the feed. (Over-qualified postings more than one band up are
 * already removed by the SCR-001 `seniority_over_band` gate, so the steepest region of
 * this curve rarely reaches scoring in practice.)
 *
 * `unknown` on either side is "no information", not "zero bands apart".
 */
function scoreSeniority(job: RuleJob, profile: RuleProfile): SubScore {
  const jobRank = seniorityRank(job.seniority);
  const targetRank = seniorityRank(profile.seniority);
  if (jobRank === null || targetRank === null) return unknown();

  return { raw: clamp01(1 - Math.abs(jobRank - targetRank) / SENIORITY_SPAN), known: true };
}

// ---------------------------------------------------------------------------
// Component 3 — compensation (15)
// ---------------------------------------------------------------------------

/**
 * Compensation sub-score: how the advertised pay compares to the stated floor.
 *
 * Ratio-based rather than a difference, because a ₹15L floor and a ₹10L offer are a
 * meaningfully worse fit than a ₹90L floor and an ₹85L offer, and only the ratio says so.
 *
 * Returns neutral — never 0 — for every "we cannot tell" case, which is the whole of
 * docs/03 §6.1 X-09: undisclosed, no floor set, currency mismatch, or an hourly rate we
 * refuse to annualise.
 */
function scoreCompensation(job: RuleJob, profile: RuleProfile): SubScore {
  if (profile.minSalary === null) return unknown();

  const advertised = job.salaryMax ?? job.salaryMin;
  if (advertised === null) return unknown();

  const jobCurrency = job.salaryCurrency?.toUpperCase() ?? null;
  const floorCurrency = profile.salaryCurrency?.toUpperCase() ?? null;
  if (jobCurrency === null || floorCurrency === null || jobCurrency !== floorCurrency) {
    return unknown();
  }

  const jobAnnual = toAnnualSalary(advertised, job.salaryPeriod);
  const floorAnnual = toAnnualSalary(profile.minSalary, profile.salaryPeriod);
  if (jobAnnual === null || floorAnnual === null || floorAnnual <= 0) return unknown();

  // Clamped: paying above the floor is not extra credit beyond a full component.
  return { raw: clamp01(jobAnnual / floorAnnual), known: true };
}

// ---------------------------------------------------------------------------
// Component 4 — location / work mode (15)
// ---------------------------------------------------------------------------

/**
 * Split of the combined location/work-mode component.
 *
 * Work mode dominates because it is the stated preference (`profiles.work_modes`), and
 * location is a secondary signal. 0.7/0.3 rather than an even split, because a
 * candidate who wants remote and is offered onsite has a structural problem that a
 * matching city does not offset.
 */
const MODE_SHARE = 0.7;
const LOCATION_SHARE = 0.3;

const UNKNOWN_MODE_RAW = 0.6;

function scoreWorkMode(job: RuleJob, profile: RuleProfile): SubScore {
  if (profile.workModes.length === 0) return unknown();

  // An undisclosed work mode is partial credit, not zero: the posting did not say no.
  // It is `known: false` so the breakdown cannot claim the mode was a match.
  if (job.workMode === "unknown") return { raw: UNKNOWN_MODE_RAW, known: false };

  if (!profile.workModes.includes(job.workMode)) {
    // A mode the user excluded. Not zero — a user listing only "remote" may still want
    // to see a hybrid role — but a low score, and it is already gated separately.
    return { raw: 0.2, known: true };
  }

  return { raw: 1, known: true };
}

function scoreLocation(job: RuleJob, profile: RuleProfile): SubScore {
  if (profile.countryCode === null) return unknown();

  if (job.countryCode === null) return unknown();

  if (job.countryCode.toUpperCase() === profile.countryCode.toUpperCase()) {
    return { raw: 1, known: true };
  }

  // A remote role is reachable from another country, but not equally so everywhere:
  // BE-317's whole point is that "Remote – India" and "Remote – Worldwide" are
  // different jobs for an Indian candidate.
  if (job.workMode === "remote" || job.workMode === "hybrid") {
    if (job.remoteScope === "global") return { raw: 0.9, known: true };
    if (job.remoteScope === "india") {
      return {
        raw: profile.countryCode.toUpperCase() === "IN" ? 1 : 0.5,
        known: true,
      };
    }
    return { raw: 0.7, known: true };
  }

  return { raw: 0.2, known: true };
}

/** The combined component, reported as one 15-point entry per docs/04 §3.4. */
function scoreLocationAndWorkMode(job: RuleJob, profile: RuleProfile): SubScore {
  const mode = scoreWorkMode(job, profile);
  const location = scoreLocation(job, profile);

  // `known` requires **both** halves to be real judgements.
  //
  // An earlier revision used `||`, on the reasoning that "one known half is enough to
  // score". That conflates having a number with having grounds for it: with the work
  // mode undisclosed and the country matching, the component reports 0.72 where a third
  // of the weight was a standing assumption about the mode. Labelling that `known: true`
  // would let the UI present a guess as a finding, which is the exact thing `known`
  // exists to prevent. `&&` keeps the honest reading — the component states what it
  // knows, and flags itself as partly inferred whenever any part of it is.
  return {
    raw: clamp01(mode.raw * MODE_SHARE + location.raw * LOCATION_SHARE),
    known: mode.known && location.known,
  };
}

// ---------------------------------------------------------------------------
// Component 5 — recency (10)
// ---------------------------------------------------------------------------

/** Days after which the recency sub-score reaches zero. */
const RECENCY_HORIZON_DAYS = 28;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Recency sub-score: linear decay to zero across the freshness window.
 *
 * The horizon is 28 days because that is where docs/02b §6.4 expires a job
 * (`active → stale` at 14 days unseen, `stale → expired` at 28). Scoring on the same
 * boundary the lifecycle uses means a job cannot be scored as fresh by this function
 * and expired by the cron at the same moment.
 *
 * Strictly monotonic non-increasing, which SCR-002 requires and which is asserted in
 * the tests: an older posting never scores higher than a newer one.
 */
function scoreRecency(job: RuleJob, now: Date): SubScore {
  if (job.postedAt === null) return unknown();

  const posted = new Date(job.postedAt);
  const postedMs = posted.getTime();
  if (Number.isNaN(postedMs)) return unknown();

  const ageDays = (now.getTime() - postedMs) / MS_PER_DAY;
  // A `posted_at` in the future is a source clock problem, not a very fresh job.
  // Clamping to 0 rather than scoring above 1 keeps the sub-score in range and stops
  // one bad timestamp outranking everything.
  if (ageDays < 0) return { raw: 1, known: true };

  return { raw: clamp01(1 - ageDays / RECENCY_HORIZON_DAYS), known: true };
}

// ---------------------------------------------------------------------------
// Component 6 — company preference (10)
// ---------------------------------------------------------------------------

/**
 * Company-preference sub-score.
 *
 * Binary, and only when the user has expressed a preference. With an empty
 * `preferred_companies` this is neutral rather than 0 — "no companies listed" is not
 * "every company is unwanted". With a non-empty list, a miss scores 0: the user took
 * the trouble to name companies, and the +10 in docs/02a §5.3 is a bonus for hitting
 * them, not a penalty for missing them on top of everything else already scoring.
 */
function scoreCompanyPreference(job: RuleJob, profile: RuleProfile): SubScore {
  if (profile.preferredCompanies.length === 0) return unknown();

  const candidates = companySlugCandidates({
    companyName: job.companyName,
    companyDomain: job.companyDomain,
  });
  if (candidates.length === 0) return unknown();

  const hit = candidates.some((c) => profile.preferredCompanies.includes(c));
  return { raw: hit ? 1 : 0, known: true };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Score one job against one profile. Pure and deterministic.
 *
 * `breakdown` is always emitted and always has one entry per weight, in
 * {@link RULE_WEIGHTS} order — docs/04 §3.4 renders them positionally, and a missing
 * entry would shift every label below it.
 */
export function scoreRule(input: RuleScoreInput): RuleScoreResult {
  const { job, profile, now } = input;

  const subScores: Record<RuleComponentKey, SubScore> = {
    skills: scoreSkills(input.jobSkills, input.profileSkills),
    seniority: scoreSeniority(job, profile),
    compensation: scoreCompensation(job, profile),
    "work-mode": scoreLocationAndWorkMode(job, profile),
    recency: scoreRecency(job, now),
    "company-preference": scoreCompanyPreference(job, profile),
  };

  const breakdown: BreakdownEntry[] = RULE_WEIGHTS.map((entry) => {
    const sub = subScores[entry.key];
    const raw = clamp01(sub.raw);
    return {
      key: entry.key,
      weight: entry.weight,
      raw: round2(raw),
      points: round2(raw * entry.weight),
      known: sub.known,
    };
  });

  const total = breakdown.reduce((sum, b) => sum + b.points, 0);

  return { score: round2(total), breakdown, modelVersion: RULE_MODEL_VERSION };
}