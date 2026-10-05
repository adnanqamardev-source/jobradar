/**
 * resume.ts — resume upload, parsing, and extraction types (BE-314–316).
 *
 * The resume pipeline: upload → store → parse → extract → bootstrap profile.
 * These types cover the full flow. The actual parsing logic lives in
 * `src/lib/resume/`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Resume record status
// ---------------------------------------------------------------------------

export const resumeStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);
export type ResumeStatus = z.infer<typeof resumeStatusSchema>;

// ---------------------------------------------------------------------------
// Resume record (DB row)
// ---------------------------------------------------------------------------

/**
 * A resume record in the `resumes` table. The actual file is stored in
 * Supabase Storage (private `resumes` bucket); this row tracks metadata
 * and the extraction result.
 */
export const resumeRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  filePath: z.string(),
  mimeType: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  sizeBytes: z.number().int().positive(),
  parsedJson: z.record(z.unknown()).nullable(),
  status: resumeStatusSchema,
  confidence: z.number().min(0).max(1).nullable(),
  extractedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ResumeRecord = z.infer<typeof resumeRecordSchema>;

// ---------------------------------------------------------------------------
// Extracted profile (BE-315 output)
// ---------------------------------------------------------------------------

/**
 * The structured profile extracted from a resume. This is the output of the
 * parsing pipeline and the input to the bootstrap flow (BE-316).
 *
 * All fields are nullable — a resume may not contain every piece of information.
 * The `confidence` score (0–1) indicates overall extraction quality.
 * `needsReview` is true when confidence is below threshold or required fields
 * are missing, signalling that the user should review before applying.
 */
export const extractedProfileSchema = z.object({
  // Identity
  fullName: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),

  // Location
  location: z.object({
    city: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().length(2).nullable(),
  }),

  // Professional
  titles: z.array(z.string()),
  seniority: z.enum([
    "intern", "junior", "mid", "senior", "lead", "staff", "principal", "director", "exec", "unknown",
  ]).nullable(),
  yearsExperience: z.number().min(0).max(60).nullable(),
  skills: z.array(z.string()),

  // Preferences
  workModes: z.array(z.enum(["remote", "hybrid", "onsite"])),
  minSalary: z.number().int().positive().nullable(),
  salaryCurrency: z.string().length(3).nullable(),
  salaryPeriod: z.enum(["year", "month", "hour"]).nullable(),

  // Education
  education: z.array(z.object({
    degree: z.string(),
    institution: z.string(),
    year: z.number().int().nullable(),
  })),

  // Summary
  summary: z.string().nullable(),

  // Quality
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
});
export type ExtractedProfile = z.infer<typeof extractedProfileSchema>;

// ---------------------------------------------------------------------------
// Bootstrap payload (BE-316 output)
// ---------------------------------------------------------------------------

/**
 * The prefill payload for onboarding, derived from an extracted resume profile.
 * This maps resume data to the onboarding wizard fields (ONB-002–005).
 *
 * The user reviews and confirms before this is saved to their profile.
 */
export const bootstrapProfileSchema = z.object({
  targetTitles: z.array(z.string()),
  seniority: z.string().nullable(),
  yearsExperience: z.number().nullable(),
  skills: z.array(z.string()),
  workModes: z.array(z.string()),
  countryCode: z.string().length(2).nullable(),
  city: z.string().nullable(),
  minSalary: z.number().nullable(),
  salaryCurrency: z.string().length(3).nullable(),
  salaryPeriod: z.string().nullable(),
});
export type BootstrapProfile = z.infer<typeof bootstrapProfileSchema>;

// ---------------------------------------------------------------------------
// Parsing configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the resume parser. The rule-based parser is always
 * attempted first; the LLM parser is used as a fallback when rule-based
 * confidence is below `llmFallbackThreshold`.
 */
export const resumeParserConfigSchema = z.object({
  llmFallbackThreshold: z.number().min(0).max(1).default(0.6),
  maxSkills: z.number().int().positive().default(30),
  maxTitles: z.number().int().positive().default(10),
});
export type ResumeParserConfig = z.infer<typeof resumeParserConfigSchema>;
