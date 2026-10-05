/**
 * resumes.ts — Supabase Storage operations for résumé files (BE-314).
 *
 * All résumé files live in a private `resumes` bucket, organised by user ID:
 * `resumes/{user_id}/{resume_id}.{ext}`.
 *
 * Security:
 * - Bucket is private (no public access)
 * - RLS policies restrict access to the owning user
 * - File paths are never exposed directly; signed URLs are generated with short expiry
 *
 * The pure path/validation helpers live in `./resume-file`, which deliberately does not
 * import the database client — see that module for why.
 */

import { createClient } from "@/lib/db/client";
import { getResumeFilePath } from "./resume-file";

const BUCKET_NAME = "resumes";
const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadUrlResult {
  uploadUrl: string;
  filePath: string;
  expiresAt: string;
}

export interface SignedUrlResult {
  signedUrl: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `getResumeFilePath`, `getResumeExtension` and `validateResumeFile` now live in
// `./resume-file` so they can be unit tested without a configured environment. Re-exported
// here so existing importers keep working, and so the storage module remains the obvious
// entry point for "everything about résumé files".

export {
  getResumeFilePath,
  validateResumeFile,
  resumeExtensionFor,
  RESUME_MIME_TYPES,
  MAX_RESUME_BYTES,
} from "./resume-file";

// ---------------------------------------------------------------------------
// Storage operations
// ---------------------------------------------------------------------------

/**
 * Create a signed upload URL for a resume file.
 *
 * The client uploads directly to Supabase Storage using this URL.
 * The file path is deterministic: `{user_id}/{resume_id}.{ext}`.
 */
export async function createResumeUploadUrl(
  userId: string,
  resumeId: string,
  mimeType: string,
): Promise<UploadUrlResult> {
  const supabase = createClient();
  const filePath = getResumeFilePath(userId, resumeId, mimeType);

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(filePath, {
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to create upload URL: ${error.message}`);
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  return {
    uploadUrl: data.signedUrl,
    filePath,
    expiresAt,
  };
}

/**
 * Create a signed download URL for a resume file.
 *
 * Used when the user wants to view/download their uploaded resume.
 * URL expires after 1 hour.
 */
export async function createResumeDownloadUrl(
  userId: string,
  filePath: string,
): Promise<SignedUrlResult> {
  const supabase = createClient();

  // Verify the file belongs to the user
  if (!filePath.startsWith(`${userId}/`)) {
    throw new Error("Access denied: file does not belong to user");
  }

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (error) {
    throw new Error(`Failed to create download URL: ${error.message}`);
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  return {
    signedUrl: data.signedUrl,
    expiresAt,
  };
}

/**
 * Delete a resume file from storage.
 */
export async function deleteResumeFile(
  userId: string,
  filePath: string,
): Promise<void> {
  const supabase = createClient();

  // Verify the file belongs to the user
  if (!filePath.startsWith(`${userId}/`)) {
    throw new Error("Access denied: file does not belong to user");
  }

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([filePath]);

  if (error) {
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

/**
 * Check whether a résumé object exists in storage.
 *
 * Errors are thrown, not folded into `false`. The previous version returned `false` on any
 * storage error, which made "the network is down" indistinguishable from "the user never
 * uploaded this" — and the caller that most needs this is BE-313's account-deletion sweep,
 * where a false negative means a file survives a deletion the user asked for and was told
 * had completed. A cleanup routine must fail loudly on an inconclusive check.
 *
 * @throws Whatever the storage client throws, so the caller can distinguish
 *         "absent" from "could not determine".
 */
export async function resumeFileExists(filePath: string): Promise<boolean> {
  const supabase = createClient();
  const segments = filePath.split("/");
  const folder = segments[0];
  const name = segments[1];

  if (!folder || !name) {
    throw new Error(`Malformed resume path: ${filePath}`);
  }

  const { data, error } = await supabase.storage.from(BUCKET_NAME).list(folder, {
    limit: 1,
    search: name,
  });

  if (error) {
    throw new Error(`Failed to check resume existence: ${error.message}`);
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Download and extract text from a resume file.
 *
 * This is used by the resume parsing pipeline (BE-315) to get the text
 * content of an uploaded resume for extraction.
 *
 * @param userId - The user who owns the resume
 * @param filePath - The storage path of the resume file
 * @returns The extracted text content
 */
export async function getResumeText(
  userId: string,
  filePath: string,
): Promise<{ text: string }> {
  const supabase = createClient();

  // Verify the file belongs to the user
  if (!filePath.startsWith(`${userId}/`)) {
    throw new Error("Access denied: file does not belong to user");
  }

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(filePath);

  if (error) {
    throw new Error(`Failed to download resume: ${error.message}`);
  }

  // Convert Buffer to text (PDF/DOCX parsing happens in parse.ts)
  // For now, return as string — the actual PDF/DOCX parsing is in parse.ts
  const buffer = Buffer.from(await data.arrayBuffer());

  // Dynamic import to avoid bundling issues
  const { extractResumeText } = await import("@/lib/resume/parse");
  const mimeType = filePath.endsWith(".pdf")
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  const result = await extractResumeText(buffer, mimeType);

  return { text: result.text };
}
