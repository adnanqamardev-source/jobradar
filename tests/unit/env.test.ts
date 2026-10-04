/**
 * env contract tests (docs/02 §7.2).
 *
 * These import `@/lib/env/schema`, which is pure. They do not touch `process.env`, do
 * not call `vi.resetModules()`, and have nothing to restore — the test surface is the
 * same one any caller of `parseEnv` would use.
 *
 * The module-load binding is a separate concern and lives in its own describe block at
 * the bottom. That block is the only place here that loads `@/lib/env`, which is exactly
 * why it is a different module: loading the binding evaluates `process.env`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatEnvProblems, parseEnv, type EnvInput } from "@/lib/env/schema";

const VALID: EnvInput = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  CRON_SECRET: "a".repeat(64),
  OPENROUTER_API_KEY: "sk-or-v1-test",
};

/** Validate a record and return the env, or throw with the rendered problems. */
const envOf = (overrides: EnvInput = {}) => {
  const result = parseEnv({ ...VALID, ...overrides });
  if (result.ok) return result.env;
  throw new Error(formatEnvProblems(result.problems));
};

/** Assert a record is rejected, returning the message a boot error would show. */
const rejection = (overrides: EnvInput = {}) => {
  const result = parseEnv({ ...VALID, ...overrides });
  if (result.ok) throw new Error("expected the record to be rejected, but it parsed");
  return formatEnvProblems(result.problems);
};

describe("env — required vars", () => {
  it("parses when every required var is present", () => {
    const env = envOf();
    expect(env.CRON_SECRET).toHaveLength(64);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-test");
  });

  it("rejects a CRON_SECRET shorter than 32 chars", () => {
    const msg = rejection({ CRON_SECRET: "too-short" });
    expect(msg).toContain("CRON_SECRET");
    expect(msg).toContain("32");
  });

  it("rejects a missing OPENROUTER_API_KEY", () => {
    expect(rejection({ OPENROUTER_API_KEY: undefined })).toContain("OPENROUTER_API_KEY");
  });

  it("rejects a non-URL NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(rejection({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" })).toContain(
      "NEXT_PUBLIC_SUPABASE_URL",
    );
  });

  it("reports every problem at once, not just the first", () => {
    // Start from VALID and break exactly one thing, so the expected set is knowable.
    const result = parseEnv({ ...VALID, CRON_SECRET: "short", OPENROUTER_API_KEY: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.field).sort()).toEqual([
      "CRON_SECRET",
      "OPENROUTER_API_KEY",
    ]);
  });

  it("names each offending variable in the rendered boot error", () => {
    const result = parseEnv({ ...VALID, CRON_SECRET: "short" });
    if (result.ok) throw new Error("expected rejection");
    const msg = formatEnvProblems(result.problems);
    expect(msg).toContain("CRON_SECRET");
    // An operator should not have to read the stack to learn which var is wrong.
    expect(msg.startsWith("❌ Invalid environment variables:")).toBe(true);
  });
});

describe("env — free-model constraint (docs/02 §8 cost envelope)", () => {
  it("rejects a paid embedding model", () => {
    const msg = rejection({ OPENROUTER_EMBEDDING_MODEL: "openai/text-embedding-3-small" });
    expect(msg).toContain("OPENROUTER_EMBEDDING_MODEL");
    expect(msg).toContain(":free");
  });

  it("rejects a paid chat model", () => {
    const msg = rejection({ OPENROUTER_CHAT_MODEL: "openai/gpt-4o-mini" });
    expect(msg).toContain("OPENROUTER_CHAT_MODEL");
    expect(msg).toContain(":free");
  });

  it("defaults to free 2048-dim embeddings and a free chat model", () => {
    const env = envOf();
    expect(env.OPENROUTER_EMBEDDING_MODEL).toBe("nvidia/nemotron-3-embed-1b:free");
    expect(env.OPENROUTER_CHAT_MODEL).toBe("qwen/qwen3.8-27b:free");
    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
});

describe("env — blank is not absent (docs/02 §7.2 rule 6a)", () => {
  it("treats VAR= as undefined, so boot does not fail on unset optionals", () => {
    const env = envOf({
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

  it("treats whitespace-only values as undefined too", () => {
    expect(envOf({ FIRECRAWL_API_KEY: "   " }).FIRECRAWL_API_KEY).toBeUndefined();
  });

  it("still rejects a blank URL var that is genuinely malformed", () => {
    expect(rejection({ SENTRY_DSN: "not-a-url" })).toContain("SENTRY_DSN");
  });

  it("falls back to the default when a defaulted var is left blank", () => {
    // `VAR=` for a var with a default must use the default, not fail boot. This is the
    // same class of bug as the optional-vars case, one level up.
    const env = envOf({
      NEXT_PUBLIC_APP_URL: "",
      OPENROUTER_BASE_URL: "",
      POSTHOG_HOST: "",
      OPENROUTER_EMBEDDING_MODEL: "",
      OPENROUTER_CHAT_MODEL: "",
    });
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(env.OPENROUTER_EMBEDDING_MODEL).toBe("nvidia/nemotron-3-embed-1b:free");
  });

  it("falls back to the default when a defaulted var is absent entirely", () => {
    const record = { ...VALID };
    delete record.NEXT_PUBLIC_APP_URL;
    const result = parseEnv(record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });

  it("keeps the default behind the blank check, not in front of it", () => {
    // Regression: `blank(schema).default(x)` looks correct and is not. The outer default
    // only fires on `undefined`, so a raw `""` skipped it, the inner optional swallowed the
    // value, and a refined schema (`freeModel`) then rejected the result. Putting the
    // default inside the preprocess is what makes both `VAR=` and a missing `VAR` work.
    for (const blank of ["", "   "]) {
      const result = parseEnv({ ...VALID, OPENROUTER_EMBEDDING_MODEL: blank });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.env.OPENROUTER_EMBEDDING_MODEL).toBe("nvidia/nemotron-3-embed-1b:free");
    }
  });
});

describe("env — EMAIL_FROM accepts RFC 5322 display-name form", () => {
  it("accepts the value docs/02 §7.1 documents", () => {
    expect(envOf({ EMAIL_FROM: "JobRadar <hi@jobradar.app>" }).EMAIL_FROM).toBe(
      "JobRadar <hi@jobradar.app>",
    );
  });

  it("accepts a bare addr-spec", () => {
    expect(envOf({ EMAIL_FROM: "hi@jobradar.app" }).EMAIL_FROM).toBe("hi@jobradar.app");
  });

  it("rejects a value with no address at all", () => {
    expect(rejection({ EMAIL_FROM: "not-an-email" })).toContain("EMAIL_FROM");
  });

  it("rejects an unbalanced display name", () => {
    expect(rejection({ EMAIL_FROM: "JobRadar hi@jobradar.app" })).toContain("EMAIL_FROM");
  });
});

describe("env — documented defaults (docs/02 §7.1)", () => {
  it("defaults the four RATE_LIMIT_* ceilings the example file omits", () => {
    const env = envOf();
    expect(env.RATE_LIMIT_APPLY_PER_MINUTE).toBe(10);
    expect(env.RATE_LIMIT_SAVE_PER_MINUTE).toBe(30);
    expect(env.RATE_LIMIT_DISMISS_PER_MINUTE).toBe(30);
    expect(env.RATE_LIMIT_SEARCH_PER_MINUTE).toBe(60);
  });

  it("coerces numeric strings from a .env file", () => {
    expect(envOf({ RATE_LIMIT_APPLY_PER_MINUTE: "5" }).RATE_LIMIT_APPLY_PER_MINUTE).toBe(5);
  });

  it("rejects a non-positive or non-integer ceiling", () => {
    expect(rejection({ RATE_LIMIT_APPLY_PER_MINUTE: "0" })).toContain(
      "RATE_LIMIT_APPLY_PER_MINUTE",
    );
    expect(rejection({ RATE_LIMIT_APPLY_PER_MINUTE: "1.5" })).toContain(
      "RATE_LIMIT_APPLY_PER_MINUTE",
    );
  });
});

describe("env — service-role key hygiene (AGENTS.md hard constraints)", () => {
  it("keeps the service-role key server-scoped in the schema", () => {
    expect(envOf().SUPABASE_SERVICE_ROLE_KEY).toBe("sb_secret_test");
    // A NEXT_PUBLIC_ service-role key would be a leak; the schema must not define one.
    expect(Object.keys(envOf()).some((k) => k === "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY")).toBe(
      false,
    );
  });
});

describe("env — the module-load binding", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  /** Point process.env at a known-good or known-bad record, then load the module. */
  const loadWith = async (overrides: EnvInput) => {
    const record = { ...VALID, ...overrides };
    for (const [k, v] of Object.entries(record)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    return import("@/lib/env");
  };

  it("exposes the validated object on import", async () => {
    const { env } = await loadWith({});
    expect(env.CRON_SECRET).toHaveLength(64);
  });

  it("throws at import time on misconfiguration (docs/02 §7.2 rule 3)", async () => {
    // The one behaviour a pure function cannot express, and the reason the binding exists.
    await expect(loadWith({ CRON_SECRET: "short" })).rejects.toThrow(/CRON_SECRET/);
  });
});