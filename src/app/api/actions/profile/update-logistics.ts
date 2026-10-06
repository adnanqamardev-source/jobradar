/**
 * update-logistics.ts — Server Action for ONB-004 (BE-304).
 *
 * Updates work modes, hybrid cap, country/city, time zone, salary, visa requirement.
 *
 * ## Salary floor: `null` clears, `undefined` leaves alone
 *
 * ONB-004: "empty salary = no floor (`NULL`), not `0`". Three states, three behaviours:
 * - `minSalary: <positive int>` → write the floor
 * - `minSalary: null`           → **clear** the floor (write `NULL`)
 * - `minSalary` omitted         → leave the column untouched
 *
 * The `null`-clears distinction matters: an earlier revision guarded on
 * `!== undefined && !== null`, which silently dropped the only input that can
 * clear a floor, so a user could set a minimum and never remove it. `0` is not
 * a third option — `updateLogisticsRequestSchema` is `.positive()`, so Zod
 * rejects it before this file sees it.
 */

"use server";

import { z } from "zod";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { updateOwnProfile, type ProfileUpdateResult } from "@/lib/db/profile-update";
import { updateLogisticsRequestSchema } from "@/types/api";

export type UpdateLogisticsResult = ProfileUpdateResult;

function pick(
  input: z.infer<typeof updateLogisticsRequestSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.workModes !== undefined) out.work_modes = input.workModes;
  if (input.hybridDaysMax !== undefined) out.hybrid_days_max = input.hybridDaysMax;
  if (input.countryCode !== undefined) out.country_code = input.countryCode;
  if (input.city !== undefined) out.city = input.city;
  if (input.timeZone !== undefined) out.time_zone = input.timeZone;
  // `null` clears the floor; omitted leaves the column untouched.
  if (input.minSalary !== undefined) out.min_salary = input.minSalary;
  if (input.salaryCurrency !== undefined) out.salary_currency = input.salaryCurrency;
  if (input.salaryPeriod !== undefined) out.salary_period = input.salaryPeriod;
  if (input.visaRequired !== undefined) out.visa_required = input.visaRequired;
  return out;
}

export async function updateLogistics(
  input: z.infer<typeof updateLogisticsRequestSchema>,
): Promise<UpdateLogisticsResult> {
  try {
    const parsed = updateLogisticsRequestSchema.parse(input);
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
      "Failed to update logistics",
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
      error: { code: "INTERNAL_ERROR", message: "Failed to update logistics" },
    };
  }
}