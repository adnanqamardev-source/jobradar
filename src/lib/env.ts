/**
 * env.ts — Zod schema for all environment variables.
 * Single source of truth for config validation (docs/02 §7.2).
 * Import as: import { env } from "@/lib/env";
 */

import { z } from "zod";

const envSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // App
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  CRON_SECRET: z.string().min(32), // constant-time verified
  ADMIN_EMAILS: z.string().optional(), // comma-separated

  // Firecrawl
  FIRECRAWL_API_KEY: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o-mini"),

  // Job source APIs
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  USAJOBS_API_KEY: z.string().optional(),
  USAJOBS_AUTHORIZATION_KEY: z.string().optional(),
  RAPIDAPI_KEY: z.string().optional(),

  // Email
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),

  // Rate limits (server-only)
  RATE_LIMIT_APPLY_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SAVE_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DISMISS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_SEARCH_PER_MINUTE: z.coerce.number().int().positive().default(60),

  // Stripe (SHOULD)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_PRICE_ID_PRO: z.string().optional(),

  // Analytics & errors
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  POSTHOG_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),

  // Optional
  SLACK_WEBHOOK_URL: z.string().url().optional(),
});

// Parse once at module load — fails fast if invalid
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.flatten().fieldErrors;
  const msg = Object.entries(issues)
    .map(([k, v]) => `${k}: ${v.join(", ")}`)
    .join("\n");
  throw new Error(`❌ Invalid environment variables:\n${msg}`);
}

export const env = parsed.data;

// Type helper for consumers
export type Env = z.infer<typeof envSchema>;