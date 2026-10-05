/**
 * bootstrap-from-resume.ts — Server Action to bootstrap profile from resume (BE-316).
 *
 * This action:
 * 1. Validates the request
 * 2. Loads the resume record (RLS-enforced)
 * 3. Runs the extraction pipeline (if not already done)
 * 4. Maps the extracted profile to onboarding preferences
 * 5. Returns the prefill payload for the onboarding wizard
 *
 * The user reviews and confirms before this is saved to their profile.
 * This action does NOT modify the profile — it only returns the prefill data.
 */

"use server";

import { z } from "zod";
import { createUserClient } from "@/lib/db/user-client";
import { bootstrapFromResumeRequestSchema } from "@/types/api";
import { extractProfile } from "@/lib/resume/extract";
import { mapExtractedToBootstrap } from "@/lib/resume/bootstrap";
import { getResumeText } from "@/lib/storage/resumes";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/auth/require-user";
import type { ResumeRow } from "@/types/db";
import type { ExtractedProfile } from "@/types/resume";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The awaited shape of a Supabase `.single()` query.
 *
 * The client is created without a generated `Database` generic, so its query
 * builder resolves to `any`. Destructuring that directly trips
 * `no-unsafe-assignment`; casting the awaited value to this narrow shape once
 * keeps the rest of the function type-safe and honest about what it read.
 */
interface SingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface BootstrapFromResumeResult {
  ok: boolean;
  data?: {
    profile: {
      targetTitles: string[];
      seniority: string | null;
      yearsExperience: number | null;
      skills: string[];
      workModes: string[];
      countryCode: string | null;
      city: string | null;
      minSalary: number | null;
      salaryCurrency: string | null;
      salaryPeriod: string | null;
    };
    confidence: number;
    needsReview: boolean;
  };
  error?: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Server Action
// ---------------------------------------------------------------------------

/**
 * Bootstrap profile from a uploaded resume.
 *
 * @param input - The resume ID to bootstrap from
 * @returns The prefill payload for onboarding, or an error
 */
export async function bootstrapFromResume(
  input: z.infer<typeof bootstrapFromResumeRequestSchema>,
): Promise<BootstrapFromResumeResult> {
  try {
    // Validate input
    const { resumeId } = bootstrapFromResumeRequestSchema.parse(input);

    // BLOCKED: needs BE-302 (`requireUser()`) to resolve the caller's real JWT.
    // `createUserClient` throws until then, and this action deliberately has no
    // service-role fallback — that would bypass the `resumes_*_own` RLS policies and
    // make every row in the table readable by every caller.
    const user = await requireUser();
    const supabase = createUserClient(user.accessToken);

    // Load the resume record (RLS will enforce ownership).
    // The client is untyped, so the awaited query is `any`; cast once to a narrow
    // shape rather than destructuring `any` field by field.
    const result = (await supabase
      .from("resumes")
      .select("*")
      .eq("id", resumeId)
      .single()) as SingleResult<ResumeRow>;

    const resume = result.data;

    if (result.error || !resume) {
      return {
        ok: false,
        error: {
          code: "RESUME_NOT_FOUND",
          message: "Resume not found or access denied",
        },
      };
    }

    // Check if extraction has already been done
    let extractedProfile = resume.parsed_json as ExtractedProfile | null;

    if (!extractedProfile || resume.status !== "completed") {
      // Run extraction pipeline
      logger.info("Running resume extraction", { resumeId });

      // Get the file from storage
      const { text } = await getResumeText(resume.user_id, resume.file_path);

      // Extract profile
      const result = await extractProfile(text);

      extractedProfile = result.profile;

      // Update the resume record
      const { error: updateError } = await supabase
        .from("resumes")
        .update({
          parsed_json: extractedProfile,
          status: "completed",
          confidence: result.profile.confidence,
          extracted_at: new Date().toISOString(),
        })
        .eq("id", resumeId);

      if (updateError) {
        logger.error("Failed to update resume record", { resumeId, error: updateError });
        // Continue anyway — we still have the extracted profile
      }
    }

    // Map to bootstrap profile
    const bootstrapProfile = mapExtractedToBootstrap(extractedProfile);

    return {
      ok: true,
      data: {
        profile: bootstrapProfile,
        confidence: extractedProfile.confidence,
        needsReview: extractedProfile.needsReview,
      },
    };
  } catch (error) {
    logger.error("Bootstrap from resume failed", { error });

    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: error.errors.map((e) => e.message).join(", "),
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to bootstrap profile from resume",
      },
    };
  }
}
