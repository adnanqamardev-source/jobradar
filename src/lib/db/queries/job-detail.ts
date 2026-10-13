/**
 * queries/job-detail.ts — one job, its score, and its sightings (FE-108, FE-109, JOB-004).
 *
 * ## Why three queries and not the feed view
 *
 * `v_ranked_jobs` is the *feed* projection: score-ordered, already joined to `job_scores`,
 * carrying the three per-user EXISTS columns. The detail page needs a different set —
 * `description_text`, `description_html`, `source_url`, `apply_url`, `salary_raw`,
 * `location_raw` — and a view that served both would be a wide row most callers never read.
 * So this reads `jobs` and `job_scores` directly, plus `job_sightings` from the module that
 * owns it.
 *
 * `jobs` is readable by any authenticated user (`jobs_authenticated_read`, 0001:666) and
 * `job_scores` only by its owner (`job_scores_owner_select`, 0001:652), so the caller's
 * RLS-scoped client returns exactly their own score. That is the whole authorisation story for
 * this page: there is no per-user `jobs` row to leak.
 *
 * ## Missing vs forbidden
 *
 * JOB-001 requires a 404 for an id the caller may not see that is **byte-identical** to a 404
 * for an id that does not exist. Since `jobs` is shared corpus, both cases are the same code
 * path: no row comes back, and {@link queryJobDetail} returns `null`. The page calls
 * `notFound()`. There is deliberately no branch that distinguishes them — a different error
 * body would be exactly the leak the criterion forbids.
 *
 * `last_seen_at` is in the projection on purpose: JOB-001's first done-when names it
 * explicitly, and it is the field that tells a user this posting is still live.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";
import { queryJobSightings, type JobSighting } from "@/lib/db/queries/sightings";
import { dbTimestampSchema } from "@/types/db";
import { appStageSchema } from "@/types/db";
import type { BreakdownEntry } from "@/lib/scoring/rules";
import type { GateReason } from "@/lib/scoring/gates";

/** `job_scores.gate_result` — docs/02a §5.5: `{ "passed": false, "reasons": [...] }`. */
const gateResultSchema = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string()),
});

/**
 * One `job_scores.breakdown` row (docs/02a §5.5, shape pinned by `scoring/rules.ts`).
 * Always present for a scored job — C3, so the UI never renders a bare score.
 */
const breakdownEntrySchema = z.object({
  key: z.string(),
  weight: z.number(),
  raw: z.number(),
  points: z.number(),
  known: z.boolean(),
});

/**
 * The `jobs` projection the detail page renders.
 *
 * `dbTimestampSchema` because every timestamp here is a `timestamptz` read back from
 * Postgres — see the note on that schema. `skills` is nullable (`text[]`, no default,
 * 0001:256) and stays nullable here rather than being normalised, because the schema reports
 * what the database holds and the component decides how to present it.
 */
const jobRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  company_name: z.string(),
  company_domain: z.string().nullable(),
  location_raw: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country_code: z.string().nullable(),
  work_mode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  remote_scope: z.enum(["india", "global", "unknown"]),
  employment_type: z.string(),
  seniority: z.string(),
  salary_min: z.number().nullable(),
  salary_max: z.number().nullable(),
  salary_currency: z.string().nullable(),
  salary_period: z.string().nullable(),
  salary_raw: z.string().nullable(),
  description_text: z.string().nullable(),
  description_html: z.string().nullable(),
  skills: z.array(z.string()).nullable(),
  posted_at: dbTimestampSchema.nullable(),
  first_seen_at: dbTimestampSchema,
  last_seen_at: dbTimestampSchema,
  sighting_count: z.number(),
  status: z.enum(["active", "stale", "expired", "removed"]),
  source_url: z.string(),
  apply_url: z.string().nullable(),
});

/** The caller's score for this job. Nullable fields are genuine nulls, not coercions. */
const scoreRowSchema = z.object({
  final_score: z.number(),
  rule_score: z.number().nullable(),
  semantic_score: z.number().nullable(),
  gate_result: gateResultSchema.nullable(),
  breakdown: z.array(breakdownEntrySchema).nullable(),
  explanation: z.string().nullable(),
  scored_at: dbTimestampSchema,
  model_version: z.string().nullable(),
});

/** The caller's application for this job, if any (FE-108 shows its stage). */
const applicationRowSchema = z.object({
  id: z.string().uuid(),
  stage: appStageSchema,
  applied_at: dbTimestampSchema.nullable(),
  next_action_at: dbTimestampSchema.nullable(),
  notes: z.string().nullable(),
});

const JOB_COLUMNS = Object.keys(jobRowSchema.shape).join(", ");
const SCORE_COLUMNS = Object.keys(scoreRowSchema.shape).join(", ");
const APPLICATION_COLUMNS = Object.keys(applicationRowSchema.shape).join(", ");

export interface JobDetail {
  job: z.infer<typeof jobRowSchema>;
  /** `null` when the caller has never been scored against this job. */
  score: z.infer<typeof scoreRowSchema> | null;
  /** `null` when the caller has no application for it. */
  application: z.infer<typeof applicationRowSchema> | null;
  sightings: JobSighting[];
}

/** Re-exported so the breakdown component types its props without reaching into scoring. */
export type { BreakdownEntry };
export type DetailGateReason = GateReason;

/**
 * Load one job for the detail page.
 *
 * @returns The job with its score, application and sightings, or `null` when there is no such
 *          row visible to this caller. The three sub-queries run concurrently — they are
 *          independent reads and the detail page is not on the LCP-critical feed path.
 *
 * A `job_scores` or `applications` read that *fails* is not fatal: the job still renders. A
 * missing score is a normal state (the job was ingested after this user's last rescore) and a
 * missing application is the normal state for most jobs. Only the `jobs` read decides whether
 * the page exists, because without it there is nothing to render.
 */
export async function queryJobDetail(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobDetail | null> {
  const [jobResult, scoreResult, applicationResult, sightings] = await Promise.all([
    supabase.from("jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle(),
    supabase
      .from("job_scores")
      .select(SCORE_COLUMNS)
      .eq("job_id", jobId)
      .maybeSingle(),
    supabase
      .from("applications")
      .select(APPLICATION_COLUMNS)
      .eq("job_id", jobId)
      .maybeSingle(),
    // A `jobs` row with no sighting (pre-0012 data) must not 404 the page, so a read failure
    // degrades to "no other sources" instead of propagating.
    queryJobSightings(supabase, jobId).catch(() => [] as JobSighting[]),
  ]);

  if (jobResult.error) {
    // Includes `22P02 invalid_input_syntax` for a malformed uuid. The page treats both an
    // unknown column and an unparseable id as "no such job", so a hand-edited URL cannot
    // produce a 500 — see "Missing vs forbidden" in the header.
    return null;
  }
  if (!jobResult.data) return null;

  const job = jobRowSchema.safeParse(jobResult.data);
  if (!job.success) return null;

  const score = scoreResult.error ? null : scoreRowSchema.safeParse(scoreResult.data ?? null);
  const application = applicationResult.error
    ? null
    : applicationRowSchema.safeParse(applicationResult.data ?? null);

  return {
    job: job.data,
    score: score?.success ? score.data : null,
    application: application?.success ? application.data ?? null : null,
    sightings,
  };
}
