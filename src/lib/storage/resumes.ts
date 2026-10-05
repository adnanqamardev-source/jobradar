/**
 * storage.ts — Supabase Storage helpers for resume files (BE-314).
 *
 * All resume files are stored in a private `resumes` bucket. Files are
 * organized by user ID: `resumes/{user_id}/{resume_id}.{ext}`.
 *
 * Security:
 * - Bucket is private (no public access)
 * - RLS policies restrict access to the owning user
 * - File paths are never exposed directly; signed URLs are generated
 *   with short expiry for downloads
 */

import { createClient } from "@/lib/db/client";

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

/**
 * Generate the storage file path for a resume.
 * Format: `{user_id}/{resume_id}.{ext}`
 */
export function getResumeFilePath(userId: string, resumeId: string, mimeType: string): string {
  const ext = mimeType === "application/pdf" ? "pdf" : "docx";
  return `${userId}/${resumeId}.${ext}`;
}

/**
 * Get the file extension from a resume MIME type.
 */
export function getResumeExtension(mimeType: string): string {
  return mimeType === "application/pdf" ? "pdf" : "docx";
}

/**
 * Validate a resume file before upload.
 * Returns an error message if invalid, null if valid.
 */
export function validateResumeFile(
  mimeType: string,
  sizeBytes: number,
): string | null {
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];

  if (!allowedTypes.includes(mimeType)) {
    return "Invalid file type. Only PDF and DOCX are allowed.";
  }

  const maxSize = 10 * 1024 * 1024; // 10MB
  if (sizeBytes > maxSize) {
    return "File too large. Maximum size is 10MB.";
  }

  if (sizeBytes === 0) {
    return "File is empty.";
  }

  return null;
}

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
 * Check if a resume file exists in storage.
 */
export async function resumeFileExists(filePath: string): Promise<boolean> {
  const supabase = createClient();

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .list(filePath.split("/")[0], {
      limit: 1,
      search: filePath.split("/")[1],
    });

  if (error) {
    return false;
  }

  return data && data.length > 0;
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
