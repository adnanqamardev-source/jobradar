/**
 * update-logistics.ts — Server Action for ONB-004 (BE-304).
 *
 * Updates work modes, hybrid cap, country/city, time zone, salary, visa requirement.
 * Salary fields: write a positive integer, or `null`/omitted for "no floor".
 * `0` is normalised to `null` so the DB CHECK constraint (`min_salary > 0`
 * when present) is never breached by a user mistake.
 */

"use server";

import { z } from "zod";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { updateLogisticsRequestSchema } from "@/types/api";
import type { ProfileRow } from "@/types/db";

interface SingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface UpdateLogisticsResult {
  ok: boolean;
  data?: { profile: ProfileRow };
  error?: { code: string; message: string };
}

function pick(
  input: z.infer<typeof updateLogisticsRequestSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.workModes !== undefined) out.work_modes = input.workModes;
  if (input.hybridDaysMax !== undefined) out.hybrid_days_max = input.hybridDaysMax;
  if (input.countryCode !== undefined) out.country_code = input.countryCode;
  if (input.city !== undefined) out.city = input.city;
  if (input.timeZone !== undefined) out.time_zone = input.timeZone;
  if (input.minSalary !== undefined && input.minSalary !== null)
    out.min_salary = input.minSalary > 0 ? input.minSalary : null;
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
          message: result.error?.message ?? "Failed to update logistics",
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
      error: { code: "INTERNAL_ERROR", message: "Failed to update logistics" },
    };
  }
}