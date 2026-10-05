/**
 * extract-llm.ts — LLM-based resume profile extraction (BE-315 fallback).
 *
 * Used when the rule-based extractor (extract-rules.ts) produces low confidence.
 * Sends the resume text to an OpenRouter free chat model and parses the
 * structured JSON response.
 *
 * IMPORTANT: This module makes external API calls. It must NEVER be called
 * from unit tests — mock the OpenRouter client in tests.
 *
 * Error handling (per notes.md §22):
 * - 429 responses are retried with exponential backoff
 * - Empty content in 200 responses is treated as failure
 * - All errors are caught and returned as fallback results
 */

import { env } from "@/lib/env";
import type { ExtractedProfile } from "@/types/resume";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a resume parsing assistant. Extract structured information from the provided resume text.

Return a JSON object with this exact structure:
{
  "fullName": string | null,
  "email": string | null,
  "phone": string | null,
  "location": {
    "city": string | null,
    "region": string | null,
    "countryCode": string | null
  },
  "titles": string[],
  "seniority": "intern" | "junior" | "mid" | "senior" | "lead" | "staff" | "principal" | "director" | "exec" | "unknown" | null,
  "yearsExperience": number | null,
  "skills": string[],
  "workModes": ("remote" | "hybrid" | "onsite")[],
  "minSalary": number | null,
  "salaryCurrency": string | null,
  "salaryPeriod": "year" | "month" | "hour" | null,
  "education": [{ "degree": string, "institution": string, "year": number | null }],
  "summary": string | null
}

Rules:
- Extract only information explicitly stated in the resume
- Use null for missing fields, never guess or infer
- For countryCode, use ISO 3166-1 alpha-2 (e.g. "US", "IN", "GB")
- For seniority, infer from years of experience if not explicitly stated
- For skills, list technical skills only (not soft skills)
- Return ONLY the JSON object, no additional text`;

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

/**
 * Extract profile from resume text using an LLM.
 *
 * @param text - The resume text to parse
 * @returns The extracted profile, or null if extraction fails
 */
export async function extractProfileWithLlm(text: string): Promise<ExtractedProfile | null> {
  const userPrompt = `Extract the profile from this resume:\n\n${text.slice(0, 8000)}`; // Limit to 8k chars

  const messages: OpenRouterMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await callOpenRouter(messages);

      if (!response) {
        // Empty response — retry
        await delay(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      const profile = parseLlmResponse(response);

      if (profile) {
        return profile;
      }

      // Parse failed — retry
      await delay(BASE_DELAY_MS * 2 ** attempt);
    } catch (error) {
      // Log error but don't throw — return null to trigger fallback
      console.error(`LLM extraction attempt ${attempt + 1} failed:`, error);

      if (attempt < MAX_RETRIES - 1) {
        await delay(BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// OpenRouter API call
// ---------------------------------------------------------------------------

async function callOpenRouter(messages: OpenRouterMessage[]): Promise<string | null> {
  const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
      "X-Title": "JobRadar Resume Parser",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_CHAT_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (response.status === 429) {
    // Rate limited — respect Retry-After header
    const retryAfter = response.headers.get("Retry-After");
    const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_DELAY_MS * 2 ** MAX_RETRIES;
    await delay(delayMs);
    throw new Error("Rate limited by OpenRouter");
  }

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenRouterResponse;

  // Validate non-empty content (per notes.md §22: 200 ≠ usable)
  const content = data.choices?.[0]?.message?.content;

  if (!content || content.trim().length === 0) {
    return null;
  }

  return content;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseLlmResponse(response: string): ExtractedProfile | null {
  try {
    // Try to extract JSON from the response
    // The LLM might wrap the JSON in markdown code blocks
    const jsonMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(response);
    const jsonString = jsonMatch?.[1] ?? response;

    const parsed: unknown = JSON.parse(jsonString);

    // Validate required fields
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const p = parsed as Record<string, unknown>;

    // Calculate confidence (LLM extraction is generally higher confidence)
    const confidence = calculateLlmConfidence(p);

    const location = p.location as Record<string, unknown> | undefined;

    return {
      fullName: (p.fullName as string) ?? null,
      email: (p.email as string) ?? null,
      phone: (p.phone as string) ?? null,
      location: {
        city: (location?.city as string) ?? null,
        region: (location?.region as string) ?? null,
        countryCode: (location?.countryCode as string) ?? null,
      },
      titles: Array.isArray(p.titles) ? (p.titles as string[]) : [],
      seniority: (p.seniority as ExtractedProfile["seniority"]) ?? null,
      yearsExperience: (p.yearsExperience as number) ?? null,
      skills: Array.isArray(p.skills) ? (p.skills as string[]) : [],
      workModes: Array.isArray(p.workModes) ? (p.workModes as ("remote" | "hybrid" | "onsite")[]) : [],
      minSalary: (p.minSalary as number) ?? null,
      salaryCurrency: (p.salaryCurrency as string) ?? null,
      salaryPeriod: (p.salaryPeriod as "year" | "month" | "hour") ?? null,
      education: Array.isArray(p.education) ? (p.education as ExtractedProfile["education"]) : [],
      summary: (p.summary as string) ?? null,
      confidence,
      needsReview: confidence < 0.7,
    };
  } catch (error) {
    console.error("Failed to parse LLM response:", error);
    return null;
  }
}

function calculateLlmConfidence(profile: Record<string, unknown>): number {
  let score = 0;
  let maxScore = 0;

  maxScore += 20;
  if (profile.email) score += 20;

  maxScore += 15;
  const location = profile.location as Record<string, unknown> | undefined;
  if (location?.city || location?.countryCode) score += 15;

  maxScore += 20;
  if (Array.isArray(profile.titles) && profile.titles.length > 0) score += 20;

  maxScore += 20;
  if (Array.isArray(profile.skills) && profile.skills.length > 0) score += 20;

  maxScore += 10;
  if (profile.seniority) score += 10;

  maxScore += 15;
  if (profile.summary) score += 15;

  return maxScore > 0 ? score / maxScore : 0;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
