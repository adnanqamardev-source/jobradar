/**
 * db.ts — Supabase table row and enum types (docs/02 §5).
 *
 * These types mirror the database schema defined in `supabase/migrations/0001_init.sql`
 * and `docs/02a-schema.md`. They are used by the data layer (`src/lib/db/queries/`)
 * and by Server Actions that need to work with raw DB rows.
 *
 * For new tables added in Phase 1 (e.g. `resumes`), types are added here as
 * the tables are created. The `Database` type from Supabase can be used for
 * full type safety, but explicit row types are provided here for clarity and
 * to avoid coupling to the generated Supabase client types.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enum types (mirror docs/02a-schema.md §5.2)
// ---------------------------------------------------------------------------

export const userRoleSchema = z.enum(["user", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const jobStatusSchema = z.enum(["active", "stale", "expired", "removed"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const workModeSchema = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export type WorkMode = z.infer<typeof workModeSchema>;

export const senioritySchema = z.enum([
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
]);
export type Seniority = z.infer<typeof senioritySchema>;

export const employmentTypeSchema = z.enum([
  "full_time",
  "part_time",
  "contract",
  "internship",
  "temporary",
 "unknown",
]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const profLevelSchema = z.enum(["familiar", "proficient", "expert"]);
export type ProfLevel = z.infer<typeof profLevelSchema>;

export const appStageSchema = z.enum([
  "discovered",
  "saved",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
]);
export type AppStage = z.infer<typeof appStageSchema>;

export const taskStatusSchema = z.enum(["pending", "running", "done", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskKindSchema = z.enum([
  "ingest_source",
  "score_jobs",
  "send_digest",
  "rescore_profile",
  "account_export",
  "cleanup",
]);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const runStatusSchema = z.enum(["running", "success", "partial", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sourceKindSchema = z.enum([
  "api_greenhouse",
  "api_lever",
  "api_ashby",
  "api_remotive",
  "api_arbeitnow",
  "api_usajobs",
  "api_adzuna",
  "firecrawl_scrape",
  "firecrawl_search",
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const planTierSchema = z.enum(["free", "pro"]);
export type PlanTier = z.infer<typeof planTierSchema>;

export const digestChannelSchema = z.enum(["email", "slack"]);
export type DigestChannel = z.infer<typeof digestChannelSchema>;

// ---------------------------------------------------------------------------
// Table row types
// ---------------------------------------------------------------------------

/** `profiles` table row (docs/02a-schema.md §5.3). */
export interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  plan: PlanTier;
  target_titles: string[];
  seniority: Seniority;
  years_experience: number | null;
  headline: string | null;
  country_code: string | null;
  city: string | null;
  time_zone: string | null;
  work_modes: WorkMode[];
  hybrid_days_max: number | null;
  min_salary: number | null;
  salary_currency: string;
  salary_period: string | null;
  visa_required: boolean | null;
  blocked_companies: string[];
  excluded_keywords: string[];
  preferred_companies: string[];
  onboarding_completed: boolean;
  onboarding_step: number;
  last_digest_at: string | null;
  last_seen_feed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `jobs` table row (docs/02a-schema.md §5.4). */
export interface JobRow {
  id: string;
  company_id: string | null;
  source_id: string | null;
  external_id: string;
  source_url: string;
  apply_url: string | null;
  dedupe_hash: string;
  title: string;
  title_norm: string | null;
  company_name: string;
  company_domain: string | null;
  location_raw: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  work_mode: WorkMode;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  salary_raw: string | null;
  seniority: Seniority;
  employment_type: EmploymentType;
  description_text: string | null;
  description_html: string | null;
  skills: string[];
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  sighting_count: number;
  status: JobStatus;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/** `job_scores` table row (docs/02a-schema.md §5.5). */
export interface JobScoreRow {
  id: string;
  user_id: string;
  job_id: string;
  final_score: number;
  rule_score: number | null;
  semantic_score: number | null;
  gate_result: Record<string, unknown> | null;
  breakdown: { key: string; weight: number; raw: number; points: number }[] | null;
  explanation: string | null;
  scored_at: string;
  model_version: string | null;
}

/** `applications` table row (docs/02a-schema.md §5.6). */
export interface ApplicationRow {
  id: string;
  user_id: string;
  job_id: string;
  stage: AppStage;
  notes: string | null;
  applied_at: string | null;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `application_events` table row (docs/02a-schema.md §5.6). */
export interface ApplicationEventRow {
  id: string;
  application_id: string;
  event: string;
  from_stage: AppStage | null;
  to_stage: AppStage | null;
  note: string | null;
  created_at: string;
}

/** `saved_searches` table row (docs/02a-schema.md §5.7). */
export interface SavedSearchRow {
  id: string;
  user_id: string;
  name: string;
  filters: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** `task_queue` table row (docs/02a-schema.md §5.8). */
export interface TaskQueueRow {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: number;
  run_after: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  last_error: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
}

/** `scrape_runs` table row (docs/02a-schema.md §5.4). */
export interface ScrapeRunRow {
  id: string;
  source_id: string;
  task_id: string | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  found: number;
  inserted: number;
  duplicates: number;
  failed: number;
  api_calls: number;
  error: string | null;
  log: Record<string, unknown> | null;
  created_at: string;
}

/** `sources` table row (docs/02a-schema.md §5.4). */
export interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  config: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  cadence_minutes: number;
  next_run_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_error: string | null;
  rate_limit_per_day: number;
  created_at: string;
  updated_at: string;
}

/** `resumes` table row (BE-314, migration 0002_resumes.sql). */
export interface ResumeRow {
  id: string;
  user_id: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  parsed_json: Record<string, unknown> | null;
  status: "pending" | "processing" | "completed" | "failed";
  confidence: number | null;
  extracted_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** `resume_versions` table row (docs/02a-schema.md §5.3, BKG-001). */
export interface ResumeVersionRow {
  id: string;
  user_id: string;
  label: string;
  storage_path: string;
  is_default: boolean;
  size_bytes: number;
  created_at: string;
}

/** `subscriptions` table row (docs/02a-schema.md §5.3). */
export interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

/** `usage_events` table row (docs/02a-schema.md §5.9). */
export interface UsageEventRow {
  id: string;
  user_id: string;
  event: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** `audit_logs` table row (docs/02a-schema.md §5.9). */
export interface AuditLogRow {
  id: string;
  user_id: string;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}
