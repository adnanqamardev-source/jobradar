/**
 * scoring-gates.test.ts — the five hard filters (SCR-001, BE-201).
 *
 * docs/05b SCR-001 asks for "one passing case + one failing case per gate". That is
 * the floor, not the goal. The more valuable cases here are the ones where a gate
 * *must not* fire: a gate that excludes a job because data was missing is invisible
 * to the user, and the whole feed can disappear without a single error being raised.
 * Those are pinned as a separate describe block so they cannot be lost.
 */

import { describe, expect, it } from "vitest";

import {
  GATE_REASONS,
  evaluateGates,
  seniorityRank,
  shouldAppearInFeed,
  toAnnualSalary,
  type GateJob,
  type GateProfile,
} from "@/lib/scoring/gates";

/** A job that passes every gate — each test overrides only what it is testing. */
function job(overrides: Partial<GateJob> = {}): GateJob {
  return {
    title: "Senior Backend Engineer",
    companyName: "Globex",
    companyDomain: "globex.io",
    descriptionText: "We run Go and PostgreSQL at scale.",
    workMode: "remote",
    seniority: "senior",
    salaryMin: 120000,
    salaryMax: 160000,
    salaryCurrency: "USD",
    salaryPeriod: "year",
    ...overrides,
  };
}

/** A profile with no preferences stated, so nothing gates by default. */
function profile(overrides: Partial<GateProfile> = {}): GateProfile {
  return {
    blockedCompanies: [],
    excludedKeywords: [],
    workModes: ["remote"],
    minSalary: null,
    salaryCurrency: "USD",
    salaryPeriod: "year",
    seniority: "senior",
    ...overrides,
  };
}

describe("gate result shape (docs/02a §5.5)", () => {
  it("returns passed:true with an empty reasons array when nothing fires", () => {
    const result = evaluateGates(job(), profile());
    expect(result).toEqual({ passed: true, reasons: [] });
  });

  it("produces the documented gate_result shape on a hit", () => {
    const result = evaluateGates(
      job({ companyName: "Acme Corp.", companyDomain: "acme.com" }),
      profile({ blockedCompanies: ["acme.com"] }),
    );
    expect(result).toEqual({ passed: false, reasons: ["blocked_company"] });
  });

  it("collects every reason rather than stopping at the first gate", () => {
    const result = evaluateGates(
      job({
        title: "Principal Architect",
        companyName: "Acme",
        companyDomain: "acme.com",
        salaryMax: 50000,
      }),
      profile({
        blockedCompanies: ["acme.com"],
        minSalary: 120000,
        seniority: "junior",
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain(GATE_REASONS.blockedCompany);
    expect(result.reasons).toContain(GATE_REASONS.salaryBelowFloor);
    expect(result.reasons).toContain(GATE_REASONS.seniorityOverBand);
  });
});

// ---------------------------------------------------------------------------

describe("gate 1 — blocked company", () => {
  it("FAILS when the company is blocked", () => {
    const result = evaluateGates(
      job({ companyName: "Acme", companyDomain: "acme.com" }),
      profile({ blockedCompanies: ["acme.com"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.blockedCompany);
  });

  it("fails on a blocked company NAME, matching what onboarding actually stores", () => {
    // onboarding stores `normaliseCompanyInput("Acme Corp.")` → "acme-corp"
    const result = evaluateGates(
      job({ companyName: "ACME Corp", companyDomain: null }),
      profile({ blockedCompanies: ["acme-corp"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.blockedCompany);
  });

  it("PASSES for a company that is not blocked", () => {
    const result = evaluateGates(
      job({ companyName: "Globex", companyDomain: "globex.io" }),
      profile({ blockedCompanies: ["acme.com"] }),
    );
    expect(result.passed).toBe(true);
  });

  // docs/03 §6.1 X-12 — gating the feed must never rewrite history. Asserting here
  // that the gate is a pure function of its inputs is what makes X-12 implementable
  // by the caller: nothing here touches applications.
  it("is a pure function — repeated evaluation is identical (X-12 depends on this)", () => {
    const j = job({ companyName: "Acme" });
    const p = profile({ blockedCompanies: ["acme"] });
    expect(evaluateGates(j, p)).toEqual(evaluateGates(j, p));
  });
});

describe("gate 2 — excluded keyword", () => {
  it("FAILS when a keyword appears in the title", () => {
    const result = evaluateGates(
      job({ title: "Golang Engineer" }),
      profile({ excludedKeywords: ["golang"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.excludedKeyword);
  });

  it("FAILS when a keyword appears in the description", () => {
    const result = evaluateGates(
      job({ descriptionText: "You will work on Golang services." }),
      profile({ excludedKeywords: ["golang"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.excludedKeyword);
  });

  it("PASSES when the keyword is absent", () => {
    const result = evaluateGates(
      job({ descriptionText: "Rust and Kubernetes." }),
      profile({ excludedKeywords: ["golang"] }),
    );
    expect(result.passed).toBe(true);
  });

  it("respects word boundaries, so a short keyword is not a wildcard", () => {
    // The failure this prevents: excluding "ai" substring-matching "maintain",
    // "training" and "email", which would silently empty the feed.
    const result = evaluateGates(
      job({ title: "Role maintaining training pipelines", descriptionText: "Email a report." }),
      profile({ excludedKeywords: ["ai"] }),
    );
    expect(result.passed).toBe(true);
  });

  it("still matches a keyword that is mostly punctuation", () => {
    // "c++" has no \b at either end, so the word-boundary regex would never fire.
    const result = evaluateGates(
      job({ descriptionText: "Strong C++ required." }),
      profile({ excludedKeywords: ["c++"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.excludedKeyword);
  });

  it("treats a multi-word keyword as a phrase, not two separate words", () => {
    const both = evaluateGates(
      job({ descriptionText: "We use Python. Remote first." }),
      profile({ excludedKeywords: ["python remote"] }),
    );
    expect(both.passed).toBe(true);
  });

  it("does not treat regex metacharacters in a keyword as a pattern", () => {
    const result = evaluateGates(
      job({ descriptionText: "Compensation is a plus (a+b)* bonus." }),
      profile({ excludedKeywords: ["(a+b)*"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.excludedKeyword);
  });
});

describe("gate 3 — work mode mismatch", () => {
  it("FAILS when the job's mode is not accepted", () => {
    const result = evaluateGates(
      job({ workMode: "onsite" }),
      profile({ workModes: ["remote"] }),
    );
    expect(result.reasons).toContain(GATE_REASONS.workModeMismatch);
  });

  it("PASSES when the job's mode is accepted", () => {
    const result = evaluateGates(job({ workMode: "remote" }), profile({ workModes: ["remote"] }));
    expect(result.passed).toBe(true);
  });

  it("PASSES when the job's mode is unknown — undisclosed is not a mismatch", () => {
    const result = evaluateGates(
      job({ workMode: "unknown" }),
      profile({ workModes: ["remote"] }),
    );
    expect(result.passed).toBe(true);
  });

  it("PASSES when the user stated no preference at all", () => {
    // work_modes defaults to '{}'. Gating on an empty list would hide every job from
    // any user who has not finished onboarding.
    const result = evaluateGates(job({ workMode: "onsite" }), profile({ workModes: [] }));
    expect(result.passed).toBe(true);
  });
});

describe("gate 4 — salary below floor", () => {
  it("FAILS when salary_max is below the floor", () => {
    const result = evaluateGates(
      job({ salaryMax: 90000 }),
      profile({ minSalary: 120000 }),
    );
    expect(result.reasons).toContain(GATE_REASONS.salaryBelowFloor);
  });

  it("PASSES when salary_max clears the floor", () => {
    const result = evaluateGates(
      job({ salaryMax: 150000 }),
      profile({ minSalary: 120000 }),
    );
    expect(result.passed).toBe(true);
  });

  it("treats an exactly-equal salary_max as clearing the floor", () => {
    const result = evaluateGates(
      job({ salaryMax: 120000 }),
      profile({ minSalary: 120000 }),
    );
    expect(result.passed).toBe(true);
  });

  it("uses salary_min when only one figure was advertised", () => {
    // "from 90k" is below a 120k floor; gating on salary_max alone would miss it.
    const result = evaluateGates(
      job({ salaryMin: 90000, salaryMax: null }),
      profile({ minSalary: 120000 }),
    );
    expect(result.reasons).toContain(GATE_REASONS.salaryBelowFloor);
  });

  it("PASSES when no floor is set", () => {
    const result = evaluateGates(
      job({ salaryMax: 1000 }),
      profile({ minSalary: null }),
    );
    expect(result.passed).toBe(true);
  });

  it("annualises a monthly posting before comparing", () => {
    const result = evaluateGates(
      // 9000/month = 108000/year, below a 120k floor.
      job({ salaryMin: 9000, salaryMax: 9000, salaryPeriod: "month" }),
      profile({ minSalary: 120000, salaryPeriod: "year" }),
    );
    expect(result.reasons).toContain(GATE_REASONS.salaryBelowFloor);
  });

  it("does not compare across currencies", () => {
    const result = evaluateGates(
      job({ salaryMax: 90000, salaryCurrency: "EUR" }),
      profile({ minSalary: 120000, salaryCurrency: "USD" }),
    );
    expect(result.passed).toBe(true);
  });

  it("ignores an hourly rate rather than inventing an annual figure", () => {
    const result = evaluateGates(
      job({ salaryMin: 30, salaryMax: 30, salaryPeriod: "hour" }),
      profile({ minSalary: 120000 }),
    );
    expect(result.passed).toBe(true);
  });
});

describe("gate 5 — seniority over band", () => {
  it("FAILS when the job is more than one band above the target", () => {
    const result = evaluateGates(
      job({ seniority: "principal" }),
      profile({ seniority: "senior" }),
    );
    expect(result.reasons).toContain(GATE_REASONS.seniorityOverBand);
  });

  it("PASSES one band above the target — one band of slack is deliberate", () => {
    const result = evaluateGates(job({ seniority: "lead" }), profile({ seniority: "senior" }));
    expect(result.passed).toBe(true);
  });

  it("PASSES at or below the target", () => {
    expect(evaluateGates(job({ seniority: "senior" }), profile({ seniority: "senior" })).passed).toBe(
      true,
    );
    expect(evaluateGates(job({ seniority: "mid" }), profile({ seniority: "senior" })).passed).toBe(
      true,
    );
  });

  it("does not gate the under-qualified direction — that is a score, not an exclusion", () => {
    const result = evaluateGates(job({ seniority: "intern" }), profile({ seniority: "exec" }));
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("gates must never fire on missing data", () => {
  it("does not fire the salary gate when salary is undisclosed (docs/03 §6.1 X-09)", () => {
    const result = evaluateGates(
      job({ salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null }),
      profile({ minSalary: 500000 }),
    );
    expect(result.passed).toBe(true);
  });

  it("does not fire any gate when the job is almost entirely unknown", () => {
    const result = evaluateGates(
      {
        title: "Engineer",
        companyName: null,
        companyDomain: null,
        descriptionText: null,
        workMode: "unknown",
        seniority: "unknown",
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
      },
      profile({
        blockedCompanies: ["acme.com"],
        excludedKeywords: ["golang", "java"],
        workModes: ["remote"],
        minSalary: 500000,
        seniority: "junior",
      }),
    );
    expect(result).toEqual({ passed: true, reasons: [] });
  });

  it("does not fire the seniority gate when either side is unknown", () => {
    expect(
      evaluateGates(job({ seniority: "unknown" }), profile({ seniority: "junior" })).passed,
    ).toBe(true);
    expect(evaluateGates(job({ seniority: "exec" }), profile({ seniority: "unknown" })).passed).toBe(
      true,
    );
  });

  it("ignores blank keyword and blocked-company entries", () => {
    const result = evaluateGates(
      job(),
      profile({ excludedKeywords: ["", "   "], blockedCompanies: [""] }),
    );
    expect(result.passed).toBe(true);
  });
});

describe("helpers", () => {
  it("seniorityRank returns null for unknown and orders the rest", () => {
    expect(seniorityRank("unknown")).toBeNull();
    expect(seniorityRank(null)).toBeNull();
    expect(seniorityRank("intern")).toBe(0);
    expect(seniorityRank("exec")).toBe(8);
    expect(seniorityRank("mid")!).toBeGreaterThan(seniorityRank("junior")!);
  });

  it("toAnnualSalary treats a null period as year and refuses hourly", () => {
    expect(toAnnualSalary(1000, null)).toBe(1000);
    expect(toAnnualSalary(1000, "year")).toBe(1000);
    expect(toAnnualSalary(1000, "month")).toBe(12000);
    expect(toAnnualSalary(1000, "hour")).toBeNull();
    expect(toAnnualSalary(null, "year")).toBeNull();
  });

  it("shouldAppearInFeed mirrors passed", () => {
    expect(shouldAppearInFeed({ passed: true, reasons: [] })).toBe(true);
    expect(shouldAppearInFeed({ passed: false, reasons: ["blocked_company"] })).toBe(false);
  });
});

describe("determinism", () => {
  it("same inputs → same decision (SCR-002 requires this of the whole scorer)", () => {
    const j = job();
    const p = profile({ blockedCompanies: ["acme.com"], excludedKeywords: ["golang"] });
    const first = evaluateGates(j, p);
    for (let i = 0; i < 5; i++) {
      expect(evaluateGates(j, p)).toEqual(first);
    }
  });
});