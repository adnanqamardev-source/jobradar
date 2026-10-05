/**
 * process-resume.ts — Server Action to process an uploaded resume (BE-315).
 *
 * This action:
 * 1. Validates the request
 * 2. Loads the resume record (RLS-enforced)
 * 3. Downloads the file from storage
 * 4. Runs the extraction pipeline
 * 5. Updates the resume record with the extracted profile
 * 6. Returns the extraction result
 *
 * This is called after the client has uploaded the file to Supabase Storage.
 */

"use server";

import { z } from "zod";
import { createUserClient } from "@/lib/db/user-client";
import { extractProfile } from "@/lib/resume/extract";
import { getResumeText } from "@/lib/storage/resumes";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/auth/require-user";
import type { ResumeRow } from "@/types/db";
import type { ExtractedProfile } from "@/types/resume";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** See `SingleResult` in bootstrap-from-resume.ts. */
interface SingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface ProcessResumeResult {
  ok: boolean;
  data?: {
    resumeId: string;
    status: "completed" | "failed";
    confidence: number;
    needsReview: boolean;
    extractedProfile: {
      fullName: string | null;
      email: string | null;
      phone: string | null;
      location: {
        city: string | null;
        region: string | null;
        countryCode: string | null;
      };
      titles: string[];
      seniority: string | null;
      yearsExperience: number | null;
      skills: string[];
      workModes: string[];
      minSalary: number | null;
      salaryCurrency: string | null;
      salaryPeriod: string | null;
      education: {
        degree: string;
        institution: string;
        year: number | null;
      }[];
      summary: string | null;
    };
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
 * Process an uploaded resume — extract profile data.
 *
 * @param input - The resume ID to process
 * @returns The extraction result
 */
export async function processResume(input: { resumeId: string }): Promise<ProcessResumeResult> {
  try {
    const { resumeId } = z.object({ resumeId: z.string().uuid() }).parse(input);

    // BLOCKED: needs BE-302 (`requireUser()`) to resolve the caller's real JWT.
    // This action reads and writes a resume row, so it must run as the user whose
    // row it is — a service-role client would bypass the ownership policy.
    const user = await requireUser();
    const supabase = createUserClient(user.accessToken);

    // Load the resume record (RLS will enforce ownership).
    // See `SingleResult` in bootstrap-from-resume.ts: the client is untyped,
    // so the awaited query is `any` and is cast to a narrow shape once.
    const lookup = (await supabase
      .from("resumes")
      .select("*")
      .eq("id", resumeId)
      .single()) as SingleResult<ResumeRow>;

    const resume = lookup.data;

    if (lookup.error || !resume) {
      return {
        ok: false,
        error: {
          code: "RESUME_NOT_FOUND",
          message: "Resume not found or access denied",
        },
      };
    }

    // Check if already processed
    if (resume.status === "completed" && resume.parsed_json) {
      const parsed = resume.parsed_json as ExtractedProfile;
      return {
        ok: true,
        data: {
          resumeId: resume.id,
          status: "completed",
          confidence: resume.confidence ?? 0,
          needsReview: parsed.needsReview ?? true,
          extractedProfile: parsed,
        },
      };
    }

    // Update status to processing
    await supabase
      .from("resumes")
      .update({ status: "processing" })
      .eq("id", resumeId);

    // Download and extract text from the file
    const { text } = await getResumeText(resume.user_id, resume.file_path);

    // Run extraction pipeline
    const result = await extractProfile(text);

    // Update the resume record
    const { error: updateError } = await supabase
      .from("resumes")
      .update({
        parsed_json: result.profile,
        status: "completed",
        confidence: result.profile.confidence,
        extracted_at: new Date().toISOString(),
      })
      .eq("id", resumeId);

    if (updateError) {
      logger.error("Failed to update resume record", { resumeId, error: updateError });
    }

    logger.info("Resume processing completed", {
      resumeId,
      method: result.method,
      confidence: result.profile.confidence,
    });

    return {
      ok: true,
      data: {
        resumeId: resume.id,
        status: "completed",
        confidence: result.profile.confidence,
        needsReview: result.profile.needsReview,
        extractedProfile: result.profile,
      },
    };
  } catch (error) {
    logger.error("Resume processing failed", { error });

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
        message: "Failed to process resume",
      },
    };
  }
}
