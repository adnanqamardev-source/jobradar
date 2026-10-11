/**
 * format.test.ts — the display formatters shared by the feed card and the job
 * detail page, plus the score-band boundaries (docs/04 §1.3).
 *
 * These are the strings a user reads; a salary that renders differently on
 * the card and the detail page is a defect, so both import from one pure
 * module and the behaviour is pinned here.
 */

import { describe, it, expect } from "vitest";

import { scoreBand } from "@/lib/utils/score-band";
import { formatDate, formatSalary } from "@/lib/utils/format";
import type { FeedRow } from "@/lib/db/queries/feed";

function makeJob(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    id: "3f2a9c1e-0000-4000-8000-000000000001",
    title: "Senior Frontend Engineer",
    company_name: "Acme Corp",
    company_domain: "acme.example",
    location: "Remote (US)",
    city: null,
    region: null,
    country_code: "US",
    work_mode: "remote",
    remote_scope: "global",
    employment_type: "full_time",
    seniority: "senior",
    salary_min: 160000,
    salary_max: 190000,
    salary_currency: "USD",
    salary_period: "year",
    posted_at: "2026-10-01T00:00:00.000Z",
    first_seen_at: "2026-10-01T00:00:00.000Z",
    last_seen_at: "2026-10-02T00:00:00.000Z",
    sighting_count: 1,
    skills: ["react"],
    final_score: 78.42,
    rule_score: 62.5,
    semantic_score: 71.3,
    breakdown: [],
    explanation: null,
    saved: false,
    dismissed: false,
    applied: false,
    ...overrides,
  };
}

describe("scoreBand (docs/04 §1.3)", () => {
  it("marks 85+ as strong", () => {
    expect(scoreBand(85).band).toBe("strong");
    expect(scoreBand(100).band).toBe("strong");
  });

  it("marks 70–84 as good", () => {
    expect(scoreBand(70).band).toBe("good");
    expect(scoreBand(84.99).band).toBe("good");
  });

  it("marks 55–69 as fair", () => {
    expect(scoreBand(55).band).toBe("fair");
    expect(scoreBand(69.99).band).toBe("fair");
  });

  it("marks 1–54 as weak and 0 as gated", () => {
    expect(scoreBand(54).band).toBe("weak");
    expect(scoreBand(1).band).toBe("weak");
    expect(scoreBand(0).band).toBe("gated");
  });
});

describe("formatSalary", () => {
  it("formats a full range with currency and period", () => {
    expect(formatSalary(makeJob())).toBe("160000–190000 USD/yr");
  });

  it("formats an open-ended range", () => {
    expect(formatSalary(makeJob({ salary_min: null }))).toBe("up to 190000 USD/yr");
    expect(formatSalary(makeJob({ salary_max: null }))).toBe("from 160000 USD/yr");
  });

  it("returns null when no salary was parsed", () => {
    expect(formatSalary(makeJob({ salary_min: null, salary_max: null }))).toBeNull();
  });

  it("renders numbers when currency is missing", () => {
    expect(formatSalary(makeJob({ salary_currency: null }))).toBe("160000–190000 /yr");
  });
});

describe("formatDate", () => {
  it("formats an ISO timestamp", () => {
    expect(formatDate("2026-10-01T00:00:00.000Z")).toBe("10/1/2026");
  });

  it("returns \"unknown\" for null or garbage", () => {
    expect(formatDate(null)).toBe("unknown");
    expect(formatDate("not-a-date")).toBe("unknown");
  });
});
