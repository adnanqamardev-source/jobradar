/**
 * env.ts — Zod schema for all environment variables.
 * Single source of truth for config validation (docs/02 §7.2).
 * Import as: import { env } from "@/lib/env";
 */

import { z } from "zod";

/**
 * Treats an empty env value as absent.
 *
 * A `.env` file expresses "not configured" as `VAR=`, which `process.env` surfaces as `""` —
 * *present*, not `undefined`. So `z.string().url().optional()` still fails on a blank var.
 * This maps `""` → `undefined` before the inner schema ever runs (docs/02 §7.2 rule 6a).
 */
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

/** Bare addr-spec, e.g. `hi@example.com`. Deliberately not z.string().email(), which is stricter. */
const ADDR_SPEC = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;

/**
 * RFC 5322 address, optionally with a display name: `hi@example.com` or
 * `JobRadar <hi@jobradar.app>` (the format docs/02 §7.1 specifies).
 * `z.string().email()` rejects the display-name form, so the documented value would be illegal.
 */
const emailAddress = z.string().refine(
  (v) => {
    const trimmed = v.trim();
    if (ADDR_SPEC.test(trimmed)) return true;
    const angled = /^(.*?)<([^<>]+)>$/.exec(trimmed);
    const inner = angled?.[2];
    return inner !== undefined && ADDR_SPEC.test(inner.trim());
  },
  { message: "must be `addr@example.com` or `Display Name <addr@example.com>`" },
);

const envSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // App
  NEXT_PUBLIC_APP_URL: blank(z.string().url()),
  CRON_SECRET: z.string().min(32), // constant-time verified
  ADMIN_EMAILS: blank(z.string()), // comma-separated

  // Firecrawl
  FIRECRAWL_API_KEY: blank(z.string()),

  // OpenRouter — embeddings + rationale (docs/02 §2, §7.1)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  // Free-only constraint: these MUST be `:free` ids or the §8 cost envelope breaks.
  OPENROUTER_EMBEDDING_MODEL: z
    .string()
    .refine((m) => m.endsWith(":free"), "must be a :free model (docs/02 §8 cost envelope)")
    .default("nvidia/nemotron-3-embed-1b:free"),
  OPENROUTER_CHAT_MODEL: z
    .string()
    .refine((m) => m.endsWith(":free"), "must be a :free model (docs/02 §8 cost envelope)")
    .default("qwen/qwen3.8-27b:free"),

  // Job source APIs
  ADZUNA_APP_ID: blank(z.string()),
  ADZUNA_APP_KEY: blank(z.string()),
  USAJOBS_API_KEY: blank(z.string()),
  USAJOBS_AUTHORIZATION_KEY: blank(z.string()),
  RAPIDAPI_KEY: blank(z.string()),

  // Email
  RESEND_API_KEY: blank(z.string()),
  EMAIL_FROM: blank(emailAddress),

  // Rate limits (server-only)
  RATE_LIMIT_APPLY_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SAVE_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DISMISS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_SEARCH_PER_MINUTE: z.coerce.number().int().positive().default(60),

  // Stripe (SHOULD)
  STRIPE_SECRET_KEY: blank(z.string()),
  STRIPE_WEBHOOK_SECRET: blank(z.string()),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: blank(z.string()),
  STRIPE_PRICE_ID_PRO: blank(z.string()),

  // Analytics & errors
  NEXT_PUBLIC_POSTHOG_KEY: blank(z.string()),
  POSTHOG_KEY: blank(z.string()),
  POSTHOG_HOST: blank(z.string().url()),
  SENTRY_DSN: blank(z.string().url()),
  NEXT_PUBLIC_SENTRY_DSN: blank(z.string().url()),

  // Optional
  SLACK_WEBHOOK_URL: blank(z.string().url()),
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