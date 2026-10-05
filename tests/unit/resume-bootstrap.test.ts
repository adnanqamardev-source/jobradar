/**
 * bootstrap.test.ts — tests for resume bootstrap mapping (BE-316).
 *
 * Tests the mapping from ExtractedProfile → BootstrapProfile.
 */

import { describe, it, expect } from "vitest";
import {
  mapExtractedToBootstrap,
  mergeBootstrapWithExisting,
  isBootstrapReady,
} from "@/lib/resume/bootstrap";
import type { ExtractedProfile } from "@/types/resume";

describe("mapExtractedToBootstrap", () => {
  it("maps extracted profile to bootstrap profile", () => {
    const extracted: ExtractedProfile = {
      fullName: "John Doe",
      email: "john@example.com",
      phone: "+1 (555) 123-4567",
      location: {
        city: "San Francisco",
        region: "CA",
        countryCode: "US",
      },
      titles: ["Senior Software Engineer", "Software Engineer"],
      seniority: "senior",
      yearsExperience: 5,
      skills: ["JavaScript", "TypeScript", "React"],
      workModes: ["remote", "hybrid"],
      minSalary: 120000,
      salaryCurrency: "USD",
      salaryPeriod: "year",
      education: [],
      summary: "Experienced engineer",
      confidence: 0.9,
      needsReview: false,
    };

    const bootstrap = mapExtractedToBootstrap(extracted);

    expect(bootstrap.targetTitles).toEqual(["Senior Software Engineer", "Software Engineer"]);
    expect(bootstrap.seniority).toBe("senior");
    expect(bootstrap.yearsExperience).toBe(5);
    expect(bootstrap.skills).toEqual(["JavaScript", "TypeScript", "React"]);
    expect(bootstrap.workModes).toEqual(["remote", "hybrid"]);
    expect(bootstrap.countryCode).toBe("US");
    expect(bootstrap.city).toBe("San Francisco");
    expect(bootstrap.minSalary).toBe(120000);
    expect(bootstrap.salaryCurrency).toBe("USD");
    expect(bootstrap.salaryPeriod).toBe("year");
  });

  it("handles null values in extracted profile", () => {
    const extracted: ExtractedProfile = {
      fullName: null,
      email: null,
      phone: null,
      location: {
        city: null,
        region: null,
        countryCode: null,
      },
      titles: [],
      seniority: null,
      yearsExperience: null,
      skills: [],
      workModes: [],
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
      education: [],
      summary: null,
      confidence: 0,
      needsReview: true,
    };

    const bootstrap = mapExtractedToBootstrap(extracted);

    expect(bootstrap.targetTitles).toEqual([]);
    expect(bootstrap.seniority).toBeNull();
    expect(bootstrap.yearsExperience).toBeNull();
    expect(bootstrap.skills).toEqual([]);
    expect(bootstrap.workModes).toEqual([]);
    expect(bootstrap.countryCode).toBeNull();
    expect(bootstrap.city).toBeNull();
    expect(bootstrap.minSalary).toBeNull();
    expect(bootstrap.salaryCurrency).toBeNull();
    expect(bootstrap.salaryPeriod).toBeNull();
  });

  it("limits titles to 10 items", () => {
    const extracted: ExtractedProfile = {
      fullName: "John Doe",
      email: "john@example.com",
      phone: null,
      location: { city: null, region: null, countryCode: null },
      titles: Array(15).fill("Engineer"),
      seniority: "mid",
      yearsExperience: 3,
      skills: [],
      workModes: [],
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
      education: [],
      summary: null,
      confidence: 0.5,
      needsReview: true,
    };

    const bootstrap = mapExtractedToBootstrap(extracted);
    expect(bootstrap.targetTitles.length).toBe(10);
  });

  it("limits skills to 30 items", () => {
    const extracted: ExtractedProfile = {
      fullName: "John Doe",
      email: "john@example.com",
      phone: null,
      location: { city: null, region: null, countryCode: null },
      titles: [],
      seniority: "mid",
      yearsExperience: 3,
      skills: Array(50).fill("Skill"),
      workModes: [],
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
      education: [],
      summary: null,
      confidence: 0.5,
      needsReview: true,
    };

    const bootstrap = mapExtractedToBootstrap(extracted);
    expect(bootstrap.skills.length).toBe(30);
  });
});

describe("mergeBootstrapWithExisting", () => {
  it("prefers bootstrap values over existing", () => {
    const existing = {
      targetTitles: ["Old Title"],
      seniority: "junior" as const,
      yearsExperience: 2,
      skills: ["Old Skill"],
      workModes: ["onsite"] as string[],
      countryCode: "IN" as string | null,
      city: "Mumbai",
      minSalary: 500000,
      salaryCurrency: "INR" as string | null,
      salaryPeriod: "year" as string | null,
    };

    const bootstrap = {
      targetTitles: ["New Title"],
      seniority: "senior" as string | null,
      yearsExperience: 5,
      skills: ["New Skill"],
      workModes: ["remote"] as string[],
      countryCode: "US" as string | null,
      city: "San Francisco",
      minSalary: 120000,
      salaryCurrency: "USD" as string | null,
      salaryPeriod: "year" as string | null,
    };

    const merged = mergeBootstrapWithExisting(existing, bootstrap);

    expect(merged.targetTitles).toEqual(["New Title"]);
    expect(merged.seniority).toBe("senior");
    expect(merged.yearsExperience).toBe(5);
    expect(merged.skills).toEqual(["New Skill"]);
    expect(merged.workModes).toEqual(["remote"]);
    expect(merged.countryCode).toBe("US");
    expect(merged.city).toBe("San Francisco");
  });

  it("falls back to existing when bootstrap is empty", () => {
    const existing = {
      targetTitles: ["Existing Title"],
      seniority: "mid" as const,
      yearsExperience: 3,
      skills: ["Existing Skill"],
      workModes: ["hybrid"] as string[],
      countryCode: "GB" as string | null,
      city: "London",
      minSalary: 60000,
      salaryCurrency: "GBP" as string | null,
      salaryPeriod: "year" as string | null,
    };

    const bootstrap = {
      targetTitles: [],
      seniority: null,
      yearsExperience: null,
      skills: [],
      workModes: [],
      countryCode: null,
      city: null,
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
    };

    const merged = mergeBootstrapWithExisting(existing, bootstrap);

    expect(merged.targetTitles).toEqual(["Existing Title"]);
    expect(merged.seniority).toBe("mid");
    expect(merged.yearsExperience).toBe(3);
    expect(merged.skills).toEqual(["Existing Skill"]);
    expect(merged.workModes).toEqual(["hybrid"]);
    expect(merged.countryCode).toBe("GB");
    expect(merged.city).toBe("London");
  });
});

describe("isBootstrapReady", () => {
  it("returns true when titles are present", () => {
    const profile = {
      targetTitles: ["Engineer"],
      seniority: null,
      yearsExperience: null,
      skills: [],
      workModes: [],
      countryCode: null,
      city: null,
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
    };
    expect(isBootstrapReady(profile)).toBe(true);
  });

  it("returns true when skills are present", () => {
    const profile = {
      targetTitles: [],
      seniority: null,
      yearsExperience: null,
      skills: ["JavaScript"],
      workModes: [],
      countryCode: null,
      city: null,
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
    };
    expect(isBootstrapReady(profile)).toBe(true);
  });

  it("returns true when country is present", () => {
    const profile = {
      targetTitles: [],
      seniority: null,
      yearsExperience: null,
      skills: [],
      workModes: [],
      countryCode: "US",
      city: null,
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
    };
    expect(isBootstrapReady(profile)).toBe(true);
  });

  it("returns false when profile is empty", () => {
    const profile = {
      targetTitles: [],
      seniority: null,
      yearsExperience: null,
      skills: [],
      workModes: [],
      countryCode: null,
      city: null,
      minSalary: null,
      salaryCurrency: null,
      salaryPeriod: null,
    };
    expect(isBootstrapReady(profile)).toBe(false);
  });
});
