/**
 * onboarding-normalise.test.ts — the wizard's pure helpers (ONB-002, ONB-003, ONB-005).
 *
 * Small and pure, so these run in the `node` environment. The behaviour worth pinning is
 * **case-insensitive de-duplication that preserves display casing** — the failure it replaces
 * was `["React", "react"]` becoming two chips, which then fails `updateProfile`'s own dedupe
 * expectations downstream and shows the user a list they did not write.
 */

import { describe, it, expect } from "vitest";

import {
  normaliseList,
  splitAndNormalise,
  stepOneComplete,
  stepTwoComplete,
  MIN_SKILLS,
  MAX_TITLES,
} from "@/lib/onboarding/normalise";

describe("normaliseList", () => {
  it("trims whitespace", () => {
    expect(normaliseList(["  React  ", "\tTypeScript\n"])).toEqual(["React", "TypeScript"]);
  });

  it("drops empty entries", () => {
    expect(normaliseList(["React", "", "   ", "Go"])).toEqual(["React", "Go"]);
  });

  it("de-duplicates case-insensitively but keeps the first-seen casing", () => {
    // The user typed "React" first, so "React" is what they see again on the next visit.
    expect(normaliseList(["React", "react", "REACT"])).toEqual(["React"]);
    expect(normaliseList(["react", "React"])).toEqual(["react"]);
  });

  it("keeps distinct entries that differ only by surrounding space", () => {
    expect(normaliseList(["Engineer", "Engineer "])).toEqual(["Engineer"]);
  });

  it("preserves first-seen order rather than sorting", () => {
    // Sorting would reorder the user's own list on every keystroke.
    expect(normaliseList(["Go", "Rust", "C++"])).toEqual(["Go", "Rust", "C++"]);
  });

  it("preserves internal punctuation and commas", () => {
    expect(normaliseList(["Sales, EMEA"])).toEqual(["Sales, EMEA"]);
  });

  it("caps at max, dropping rather than throwing", () => {
    // A wizard should not fail a save over the 11th keyword.
    const many = Array.from({ length: MAX_TITLES + 5 }, (_, i) => `title ${i}`);
    const result = normaliseList(many, MAX_TITLES);
    expect(result).toHaveLength(MAX_TITLES);
    expect(result[0]).toBe("title 0");
  });

  it("returns an empty array for empty input", () => {
    expect(normaliseList([])).toEqual([]);
    expect(normaliseList(["", "  "])).toEqual([]);
  });
});

describe("splitAndNormalise", () => {
  it("splits on commas and normalises each part", () => {
    expect(splitAndNormalise(" React, TypeScript ,, Go ")).toEqual(["React", "TypeScript", "Go"]);
  });

  it("de-duplicates across the split", () => {
    expect(splitAndNormalise("react,React,REACT")).toEqual(["react"]);
  });

  it("returns empty for a blank string", () => {
    expect(splitAndNormalise("")).toEqual([]);
    expect(splitAndNormalise("   ,  ")).toEqual([]);
  });
});

describe("step minimums", () => {
  it("step 1 needs at least one non-blank title", () => {
    expect(stepOneComplete([])).toBe(false);
    expect(stepOneComplete(["   "])).toBe(false);
    expect(stepOneComplete(["Engineer"])).toBe(true);
  });

  it("step 2 needs three skills, matching updateSkills' own minimum", () => {
    // The action enforces `.min(3)` too. Two places, one rule — asserted here so the UI cannot
    // drift to a different number and strand the user on a button that always 400s.
    expect(MIN_SKILLS).toBe(3);
    expect(stepTwoComplete(0)).toBe(false);
    expect(stepTwoComplete(2)).toBe(false);
    expect(stepTwoComplete(3)).toBe(true);
    expect(stepTwoComplete(10)).toBe(true);
  });
});
