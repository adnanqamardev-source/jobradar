/**
 * normalize.test.ts — tests for job normalisation (BE-106, BE-317).
 *
 * Tests remote scope detection, location parsing, and salary parsing.
 */

import { describe, it, expect } from "vitest";
import {
  detectRemoteScope,
  parseLocation,
  parseSalary,
  extractSeniority,
  normaliseJob,
} from "@/lib/ingest/normalize";
import type { RawJob } from "@/types/canonical-job";

describe("detectRemoteScope", () => {
  it("detects India-specific remote roles", () => {
    expect(detectRemoteScope("Remote – India")).toBe("india");
    expect(detectRemoteScope("Work from India")).toBe("india");
    expect(detectRemoteScope("PAN India")).toBe("india");
    expect(detectRemoteScope("Anywhere in India")).toBe("india");
    expect(detectRemoteScope("India WFH")).toBe("india");
    expect(detectRemoteScope("Remote (India)")).toBe("india");
  });

  it("detects global remote roles", () => {
    expect(detectRemoteScope("Remote – Anywhere")).toBe("global");
    expect(detectRemoteScope("Worldwide")).toBe("global");
    expect(detectRemoteScope("Global")).toBe("global");
    expect(detectRemoteScope("International Remote")).toBe("global");
    expect(detectRemoteScope("Work from Anywhere")).toBe("global");
    expect(detectRemoteScope("Location Agnostic")).toBe("global");
    expect(detectRemoteScope("Remote (Worldwide)")).toBe("global");
  });

  it("returns unknown for non-remote text", () => {
    expect(detectRemoteScope("New York, NY")).toBe("unknown");
    expect(detectRemoteScope("London, UK")).toBe("unknown");
    expect(detectRemoteScope("Software Engineer")).toBe("unknown");
  });

  it("prefers India over global when both patterns match", () => {
    // India-specific patterns are checked first
    expect(detectRemoteScope("Remote – India (Worldwide)")).toBe("india");
  });
});

describe("parseLocation", () => {
  it("parses India remote location", () => {
    const result = parseLocation("Remote – India");
    expect(result.remoteScope).toBe("india");
    expect(result.countryCode).toBe("IN");
  });

  it("parses global remote location", () => {
    const result = parseLocation("Remote – Anywhere");
    expect(result.remoteScope).toBe("global");
    expect(result.countryCode).toBeNull();
  });

  it("parses city, region, country", () => {
    const result = parseLocation("San Francisco, CA, USA");
    expect(result.city).toBe("San Francisco");
    expect(result.region).toBe("CA");
    expect(result.countryCode).toBe("US");
  });

  it("parses city, country", () => {
    const result = parseLocation("London, UK");
    expect(result.city).toBe("London");
    expect(result.countryCode).toBe("GB");
  });

  it("parses Indian city", () => {
    const result = parseLocation("Bangalore, India");
    expect(result.city).toBe("Bangalore");
    expect(result.countryCode).toBe("IN");
  });

  it("handles empty location", () => {
    const result = parseLocation("");
    expect(result.city).toBeNull();
    expect(result.countryCode).toBeNull();
    expect(result.remoteScope).toBe("unknown");
  });
});

describe("parseSalary", () => {
  it("parses USD salary", () => {
    const result = parseSalary("$120,000 per year");
    expect(result.min).toBe(120000);
    expect(result.currency).toBe("USD");
    expect(result.period).toBe("year");
  });

  it("parses INR salary", () => {
    const result = parseSalary("₹15,00,000 per year");
    expect(result.min).toBe(1500000);
    expect(result.currency).toBe("INR");
    expect(result.period).toBe("year");
  });

  it("parses salary range", () => {
    const result = parseSalary("$100,000 - $150,000");
    expect(result.min).toBe(100000);
    expect(result.max).toBe(150000);
  });

  it("parses monthly salary", () => {
    const result = parseSalary("$5,000/month");
    expect(result.min).toBe(5000);
    expect(result.period).toBe("month");
  });

  it("parses Indian lakh format", () => {
    const result = parseSalary("15L per year");
    expect(result.min).toBe(1500000);
    expect(result.currency).toBe("INR");
  });

  it("handles empty salary", () => {
    const result = parseSalary("");
    expect(result.min).toBeNull();
    expect(result.currency).toBeNull();
  });
});

describe("extractSeniority", () => {
  it("extracts senior from title", () => {
    expect(extractSeniority("Senior Software Engineer", "")).toBe("senior");
  });

  it("extracts junior from title", () => {
    expect(extractSeniority("Junior Developer", "")).toBe("junior");
  });

  it("extracts lead from title", () => {
    expect(extractSeniority("Tech Lead", "")).toBe("lead");
  });

  it("extracts from description", () => {
    expect(extractSeniority("Software Engineer", "5+ years of experience")).toBe("senior");
  });

  it("returns unknown when no match", () => {
    expect(extractSeniority("Software Engineer", "")).toBe("unknown");
  });
});

describe("normaliseJob", () => {
  it("normalises a complete raw job", () => {
    const raw: RawJob = {
      externalId: "job-123",
      sourceUrl: "https://example.com/job/123",
      applyUrl: "https://example.com/apply/123",
      companyName: "Acme Corp",
      companyDomain: "acme.com",
      title: "Senior Software Engineer",
      descriptionText: "We are looking for a senior engineer...",
      locationRaw: "Remote – India",
      workMode: "remote",
      employmentType: "full_time",
      seniority: "senior",
      salaryRaw: "₹25,00,000 per year",
      salaryMin: 2500000,
      salaryMax: null,
      salaryCurrency: "INR",
      salaryPeriod: "year",
      skills: ["JavaScript", "TypeScript"],
      postedAt: "2026-10-01T00:00:00Z",
      raw: null,
    };

    const job = normaliseJob(raw);

    expect(job.externalId).toBe("job-123");
    expect(job.title).toBe("Senior Software Engineer");
    expect(job.remoteScope).toBe("india");
    expect(job.location.countryCode).toBe("IN");
    expect(job.salary?.min).toBe(2500000);
    expect(job.salary?.currency).toBe("INR");
  });

  it("normalises a global remote job", () => {
    const raw: RawJob = {
      externalId: "job-456",
      sourceUrl: "https://example.com/job/456",
      applyUrl: null,
      companyName: "Global Tech",
      companyDomain: "globaltech.com",
      title: "Software Engineer",
      descriptionText: "Join our distributed team...",
      locationRaw: "Remote – Anywhere",
      workMode: "remote",
      employmentType: "full_time",
      seniority: null,
      salaryRaw: "$120,000 per year",
      salaryMin: 120000,
      salaryMax: null,
      salaryCurrency: "USD",
      salaryPeriod: "year",
      skills: ["Python", "Go"],
      postedAt: null,
      raw: null,
    };

    const job = normaliseJob(raw);

    expect(job.remoteScope).toBe("global");
    expect(job.location.countryCode).toBeNull();
    expect(job.salary?.min).toBe(120000);
  });

  it("handles missing optional fields", () => {
    const raw: RawJob = {
      externalId: "job-789",
      sourceUrl: "https://example.com/job/789",
      applyUrl: null,
      companyName: "Startup Inc",
      companyDomain: null,
      title: "Developer",
      descriptionText: null,
      locationRaw: null,
      workMode: null,
      employmentType: null,
      seniority: null,
      salaryRaw: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      skills: [],
      postedAt: null,
      raw: null,
    };

    const job = normaliseJob(raw);

    expect(job.location.city).toBeNull();
    expect(job.salary?.min).toBeNull();
    expect(job.workMode).toBe("unknown");
    expect(job.remoteScope).toBe("unknown");
  });
});
