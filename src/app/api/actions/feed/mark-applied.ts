/**
 * mark-applied.ts — Mark a job as applied (BE-305, FED-002, TRK-001).
 *
 * Creates the `applications` row (stage `applied`) plus the initial
 * `application_events` row with `from_stage = null` — the append-only history
 * TRK-002 renders. The modal that collects the applied date, résumé version
 * and notes is FE-110; this action is the write it performs.
 *
 * ## The snapshot is the point (X-16)
 *
 * `job_snapshot` captures title/company/salary/source so the tracker keeps
 * rendering the role after the source deletes it or the job expires. The
 * action reads the job through the caller's own client and snapshots the
 * display fields — never the whole row, and never `description_html`.
 *
 * ## Idempotency
 *
 * `applications` has `unique (user_id, job_id)`, so a double submit — double
 * click, retry, two tabs — creates exactly one record. The upsert sends
 * `Prefer: resolution=ignore-duplicates`, which absorbs the race without a
 * check-then-insert window.
 *
 * **But an ignored duplicate is not returned.** With `resolution=ignore-duplicates`
 * PostgREST omits the conflicting row from the returned representation, so the
 * response is empty — `.single()` on it is `PGRST116`, not the existing record,
 * and an "idempotent" action that 500s on the second click is worse than one
 * that duplicates. The action therefore treats a returned row as "created" and
 * resolves the id through a second read otherwise.
 *
 * `tests/unit/feed-actions.test.ts` pins both halves: the client double models
 * `single()` as PGRST116-on-zero-rows while `maybeSingle()` is not, so the
 * test fails if the upsert terminal ever goes back to `.single()`.
 *
 * The initial `application_events` row is written on the same rule, and a
 * missing event is repaired even when the application already existed (a
 * previous run that died between the two writes). The history stays one
 * `null → applied` row per application.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { markAppliedRequestSchema } from "@/types/api";
import { dbTimestampSchema } from "@/types/db";
import type { FeedActionResult } from "./save-job";

/**
 * The snapshot source row, validated before it is written into
 * `applications.job_snapshot` (X-16). The Supabase client is untyped (no
 * database generic), so without this the snapshot would be an unvalidated
 * `GenericStringError` cast into jsonb.
 */
const jobSnapshotSourceSchema = z.object({
  title: z.string(),
  company_name: z.string(),
  company_domain: z.string().nullable(),
  location_raw: z.string().nullable(),
  salary_min: z.number().nullable(),
  salary_max: z.number().nullable(),
  salary_currency: z.string().nullable(),
  salary_period: z.string().nullable(),
  // Both of these were wrong in the same way as the feed row schema, and the second one is
  // a live bug rather than a latent one: `jobs.posted_at` is a `timestamptz` (PostgREST emits
  // `…+00:00`, which `.datetime()` rejects) and `jobs.skills` is a nullable `text[]`. Marking
  // applied a job ingested without skills failed snapshot validation and returned
  // `internal_error`. `dbTimestampSchema` is the read-from-Postgres form; see types/db.ts.
  posted_at: dbTimestampSchema.nullable(),
  seniority: z.string(),
  employment_type: z.string(),
  work_mode: z.string(),
  // Faithful to the column: the schema reports what the database holds rather than
  // normalising it, so the tracker (FE-111/112) must read `skills === null` as "no skills".
  skills: z.array(z.string()).nullable(),
  source_url: z.string(),
});

/** The snapshot fields the tracker renders when the source job is gone. */
const JOB_SNAPSHOT_COLUMNS = Object.keys(jobSnapshotSourceSchema.shape).join(", ");

async function resolveExistingApplicationId(
  supabase: Awaited<ReturnType<typeof createUserClient>>,
  userId: string,
  jobId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("applications")
    .select("id")
    .eq("user_id", userId)
    .eq("job_id", jobId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return z.object({ id: z.string() }).parse(data).id;
}

export async function markApplied(input: unknown): Promise<FeedActionResult & { applicationId?: string }> {
  try {
    const { jobId, appliedAt, nextActionAt, notes, resumeVersionId } =
      markAppliedRequestSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select(JOB_SNAPSHOT_COLUMNS)
      .eq("id", jobId)
      .maybeSingle();

    if (jobError) throw jobError;
    if (!job) {
      return {
        ok: false,
        error: { code: "not_found", message: "We couldn't find that." },
      };
    }

    const snapshot = jobSnapshotSourceSchema.parse(job);

    // PostgREST drops ignored duplicates from the returned representation, so
    // this may be null ("created" is false → the application existed already).
    const { data: applicationRow, error: upsertError } = await supabase
      .from("applications")
      .upsert(
        {
          user_id: user.id,
          job_id: jobId,
          stage: "applied",
          applied_at: appliedAt,
          next_action_at: nextActionAt ?? null,
          notes: notes ?? null,
          resume_version_id: resumeVersionId ?? null,
          source: "manual",
          job_snapshot: snapshot,
        },
        { onConflict: "user_id,job_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (upsertError) throw upsertError;

    // Resolve the id (fresh or pre-existing) without assuming the upsert
    // returned it. Triggered by a race or a re-run.
    const applicationId =
      applicationRow !== null
        ? z.object({ id: z.string() }).parse(applicationRow).id
        : await resolveExistingApplicationId(supabase, user.id, jobId);

    if (!applicationId) {
      // The unique constraint guarantees a row; reaching here means a
      // genuine mismatch (RLS stripped it, or a stale read).
      return {
        ok: false,
        error: { code: "not_found", message: "We couldn't find that." },
      };
    }

    // Initial history row: from_stage null → 'applied' (TRK-001). Idempotent —
    // write it only when it isn't there already, so a re-run never duplicates
    // the history entry. Failure repair is deliberate: see the header note.
    const { data: existingEvent, error: eventLookupError } = await supabase
      .from("application_events")
      .select("id")
      .eq("application_id", applicationId)
      .is("from_stage", null)
      .eq("to_stage", "applied")
      .limit(1)
      .maybeSingle();

    if (eventLookupError) throw eventLookupError;

    if (!existingEvent) {
      const { error: eventError } = await supabase
        .from("application_events")
        .insert({
          application_id: applicationId,
          from_stage: null,
          to_stage: "applied",
          note: notes ?? null,
        });

      if (eventError) throw eventError;
    }

    return { ok: true, applied: true, applicationId };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: "validation_failed", message: "Please check your input and try again." },
      };
    }
    if (AppError.isAppError(error)) throw error;
    return {
      ok: false,
      error: { code: "internal_error", message: "Something went wrong. Try again." },
    };
  }
}
