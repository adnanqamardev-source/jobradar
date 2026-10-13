/**
 * queries/resume-versions.ts — the user's résumé versions (JOB-003).
 *
 * The mark-as-applied dialog offers a résumé picker. docs/05c JOB-003 requires it to list
 * `resume_versions` with an **empty state if none, non-blocking** — a user who has not
 * uploaded a résumé can still record an application, so this never throws for "no rows".
 *
 * Same boundary as `queries/feed.ts`: Zod first, columns derived from the schema, and the
 * caller passes the RLS-scoped client. `resume_versions` is owner-only under RLS
 * (`resume_versions_owner_all`, 0001_init.sql), so this query cannot read another user's.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/db/user-client";

/** The picker needs an id and something to show; `file_path` is the display value. */
export const resumeVersionSchema = z.object({
  id: z.string().uuid(),
  file_path: z.string(),
  created_at: z.string(),
});

export type ResumeVersion = z.infer<typeof resumeVersionSchema>;

const RESUME_VERSION_COLUMNS = Object.keys(resumeVersionSchema.shape).join(", ");

/**
 * The caller's résumé versions, newest first. Empty array when there are none.
 *
 * `file_path` is a storage path, not a display name — the dialog shows the last path
 * segment. It is never rendered as a link: `resumes` is a **private** bucket (docs/03
 * §4.2a), so a bare path is not fetchable without a signed URL.
 */
export async function queryResumeVersions(
  supabase: SupabaseClient,
): Promise<ResumeVersion[]> {
  const { data, error } = await supabase
    .from("resume_versions")
    .select(RESUME_VERSION_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const parsed = z.array(resumeVersionSchema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(`resume_versions row failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}