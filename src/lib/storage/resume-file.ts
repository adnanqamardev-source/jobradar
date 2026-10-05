/**
 * resume-file.ts — pure path + validation helpers for résumé uploads (BE-314).
 *
 * ## Why these live apart from `resumes.ts`
 *
 * Every function here is pure: no database, no storage, no network. They were originally in
 * `resumes.ts` alongside the Supabase calls, which meant importing any of them pulled in
 * `@/lib/db/client` → `admin.ts` → `@/lib/env`. Because `env/index.ts` binds `process.env`
 * and throws at import time when a variable is missing, those helpers could not be unit
 * tested at all on a machine without a fully configured environment — a test would fail at
 * *module load* rather than at the assertion that matters.
 *
 * That is the same import-time-side-effect trap `notes.md` records three times already. The
 * structural fix, not a stubbed `env`, is to split the pure seam from the impure one.
 *
 * ## The allowlist is defined once
 *
 * `RESUME_MIME_TYPES` is the single source of truth for what this product accepts.
 * `validateResumeFile` checks against it, and `getResumeFilePath` derives the extension from
 * the same set — so a MIME type cannot be accepted by one and silently mapped by the other.
 */

import { z } from "zod";

/** The only upload types this product accepts. */
export const RESUME_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type ResumeMimeType = (typeof RESUME_MIME_TYPES)[number];

/** Largest accepted upload: 10 MB. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Map a MIME type to its canonical extension, or null when unsupported. */
export function resumeExtensionFor(mimeType: string): "pdf" | "docx" | null {
  switch (mimeType) {
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    default:
      return null;
  }
}

/**
 * Storage path for a résumé: `{user_id}/{resume_id}.{ext}`.
 *
 * User-scoped on purpose — the `storage.objects` policies in `0002_resumes.sql` authorise on
 * the first path segment, so a flat namespace could not be authorised that way.
 *
 * @throws If the MIME type is unsupported. The previous version mapped *any* non-PDF type to
 *         `.docx`, which silently disagreed with `validateResumeFile`'s allowlist: the row was
 *         accepted as valid and then named `.docx`, so the mismatch only surfaced later as an
 *         unreadable file.
 */
export function getResumeFilePath(userId: string, resumeId: string, mimeType: string): string {
  const ext = resumeExtensionFor(mimeType);
  if (ext === null) {
    throw new Error(`Unsupported resume MIME type: ${mimeType}`);
  }
  return `${userId}/${resumeId}.${ext}`;
}

/**
 * Validate an upload before anything is written.
 *
 * @returns An error message when invalid, `null` when valid.
 */
export function validateResumeFile(mimeType: string, sizeBytes: number): string | null {
  if (resumeExtensionFor(mimeType) === null) {
    return "Invalid file type. Only PDF and DOCX are allowed.";
  }

  // `sizeBytes <= 0`, not `=== 0`. A negative size passed the old zero-only check and then
  // failed the `size_bytes > 0` database constraint, surfacing to the caller as
  // DATABASE_ERROR — a misleading error for what is plainly bad input.
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return "File is empty or has an invalid size.";
  }

  if (sizeBytes > MAX_RESUME_BYTES) {
    return "File too large. Maximum size is 10MB.";
  }

  return null;
}

/**
 * The Zod mirror of {@link validateResumeFile}, so a Server Action can enforce the rule in
 * its input schema before any handler code runs.
 */
export const resumeUploadMetaSchema = z.object({
  mimeType: z.enum(RESUME_MIME_TYPES),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_RESUME_BYTES, "File too large. Maximum size is 10MB."),
});