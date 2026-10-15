/**
 * rescore-store.ts — Supabase adapter for `RescoreStore` (SCR-005, BE-205, BE-108).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RescoreStore, RescoreJobRow } from "@/lib/queue/handlers/rescore-profile";
import type { ComposedScore } from "@/lib/scoring";
import { persistScore } from "@/lib/scoring";

/**
 * A PostgREST `or=` filter selecting rows strictly "after" the cursor in this store's ordering.
 *
 * ## Why a plain `lt()` is wrong here
 *
 * The page is ordered `posted_at DESC, id ASC`, and a strict `lt("posted_at", cursor)` skips every
 * job that shares the cursor's timestamp. `posted_at` is not unique — on the linked project **30
 * jobs shared one timestamp** — so those jobs were skipped on every subsequent page and never
 * scored at all. Measured: 291 of 306 jobs scored, and the 15 missing were exactly the ties. The
 * feed looked complete; nothing said otherwise.
 *
 * ## Why this shape
 *
 * PostgREST cannot express a row-value comparison, so the lexicographic pair is written as the
 * equivalent `OR`:
 *
 *     posted_at <  C   OR   (posted_at = C AND id > I)
 *
 * `id >` rather than `<` because `id` ascends *within* one timestamp, so "further along the page"
 * at the same `posted_at` is a larger id. The pair is then a total order, which is what makes the
 * scan terminate: every row is visited exactly once.
 *
 * Returns `null` when there is no usable id — a first batch, or a cursor whose `posted_at` was
 * null — and the caller falls back to the plain timestamp filter, which is the pre-2026-10-15
 * behaviour: lossy exactly as before, and never newly wrong.
 */
function cursorFilter(resumeAfter: string, resumeAfterId: string | null): string | null {
  if (resumeAfterId === null) return null;
  // The timestamp is ISO-8601 with colons, which `or=` treats as a separator, so it is embedded
  // as a filter fragment (`posted_at.lt.<value>`) rather than as a bare value — that is the
  // documented form and it needs no escaping of the colons.
  return `posted_at.lt.${resumeAfter},and(posted_at.eq.${resumeAfter},id.gt.${resumeAfterId})`;
}

export function createSupabaseRescoreStore(supabase: SupabaseClient): RescoreStore {
  return {
    async listJobs(
      _profileId: string,
      resumeAfter: string | null,
      resumeAfterId: string | null,
      limit: number,
    ): Promise<RescoreJobRow[]> {
      let query = supabase
        .from("jobs")
        .select("id, title, company_name, company_domain, description_text, country_code, work_mode, remote_scope, seniority, salary_min, salary_max, salary_currency, salary_period, posted_at, embedding")
        .order("posted_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .limit(limit);

      // `resumeAfter` must be truthy, not merely non-null. The planner no longer writes an empty
      // cursor (that was the bug that made the scan permanently exhausted), but a task enqueued
      // before 2026-10-15 can still carry one, and treating `""` as a real timestamp filters
      // everything out.
      if (resumeAfter) {
        const filter = cursorFilter(resumeAfter, resumeAfterId);
        query = filter === null ? query.lt("posted_at", resumeAfter) : query.or(filter);
      }

      const { data, error } = await query;
      if (error) {
        throw new Error(`RescoreStore.listJobs failed: ${error.message}`);
      }

      const rawRows = (data ?? []) as Record<string, unknown>[];
      return rawRows.map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        title: typeof row.title === "string" ? row.title : "",
        company_name: typeof row.company_name === "string" ? row.company_name : null,
        company_domain: typeof row.company_domain === "string" ? row.company_domain : null,
        description_text: typeof row.description_text === "string" ? row.description_text : null,
        country_code: typeof row.country_code === "string" ? row.country_code : null,
        work_mode: (row.work_mode as RescoreJobRow["work_mode"]) ?? "unknown",
        remote_scope: (row.remote_scope as RescoreJobRow["remote_scope"]) ?? "unknown",
        seniority: (row.seniority as RescoreJobRow["seniority"]) ?? "unknown",
        salary_min: typeof row.salary_min === "number" ? row.salary_min : null,
        salary_max: typeof row.salary_max === "number" ? row.salary_max : null,
        salary_currency: typeof row.salary_currency === "string" ? row.salary_currency : null,
        salary_period: (row.salary_period as RescoreJobRow["salary_period"]) ?? null,
        posted_at: typeof row.posted_at === "string" ? row.posted_at : null,
        embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
      }));
    },

    async countRemaining(_profileId: string): Promise<number> {
      const { count, error } = await supabase
        .from("jobs")
        .select("*", { count: "exact", head: true });

      if (error) {
        return 0;
      }
      return count ?? 0;
    },

    async listJobSkills(jobIds: string[]): Promise<{ job_id: string; skill_id: string; weight: number | null }[]> {
      if (jobIds.length === 0) return [];
      const { data, error } = await supabase
        .from("job_skills")
        .select("job_id, skill_id, weight")
        .in("job_id", jobIds);

      if (error || !data) return [];
      const rows = data as Record<string, unknown>[];
      return rows.map((row) => ({
        job_id: typeof row.job_id === "string" ? row.job_id : "",
        skill_id: typeof row.skill_id === "string" ? row.skill_id : "",
        weight: typeof row.weight === "number" ? row.weight : null,
      }));
    },

    async listProfileSkills(profileId: string): Promise<{ skill_id: string; level: "familiar" | "proficient" | "expert" | null }[]> {
      const { data, error } = await supabase
        .from("profile_skills")
        .select("skill_id, level")
        .eq("profile_id", profileId);

      if (error || !data) return [];
      const rows = data as Record<string, unknown>[];
      return rows.map((row) => ({
        skill_id: typeof row.skill_id === "string" ? row.skill_id : "",
        level: (row.level as "familiar" | "proficient" | "expert" | null) ?? null,
      }));
    },

    async saveScore(score: ComposedScore): Promise<{ ok: boolean }> {
      const res = await persistScore(supabase, score);
      return { ok: res.ok };
    },

    async requeue(
      profileId: string,
      resumeAfter: string,
      resumeAfterId: string | null,
    ): Promise<void> {
      // The insert's error is deliberately **not** checked, which is a known gap and not an
      // oversight: `idx_task_queue_one_pending_rescore_per_profile` (0007) makes this insert
      // collide whenever a pending task for the profile already exists, and a collision here is
      // benign — the task that already exists covers the same jobs. Logged rather than thrown so
      // a duplicate cannot fail an otherwise-successful batch. See the "Adjacent problem" note in
      // docs/07 for why it should not stay this way indefinitely.
      const { error } = await supabase.from("task_queue").insert({
        kind: "rescore_profile",
        payload: { profile_id: profileId, resume_after: resumeAfter, resume_after_id: resumeAfterId },
        priority: 100,
        status: "pending",
      });
      if (error) {
        console.warn(
          `[rescore] requeue insert failed for profile ${profileId}: ${error.message}. ` +
            "A pending task for this profile most likely already exists and covers the same jobs.",
        );
      }
    },
  };
}
