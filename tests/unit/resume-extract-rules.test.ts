/**
 * extract-rules.test.ts — tests for rule-based resume extraction (BE-315).
 *
 * These tests use synthetic resume text fixtures. No external API calls,
 * no file I/O — pure text in, structured profile out.
 */

import { describe, it, expect } from "vitest";
import { extractProfileFromText } from "@/lib/resume/extract-rules";

describe("extractProfileFromText", () => {
  it("extracts email from resume text", () => {
    const text = `
      John Doe
      john.doe@example.com
      Software Engineer
    `;
    const profile = extractProfileFromText(text);
    expect(profile.email).toBe("john.doe@example.com");
  });

  it("extracts phone number from resume text", () => {
    const text = `
      Jane Smith
      jane@example.com
      +1 (555) 123-4567
      Senior Developer
    `;
    const profile = extractProfileFromText(text);
    expect(profile.phone).toBe("+1 (555) 123-4567");
  });

  it("extracts skills from resume text", () => {
    const text = `
      John Doe
      john@example.com
      Skills: JavaScript, TypeScript, React, Node.js, AWS
    `;
    const profile = extractProfileFromText(text);
    expect(profile.skills).toContain("JavaScript");
    expect(profile.skills).toContain("TypeScript");
    expect(profile.skills).toContain("React");
    expect(profile.skills).toContain("Node.js");
    expect(profile.skills).toContain("AWS");
  });

  it("extracts seniority from job title", () => {
    const text = `
      John Doe
      john@example.com
      Senior Software Engineer at Acme Corp
      5+ years of experience
    `;
    const profile = extractProfileFromText(text);
    expect(profile.seniority).toBe("senior");
  });

  it("extracts years of experience", () => {
    const text = `
      John Doe
      john@example.com
      Software Engineer
      3+ years of experience in web development
    `;
    const profile = extractProfileFromText(text);
    expect(profile.yearsExperience).toBe(3);
  });

  it("extracts work modes from resume text", () => {
    const text = `
      John Doe
      john@example.com
      Software Engineer
      Open to remote and hybrid roles
    `;
    const profile = extractProfileFromText(text);
    expect(profile.workModes).toContain("remote");
    expect(profile.workModes).toContain("hybrid");
  });

  it("extracts location from resume text", () => {
    const text = `
      John Doe
      john@example.com
      San Francisco, CA, USA
      Software Engineer
    `;
    const profile = extractProfileFromText(text);
    expect(profile.location.city).toBe("San Francisco");
    expect(profile.location.region).toBe("CA");
    expect(profile.location.countryCode).toBe("US");
  });

  it("extracts salary from resume text", () => {
    const text = `
      John Doe
      john@example.com
      Software Engineer
      Expected salary: $120,000 per year
    `;
    const profile = extractProfileFromText(text);
    expect(profile.minSalary).toBe(120000);
    expect(profile.salaryCurrency).toBe("USD");
    expect(profile.salaryPeriod).toBe("year");
  });

  it("extracts Indian salary format", () => {
    const text = `
      Rahul Sharma
      rahul@example.com
      Software Engineer
      Expected CTC: ₹15,00,000 per year
    `;
    const profile = extractProfileFromText(text);
    expect(profile.minSalary).toBe(1500000);
    expect(profile.salaryCurrency).toBe("INR");
  });

  it("extracts full name from first line", () => {
    const text = `
      John Michael Doe
      john@example.com
      Software Engineer
    `;
    const profile = extractProfileFromText(text);
    expect(profile.fullName).toBe("John Michael Doe");
  });

  it("extracts summary from resume", () => {
    const text = `
      John Doe
      john@example.com
      Summary: Experienced software engineer with 5 years of experience
      in building scalable web applications.
    `;
    const profile = extractProfileFromText(text);
    expect(profile.summary).toContain("Experienced software engineer");
  });

  it("returns null for missing fields", () => {
    const text = "Just some random text without any structure";
    const profile = extractProfileFromText(text);
    expect(profile.email).toBeNull();
    expect(profile.phone).toBeNull();
    expect(profile.fullName).toBeNull();
  });

  it("sets needsReview when confidence is low", () => {
    const text = "Minimal info";
    const profile = extractProfileFromText(text);
    expect(profile.needsReview).toBe(true);
  });

  it("sets needsReview to false when confidence is high", () => {
    const text = `
      John Doe
      john.doe@example.com
      +1 (555) 123-4567
      San Francisco, CA, USA
      Senior Software Engineer
      5+ years of experience
      Skills: JavaScript, TypeScript, React, Node.js
      Summary: Experienced engineer
    `;
    const profile = extractProfileFromText(text);
    expect(profile.needsReview).toBe(false);
  });

  it("extracts multiple emails but returns first", () => {
    const text = `
      John Doe
      john@example.com
      j.doe@work.com
    `;
    const profile = extractProfileFromText(text);
    expect(profile.email).toBe("john@example.com");
  });

  it("extracts education information", () => {
    const text = `
      John Doe
      john@example.com
      Education:
      B.S. Computer Science, Stanford University, 2018
      M.S. Software Engineering, MIT, 2020
    `;
    const profile = extractProfileFromText(text);
    expect(profile.education.length).toBeGreaterThan(0);
    expect(profile.education[0]?.degree).toContain("B.S.");
  });

  it("extracts job titles from experience section", () => {
    const text = `
      John Doe
      john@example.com
      Experience:
      Senior Software Engineer at Acme Corp (2020-Present)
      Software Engineer at Beta Inc (2018-2020)
    `;
    const profile = extractProfileFromText(text);
    expect(profile.titles.length).toBeGreaterThan(0);
    expect(profile.titles[0]).toContain("Senior Software Engineer");
  });

  it("handles empty text gracefully", () => {
    const profile = extractProfileFromText("");
    expect(profile.email).toBeNull();
    expect(profile.confidence).toBe(0);
    expect(profile.needsReview).toBe(true);
  });

  it("calculates confidence based on extracted fields", () => {
    const minimalText = "John Doe john@example.com";
    const fullText = `
      John Doe
      john.doe@example.com
      +1 (555) 123-4567
      San Francisco, CA, USA
      Senior Software Engineer
      5+ years of experience
      Skills: JavaScript, TypeScript, React, Node.js, AWS, Docker
      Summary: Experienced engineer with strong background
    `;

    const minimalProfile = extractProfileFromText(minimalText);
    const fullProfile = extractProfileFromText(fullText);

    expect(fullProfile.confidence).toBeGreaterThan(minimalProfile.confidence);
  });
});
