/**
 * logger.test.ts — unit tests for structured logging and secret redaction (FND-004).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redact, redactObject, generateRequestId, logger } from "@/lib/logger";

// Helper to construct test keys dynamically so static gitleaks scanner doesn't flag test cases as leaks
const k = (prefix: string, body: string) => prefix + body;

describe("redact", () => {
  it("redacts Supabase service keys", () => {
    const key = k("sb_secret_", "abcdef1234567890abcdef1234567890");
    const input = `Connecting with key ${key} and more`;
    const output = redact(input);
    expect(output).toBe("Connecting with key *** and more");
  });

  it("redacts Supabase publishable keys", () => {
    const key = k("sb_publishable_", "abcdef1234567890abcdef1234567890");
    const input = `Publishable key ${key} end`;
    const output = redact(input);
    expect(output).toBe("Publishable key *** end");
  });

  it("redacts JWT tokens", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `Authorization: Bearer ${token}`;
    const output = redact(input);
    expect(output).not.toContain(token);
  });

  it("redacts OpenRouter keys", () => {
    const key = k("sk-or-v1-", "abcdef1234567890abcdef1234567890abcdef1234567890");
    const input = `Using key ${key} for AI`;
    const output = redact(input);
    expect(output).toBe("Using key *** for AI");
  });

  it("redacts Stripe webhook and live keys", () => {
    const whsec = k("whsec_", "abcdef1234567890abcdef1234567890");
    const rklive = k("rk_live_", "abcdef1234567890abcdef1234567890");
    const input = `Stripe ${whsec} and ${rklive}`;
    const output = redact(input);
    expect(output).toBe("Stripe *** and ***");
  });

  it("redacts authorization headers and cookies", () => {
    const input = "Headers authorization:BasicAuthToken and cookie:session=secretvalue";
    const output = redact(input);
    expect(output).toBe("Headers *** and ***");
  });

  it("redacts generic API keys, secrets, and tokens", () => {
    const input = "API_KEY=secretval and MY_SECRET = supersecret and access_token:tokval";
    const output = redact(input);
    expect(output).toBe("*** and *** and ***");
  });
});

describe("redactObject", () => {
  it("recursively redacts strings in objects and arrays", () => {
    const sbKey = k("sb_secret_", "abcdef1234567890abcdef1234567890");
    const orKey = k("sk-or-v1-", "abcdef1234567890abcdef1234567890abcdef1234567890");
    const whKey = k("whsec_", "abcdef1234567890abcdef1234567890");

    const obj = {
      message: `User login with key ${sbKey}`,
      nested: {
        token: orKey,
        safe: "hello world",
      },
      list: [
        "ApiKey=secret123",
        { innerKey: whKey },
      ],
      number: 42,
      boolean: true,
      nullVal: null,
    };

    const redacted = redactObject(obj);

    expect(redacted.message).toBe("User login with key ***");
    expect(redacted.nested.token).toBe("***");
    expect(redacted.nested.safe).toBe("hello world");
    expect(redacted.list[0]).toBe("***");
    expect((redacted.list[1] as { innerKey: string }).innerKey).toBe("***");
    expect(redacted.number).toBe(42);
    expect(redacted.boolean).toBe(true);
    expect(redacted.nullVal).toBeNull();
  });
});

describe("generateRequestId", () => {
  it("generates an 8-character string", () => {
    const id = generateRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(8);
  });
});

describe("logger", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("logs structured info messages with redaction", () => {
    const sbKey = k("sb_secret_", "abcdef1234567890abcdef1234567890");
    const orKey = k("sk-or-v1-", "abcdef1234567890abcdef1234567890abcdef1234567890");

    logger.setRequestId("req-123");
    logger.info(`User action with ${sbKey}`, {
      secretData: orKey,
    });

    expect(consoleLogSpy).toHaveBeenCalled();
    const callArg = consoleLogSpy.mock.calls[0]?.[0];
    expect(typeof callArg).toBe("string");
    const parsed = JSON.parse(callArg as string);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("User action with ***");
    expect(parsed.requestId).toBe("req-123");
    expect(parsed.secretData).toBe("***");
  });
});
