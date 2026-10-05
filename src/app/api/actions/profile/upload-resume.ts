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
import { createResumeUploadUrl, validateResumeFile } from "@/lib/storage/resumes";
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

    // BLOCKED: needs BE-302 (`requireUser()`) to resolve the caller's real JWT and id.
    // Both must come from the verified session. A hardcoded id matches no RLS policy
    // (they compare against `auth.uid()`), and a service-role client would bypass the
    // check entirely — so this path fails closed rather than half-working.
    const user = await requireUser();
    const userId = user.id;
    const supabase = createUserClient(user.accessToken);

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

    // Generate signed upload URL
    const { uploadUrl, filePath, expiresAt } = await createResumeUploadUrl(
      userId,
      resume.id,
      mimeType,
    );

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
