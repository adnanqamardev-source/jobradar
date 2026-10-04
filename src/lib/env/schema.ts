/**
 * schema.ts — the environment contract. Pure.
 *
 * Everything docs/02 §7.1 and §7.2 specify about variables lives here, and nothing here
 * touches `process.env`, throws at import time, or has any other side effect. Importing
 * this module is always safe, which is what lets a test call `parseEnv({...})` with a
 * literal and get a result back.
 *
 * `src/lib/env/index.ts` is the binding that feeds this contract `process.env` and throws
 * on failure. Application code imports that; tests and tooling import this.
 *
 * The separation is the whole point. Before it, the schema and the binding shared a
 * module, so testing a rule meant mutating `process.env` and re-importing with
 * `vi.resetModules()` — around forty lines of harness per file, and an order-dependent
 * flake risk that grew with every case. See tests/unit/env.test.ts.
 */

import { z } from "zod";

/**
 * Treats an empty env value as absent.
 *
 * A `.env` file expresses "not configured" as `VAR=`, which `process.env` surfaces as `""` —
 * *present*, not `undefined`. So `z.string().url().optional()` still fails on a blank var.
 * This maps `""` → `undefined` before the inner schema ever runs (docs/02 §7.2 rule 6a).
 *
 * `z.optional()` alone would not do this: it handles a missing key, never an empty value.
 * Every optional var must go through this helper — and so must every optional var that
 * has a default, since `VAR=` must fall back to the default rather than fail boot.
 *
 * **Order matters.** The default must sit *inside* the preprocess, as
 * `schema.default(d)`, never as `blank(schema).default(d)`. In the latter the outer default
 * sees the raw `""`, does not apply (it only fires on `undefined`), and the inner optional
 * then swallows the value — so the var silently resolves to `undefined` instead of the
 * default, and a refined schema like `freeModel` rejects it. Wrap the default with
 * {@link blankDefault} instead.
 */
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

/**
 * An optional var that falls back to `fallback` when left blank or absent.
 *
 * `VAR=` and a missing `VAR` must both produce `fallback`, which is what a developer
 * copying `.env.example` expects. See {@link blank} for why the default goes inside.
 */
const blankDefault = <T extends z.ZodTypeAny>(schema: T, fallback: T["_output"]) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.default(fallback),
  );

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

/** Free-only: these MUST be `:free` ids or the §8 cost envelope breaks. */
const freeModel = (field: string) =>
  z
    .string()
    .refine((m) => m.endsWith(":free"), `must be a :free model (docs/02 §8 cost envelope) — ${field}`);

const envSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // App
  // Blank-tolerant: `VAR=` in a .env file must fall back to the default, not fail boot.
  NEXT_PUBLIC_APP_URL: blankDefault(z.string().url(), "http://localhost:3000"),
  CRON_SECRET: z.string().min(32), // constant-time verified; docs/02 §7.1
  ADMIN_EMAILS: blank(z.string()), // comma-separated

  // Firecrawl
  FIRECRAWL_API_KEY: blank(z.string()),

  // OpenRouter — embeddings + rationale (docs/02 §2, §7.1)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: blankDefault(z.string().url(), "https://openrouter.ai/api/v1"),
  // 2048-dim, 32k ctx. Do NOT send `dimensions` — this model 400s on any other value.
  // Changing the embedding model means a full reindex (docs/02 §7.1).
  OPENROUTER_EMBEDDING_MODEL: blankDefault(
    freeModel("OPENROUTER_EMBEDDING_MODEL"),
    "nvidia/nemotron-3-embed-1b:free",
  ),
  OPENROUTER_CHAT_MODEL: blankDefault(freeModel("OPENROUTER_CHAT_MODEL"), "qwen/qwen3.8-27b:free"),

  // Job source APIs
  ADZUNA_APP_ID: blank(z.string()),
  ADZUNA_APP_KEY: blank(z.string()),
  USAJOBS_API_KEY: blank(z.string()),
  USAJOBS_AUTHORIZATION_KEY: blank(z.string()),
  RAPIDAPI_KEY: blank(z.string()),

  // Email
  RESEND_API_KEY: blank(z.string()),
  EMAIL_FROM: blank(emailAddress),

  // Rate limits (server-only) — docs/02 §7.1, §7.2 rule 5
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
  POSTHOG_HOST: blankDefault(z.string().url(), "https://us.i.posthog.com"),
  SENTRY_DSN: blank(z.string().url()),
  NEXT_PUBLIC_SENTRY_DSN: blank(z.string().url()),

  // Optional
  SLACK_WEBHOOK_URL: blank(z.string().url()),
});

/** The full env contract, keyed as `process.env` is. */
export type EnvInput = Record<string, string | undefined>;

export type Env = z.infer<typeof envSchema>;

/** A parse failure, rendered for a human staring at a boot error. */
export interface EnvProblem {
  field: string;
  messages: string[];
}

export type EnvParseResult = { ok: true; env: Env } | { ok: false; problems: EnvProblem[] };

/**
 * Validate an environment record against docs/02 §7.
 *
 * Pure: takes the record, returns the result, touches nothing, throws nothing. Callers
 * that want fail-fast semantics use the `env` export in `./index.ts`; tests and tooling
 * call this directly.
 *
 * ```ts
 * const r = parseEnv({ ...required, CRON_SECRET: "too-short" });
 * if (!r.ok) console.error(formatEnvProblems(r.problems));
 * ```
 */
export function parseEnv(input: EnvInput): EnvParseResult {
  const parsed = envSchema.safeParse(input);
  if (parsed.success) return { ok: true, env: parsed.data };

  const problems: EnvProblem[] = Object.entries(parsed.error.flatten().fieldErrors).map(
    ([field, messages]) => ({ field, messages }),
  );
  return { ok: false, problems };
}

/** Render a failure the way the boot error has always read. */
export function formatEnvProblems(problems: readonly EnvProblem[]): string {
  const body = problems.map((p) => `${p.field}: ${p.messages.join(", ")}`).join("\n");
  return `❌ Invalid environment variables:\n${body}`;
}