/**
 * queries/applications.ts — the tracker's reads (FE-111, FE-112).
 *
 * ## Why a query module and not `.from()` in the page
 *
 * docs/06 §8.1: "Components never call PostgREST directly — only `lib/db/queries/` and Server
 * Actions." `/applications` would otherwise reach for `.from("applications")` and hand the page
 * `any` for every column, because the Supabase client carries no database generic. The
 * `@typescript-eslint/no-unsafe-*` rules fire on all of it, and the lint rule and the
 * architecture rule are the same rule.
 *
 * ## Two reads, because the board and the drawer need different shapes
 *
 * The board wants one row per application, grouped client-side into columns. The drawer wants the
 * append-only `application_events` history. Neither needs the other's columns, and returning the
 * events with every board row would be a cartesian product the UI then has to unpick.
 *
 * ## `job_snapshot` is the fallback, not a convenience
 *
 * `applications.job_snapshot` captures title/company/salary (docs/03 §5.2, "Deleted job while an
 * application references it") so a tracker row still renders after the source deletes the job —
 * which only became true when `0016` relaxed `job_id` to `on delete set null`.
 * `queryApplications` reads the live job when it exists and
 * falls back to the snapshot when it does not, so the board shows one consistent card rather
 * than a row with half its fields missing.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";
import { applicationStageSchema } from "@/lib/tracker/stages";
import { dbTimestampSchema } from "@/types/db";

/** The snapshot fields `markApplied` writes. Validated so a malformed row is a visible error. */
const jobSnapshotSchema = z.object({
  title: z.string(),
  company: z.string().nullable().optional(),
  salary: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
});

export interface TrackerCard {
  applicationId: string;
  /**
   * Null once the job has been deleted — `applications.job_id` is `on delete set null` (0016),
   * which is what lets `jobSnapshot` be the fallback docs/03 §5.2 describes.
   *
   * Non-null whenever `jobLive` is true, because that flag *is* the presence of the embedded job
   * row this id points at. The two are read together, never independently.
   */
  jobId: string | null;
  stage: z.infer<typeof applicationStageSchema>;
  appliedAt: string | null;
  nextActionAt: string | null;
  notes: string | null;
  updatedAt: string;
  /** Present when the source job still exists; `false` means the snapshot is carrying the card. */
  jobLive: boolean;
  title: string;
  company: string | null;
  salary: string | null;
}

const cardRowSchema = z.object({
  id: z.string().uuid(),
  // Nullable since 0016: a deleted job leaves the application standing with job_id null. The
  // embed is what actually tells the UI which case it is in.
  job_id: z.string().uuid().nullable(),
  stage: applicationStageSchema,
  applied_at: dbTimestampSchema.nullable(),
  next_action_at: dbTimestampSchema.nullable(),
  notes: z.string().nullable(),
  updated_at: dbTimestampSchema,
  job_snapshot: jobSnapshotSchema,
  // PostgREST returns nulls for every column of a missing left join, so the embedded job arrives
  // as an object of nulls rather than as `null` unless `!inner` is used. The shape distinguishes
  // "no live job" from "live job with no company_name".
  jobs: z
    .object({
      id: z.string().uuid(),
      title: z.string(),
      company_name: z.string().nullable(),
      salary_min: z.number().nullable(),
      salary_currency: z.string().nullable(),
    })
    .nullable(),
});

/** One `application_events` row, newest first — TRK-002's timeline. */
export interface TrackerEvent {
  id: string;
  fromStage: z.infer<typeof applicationStageSchema> | null;
  toStage: z.infer<typeof applicationStageSchema>;
  note: string | null;
  occurredAt: string;
}

const eventRowSchema = z.object({
  id: z.string().uuid(),
  from_stage: applicationStageSchema.nullable(),
  to_stage: applicationStageSchema,
  note: z.string().nullable(),
  occurred_at: dbTimestampSchema,
});

const CARD_SELECT = [
  "id",
  "job_id",
  "stage",
  "applied_at",
  "next_action_at",
  "notes",
  "updated_at",
  "job_snapshot",
  "jobs(id,title,company_name,salary_min,salary_currency)",
].join(", ");

/**
 * Every application the caller owns, newest activity first.
 *
 * @returns an empty array when there are none — the board renders a per-column empty state, so
 *          "no applications" is a normal state and not an error.
 *
 * Scoped by `user_id` explicitly as well as relying on RLS. The two are not redundant: RLS is a
 * policy that can be edited, and a missing or inverted predicate there would surface as *another
 * user's applications on this user's board*. The explicit filter makes that failure mode "an empty
 * board", which is a visible bug, rather than a silent data leak.
 */
export async function queryApplications(
  supabase: SupabaseClient,
  userId: string,
): Promise<TrackerCard[]> {
  const { data, error } = await supabase
    .from("applications")
    .select(CARD_SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`queryApplications failed: ${error.message}`);

  const rows = z.array(cardRowSchema).safeParse(data ?? []);
  if (!rows.success) {
    // A row that does not match is a bug (a new stage, a changed column), not something to
    // silently drop: dropping it would render a shorter board with no explanation.
    throw new Error(`queryApplications: unexpected row shape — ${rows.error.message}`);
  }

  // Mapped by `toCard` rather than inline: the board and any future single-card read must not be
  // able to disagree about, say, whether salary falls back to the snapshot.
  return rows.data.map(toCard);
}

/** The append-only history for one application, newest first (TRK-002). */
export async function queryApplicationEvents(
  supabase: SupabaseClient,
  applicationId: string,
): Promise<TrackerEvent[]> {
  const { data, error } = await supabase
    .from("application_events")
    .select("id, from_stage, to_stage, note, occurred_at")
    .eq("application_id", applicationId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false });

  if (error) throw new Error(`queryApplicationEvents failed: ${error.message}`);

  const rows = z.array(eventRowSchema).safeParse(data ?? []);
  if (!rows.success) {
    throw new Error(`queryApplicationEvents: unexpected row shape — ${rows.error.message}`);
  }

  return rows.data.map((row) => ({
    id: row.id,
    fromStage: row.from_stage,
    toStage: row.to_stage,
    note: row.note,
    occurredAt: row.occurred_at,
  }));
}

/** Shared row -> card mapping, so the board and the drawer cannot disagree on a field. */
function toCard(row: z.infer<typeof cardRowSchema>): TrackerCard {
  return {
    applicationId: row.id,
    jobId: row.job_id,
    stage: row.stage,
    appliedAt: row.applied_at,
    nextActionAt: row.next_action_at,
    notes: row.notes,
    updatedAt: row.updated_at,
    jobLive: row.jobs !== null,
    title: row.jobs?.title ?? row.job_snapshot.title,
    company: row.jobs?.company_name ?? row.job_snapshot.company ?? null,
    salary:
      row.jobs?.salary_min !== null && row.jobs?.salary_min !== undefined
        ? `${row.jobs.salary_min}${row.jobs.salary_currency ? ` ${row.jobs.salary_currency}` : ""}`
        : (row.job_snapshot.salary ?? null),
  };
}