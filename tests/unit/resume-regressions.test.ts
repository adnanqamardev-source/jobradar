/**
 * resume-regressions.test.ts — pins every bug found in the 2026-10-04 review.
 *
 * ## Why these tests exist in this shape
 *
 * Each case below was a real defect, confirmed by running the code before the fix. The
 * original suite passed with all of them present because no fixture used "Staff Engineer",
 * "C++", "LPA", a lakh range, a negative file size, or an unsupported MIME type. Green tests
 * were not evidence of correctness — they were evidence of narrow coverage.
 *
 * So these are deliberately written as *table* tests over the input that broke, not as
 * assertions about current behaviour discovered after the fact. If someone reintroduces
 * `lead|principal|staff` inside the `senior` pattern, the "Staff Engineer -> staff" row fails
 * immediately rather than silently classifying senior staff as senior.
 */

import { describe, it, expect } from "vitest";
import { extractProfileFromText } from "@/lib/resume/extract-rules";
import { parseSalary } from "@/lib/ingest/normalize";
import {
  getResumeFilePath,
  validateResumeFile,
  resumeExtensionFor,
  MAX_RESUME_BYTES,
} from "@/lib/storage/resume-file";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("seniority: no level may shadow another", () => {
  // The defect: `senior` listed `lead|principal|staff`, and SENIORITY_KEYWORDS is scanned in
  // declaration order with first-match-wins. So "Staff Engineer" returned "senior" and the
  // lead/staff/principal branches below were unreachable.
  const cases = [
    ["Staff Engineer", "staff"],
    ["Staff Software Engineer", "staff"],
    ["Principal Developer", "principal"],
    ["Principal Product Manager", "principal"],
    ["Tech Lead", "lead"],
    ["Team Lead", "lead"],
    ["Lead Engineer", "lead"],
    ["Senior Engineer", "senior"],
    ["Junior Developer", "junior"],
    ["Director of Engineering", "director"],
  ] as const;

  for (const [title, expected] of cases) {
    it(`classifies "${title}" as ${expected}`, () => {
      const profile = extractProfileFromText(
        `Jane Doe\njane@example.com\nExperience:\n${title}\nAcme Corp`,
      );
      expect(profile.seniority).toBe(expected);
    });
  }

  it("lets an explicit title outrank a conflicting years figure", () => {
    // Second defect found while fixing the first: year ranges lived inside the level
    // patterns, so `senior`'s "5+ years" beat a stated "Junior Developer" by position alone.
    // Years are a fallback, applied only when no keyword matched.
    const profile = extractProfileFromText(
      "Jane Doe\njane@example.com\nExperience:\nJunior Developer\n5+ years of experience",
    );
    expect(profile.seniority).toBe("junior");
  });

  it("still infers a level from years when no title keyword is present", () => {
    const profile = extractProfileFromText(
      "Jane Doe\njane@example.com\nExperience:\nAcme Corp\n7+ years of experience",
    );
    expect(profile.seniority).toBe("senior");
  });
});

describe("skills: entries ending in a non-word character", () => {
  // The defect: the trailing guard was `\b`, which requires a word/non-word boundary. After
  // the final "+" in "C++" there is none, so C++ and C# were in COMMON_SKILLS but could never
  // be extracted.
  it.each([
    ["C++", true],
    ["C#", true],
    ["JavaScript", true],
    ["Go", true],
  ])("extracts %s", (skill, expected) => {
    const profile = extractProfileFromText(`Jane Doe\njane@example.com\nSkills: ${skill}, Python`);
    expect(profile.skills.includes(skill)).toBe(expected);
  });

  it("still refuses a word-boundary match inside a longer word", () => {
    // The lookahead must not become so loose that "Go" matches "Going".
    const profile = extractProfileFromText("Jane Doe\njane@example.com\nGoing to college");
    expect(profile.skills).not.toContain("Go");
  });
});

describe("salary: lakh ranges and decimals", () => {
  it("keeps both bounds of a lakh range", () => {
    // The defect: `exec` returned after the first match, so "15L - 20L" silently dropped the
    // upper bound that the docstring advertises as a supported format.
    expect(parseSalary("15L - 20L")).toEqual({
      min: 1500000,
      max: 2000000,
      currency: "INR",
      period: "year",
    });
  });

  it("still handles a single lakh figure", () => {
    expect(parseSalary("15L per year")).toEqual({
      min: 1500000,
      max: null,
      currency: "INR",
      period: "year",
    });
  });

  it("does not truncate decimals", () => {
    // The defect: parseInt truncated "$120,000.50" to 120000. A salary floor that silently
    // rounds down changes which jobs clear a gate.
    expect(parseSalary("$120,000.50")).toEqual({
      min: 120000.5,
      max: null,
      currency: "USD",
      period: "year",
    });
  });
});

describe("salary: LPA", () => {
  // The defect: "12 LPA" fell through the lakh pattern (which needs a word boundary after
  // "l", and "L" is followed by the word char "P") to the generic number scan, yielding
  // { min: 12, currency: "USD" } — wrong by six orders of magnitude in the wrong currency.
  it.each(["12 LPA", "CTC 12 LPA", "Expected CTC: 12 LPA"])("parses %s as INR per year", (raw) => {
    expect(parseSalary(raw)).toEqual({
      min: 1200000,
      max: null,
      currency: "INR",
      period: "year",
    });
  });

  it("parses a fractional LPA", () => {
    expect(parseSalary("12.5 LPA").min).toBe(1250000);
  });
});

describe("resume-file: MIME allowlist is the single source of truth", () => {
  // The defect: getResumeFilePath mapped *any* non-PDF type to ".docx", so an unsupported
  // upload produced a valid-looking path that disagreed with validateResumeFile.
  it("maps the supported types", () => {
    expect(resumeExtensionFor(PDF)).toBe("pdf");
    expect(resumeExtensionFor(DOCX)).toBe("docx");
  });

  it.each(["image/png", "text/html", "application/zip", "", "application/pdf-ish"])(
    "returns null for %s",
    (mime) => {
      expect(resumeExtensionFor(mime)).toBeNull();
    },
  );

  it("builds a user-scoped path for a supported type", () => {
    expect(getResumeFilePath("user-1", "resume-2", PDF)).toBe("user-1/resume-2.pdf");
    expect(getResumeFilePath("user-1", "resume-2", DOCX)).toBe("user-1/resume-2.docx");
  });

  it("throws rather than inventing a .docx path for an unsupported type", () => {
    expect(() => getResumeFilePath("user-1", "resume-2", "image/png")).toThrow(
      /Unsupported resume MIME type/,
    );
  });
});

describe("resume-file: size validation", () => {
  // The defect: the check was `sizeBytes === 0`, so a negative size passed validation and
  // then failed the `size_bytes > 0` database constraint, surfacing as DATABASE_ERROR.
  it.each([0, -1, -999_999])("rejects size %i", (size) => {
    expect(validateResumeFile(PDF, size)).toBe("File is empty or has an invalid size.");
  });

  it.each([1, 1024, MAX_RESUME_BYTES])("accepts size %i", (size) => {
    expect(validateResumeFile(PDF, size)).toBeNull();
  });

  it("rejects one byte over the cap", () => {
    expect(validateResumeFile(PDF, MAX_RESUME_BYTES + 1)).toBe(
      "File too large. Maximum size is 10MB.",
    );
  });

  it("rejects a non-integer size", () => {
    expect(validateResumeFile(PDF, 1.5)).toBe("File is empty or has an invalid size.");
  });

  it("rejects an unsupported type regardless of size", () => {
    expect(validateResumeFile("image/png", 1024)).toBe("Invalid file type. Only PDF and DOCX are allowed.");
  });
});