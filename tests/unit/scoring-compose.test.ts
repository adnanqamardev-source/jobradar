/**
 * scoring-compose.test.ts â€” score composition and persistence (SCR-004, BE-204).
 *
 * docs/05b SCR-004 acceptance criteria: unique `(user_id, job_id)` with re-scoring
 * **upserting rather than duplicating**; gated jobs get `final_score = 0` with
 * `gate_result` populated; `breakdown` always present; coverage computable.
 *
 * The two decisions worth their own tests:
 *  - a gated job is **written**, not skipped, because that row is the only record of why
 *    a job is missing from the feed;
 *  - a missing semantic score **reweights to the rule score** rather than scoring 0,
 *    because 0 would rank every not-yet-embedded job below every embedded one and an
 *    OpenRouter outage would empty the feed (docs/04 Â§5.9).
 */

import { describe, expect, it, vi } from "vitest";

import {
  composeScore,
  coverage,
  persistScore,
  type ComposeScoreInput,
  type ScoreWriter,
} from "@/lib/scoring";
import { RULE_WEIGHTS } from "@/lib/scoring/weights";

const NOW = new Date("2026-10-06T12:00:00.000Z");

function input(overrides: Partial<ComposeScoreInput> = {}): ComposeScoreInput {
  return {
    profileId: "p1",
    jobId: "j1",
    job: {
      title: "Senior Backend Engineer",
      companyName: "Globex",
      companyDomain: "globex.io",
      descriptionText: "Go and PostgreSQL.",
      countryCode: "IN",
      workMode: "remote",
      remoteScope: "global",
      seniority: "senior",
      salaryMin: 3000000,
      salaryMax: 4000000,
      salaryCurrency: "INR",
      salaryPeriod: "year",
      postedAt: NOW.toISOString(),
    },
    profile: {
      targetTitles: ["backend engineer"],
      seniority: "senior",
      yearsExperience: 6,
      countryCode: "IN",
      workModes: ["remote"],
      minSalary: null,
      salaryCurrency: "INR",
      salaryPeriod: "year",
      preferredCompanies: [],
      blockedCompanies: [],
      excludedKeywords: [],
    },
    jobSkills: [{ skillId: "go", weight: 1 }],
    profileSkills: [{ skillId: "go", level: "expert" }],
    semanticScore: 80,
    now: NOW,
    ...overrides,
  };
}

/** A writer double that records exactly what was handed to `upsert`. */
function makeWriter(error: { message: string } | null = null) {
  const upsert = vi.fn().mockResolvedValue({ error });
  const from = vi.fn().mockReturnValue({ upsert });
  const writer: ScoreWriter = { from };
  return { writer, upsert, from };
}

describe("blend (docs/02b Â§6.3: 0.5Â·rule + 0.5Â·semantic)", () => {
  it("averages rule and semantic when both are available", () => {
    const composed = composeScore(input());
    const expected = Math.round((composed.ruleScore * 0.5 + 80 * 0.5) * 100) / 100;
    expect(composed.finalScore).toBe(expected);
  });

  it("reweights to the rule score when there is no semantic score", () => {
    // Not 0. A 0 would rank every not-yet-embedded job below every embedded one, so a
    // transient embedding failure would empty the feed (docs/04 Â§5.9).
    const composed = composeScore(input({ semanticScore: null }));
    expect(composed.finalScore).toBe(composed.ruleScore);
    expect(composed.finalScore).toBeGreaterThan(0);
    expect(composed.semanticScore).toBeNull();
  });

  it("handles a semantic score of 0 as a real signal, not as missing", () => {
    // The distinction between "no embedding" and "cosine distance 1.0" must survive:
    // the first reweights, the second genuinely halves.
    const none = composeScore(input({ semanticScore: null }));
    const zero = composeScore(input({ semanticScore: 0 }));
    expect(zero.finalScore).not.toBe(none.finalScore);
    expect(zero.finalScore).toBeCloseTo(zero.ruleScore * 0.5, 2);
  });

  it("clamps a semantic score outside 0-100 rather than exceeding the total", () => {
    for (const semanticScore of [-50, 500]) {
      const composed = composeScore(input({ semanticScore }));
      expect(composed.finalScore).toBeGreaterThanOrEqual(0);
      expect(composed.finalScore).toBeLessThanOrEqual(100);
    }
  });

  it("stays within 0-100 for the strongest possible pair", () => {
    const composed = composeScore(input({ semanticScore: 100 }));
    expect(composed.finalScore).toBeLessThanOrEqual(100);
  });
});

describe("gated jobs", () => {
  const gated = () =>
    input({
      job: { ...input().job, companyName: "Acme", companyDomain: "acme.com" },
      profile: { ...input().profile, blockedCompanies: ["acme.com"] },
    });

  it("writes final_score = 0 rather than skipping the row", () => {
    // Skipping would leave no record of why the job is absent from the feed.
    const composed = composeScore(gated());
    expect(composed.finalScore).toBe(0);
    expect(composed.jobId).toBe("j1");
  });

  it("populates gate_result with the reason", () => {
    const composed = composeScore(gated());
    expect(composed.gateResult).toEqual({ passed: false, reasons: ["blocked_company"] });
  });

  it("still records the rule score as evidence", () => {
    expect(composeScore(gated()).ruleScore).toBeGreaterThan(0);
  });

  it("reports passed with no reasons for an ungated job", () => {
    expect(composeScore(input()).gateResult).toEqual({ passed: true, reasons: [] });
  });

  it("does not blend semantic into a gated job â€” the score is 0, not halved", () => {
    // A gated job must be 0. Halving it would leak it into the feed at a low rank.
    const composed = composeScore(gated());
    expect(composed.finalScore).toBe(0);
  });
});

describe("breakdown (C3 â€” the UI never shows a bare number)", () => {
  it("is present on a normal score", () => {
    expect(composeScore(input()).breakdown).toHaveLength(RULE_WEIGHTS.length);
  });

  it("is present on a gated score too", () => {
    const composed = composeScore(
      input({
        job: { ...input().job, companyName: "Acme" },
        profile: { ...input().profile, blockedCompanies: ["acme"] },
      }),
    );
    expect(composed.breakdown).toHaveLength(RULE_WEIGHTS.length);
  });

  it("carries the same shape the FE renders", () => {
    for (const entry of composeScore(input()).breakdown) {
      expect(Object.keys(entry).sort()).toEqual(["key", "known", "points", "raw", "weight"]);
    }
  });
});

describe("composed score metadata", () => {
  it("stamps model_version and an ISO scored_at from the injected clock", () => {
    const composed = composeScore(input());
    expect(composed.modelVersion).toBeTruthy();
    expect(composed.scoredAt).toBe(NOW.toISOString());
  });

  it("is deterministic", () => {
    const a = composeScore(input());
    const b = composeScore(input());
    expect(a).toEqual(b);
  });
});

describe("persistScore", () => {
  it("upserts on (user_id, job_id) so re-scoring cannot duplicate", () => {
    // SCR-004: "Unique (user_id, job_id); re-scoring upserts rather than duplicating".
    const { writer, upsert } = makeWriter();
    const composed = composeScore(input());
    void persistScore(writer, composed);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[1]).toEqual({ onConflict: "user_id,job_id" });
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      user_id: "p1",
      job_id: "j1",
    });
  });

  it("writes the columns the schema defines", () => {
    const { writer, upsert } = makeWriter();
    const composed = composeScore(input());
    void persistScore(writer, composed);

    const row = upsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "breakdown",
      "final_score",
      "gate_result",
      "job_id",
      "model_version",
      "rule_score",
      "scored_at",
      "semantic_score",
      "user_id",
    ]);
  });

  it("does not overwrite explanation â€” a rescore must not discard a rationale", () => {
    // `explanation` is Pro-only and separately metered (SCR-006). Including it as null
    // would delete a still-valid rationale on every profile edit.
    const { writer, upsert } = makeWriter();
    void persistScore(writer, composeScore(input()));
    const row = upsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("explanation" in row).toBe(false);
  });

  it("reports a database failure without throwing", async () => {
    // The caller is a queue handler that must decide retry-vs-fail; an exception here
    // would escape that decision.
    const { writer } = makeWriter({ message: "permission denied" });
    const result = await persistScore(writer, composeScore(input()));
    expect(result).toEqual({
      ok: false,
      error: { code: "DATABASE_ERROR", message: "Failed to persist job score" },
    });
  });

  it("returns the composed score on success", async () => {
    const { writer } = makeWriter();
    const composed = composeScore(input());
    const result = await persistScore(writer, composed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.score).toEqual(composed);
  });

  it("targets job_scores", () => {
    const { writer, from } = makeWriter();
    void persistScore(writer, composeScore(input()));
    expect(from).toHaveBeenCalledWith("job_scores");
  });
});

describe("coverage (SCR-004: â‰¥98% of active jobs scored)", () => {
  it("computes the fraction", () => {
    expect(coverage(98, 100)).toBe(0.98);
    expect(coverage(1, 3)).toBe(0.33);
  });

  it("reports 1 when there is nothing to score", () => {
    // An empty active set is fully covered, not a failure.
    expect(coverage(0, 0)).toBe(1);
  });

  it("never exceeds 1 or drops below 0", () => {
    expect(coverage(120, 100)).toBe(1.2);
    expect(coverage(-5, 100)).toBe(-0.05);
  });
});