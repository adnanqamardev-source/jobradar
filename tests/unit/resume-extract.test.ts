/**
 * extract.test.ts — the extraction orchestrator (BE-315).
 *
 * The property that matters here is not extraction quality — `extract-rules.test.ts`
 * covers that — but that parsing a resume performs **no network I/O** unless a caller
 * explicitly asks for the LLM fallback.
 *
 * docs/02 §1.2 requires that an HTTP request never block on the outside world. The
 * orchestrator is reached from a Server Action, so a default-on fallback would put a live
 * OpenRouter round trip (seconds, on a free tier that returns 429 under load) inside a user
 * request. Asserting that with a mocked `fetch` is what keeps that from regressing quietly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { extractProfile } from "@/lib/resume/extract";

const RICH_RESUME = `
  John Doe
  john.doe@example.com
  +1 (555) 123-4567
  San Francisco, CA, USA
  Senior Software Engineer
  5+ years of experience
  Skills: JavaScript, TypeScript, React, Node.js
  Summary: Experienced engineer with a strong background.
`;

const SPARSE_RESUME = "Some unstructured text with no contact details.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractProfile", () => {
  it("returns a rules result without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await extractProfile(RICH_RESUME);

    expect(result.method).toBe("rules");
    expect(result.profile.email).toBe("john.doe@example.com");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT call the LLM on low confidence unless opted in", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await extractProfile(SPARSE_RESUME);

    // Low confidence, and still no network call: the fallback is opt-in.
    expect(result.ruleConfidence).toBeLessThan(0.6);
    expect(result.method).toBe("fallback");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports method=fallback, never method=llm, without opt-in", async () => {
    const result = await extractProfile(SPARSE_RESUME);
    expect(result.method).not.toBe("llm");
    expect(result.llmConfidence).toBeUndefined();
  });

  it("marks low-confidence output as needing review", async () => {
    const result = await extractProfile(SPARSE_RESUME);
    expect(result.profile.needsReview).toBe(true);
  });

  it("is deterministic for the same input", async () => {
    const first = await extractProfile(RICH_RESUME);
    const second = await extractProfile(RICH_RESUME);

    expect(first.profile).toEqual(second.profile);
    expect(first.ruleConfidence).toBe(second.ruleConfidence);
  });
});