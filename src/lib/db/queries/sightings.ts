/**
 * queries/sightings.ts — where each sighting of a job was seen (FED-005).
 *
 * ## Why this module exists
 *
 * `jobs.dedupe_hash` is UNIQUE, so a duplicate cluster is one row and `jobs.sighting_count`
 * is only an integer. The chip on the card can say "Seen on 3 sources" from that, but
 * nothing could say *which* — there was no table of individual sightings until migration
 * `0012_job_sightings.sql`. This is the read path for that table; FE-108's detail view is
 * its first consumer.
 *
 * ## Shape
 *
 * One row per (job, source posting URL), newest sighting first. `source_id` is nullable
 * because a deactivated source nulls it (`on delete set null`) — the sighting evidence
 * outlives the provider row.
 *
 * ## Boundary
 *
 * Same rules as `queries/feed.ts`: Zod validates the row, the column list is derived from
 * the schema so a typo cannot silently widen the query, and the caller passes the
 * RLS-scoped client. Components never call PostgREST directly (docs/06 §8.1).
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";
import { dbTimestampSchema } from "@/types/db";

/** One row of `job_sightings` as PostgREST returns it. */
export const jobSightingSchema = z.object({
  source_id: z.string().uuid().nullable(),
  source_url: z.string(),
  // `timestamptz` read back from Postgres, which emits `…+00:00`. See `dbTimestampSchema`.
  first_seen_at: dbTimestampSchema,
  last_seen_at: dbTimestampSchema,
  sighting_count: z.number(),
});

export type JobSighting = z.infer<typeof jobSightingSchema>;

const SIGHTING_COLUMNS = Object.keys(jobSightingSchema.shape).join(", ");

/**
 * Every source this posting was seen on, most recently seen first.
 *
 * Returns an empty array rather than throwing when there are no sightings: a job ingested
 * before `0012`, or one whose only sighting row predates the table, is a normal state and
 * the detail view renders it as "no other sources". An empty feed of sources must not be
 * an error on a page that otherwise has a job to show.
 *
 * A row that fails the schema is an error, not a silent drop — the same rule as the feed
 * query: a shape change is a bug to surface, and a sighting list that quietly omits a
 * source is the exact "partial-source failures hide a live job" case FED-005 calls out.
 */
export async function queryJobSightings(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobSighting[]> {
  const { data, error } = await supabase
    .from("job_sightings")
    .select(SIGHTING_COLUMNS)
    .eq("job_id", jobId)
    .order("last_seen_at", { ascending: false });

  if (error) throw error;

  const parsed = z.array(jobSightingSchema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(`job_sightings row failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}