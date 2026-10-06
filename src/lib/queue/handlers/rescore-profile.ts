/**
 * rescore-profile.ts — the `rescore_profile` task handler (SCR-005, BE-205).
 *
 * docs/02b §6.3: a profile save queues a `rescore_profile` task, which requeues affected
 * jobs **asynchronously** (C4 — never in the request path). BE-304 already enqueues the
 * task via `enqueue_rescore_profile()`; this module is the other end of that contract.
 *
 * ## The split, and why it is here
 *
 * - {@link planRescoreBatch} is **pure**: it decides which (user, job) pairs to score in
 *   this batch and what to do about a partial batch. No clock, no database.
 * - {@link runRescoreProfile} is the **executor**: it reads, scores, and writes.
 *
 * docs/02 §6.4 states the governing constraint directly: "Vercel function timeouts are
 * respected by **batch size, not long-running loops** — if a batch is incomplete, the
 * handler re-enqueues itself." That is why {@link planRescoreBatch} returns a
 * `requeue` verdict rather than looping internally: a handler that tried to finish every
 * job in one invocation would either time out mid-write or hold a worker for minutes,
 * and Vercel kills the function while the lease is still held.
 *
 * ## Concurrency
 *
 * Two workers may hold two pending `rescore_profile` tasks for the same profile at once.
 * That is safe **because every write is an upsert keyed on `(user_id, job_id)`** — the
 * work is idempotent by construction rather than by a lock. `sighting_count`-style
 * accumulation is deliberately avoided here, since that would double-count under a race.
 *
 * ## Growth
 *
 * SCR-005 requires "no unbounded growth of `job_scores`". That is a consequence of the
 * upsert: one row per (user, job) pair, overwritten in place, with `explanation`
 * deliberately untouched by {@link persistScore}.
 */

import { composeScore, coverage } from "@/lib/scoring";
import { cosineSimilarityPercent } from "@/lib/scoring/semantic";
import type { GateJob, GateProfile } from "@/lib/scoring/gates";
import type { RuleJob, RuleProfile } from "@/lib/scoring/rules";
import { logger } from "@/lib/logger";

/**
 * Jobs scored per handler invocation.
 *
 * Sized against the docs/02 §6.4 constraint rather than picked for speed: a profile with
 * 2,000 active jobs would need 20 invocations at 100 each. Each invocation is bounded,
 * so the total time is bounded by the number of invocations, not by the size of the
 * user's feed. Raising this trades Vercel's timeout budget for rescore latency.
 */
export const RESCORE_BATCH_SIZE = 100;

/** The job rows this handler needs. */
export interface RescoreJobRow {
  id: string;
  title: string;
  company_name: string | null;
  company_domain: string | null;
  description_text: string | null;
  country_code: string | null;
  work_mode: GateJob["workMode"];
  remote_scope: RuleJob["remoteScope"];
  seniority: GateJob["seniority"];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: "year" | "month" | "hour" | null;
  posted_at: string | null;
  embedding: number[] | null;
}

/** The profile row fields scoring reads. */
export interface RescoreProfileRow {
  id: string;
  target_titles: string[];
  seniority: RuleProfile["seniority"];
  years_experience: number | null;
  country_code: string | null;
  work_modes: GateProfile["workModes"];
  min_salary: number | null;
  salary_currency: string | null;
  salary_period: "year" | "month" | "hour" | null;
  preferred_companies: string[];
  blocked_companies: string[];
  excluded_keywords: string[];
  profile_embedding: number[] | null;
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/** What the handler should do after processing a batch. */
export type RescoreVerdict =
  /** Every remaining job was scored in this batch. */
  | { kind: "done"; scored: number; total: number; coverage: number }
  /**
   * More jobs remain. `resumeAfter` is the `posted_at` cursor to continue from — the
   * handler re-enqueues itself rather than looping (docs/02 §6.4).
   */
  | { kind: "requeue"; scored: number; total: number; coverage: number; resumeAfter: string };

export interface PlanRescoreInput {
  /**
   * The jobs still to score, already limited by the caller's cursor.
   *
   * The cursor lives in the store, not here. An earlier revision sliced this list again
   * based on `resumeAfter`, which double-applied the pagination: the executor had already
   * skipped past the cursor, so slicing a second time silently dropped the first job of
   * every resumed batch — a job the next cursor would then move past, so it would never
   * be scored at all. One place owns the cursor.
   */
  jobs: RescoreJobRow[];
  batchSize?: number;
}

/**
 * Decide whether this invocation covers every remaining job, or must re-enqueue itself.
 *
 * Pure, so the "bounded batch, re-enqueue if incomplete" rule is testable without a
 * queue, a database, or a clock.
 *
 * `total` is the real remaining count from the store, not the batch length. A batch of
 * 100 against 2,000 remaining is 5%, and reporting that as "done" is the whole bug this
 * function exists to prevent — which is why coverage is measured against `total`.
 */
export function planRescoreBatch(input: PlanRescoreInput, total: number): RescoreVerdict {
  const batchSize = input.batchSize ?? RESCORE_BATCH_SIZE;
  const jobs = input.jobs;

  // Completeness is decided by `total` — the store's count of what remains — and never by
  // `jobs.length`. The store already limits the query to `batchSize`, so a full batch is
  // indistinguishable from a complete feed by length alone: an earlier revision reported
  // "done" whenever `jobs.length <= batchSize`, which is true for *every* full batch, so a
  // profile with 2,000 jobs would score 100 and be marked finished with 1,900 unscored.
  const complete = jobs.length >= total;

  if (complete) {
    return { kind: "done", scored: jobs.length, total, coverage: coverage(jobs.length, total) };
  }

  // Continue from the last job in this batch. `posted_at` is nullable, so the cursor
  // falls back to an empty string; the executor re-reads from the cursor rather than
  // trusting this value to be a timestamp.
  const last = jobs[batchSize - 1];
  return {
    kind: "requeue",
    scored: Math.min(batchSize, jobs.length),
    total,
    coverage: coverage(Math.min(batchSize, jobs.length), total),
    resumeAfter: last?.posted_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The database operations the executor needs, injected so it can be tested. */
export interface RescoreStore {
  /** Jobs to score, ordered stably, starting after `resumeAfter` when given. */
  listJobs(profileId: string, resumeAfter: string | null, limit: number): Promise<RescoreJobRow[]>;
  /** Count of remaining unscored-or-stale jobs for this profile. */
  countRemaining(profileId: string): Promise<number>;
  /** `job_skills` for a set of jobs, in one query. */
  listJobSkills(jobIds: string[]): Promise<{ job_id: string; skill_id: string; weight: number | null }[]>;
  /** `profile_skills` for the profile. */
  listProfileSkills(
    profileId: string,
  ): Promise<{ skill_id: string; level: "familiar" | "proficient" | "expert" | null }[]>;
  /** Persist one composed score. */
  saveScore(score: ReturnType<typeof composeScore>): Promise<{ ok: boolean }>;
  /** Re-queue this profile for another pass. */
  requeue(profileId: string, resumeAfter: string): Promise<void>;
}

export interface RunRescoreResult {
  scored: number;
  failed: number;
  verdict: RescoreVerdict;
}

export interface RunRescoreOptions {
  store: RescoreStore;
  profile: RescoreProfileRow;
  resumeAfter?: string | null;
  batchSize?: number;
  now: Date;
}

/**
 * Score one batch for one profile, then re-enqueue if work remains.
 *
 * Every per-job failure is counted and skipped rather than thrown: one malformed job row
 * must not abort a batch of 100 and leave the remaining 99 unscored with the task marked
 * failed. The batch verdict still reports the shortfall, and `coverage` is measured
 * against the real total, so a chronic failure shows up as coverage below the SCR-004
 * threshold rather than as a silently healthy queue.
 */
export async function runRescoreProfile(
  options: RunRescoreOptions,
): Promise<RunRescoreResult> {
  const { store, profile, now } = options;
  const batchSize = options.batchSize ?? RESCORE_BATCH_SIZE;
  const resumeAfter = options.resumeAfter ?? null;

  const jobs = await store.listJobs(profile.id, resumeAfter, batchSize);
  const total = await store.countRemaining(profile.id);

  const jobIds = jobs.map((j) => j.id);
  const jobSkills = jobIds.length > 0 ? await store.listJobSkills(jobIds) : [];
  const profileSkills = await store.listProfileSkills(profile.id);

  const skillsByJob = new Map<string, { skillId: string; weight: number | null }[]>();
  for (const row of jobSkills) {
    const list = skillsByJob.get(row.job_id) ?? [];
    list.push({ skillId: row.skill_id, weight: row.weight });
    skillsByJob.set(row.job_id, list);
  }

  let scored = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const composed = composeScore({
        profileId: profile.id,
        jobId: job.id,
        job: {
          title: job.title,
          companyName: job.company_name,
          companyDomain: job.company_domain,
          descriptionText: job.description_text,
          countryCode: job.country_code,
          workMode: job.work_mode,
          remoteScope: job.remote_scope,
          seniority: job.seniority,
          salaryMin: job.salary_min,
          salaryMax: job.salary_max,
          salaryCurrency: job.salary_currency,
          salaryPeriod: job.salary_period,
          postedAt: job.posted_at,
        },
        profile: {
          targetTitles: profile.target_titles,
          seniority: profile.seniority,
          yearsExperience: profile.years_experience,
          countryCode: profile.country_code,
          workModes: profile.work_modes,
          minSalary: profile.min_salary,
          salaryCurrency: profile.salary_currency,
          salaryPeriod: profile.salary_period,
          preferredCompanies: profile.preferred_companies,
          blockedCompanies: profile.blocked_companies,
          excludedKeywords: profile.excluded_keywords,
        },
        jobSkills: skillsByJob.get(job.id) ?? [],
        profileSkills: profileSkills.map((s) => ({ skillId: s.skill_id, level: s.level })),
        semanticScore: cosineSimilarityPercent(job.embedding, profile.profile_embedding),
        now,
      });

      const saved = await store.saveScore(composed);
      if (saved.ok) scored++;
      else failed++;
    } catch (error) {
      // One bad row must not cost the other 99.
      failed++;
      logger.error("Rescore failed for one job", {
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const verdict = planRescoreBatch({ jobs, batchSize }, total);

  if (verdict.kind === "requeue") {
    await store.requeue(profile.id, verdict.resumeAfter);
  }

  logger.info("Rescore batch complete", {
    profileId: profile.id,
    scored,
    failed,
    verdict: verdict.kind,
  });

  return { scored, failed, verdict };
}