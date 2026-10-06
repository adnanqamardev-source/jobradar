/**
 * api.ts — Zod schemas for all Server Action payloads and API responses.
 *
 * This is the seam contract between Back-End and Front-End (docs/06 §8.1).
 * Every Server Action input and every API response is validated here.
 * The Front-End imports `z.infer<typeof X>` — never hand-writes a parallel type.
 *
 * ## Rules
 * - Zod is the source of truth; TypeScript is derived.
 * - A BE ticket that changes an API shape updates this file **in the same commit**.
 * - Nothing bypasses the seam. Components never call PostgREST directly.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Common patterns
// ---------------------------------------------------------------------------

/** A standard API success response. */
export const apiSuccessSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.literal(true),
    data,
  });

/** A standard API error response. */
export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

/** Standard API response wrapper. */
export const apiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.union([apiSuccessSchema(data), apiErrorSchema]);

// ---------------------------------------------------------------------------
// Auth (BE-301–303)
// ---------------------------------------------------------------------------

/** POST /api/auth/magic-link — request a magic link. */
export const magicLinkRequestSchema = z.object({
  email: z.string().email(),
  redirectTo: z.string().url().optional(),
});
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

/** POST /api/auth/otp/verify — verify a 6-digit OTP code. */
export const otpVerifyRequestSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// Profile & Preferences (BE-304)
// ---------------------------------------------------------------------------

/**
 * The `updated_at` the caller last read, for the docs/03 §5.2 two-tab guard.
 * Optional: callers that don't track it (the onboarding wizard) skip the check.
 */
const expectedUpdatedAt = z.string().datetime({ offset: true }).optional();

/** Update profile — titles, seniority, headline. */
export const updateProfileRequestSchema = z.object({
  targetTitles: z.array(z.string()).max(10).optional(),
  seniority: z.enum([
    "intern", "junior", "mid", "senior", "lead", "staff", "principal", "director", "exec", "unknown",
  ]).optional(),
  yearsExperience: z.number().min(0).max(60).optional(),
  headline: z.string().max(200).optional(),
  fullName: z.string().max(100).optional(),
  expectedUpdatedAt,
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/** Update logistics — work modes, location, salary. */
export const updateLogisticsRequestSchema = z.object({
  workModes: z.array(z.enum(["remote", "hybrid", "onsite"])).max(3).optional(),
  hybridDaysMax: z.number().int().min(0).max(5).optional(),
  countryCode: z.string().length(2).optional(),
  city: z.string().max(100).optional(),
  timeZone: z.string().max(50).optional(),
  minSalary: z.number().int().positive().nullable().optional(),
  salaryCurrency: z.string().length(3).optional(),
  salaryPeriod: z.enum(["year", "month", "hour"]).optional(),
  visaRequired: z.boolean().optional(),
  expectedUpdatedAt,
});
export type UpdateLogisticsRequest = z.infer<typeof updateLogisticsRequestSchema>;

/** Update dealbreakers — blocked companies, excluded keywords. */
export const updateDealbreakersRequestSchema = z.object({
  blockedCompanies: z.array(z.string()).max(50).optional(),
  excludedKeywords: z.array(z.string()).max(50).optional(),
  preferredCompanies: z.array(z.string()).max(50).optional(),
  expectedUpdatedAt,
});
export type UpdateDealbreakersRequest = z.infer<typeof updateDealbreakersRequestSchema>;

/** Update notification preferences. */
export const updateNotificationPrefsRequestSchema = z.object({
  digestEnabled: z.boolean().optional(),
  digestChannel: z.enum(["email", "slack"]).optional(),
  highMatchAlerts: z.boolean().optional(),
});
export type UpdateNotificationPrefsRequest = z.infer<typeof updateNotificationPrefsRequestSchema>;

// ---------------------------------------------------------------------------
// Feed Actions (BE-305)
// ---------------------------------------------------------------------------

/** Save a job. */
export const saveJobRequestSchema = z.object({
  jobId: z.string().uuid(),
});
export type SaveJobRequest = z.infer<typeof saveJobRequestSchema>;

/** Dismiss a job. */
export const dismissJobRequestSchema = z.object({
  jobId: z.string().uuid(),
});
export type DismissJobRequest = z.infer<typeof dismissJobRequestSchema>;

/** Mark a job as applied. */
export const markAppliedRequestSchema = z.object({
  jobId: z.string().uuid(),
  appliedAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
  resumeVersionId: z.string().uuid().optional(),
});
export type MarkAppliedRequest = z.infer<typeof markAppliedRequestSchema>;

// ---------------------------------------------------------------------------
// Feed Query (BE-306)
// ---------------------------------------------------------------------------

/** Query parameters for the ranked job feed. */
export const feedQueryRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  workModes: z.array(z.enum(["remote", "hybrid", "onsite"])).optional(),
  seniority: z.array(z.string()).optional(),
  minSalary: z.number().int().positive().optional(),
  countryCode: z.string().length(2).optional(),
  remoteScope: z.enum(["india", "global"]).optional(),
  companyIds: z.array(z.string().uuid()).optional(),
  excludedCompanyIds: z.array(z.string().uuid()).optional(),
  newSinceLastVisit: z.boolean().optional(),
});
export type FeedQueryRequest = z.infer<typeof feedQueryRequestSchema>;

/** A single job in the feed response. */
export const feedJobSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  companyName: z.string(),
  companyDomain: z.string().nullable(),
  locationRaw: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  countryCode: z.string().length(2).nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  remoteScope: z.enum(["india", "global", "unknown"]),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.string().length(3).nullable(),
  salaryPeriod: z.string().nullable(),
  seniority: z.string(),
  employmentType: z.string(),
  skills: z.array(z.string()),
  postedAt: z.string().datetime().nullable(),
  finalScore: z.number(),
  ruleScore: z.number().nullable(),
  semanticScore: z.number().nullable(),
  explanation: z.string().nullable(),
  saved: z.boolean(),
  dismissed: z.boolean(),
  applied: z.boolean(),
});
export type FeedJob = z.infer<typeof feedJobSchema>;

/** Feed query response. */
export const feedQueryResponseSchema = z.object({
  jobs: z.array(feedJobSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
});
export type FeedQueryResponse = z.infer<typeof feedQueryResponseSchema>;

// ---------------------------------------------------------------------------
// Tracker (BE-307)
// ---------------------------------------------------------------------------

/** Move an application to a new stage. */
export const moveApplicationRequestSchema = z.object({
  applicationId: z.string().uuid(),
  toStage: z.enum([
    "discovered", "saved", "applied", "screening", "interview", "offer", "rejected", "withdrawn",
  ]),
  note: z.string().max(2000).optional(),
});
export type MoveApplicationRequest = z.infer<typeof moveApplicationRequestSchema>;

/** Create an application from a job. */
export const createApplicationRequestSchema = z.object({
  jobId: z.string().uuid(),
  notes: z.string().max(2000).optional(),
});
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;

/** Update application notes. */
export const updateApplicationNotesRequestSchema = z.object({
  applicationId: z.string().uuid(),
  notes: z.string().max(2000),
});
export type UpdateApplicationNotesRequest = z.infer<typeof updateApplicationNotesRequestSchema>;

/** Set next action date. */
export const setNextActionRequestSchema = z.object({
  applicationId: z.string().uuid(),
  nextActionAt: z.string().datetime(),
});
export type SetNextActionRequest = z.infer<typeof setNextActionRequestSchema>;

// ---------------------------------------------------------------------------
// Saved Searches (BE-308)
// ---------------------------------------------------------------------------

/** Create a saved search. */
export const createSavedSearchRequestSchema = z.object({
  name: z.string().min(1).max(100),
  filters: z.object({
    search: z.string().max(200).optional(),
    workModes: z.array(z.enum(["remote", "hybrid", "onsite"])).optional(),
    seniority: z.array(z.string()).optional(),
    minSalary: z.number().int().positive().optional(),
    countryCode: z.string().length(2).optional(),
    remoteScope: z.enum(["india", "global"]).optional(),
  }),
});
export type CreateSavedSearchRequest = z.infer<typeof createSavedSearchRequestSchema>;

/** Update a saved search. */
export const updateSavedSearchRequestSchema = z.object({
  searchId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  filters: z.object({
    search: z.string().max(200).optional(),
    workModes: z.array(z.enum(["remote", "hybrid", "onsite"])).optional(),
    seniority: z.array(z.string()).optional(),
    minSalary: z.number().int().positive().optional(),
    countryCode: z.string().length(2).optional(),
    remoteScope: z.enum(["india", "global"]).optional(),
  }).optional(),
});
export type UpdateSavedSearchRequest = z.infer<typeof updateSavedSearchRequestSchema>;

/** Delete a saved search. */
export const deleteSavedSearchRequestSchema = z.object({
  searchId: z.string().uuid(),
});
export type DeleteSavedSearchRequest = z.infer<typeof deleteSavedSearchRequestSchema>;

/** Preview count for saved search filters. */
export const previewSavedSearchRequestSchema = z.object({
  filters: z.object({
    search: z.string().max(200).optional(),
    workModes: z.array(z.enum(["remote", "hybrid", "onsite"])).optional(),
    seniority: z.array(z.string()).optional(),
    minSalary: z.number().int().positive().optional(),
    countryCode: z.string().length(2).optional(),
    remoteScope: z.enum(["india", "global"]).optional(),
  }),
});
export type PreviewSavedSearchRequest = z.infer<typeof previewSavedSearchRequestSchema>;

// ---------------------------------------------------------------------------
// Resume (BE-314–316)
// ---------------------------------------------------------------------------

/** Upload resume — request a signed upload URL. */
export const resumeUploadRequestSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), // 10MB max
});
export type ResumeUploadRequest = z.infer<typeof resumeUploadRequestSchema>;

/** Upload resume response — signed URL + resume record. */
export const resumeUploadResponseSchema = z.object({
  resumeId: z.string().uuid(),
  uploadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type ResumeUploadResponse = z.infer<typeof resumeUploadResponseSchema>;

/** Extracted profile from resume (BE-315 output). */
export const extractedProfileSchema = z.object({
  fullName: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  location: z.object({
    city: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().length(2).nullable(),
  }),
  titles: z.array(z.string()),
  seniority: z.enum([
    "intern", "junior", "mid", "senior", "lead", "staff", "principal", "director", "exec", "unknown",
  ]).nullable(),
  yearsExperience: z.number().min(0).max(60).nullable(),
  skills: z.array(z.string()),
  workModes: z.array(z.enum(["remote", "hybrid", "onsite"])),
  minSalary: z.number().int().positive().nullable(),
  salaryCurrency: z.string().length(3).nullable(),
  salaryPeriod: z.enum(["year", "month", "hour"]).nullable(),
  education: z.array(z.object({
    degree: z.string(),
    institution: z.string(),
    year: z.number().int().nullable(),
  })),
  summary: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
});
export type ExtractedProfile = z.infer<typeof extractedProfileSchema>;

/** Bootstrap profile from resume (BE-316). */
export const bootstrapFromResumeRequestSchema = z.object({
  resumeId: z.string().uuid(),
});
export type BootstrapFromResumeRequest = z.infer<typeof bootstrapFromResumeRequestSchema>;

/** Bootstrap response — prefill payload for onboarding. */
export const bootstrapFromResumeResponseSchema = z.object({
  profile: z.object({
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
  }),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
});
export type BootstrapFromResumeResponse = z.infer<typeof bootstrapFromResumeResponseSchema>;

// ---------------------------------------------------------------------------
// Admin (BE-312)
// ---------------------------------------------------------------------------

/** List sources with health info. */
export const adminListSourcesRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type AdminListSourcesRequest = z.infer<typeof adminListSourcesRequestSchema>;

/** Pause/resume a source. */
export const adminToggleSourceRequestSchema = z.object({
  sourceId: z.string().uuid(),
  enabled: z.boolean(),
});
export type AdminToggleSourceRequest = z.infer<typeof adminToggleSourceRequestSchema>;

/** Retry a failed task. */
export const adminRetryTaskRequestSchema = z.object({
  taskId: z.string().uuid(),
});
export type AdminRetryTaskRequest = z.infer<typeof adminRetryTaskRequestSchema>;

/** List scrape runs. */
export const adminListRunsRequestSchema = z.object({
  sourceId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type AdminListRunsRequest = z.infer<typeof adminListRunsRequestSchema>;

// ---------------------------------------------------------------------------
// Account (BE-313)
// ---------------------------------------------------------------------------

/** Export account data. */
export const exportAccountRequestSchema = z.object({
  format: z.enum(["json"]).default("json"),
});
export type ExportAccountRequest = z.infer<typeof exportAccountRequestSchema>;

/** Delete account. */
export const deleteAccountRequestSchema = z.object({
  confirmation: z.literal("DELETE"),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

// ---------------------------------------------------------------------------
// Manual Trigger (BE-112)
// ---------------------------------------------------------------------------

/** Trigger a manual ingestion run. */
export const runNowRequestSchema = z.object({
  sourceId: z.string().uuid().optional(),
});
export type RunNowRequest = z.infer<typeof runNowRequestSchema>;
