/**
 * canonical-job.ts — the canonical job data shape (docs/02 §4.1).
 *
 * This is the single source of truth for a normalised job posting. Connectors
 * produce `RawJob`, the normalisation pipeline (BE-106) maps it to `CanonicalJob`,
 * and the scorer (BE-201+) consumes it. The front-end never sees `RawJob`.
 *
 * Zod is the source of truth; TypeScript types are derived via `z.infer`.
 * Never hand-write a parallel interface — two definitions drift.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Remote scope (BE-317)
// ---------------------------------------------------------------------------

/**
 * Distinguishes India-specific remote roles from globally-distributed remote roles.
 *
 * - `"india"` — PAN-India / Work-from-India (e.g. "Remote – India", "Anywhere in India")
 * - `"global"` — internationally distributed (e.g. "Worldwide", "Remote – Anywhere")
 * - `"unknown"` — could not be determined from the source data
 */
export const remoteScopeSchema = z.enum(["india", "global", "unknown"]);
export type RemoteScope = z.infer<typeof remoteScopeSchema>;

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

export const rawSalarySchema = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().length(3).nullable(),
  period: z.enum(["year", "month", "hour"]).nullable(),
  raw: z.string().nullable(),
});
export type RawSalary = z.infer<typeof rawSalarySchema>;

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export const parsedLocationSchema = z.object({
  city: z.string().nullable(),
  region: z.string().nullable(),
  countryCode: z.string().length(2).nullable(),
  raw: z.string(),
});
export type ParsedLocation = z.infer<typeof parsedLocationSchema>;

// ---------------------------------------------------------------------------
// CanonicalJob
// ---------------------------------------------------------------------------

/**
 * The fully-normalised job posting. Written to `jobs` table (BE-107).
 *
 * All fields are nullable where the source may not provide them. The `dedupeHash`
 * is computed by BE-107 and is the upsert key.
 */
export const canonicalJobSchema = z.object({
  // Identity
  externalId: z.string(),
  sourceUrl: z.string().url(),
  applyUrl: z.string().url().nullable(),

  // Company
  companyName: z.string(),
  companyDomain: z.string().nullable(),

  // Title & description
  title: z.string(),
  titleNorm: z.string().nullable(),
  descriptionText: z.string().nullable(),
  descriptionHtml: z.string().nullable(),

  // Location (BE-317: extended with remote_scope)
  location: parsedLocationSchema,
  remoteScope: remoteScopeSchema.default("unknown"),

  // Work arrangement
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).default("unknown"),
  employmentType: z.enum([
    "full_time",
    "part_time",
    "contract",
    "internship",
    "temporary",
    "unknown",
  ]).default("unknown"),

  // Seniority
  seniority: z.enum([
    "intern",
    "junior",
    "mid",
    "senior",
    "lead",
    "staff",
    "principal",
    "director",
    "exec",
    "unknown",
  ]).default("unknown"),

  // Salary
  salary: rawSalarySchema.nullable(),

  // Skills (canonical slugs, populated by BE-106)
  skills: z.array(z.string()).default([]),

  // Metadata
  postedAt: z.string().datetime().nullable(),
  firstSeenAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  sightingCount: z.number().int().default(1),
  status: z.enum(["active", "stale", "expired", "removed"]).default("active"),
  confidence: z.number().min(0).max(1).default(1.0),

  // Dedupe (computed by BE-107)
  dedupeHash: z.string().nullable(),

  // Raw payload (debugging)
  raw: z.record(z.unknown()).nullable(),
});

export type CanonicalJob = z.infer<typeof canonicalJobSchema>;

// ---------------------------------------------------------------------------
// RawJob (connector output, pre-normalisation)
// ---------------------------------------------------------------------------

/**
 * The raw, unnormalised job data a connector produces. This is the input to
 * the normalisation pipeline (BE-106). Not stored in the database.
 */
export const rawJobSchema = z.object({
  externalId: z.string(),
  sourceUrl: z.string().url(),
  applyUrl: z.string().url().nullable(),
  companyName: z.string(),
  companyDomain: z.string().nullable(),
  title: z.string(),
  descriptionText: z.string().nullable(),
  locationRaw: z.string().nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).nullable(),
  employmentType: z
    .enum(["full_time", "part_time", "contract", "internship", "temporary", "unknown"])
    .nullable(),
  seniority: z
    .enum([
      "intern",
      "junior",
      "mid",
      "senior",
      "lead",
      "staff",
      "principal",
      "director",
      "exec",
      "unknown",
    ])
    .nullable(),
  salaryRaw: z.string().nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.string().length(3).nullable(),
  salaryPeriod: z.enum(["year", "month", "hour"]).nullable(),
  skills: z.array(z.string()).default([]),
  postedAt: z.string().datetime().nullable(),
  raw: z.record(z.unknown()).nullable(),
});

export type RawJob = z.infer<typeof rawJobSchema>;
