/**
 * update-skills.ts — Server Action for ONB-003 (BE-304).
 *
 * Replaces the caller's `profile_skills` rows with the supplied list.
 * Each entry carries a skill (by id) and a proficiency level.
 *
 * Spec pin: "Minimum 3 skills to continue" is enforced on the minimum
 * count before write; unknown skill ids are rejected rather than silently
 * dropped (the picker validates against `skills` via the alias index).
 *
 * ## The replace is not atomic, so it compensates
 *
 * PostgREST has no multi-statement transaction here, so this is
 * snapshot → delete → insert → (on failure) restore. See the comment at the
 * snapshot for why the snapshot is mandatory rather than an optimisation.
 */

"use server";

import { z } from "zod";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { logger } from "@/lib/logger";
import type { ProfileRow } from "@/types/db";

export interface SkillLevel {
  skillId: string;
  level: "familiar" | "proficient" | "expert";
  years?: number | null;
  isPrimary?: boolean;
}

const updateSkillsSchema = z.object({
  skills: z.array(z.unknown()).min(3, "Select at least 3 skills"),
});

export interface UpdateSkillsResult {
  ok: boolean;
  data?: { profile: ProfileRow };
  error?: { code: string; message: string };
}

export async function updateSkills(
  input: unknown,
): Promise<UpdateSkillsResult> {
  try {
    const parsed = updateSkillsSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    const skills = parsed.skills as SkillLevel[];

    // Validate each entry's shape before touching the DB.
    const seen = new Set<string>();
    for (const s of skills) {
      if (
        typeof s !== "object" ||
        s === null ||
        typeof s.skillId !== "string" ||
        !["familiar", "proficient", "expert"].includes(s.level)
      ) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Each skill must have a skillId and a valid level.",
          },
        };
      }
      // PK is (profile_id, skill_id) per docs/02a-schema.md:111. A duplicate
      // would surface as a raw Postgres unique violation from the insert, so
      // reject it here with a message that names the actual fault.
      if (seen.has(s.skillId)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: `Duplicate skill: ${s.skillId}.`,
          },
        };
      }
      seen.add(s.skillId);
    }

    // Verify the supplied skill ids exist (protects the FK to skills).
    const { data: existing, error: fetchError } = await supabase
      .from("skills")
      .select("id")
      .in(
        "id",
        skills.map((s) => s.skillId),
      );
    if (fetchError?.message || !existing || existing?.length !== skills.length) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "One or more skills do not exist.",
        },
      };
    }

    // Snapshot the current rows before the replace. Delete-then-insert is not a
    // transaction over PostgREST, so without this a failed insert returns
    // DATABASE_ERROR and leaves the user with *zero* skills — silently destroying
    // data they had before clicking Save. Restoring the snapshot is the compensating
    // write; `upload-resume.ts:128-141` does the same for its orphan row.
    const { data: snapshot, error: snapshotError } = (await supabase
      .from("profile_skills")
      .select("skill_id, level, years, is_primary")
      .eq("profile_id", user.id)) as {
      data: {
        skill_id: string;
        level: string;
        years: number | null;
        is_primary: boolean;
      }[] | null;
      error: { message: string } | null;
    };
    if (snapshotError?.message) {
      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: snapshotError.message,
        },
      };
    }
    const previous = snapshot ?? [];

    const { error: deleteError } = await supabase
      .from("profile_skills")
      .delete()
      .eq("profile_id", user.id);
    if (deleteError) {
      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to clear existing skills.",
        },
      };
    }

    const rows = skills.map((s) => ({
      profile_id: user.id,
      skill_id: s.skillId,
      level: s.level,
      years: s.years ?? null,
      is_primary: s.isPrimary ?? false,
    }));

    const { error: insertError } = await supabase
      .from("profile_skills")
      .insert(rows);
    if (insertError) {
      // Compensate: put the user's previous skills back rather than leaving an
      // empty profile. A failed restore is logged, not swallowed silently.
      const restoreRows = previous.map((r) => ({
        profile_id: user.id,
        skill_id: r.skill_id,
        level: r.level,
        years: r.years,
        is_primary: r.is_primary,
      }));
      const { error: restoreError } =
        restoreRows.length > 0
          ? await supabase.from("profile_skills").insert(restoreRows)
          : { error: null };

      logger.error("Failed to save skills; restore attempted", {
        error: insertError,
        restored: restoreError ? false : restoreRows.length,
      });

      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to save skills.",
        },
      };
    }

    // Return the refreshed profile summary so the caller can reflect the change.
    const { data: profile, error: profileError } = (await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single()) as { data: ProfileRow | null; error: { message: string } | null };
    if (profileError || !profile) {
      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: "Skills saved, but failed to read profile.",
        },
      };
    }

    return { ok: true, data: { profile } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: error.errors.map((e) => e.message).join(", "),
        },
      };
    }
    if (error instanceof AppError) throw error;
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to update skills" },
    };
  }
}