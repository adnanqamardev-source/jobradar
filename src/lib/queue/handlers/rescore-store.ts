/**
 * rescore-store.ts — Supabase adapter for `RescoreStore` (SCR-005, BE-205, BE-108).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RescoreStore, RescoreJobRow } from "@/lib/queue/handlers/rescore-profile";
import type { ComposedScore } from "@/lib/scoring";
import { persistScore } from "@/lib/scoring";

export function createSupabaseRescoreStore(supabase: SupabaseClient): RescoreStore {
  return {
    async listJobs(_profileId: string, resumeAfter: string | null, limit: number): Promise<RescoreJobRow[]> {
      let query = supabase
        .from("jobs")
        .select("id, title, company_name, company_domain, description_text, country_code, work_mode, remote_scope, seniority, salary_min, salary_max, salary_currency, salary_period, posted_at, embedding")
        .order("posted_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .limit(limit);

      if (resumeAfter) {
        query = query.lt("posted_at", resumeAfter);
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

    async requeue(profileId: string, resumeAfter: string): Promise<void> {
      await supabase.from("task_queue").insert({
        kind: "rescore_profile",
        payload: { profile_id: profileId, resume_after: resumeAfter },
        priority: 100,
        status: "pending",
      });
    },
  };
}
