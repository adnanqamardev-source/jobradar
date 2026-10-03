/**
 * env.ts contract tests (docs/02 §7.2).
 *
 * env.ts parses at module load and throws on invalid input, so every case must
 * re-import it with `vi.resetModules()` after mutating `process.env`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  CRON_SECRET: "a".repeat(64),
  OPENROUTER_API_KEY: "sk-or-v1-test",
} as const;

const loadEnv = async (overrides: Record<string, string | undefined> = {}) => {
  for (const [k, v] of Object.entries({ ...VALID, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import("@/lib/env");
};

/** Asserts the module throws, returning the joined issue lines. */
const rejection = async (overrides: Record<string, string | undefined> = {}) => {
  try {
    await loadEnv(overrides);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected env.ts to throw, but it parsed successfully");
};

const originalEnv = { ...process.env };

beforeEach(() => {
  // Start every case from a clean slate: a real shell may export vars that
  // would otherwise mask a missing-var assertion.
  for (const k of Object.keys(process.env)) delete process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe("env — required vars", () => {
  it("parses when every required var is present", async () => {
    const { env } = await loadEnv();
    expect(env.CRON_SECRET).toHaveLength(64);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-test");
  });

  it("rejects a CRON_SECRET shorter than 32 chars", async () => {
    const msg = await rejection({ CRON_SECRET: "too-short" });
    expect(msg).toContain("CRON_SECRET");
    expect(msg).toContain("32");
  });

  it("rejects a missing OPENROUTER_API_KEY", async () => {
    const msg = await rejection({ OPENROUTER_API_KEY: undefined });
    expect(msg).toContain("OPENROUTER_API_KEY");
  });

  it("rejects a non-URL NEXT_PUBLIC_SUPABASE_URL", async () => {
    const msg = await rejection({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" });
    expect(msg).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });
});

describe("env — free-model constraint (docs/02 §8 cost envelope)", () => {
  it("rejects a paid embedding model", async () => {
    const msg = await rejection({ OPENROUTER_EMBEDDING_MODEL: "openai/text-embedding-3-small" });
    expect(msg).toContain("OPENROUTER_EMBEDDING_MODEL");
    expect(msg).toContain(":free");
  });

  it("rejects a paid chat model", async () => {
    const msg = await rejection({ OPENROUTER_CHAT_MODEL: "openai/gpt-4o-mini" });
    expect(msg).toContain("OPENROUTER_CHAT_MODEL");
    expect(msg).toContain(":free");
  });

  it("defaults to free 2048-dim embeddings and a free chat model", async () => {
    const { env } = await loadEnv();
    expect(env.OPENROUTER_EMBEDDING_MODEL).toBe("nvidia/nemotron-3-embed-1b:free");
    expect(env.OPENROUTER_CHAT_MODEL.endsWith(":free")).toBe(true);
    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
});

describe("env — blank is not absent (docs/02 §7.2 rule 6a)", () => {
  it("treats VAR= as undefined, so boot does not fail on unset optionals", async () => {
    const { env } = await loadEnv({
      FIRECRAWL_API_KEY: "",
      EMAIL_FROM: "",
      SENTRY_DSN: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
      SLACK_WEBHOOK_URL: "",
      POSTHOG_KEY: "",
      NEXT_PUBLIC_POSTHOG_KEY: "",
      ADMIN_EMAILS: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      USAJOBS_API_KEY: "",
      USAJOBS_AUTHORIZATION_KEY: "",
      RAPIDAPI_KEY: "",
      RESEND_API_KEY: "",
    });
    expect(env.FIRECRAWL_API_KEY).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.ADMIN_EMAILS).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("treats whitespace-only values as undefined too", async () => {
    const { env } = await loadEnv({ FIRECRAWL_API_KEY: "   " });
    expect(env.FIRECRAWL_API_KEY).toBeUndefined();
  });

  it("still rejects a blank URL var that is genuinely malformed", async () => {
    const msg = await rejection({ SENTRY_DSN: "not-a-url" });
    expect(msg).toContain("SENTRY_DSN");
  });
});

describe("env — EMAIL_FROM accepts RFC 5322 display-name form", () => {
  it("accepts the value docs/02 §7.1 documents", async () => {
    const { env } = await loadEnv({ EMAIL_FROM: "JobRadar <hi@jobradar.app>" });
    expect(env.EMAIL_FROM).toBe("JobRadar <hi@jobradar.app>");
  });

  it("accepts a bare addr-spec", async () => {
    const { env } = await loadEnv({ EMAIL_FROM: "hi@jobradar.app" });
    expect(env.EMAIL_FROM).toBe("hi@jobradar.app");
  });

  it("rejects a value with no address at all", async () => {
    const msg = await rejection({ EMAIL_FROM: "not-an-email" });
    expect(msg).toContain("EMAIL_FROM");
  });

  it("rejects an unbalanced display name", async () => {
    const msg = await rejection({ EMAIL_FROM: "JobRadar hi@jobradar.app" });
    expect(msg).toContain("EMAIL_FROM");
  });
});

describe("env — service-role key hygiene (AGENTS.md hard constraints)", () => {
  it("keeps the service-role key server-scoped in the schema", async () => {
    const { env } = await loadEnv();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("sb_secret_test");
    // A NEXT_PUBLIC_ service-role key would be a leak; the schema must not define one.
    expect(Object.keys(env).some((k) => k === "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
  });
});
