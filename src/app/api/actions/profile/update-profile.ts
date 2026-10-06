/**
 * update-profile.ts — Server Action for ONB-002 (BE-304).
 *
 * Updates the caller's profile titles, seniority, years_experience, headline,
 * and full_name. Every input is optional; only the supplied fields are written.
 *
 * ## Why `requireUser()` is non-negotiable here
 *
 * docs/03 §2.2 and docs/06 §8.1: every user-facing mutation resolves the
 * caller's identity *before* touching the database, so RLS evaluates the
 * caller's JWT — never the service-role key. A Server Action that falls back
 * to the service role would let any authenticated user overwrite anyone's row.
 *
 * ## Error contract
 *
 * - `ZodError` → `VALIDATION_ERROR` (caught, typed response)
 * - `AppError` (e.g. `unauthenticated` from `requireUser()`) → propagates; the
 *   framework maps it to the matching HTTP status / JSON shape
 * - Unexpected → `INTERNAL_ERROR` catch block
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { updateProfileRequestSchema } from "@/types/api";
import type { ProfileRow } from "@/types/db";

interface SingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface UpdateProfileResult {
  ok: boolean;
  data?: { profile: ProfileRow };
  error?: { code: string; message: string };
}

function pick(
  input: z.infer<typeof updateProfileRequestSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.targetTitles !== undefined) out.target_titles = input.targetTitles;
  if (input.seniority !== undefined) out.seniority = input.seniority;
  if (input.yearsExperience !== undefined) out.years_experience = input.yearsExperience;
  if (input.headline !== undefined) out.headline = input.headline;
  if (input.fullName !== undefined) out.full_name = input.fullName;
  return out;
}

export async function updateProfile(
  input: z.infer<typeof updateProfileRequestSchema>,
): Promise<UpdateProfileResult> {
  try {
    const parsed = updateProfileRequestSchema.parse(input);
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

    const updates = pick(parsed);
    if (Object.keys(updates).length === 0) {
      return {
        ok: false,
        error: { code: "NO_FIELDS", message: "No fields to update." },
      };
    }

    const result = (await supabase
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select()
      .single()) as SingleResult<ProfileRow>;

    if (result.error || !result.data) {
      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: result.error?.message ?? "Failed to update profile",
        },
      };
    }

    return { ok: true, data: { profile: result.data } };
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
    // AppError (unauthenticated / forbidden) propagates — the framework
    // maps it to the right HTTP status; unexpected errors are internal.
    if (error instanceof AppError) throw error;
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to update profile" },
    };
  }
}