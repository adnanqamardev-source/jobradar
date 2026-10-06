/**
 * scoring-weights.test.ts — the weight set as a set (SCR-002, BE-202).
 *
 * The sum-to-100 property is a property of the *collection*, so no single scoring call
 * exercises it. A typo that made the weights sum to 98 would rescale every score in
 * the product and no unit test would fail unless one happened to assert a total.
 */

import { describe, expect, it } from "vitest";

import {
  NEUTRAL_RAW,
  RULE_MODEL_VERSION,
  RULE_WEIGHTS,
  SEMANTIC_BLEND,
  assertWeightsSumTo100,
  weightFor,
} from "@/lib/scoring/weights";

describe("RULE_WEIGHTS", () => {
  it("sums to exactly 100 (docs/02b §6.3)", () => {
    expect(assertWeightsSumTo100).not.toThrow();
    expect(RULE_WEIGHTS.reduce((s, w) => s + w.weight, 0)).toBe(100);
  });

  it("matches the documented weights exactly", () => {
    expect(Object.fromEntries(RULE_WEIGHTS.map((w) => [w.key, w.weight]))).toEqual({
      skills: 35,
      seniority: 15,
      compensation: 15,
      "work-mode": 15,
      recency: 10,
      "company-preference": 10,
    });
  });

  it("has unique keys — the breakdown is keyed by them", () => {
    const keys = RULE_WEIGHTS.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("emits keys in the order docs/04 §3.4 renders them", () => {
    expect(RULE_WEIGHTS.map((w) => w.key)).toEqual([
      "skills",
      "seniority",
      "compensation",
      "work-mode",
      "recency",
      "company-preference",
    ]);
  });

  it("all weights are positive", () => {
    for (const w of RULE_WEIGHTS) {
      expect(w.weight, `${w.key} must be positive`).toBeGreaterThan(0);
    }
  });
});

describe("assertWeightsSumTo100", () => {
  it("throws on a set that does not sum to 100, naming the components", () => {
    // The failure message is what a future author reads, so it must say which value is wrong.
    expect(() =>
      assertWeightsSumTo100([
        { key: "skills", weight: 35 },
        { key: "seniority", weight: 10 },
      ]),
    ).toThrow(/must sum to 100.*skills=35, seniority=10/s);
  });

  it("rejects a set that overshoots as well as undershoots", () => {
    expect(() => assertWeightsSumTo100([{ key: "skills", weight: 140 }])).toThrow(/sum to 100/);
  });
});

describe("weightFor", () => {
  it("returns the configured weight", () => {
    expect(weightFor("skills")).toBe(35);
    expect(weightFor("recency")).toBe(10);
  });

  it("throws on an unknown key rather than returning a silent 0", () => {
    // Returning 0 would drop a component from the score with no visible cause.
    expect(() => weightFor("nope" as "skills")).toThrow(/Unknown scoring weight/);
  });
});

describe("blend + versioning", () => {
  it("blends rule and semantic evenly (docs/02b §6.3)", () => {
    expect(SEMANTIC_BLEND).toBe(0.5);
  });

  it("stamps a model version, so a stored score states which weights produced it", () => {
    expect(RULE_MODEL_VERSION).toBeTruthy();
  });

  it("neutral is the midpoint — unknown is neither rewarded nor punished", () => {
    expect(NEUTRAL_RAW).toBe(0.5);
  });
});