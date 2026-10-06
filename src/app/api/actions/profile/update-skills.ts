/**
 * update-skills.ts — Server Action for ONB-003 (BE-304).
 *
 * Replaces the caller's `profile_skills` rows with the supplied list.
 * Each entry carries a skill (by id) and a proficiency level.
 *
 * Spec pin: "Minimum 3 skills to continue" is enforced on the minimum
 * count before write; unknown skill ids are rejected rather than silently
 * dropped (the picker validates against `skills` via the alias index).
 */

"use server";

import { z } from "zod";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
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

    // Replace the caller's rows in one shot.
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