/**
 * update-dealbreakers.ts — Server Action for ONB-005 (BE-304).
 *
 * Writes blocked companies, excluded keywords, preferred companies.
 * Values are normalised (trim, lowercase, dedupe) before write, matching
 * the spec's "normalised slugs" rule for blocked_companies.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { updateDealbreakersRequestSchema } from "@/types/api";
import type { ProfileRow } from "@/types/db";

interface SingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface UpdateDealbreakersResult {
  ok: boolean;
  data?: { profile: ProfileRow };
  error?: { code: string; message: string };
}

/** Normalise a free-text keyword list: trim, lowercase, dedupe, non-empty. */
function normaliseKeywords(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = raw.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function pick(
  input: z.infer<typeof updateDealbreakersRequestSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.blockedCompanies !== undefined)
    out.blocked_companies = normaliseKeywords(input.blockedCompanies);
  if (input.excludedKeywords !== undefined)
    out.excluded_keywords = normaliseKeywords(input.excludedKeywords);
  if (input.preferredCompanies !== undefined)
    out.preferred_companies = normaliseKeywords(input.preferredCompanies);
  return out;
}

export async function updateDealbreakers(
  input: z.infer<typeof updateDealbreakersRequestSchema>,
): Promise<UpdateDealbreakersResult> {
  try {
    const parsed = updateDealbreakersRequestSchema.parse(input);
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
          message: result.error?.message ?? "Failed to update dealbreakers",
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
    if (error instanceof AppError) throw error;
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to update dealbreakers",
      },
    };
  }
}