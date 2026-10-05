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
    /**
     * Only "completed" is reachable here. A parse failure is returned as
     * `ok: false` with code `EXTRACTION_FAILED`, because the caller cannot use a partial
     * profile — the previous `"completed" | "failed"` union advertised a "failed" variant
     * this function never produced.
     */
    status: "completed";
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

    // BE-302 landed: requireUser resolves the caller's real JWT; createUserClient
    // scopes every query through RLS — no service-role path exists here.
    const user = await requireUser();
    const supabase = await createUserClient(user.accessToken);

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

    // Mark the row as in-flight. `processing` is a claim, not a state we can leave behind:
    // anything that throws below used to land in the outer catch, which returned an error
    // and left the row stuck at 'processing' forever — every later call then re-ran the
    // whole extraction instead of reporting the failure that had already happened.
    await supabase
      .from("resumes")
      .update({ status: "processing" })
      .eq("id", resumeId);

    // Download + extract, with the failure recorded against the row.
    let result: Awaited<ReturnType<typeof extractProfile>>;
    try {
      const { text } = await getResumeText(resume.user_id, resume.file_path);
      result = await extractProfile(text);
    } catch (error) {
      // A corrupt or unreadable file throws from pdfjs/mammoth. Persist that as terminal
      // state rather than leaving an in-flight claim: this row has a real file behind it,
      // so unlike a failed upload it must NOT be rolled back — the user needs to see that
      // their résumé failed to parse, with a reason, rather than have it vanish.
      const message = error instanceof Error ? error.message : "Unknown extraction error";
      logger.error("Resume extraction failed", { resumeId, message });

      const { error: failError } = await supabase
        .from("resumes")
        .update({ status: "failed", error: message })
        .eq("id", resumeId);

      if (failError) {
        // The row stays at 'processing'. Log loudly — this is the one case where the
        // invariant cannot be restored, and a silent wedge is what we are avoiding.
        logger.error("Failed to record resume failure", { resumeId, error: failError });
      }

      return {
        ok: false,
        error: {
          code: "EXTRACTION_FAILED",
          message: "Could not read this résumé file. Try re-uploading it as a PDF or DOCX.",
        },
      };
    }

    // Update the resume record
    const { error: updateError } = await supabase
      .from("resumes")
      .update({
        parsed_json: result.profile,
        status: "completed",
        confidence: result.profile.confidence,
        extracted_at: new Date().toISOString(),
        error: null,
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
