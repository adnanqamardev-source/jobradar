/**
 * upload-resume.ts — Server Action to upload a resume (BE-314).
 *
 * This action:
 * 1. Validates the request (file type, size)
 * 2. Creates a resume record in the database
 * 3. Generates a signed upload URL for Supabase Storage
 * 4. Returns the upload URL and resume ID
 *
 * The client then uploads the file directly to Supabase Storage using
 * the signed URL. After upload, the client should call the processing
 * endpoint to trigger parsing.
 */

"use server";

import { z } from "zod";
import { createUserClient } from "@/lib/db/user-client";
import { resumeUploadRequestSchema } from "@/types/api";
import { createResumeUploadUrl } from "@/lib/storage/resumes";
import { validateResumeFile } from "@/lib/storage/resume-file";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/auth/require-user";
import type { ResumeRow } from "@/types/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** See `SingleResult` in bootstrap-from-resume.ts. */
interface SingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface UploadResumeResult {
  ok: boolean;
  data?: {
    resumeId: string;
    uploadUrl: string;
    expiresAt: string;
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
 * Upload a resume file.
 *
 * @param input - The file metadata (name, type, size)
 * @returns A signed upload URL and resume ID, or an error
 */
export async function uploadResume(
  input: z.infer<typeof resumeUploadRequestSchema>,
): Promise<UploadResumeResult> {
  try {
    // Validate input
    const { mimeType, sizeBytes } = resumeUploadRequestSchema.parse(input);

    // Validate file
    const validationError = validateResumeFile(mimeType, sizeBytes);
    if (validationError) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: validationError,
        },
      };
    }

    // BE-302 landed: both the id and the JWT come from the verified session. A
    // hardcoded id matches no RLS policy, and a service-role client would bypass the
    // check entirely — so there is still no fallback path here.
    const user = await requireUser();
    const userId = user.id;
    const supabase = await createUserClient(user.accessToken);

    // Create resume record.
    // See `SingleResult` in bootstrap-from-resume.ts: the client is untyped,
    // so the awaited query is `any` and is cast to a narrow shape once.
    const result = (await supabase
      .from("resumes")
      .insert({
        user_id: userId,
        file_path: "", // Will be updated after upload
        mime_type: mimeType,
        size_bytes: sizeBytes,
        status: "pending",
      })
      .select()
      .single()) as SingleResult<ResumeRow>;

    const resume = result.data;

    if (result.error || !resume) {
      logger.error("Failed to create resume record", { error: result.error });
      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to create resume record",
        },
      };
    }

    // Generate the signed upload URL. If this throws, the row inserted above is rolled back
    // rather than marked 'failed' — unlike process-resume, no file exists yet, so the row
    // is not a record of anything. Left behind it would sit at file_path = '' with status
    // 'pending': invisible in the UI, and unusable by processResume, whose ownership check
    // rejects the empty path with "Access denied".
    let uploadUrl: string;
    let filePath: string;
    let expiresAt: string;
    try {
      ({ uploadUrl, filePath, expiresAt } = await createResumeUploadUrl(
        userId,
        resume.id,
        mimeType,
      ));
    } catch (error) {
      logger.error("Failed to create resume upload URL; rolling back row", {
        resumeId: resume.id,
        error,
      });

      const { error: deleteError } = await supabase
        .from("resumes")
        .delete()
        .eq("id", resume.id);

      if (deleteError) {
        // The orphan is invisible to the user and harmless to others, but log it: an
        // accumulating pile of empty rows is a signal that storage is unhealthy.
        logger.error("Failed to roll back orphan resume row", {
          resumeId: resume.id,
          error: deleteError,
        });
      }

      return {
        ok: false,
        error: {
          code: "UPLOAD_URL_FAILED",
          message: "Could not prepare the upload. Please try again.",
        },
      };
    }

    // Update resume record with file path
    const { error: updateError } = await supabase
      .from("resumes")
      .update({ file_path: filePath })
      .eq("id", resume.id);

    if (updateError) {
      logger.error("Failed to update resume file path", { error: updateError });
      // Continue anyway — the upload URL is still valid
    }

    logger.info("Resume upload URL created", { resumeId: resume.id, userId });

    return {
      ok: true,
      data: {
        resumeId: resume.id,
        uploadUrl,
        expiresAt,
      },
    };
  } catch (error) {
    logger.error("Resume upload failed", { error });

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
        message: "Failed to upload resume",
      },
    };
  }
}
