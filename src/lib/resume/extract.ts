/**
 * extract.ts — resume profile extraction orchestrator (BE-315).
 *
 * Combines rule-based and LLM extraction:
 * 1. Always attempt rule-based extraction first (fast, deterministic, free)
 * 2. If confidence is below threshold *and the caller opted in*, fall back to LLM
 * 3. Return the best result with metadata about which method was used
 *
 * ## The LLM fallback is opt-in, and that is deliberate
 *
 * docs/02 §1.2: "Queue everything slow. HTTP requests must never block on the outside
 * world." A default-on fallback would make any caller that parses a resume perform a live
 * OpenRouter round trip inline — inside a Server Action, i.e. inside a user request. That
 * is a 2–10s latency spike on a cold parse, on a free tier that returns 429 under any
 * load (notes.md), with no queue to absorb it and no retry budget in the request.
 *
 * So the fallback must be requested explicitly, by a worker with time to spend. Today the
 * only caller is a Server Action, so nothing enables it and the pipeline stays pure and
 * offline. When BE-108's queue exists, a `parse_resume` task can pass `allowLlmFallback:
 * true` and do the slow work where it belongs.
 *
 * ## The LLM module is imported lazily, and that is also deliberate
 *
 * `extract-llm.ts` imports `@/lib/env`, which binds `process.env` and throws at import time
 * when a variable is missing. A static import here would make the *rules-only* path
 * unimportable without a fully configured environment — so the module could not be loaded,
 * let alone tested, on a clean checkout. Loading it inside the opt-in branch keeps this
 * file free of the env binding, which is what makes "no network by default" provable in a
 * test at all.
 */

import type { ExtractedProfile, ResumeParserConfig } from "@/types/resume";
import { extractProfileFromText } from "./extract-rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  profile: ExtractedProfile;
  method: "rules" | "llm" | "fallback";
  ruleConfidence: number;
  llmConfidence?: number;
}

/** Options for {@link extractProfile}, beyond the shared parser config. */
export interface ExtractOptions extends Partial<ResumeParserConfig> {
  /**
   * Permit a live OpenRouter call when rule-based confidence is too low.
   *
   * Defaults to `false`. See the module note: an inline fallback blocks a user request on
   * a third-party free tier, which docs/02 §1.2 forbids.
   */
  allowLlmFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ResumeParserConfig = {
  llmFallbackThreshold: 0.6,
  maxSkills: 30,
  maxTitles: 10,
};

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract a structured profile from resume text.
 *
 * Strategy:
 * 1. Run rule-based extraction
 * 2. If confidence >= threshold, return rule-based result
 * 3. If confidence is low **and** `allowLlmFallback` is set, attempt LLM extraction
 * 4. If the LLM result is better, return it
 * 5. Otherwise, return the rule-based result (better than nothing)
 *
 * @param text - The resume text to parse
 * @param options - Parser configuration; `allowLlmFallback` defaults to `false`
 * @returns The extraction result with metadata
 */
export async function extractProfile(
  text: string,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const { allowLlmFallback = false, ...config } = options;
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Step 1: Rule-based extraction
  const ruleResult = extractProfileFromText(text);
  const ruleConfidence = ruleResult.confidence;

  // Step 2: If confidence is high enough, return immediately
  if (ruleConfidence >= mergedConfig.llmFallbackThreshold) {
    return {
      profile: ruleResult,
      method: "rules",
      ruleConfidence,
    };
  }

  // Step 3: Low confidence. Only reach for the LLM if the caller opted in — otherwise
  // this function would make a live third-party call from inside a user request.
  if (!allowLlmFallback) {
    return {
      profile: ruleResult,
      method: "fallback",
      ruleConfidence,
    };
  }

  const llmResult = await extractProfileWithLlmLazy(text);

  // Step 4: Compare and return best result
  if (llmResult && llmResult.confidence > ruleConfidence) {
    return {
      profile: llmResult,
      method: "llm",
      ruleConfidence,
      llmConfidence: llmResult.confidence,
    };
  }

  // Step 5: Return rule-based as fallback
  return {
    profile: ruleResult,
    method: "fallback",
    ruleConfidence,
  };
}

/**
 * Load the LLM extractor on demand.
 *
 * A dynamic import, not a static one: see the module note. It also means the rules-only
 * path never pulls the OpenRouter client — or the env contract it needs — into the bundle.
 */
async function extractProfileWithLlmLazy(text: string) {
  const { extractProfileWithLlm } = await import("./extract-llm");
  return extractProfileWithLlm(text);
}
