/**
 * update-dealbreakers.ts — Server Action for ONB-005 (BE-304).
 *
 * Writes blocked companies, excluded keywords, preferred companies.
 *
 * ## Company values are slugs, keywords are lowercased text
 *
 * docs/02a §5.3 documents `blocked_companies` as "normalised slugs". This action
 * previously applied the same `trim().toLowerCase()` to all three lists, which is
 * correct for `excluded_keywords` and wrong for companies: a user who typed
 * "Acme Corp." stored the literal string `acme corp.`, which no slugified comparison
 * against a `jobs` row could ever match — so the dealbreaker silently did nothing, and
 * the gate that reads it did not exist yet to notice.
 *
 * Both sides now go through `normaliseCompanyInput`, which is the same function the
 * SCR-001 `blocked_company` gate uses via `companySlugCandidates`. One normaliser, so
 * the write and the match cannot drift apart again.
 */

"use server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { updateOwnProfile, type ProfileUpdateResult } from "@/lib/db/profile-update";
import { normaliseCompanyInput } from "@/lib/utils/company-slug";
import { updateDealbreakersRequestSchema } from "@/types/api";

export type UpdateDealbreakersResult = ProfileUpdateResult;

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

/**
 * Normalise a company list to slugs, deduped, dropping entries that slugify to
 * nothing.
 *
 * Dedupe happens *after* normalisation, so "Acme Corp." and "acme corp" collapse to a
 * single entry rather than both being stored.
 */
function normaliseCompanies(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const slug = normaliseCompanyInput(raw);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

function pick(
  input: z.infer<typeof updateDealbreakersRequestSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.blockedCompanies !== undefined)
    out.blocked_companies = normaliseCompanies(input.blockedCompanies);
  if (input.excludedKeywords !== undefined)
    out.excluded_keywords = normaliseKeywords(input.excludedKeywords);
  if (input.preferredCompanies !== undefined)
    out.preferred_companies = normaliseCompanies(input.preferredCompanies);
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

    return updateOwnProfile(
      supabase,
      user.id,
      updates,
      parsed.expectedUpdatedAt,
      "Failed to update dealbreakers",
    );
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