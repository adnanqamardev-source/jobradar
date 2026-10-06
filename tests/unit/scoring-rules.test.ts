/**
 * scoring-rules.test.ts — the deterministic rule scorer (SCR-002, BE-202).
 *
 * docs/05b SCR-002 acceptance criteria, in order: weights sum to 100; skills uses
 * `job_skills.weight`; compensation returns **neutral, not 0**, when salary is
 * undisclosed; recency decays monotonically; `breakdown` matches docs/04 §3.4's shape;
 * same inputs → same score.
 *
 * Each is pinned below against the criterion it comes from, and the emphasis is on the
 * cases where a plausible-looking implementation is wrong: undisclosed salary scoring 0,
 * a two-tab note, `job_skills.weight` having no CHECK constraint, and `posted_at` in the
 * future.
 */

import { describe, expect, it } from "vitest";

import { scoreRule, type RuleJob, type RuleProfile } from "@/lib/scoring/rules";
import { NEUTRAL_RAW, RULE_WEIGHTS } from "@/lib/scoring/weights";

const NOW = new Date("2026-10-06T12:00:00.000Z");

function job(overrides: Partial<RuleJob> = {}): RuleJob {
  return {
    title: "Senior Backend Engineer",
    companyName: "Globex",
    companyDomain: "globex.io",
    countryCode: "IN",
    workMode: "remote",
    remoteScope: "global",
    seniority: "senior",
    salaryMin: 3000000,
    salaryMax: 4000000,
    salaryCurrency: "INR",
    salaryPeriod: "year",
    postedAt: NOW.toISOString(),
    ...overrides,
  };
}

function profile(overrides: Partial<RuleProfile> = {}): RuleProfile {
  return {
    targetTitles: ["backend engineer"],
    seniority: "senior",
    yearsExperience: 6,
    countryCode: "IN",
    workModes: ["remote"],
    minSalary: null,
    salaryCurrency: "INR",
    salaryPeriod: "year",
    preferredCompanies: [],
    ...overrides,
  };
}

/** A well-matched pair: every component knows and scores full marks. */
function perfectInput() {
  return {
    job: job(),
    profile: profile({ minSalary: 3000000, preferredCompanies: ["globex"] }),
    jobSkills: [{ skillId: "go", weight: 1 }],
    profileSkills: [{ skillId: "go", level: "expert" as const }],
    now: NOW,
  };
}

describe("breakdown shape (docs/02a §5.5, docs/04 §3.4)", () => {
  it("always emits one entry per component, in order", () => {
    const { breakdown } = scoreRule(perfectInput());
    expect(breakdown.map((b) => b.key)).toEqual(RULE_WEIGHTS.map((w) => w.key));
  });

  it("emits breakdown even when nothing is known — C3: never a bare number", () => {
    const { breakdown } = scoreRule({
      job: {
        title: "",
        companyName: null,
        companyDomain: null,
        countryCode: null,
        workMode: "unknown",
        remoteScope: "unknown",
        seniority: "unknown",
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
        postedAt: null,
      },
      profile: profile({
        countryCode: null,
        workModes: [],
        minSalary: null,
        preferredCompanies: [],
      }),
      jobSkills: [],
      profileSkills: [],
      now: NOW,
    });
    expect(breakdown).toHaveLength(RULE_WEIGHTS.length);
    expect(breakdown.every((b) => b.known === false)).toBe(true);
    expect(breakdown.every((b) => b.raw === NEUTRAL_RAW)).toBe(true);
  });

  it("points is always raw × weight, rounded to 2dp", () => {
    const { breakdown } = scoreRule(perfectInput());
    for (const b of breakdown) {
      expect(b.points).toBe(Math.round(b.raw * b.weight * 100) / 100);
    }
  });

  it("score is the sum of points and lands in 0–100", () => {
    const { score, breakdown } = scoreRule(perfectInput());
    const sum = Math.round(breakdown.reduce((s, b) => s + b.points, 0) * 100) / 100;
    expect(score).toBe(sum);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("stamps the model version", () => {
    expect(scoreRule(perfectInput()).modelVersion).toBeTruthy();
  });
});

describe("determinism (SCR-002: same inputs → same score)", () => {
  it("repeated calls are identical", () => {
    const input = perfectInput();
    const first = scoreRule(input);
    for (let i = 0; i < 5; i++) {
      expect(scoreRule(input)).toEqual(first);
    }
  });

  it("does not read the wall clock — only the injected `now`", () => {
    const base = perfectInput();
    const later = { ...base, now: new Date("2026-10-20T12:00:00.000Z") };
    // Recency is the only time-sensitive component, so a different `now` must move the
    // score — and only it. If this failed, something was calling `new Date()` internally.
    const a = scoreRule(base).breakdown.find((b) => b.key === "recency");
    const b = scoreRule(later).breakdown.find((entry) => entry.key === "recency");
    expect(a?.raw).not.toBe(b?.raw);
    const others = (r: ReturnType<typeof scoreRule>) =>
      r.breakdown.filter((x) => x.key !== "recency");
    expect(others(scoreRule(base))).toEqual(others(scoreRule(later)));
  });

  it("does not mutate its inputs", () => {
    const input = perfectInput();
    // structuredClone, not JSON: JSON round-trips a Date into a string, so the snapshot
    // would differ from the original for reasons unrelated to mutation.
    const snapshot = structuredClone(input);
    scoreRule(input);
    expect(input).toEqual(snapshot);
  });
});

describe("skills sub-score (35)", () => {
  it("scores full marks when every required skill is held at expert", () => {
    const entry = scoreRule(perfectInput()).breakdown.find((b) => b.key === "skills");
    expect(entry?.raw).toBe(1);
    expect(entry?.known).toBe(true);
  });

  it("counts a weak mention less than a strong one (uses job_skills.weight)", () => {
    const input = {
      ...perfectInput(),
      jobSkills: [
        { skillId: "go", weight: 1 },
        { skillId: "rust", weight: 0.2 },
      ],
      profileSkills: [
        { skillId: "go", level: "expert" as const },
        { skillId: "rust", level: "expert" as const },
      ],
    };
    // Both are held, but `go` is the stronger ask, so matching `rust` alone would score
    // less. Assert the ordering by dropping the strong one.
    const withoutStrong = scoreRule({
      ...input,
      profileSkills: [{ skillId: "rust", level: "expert" as const }],
    }).breakdown.find((b) => b.key === "skills");
    const withoutWeak = scoreRule({
      ...input,
      profileSkills: [{ skillId: "go", level: "expert" as const }],
    }).breakdown.find((b) => b.key === "skills");
    expect(withoutStrong?.raw).toBeLessThan(withoutWeak?.raw ?? 0);
  });

  it("normalises per job, so the column's missing CHECK cannot distort the score", () => {
    // job_skills.weight is numeric(3,2) with no CHECK: a connector writing 1/3 for
    // medium/strong and one writing 0.2/0.6 must produce the same relative ordering.
    // The two fixtures below are the *same ratio* expressed on different scales — using
    // non-proportional numbers here would test nothing but the test's own arithmetic.
    const rawFor = (jobSkills: { skillId: string; weight: number }[]) =>
      scoreRule({
        ...perfectInput(),
        jobSkills,
        profileSkills: [{ skillId: "go", level: "expert" as const }],
      }).breakdown.find((b) => b.key === "skills")?.raw;

    expect(rawFor([{ skillId: "go", weight: 3 }, { skillId: "rust", weight: 1 }])).toBe(
      rawFor([{ skillId: "go", weight: 0.6 }, { skillId: "rust", weight: 0.2 }]),
    );
  });

  it("penalises breadth: 2 of 8 required skills scores poorly", () => {
    const jobSkills = Array.from({ length: 8 }, (_, i) => ({ skillId: `s${i}`, weight: 1 }));
    const entry = scoreRule({
      ...perfectInput(),
      jobSkills,
      profileSkills: [
        { skillId: "s0", level: "expert" as const },
        { skillId: "s1", level: "expert" as const },
      ],
    }).breakdown.find((b) => b.key === "skills");
    expect(entry?.raw).toBeLessThan(0.3);
  });

  it("values proficiency without discarding a `familiar` skill entirely", () => {
    const mk = (level: "familiar" | "expert") =>
      scoreRule({
        ...perfectInput(),
        profileSkills: [{ skillId: "go", level }],
      }).breakdown.find((b) => b.key === "skills")?.raw;
    expect(mk("familiar")).toBeGreaterThan(0);
    expect(mk("familiar")).toBeLessThan(mk("expert")!);
  });

  it("treats a null level as `proficient`, the column default", () => {
    const entry = scoreRule({
      ...perfectInput(),
      profileSkills: [{ skillId: "go", level: null }],
    }).breakdown.find((b) => b.key === "skills");
    expect(entry?.raw).toBeCloseTo(0.85, 5);
  });

  it("is neutral when either side has no skills", () => {
    const noProfile = scoreRule({ ...perfectInput(), profileSkills: [] }).breakdown.find(
      (b) => b.key === "skills",
    );
    const noJob = scoreRule({ ...perfectInput(), jobSkills: [] }).breakdown.find(
      (b) => b.key === "skills",
    );
    expect(noProfile).toMatchObject({ raw: NEUTRAL_RAW, known: false });
    expect(noJob).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });

  it("is neutral when every job weight is zero — no ordering to give", () => {
    const entry = scoreRule({
      ...perfectInput(),
      jobSkills: [{ skillId: "go", weight: 0 }],
    }).breakdown.find((b) => b.key === "skills");
    expect(entry).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });
});

describe("seniority sub-score (15)", () => {
  it("scores full marks at the target band", () => {
    const entry = scoreRule(perfectInput()).breakdown.find((b) => b.key === "seniority");
    expect(entry?.raw).toBe(1);
  });

  it("falls off with distance in both directions", () => {
    const raw = (j: string, p: string) =>
      scoreRule({
        ...perfectInput(),
        job: job({ seniority: j as RuleJob["seniority"] }),
        profile: profile({ seniority: p as RuleProfile["seniority"] }),
      }).breakdown.find((b) => b.key === "seniority")?.raw;

    expect(raw("lead", "senior")).toBeLessThan(raw("senior", "senior")!);
    // Under-qualified is a real mismatch too — a principal applying to an intern role.
    expect(raw("intern", "senior")).toBeLessThan(raw("senior", "senior")!);
  });

  it("is neutral when either side is unknown", () => {
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ seniority: "unknown" }),
    }).breakdown.find((b) => b.key === "seniority");
    expect(entry).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });
});

describe("compensation sub-score (15) — X-09", () => {
  it("is NEUTRAL, not 0, when the job discloses no salary", () => {
    // The headline criterion. A 0 here would bury every undisclosed posting, which is
    // precisely the outcome docs/03 §6.1 X-09 forbids.
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ salaryMin: null, salaryMax: null }),
    }).breakdown.find((b) => b.key === "compensation");
    expect(entry?.raw).toBe(NEUTRAL_RAW);
    expect(entry?.known).toBe(false);
    expect(entry?.points).toBe(7.5);
  });

  it("is neutral, not 0, when the candidate set no floor", () => {
    const entry = scoreRule({
      ...perfectInput(),
      profile: profile({ minSalary: null }),
    }).breakdown.find((b) => b.key === "compensation");
    expect(entry).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });

  it("is neutral across a currency mismatch rather than guessing a rate", () => {
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ salaryCurrency: "EUR" }),
    }).breakdown.find((b) => b.key === "compensation");
    expect(entry).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });

  it("is neutral for an hourly rate it refuses to annualise", () => {
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ salaryMin: 30, salaryMax: 30, salaryPeriod: "hour" }),
    }).breakdown.find((b) => b.key === "compensation");
    expect(entry).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });

  it("caps at full marks — paying well above the floor is not extra credit", () => {
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ salaryMin: 100000000, salaryMax: 100000000 }),
    }).breakdown.find((b) => b.key === "compensation");
    expect(entry?.raw).toBe(1);
  });

  it("scores by ratio, so a proportional shortfall beats a small absolute one", () => {
    const raw = (jobMax: number, floor: number) =>
      scoreRule({
        ...perfectInput(),
        job: job({ salaryMin: jobMax, salaryMax: jobMax }),
        profile: profile({ minSalary: floor }),
      }).breakdown.find((b) => b.key === "compensation")?.raw;

    // Proportionally much worse, even though the absolute shortfall is similar.
    expect(raw(850000, 1000000)).toBeLessThan(raw(2995000, 3000000)!);
  });

  it("annualises a monthly posting before comparing", () => {
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ salaryMin: 200000, salaryMax: 250000, salaryPeriod: "month" }),
    }).breakdown.find((b) => b.key === "compensation");
    // 250000/mo = 3,000,000/yr against a 3,000,000 floor → exactly full marks.
    expect(entry?.raw).toBeCloseTo(1, 5);
  });
});

describe("location / work-mode sub-score (15)", () => {
  it("scores full marks for an accepted mode in the candidate's country", () => {
    const entry = scoreRule(perfectInput()).breakdown.find((b) => b.key === "work-mode");
    expect(entry?.raw).toBe(1);
    expect(entry?.known).toBe(true);
  });

  it("gives partial credit to an undisclosed mode, flagged as not known", () => {
    // Partial rather than 0: the posting did not say no. The country still matched, so
    // the location half knows — but `known` is `&&`, so a component carrying any
    // assumption reports itself as inferred rather than presenting a guess as a finding.
    const entry = scoreRule({
      ...perfectInput(),
      job: job({ workMode: "unknown" }),
    }).breakdown.find((b) => b.key === "work-mode");
    expect(entry?.raw).toBeGreaterThan(NEUTRAL_RAW);
    expect(entry?.known).toBe(false);
  });

  it("applies BE-317: India-scoped remote is not worldwide remote", () => {
    // A US candidate, so the countries genuinely differ and the remote branch is
    // reached — with a matching country the remote scope is irrelevant.
    const raw = (scope: RuleJob["remoteScope"]) =>
      scoreRule({
        ...perfectInput(),
        job: job({ countryCode: "IN", remoteScope: scope }),
        profile: profile({ countryCode: "US", workModes: ["remote"] }),
      }).breakdown.find((b) => b.key === "work-mode")?.raw;

    expect(raw("global")).toBeGreaterThan(raw("india")!);
  });

  it("is fully known only when both halves are real judgements", () => {
    const bothUnknown = scoreRule({
      ...perfectInput(),
      job: job({ workMode: "unknown", countryCode: null }),
      profile: profile({ countryCode: null, workModes: [] }),
    }).breakdown.find((b) => b.key === "work-mode");
    expect(bothUnknown).toMatchObject({ raw: NEUTRAL_RAW, known: false });

    const bothKnown = scoreRule({
      ...perfectInput(),
      job: job({ workMode: "remote", countryCode: "IN" }),
      profile: profile({ countryCode: "IN", workModes: ["remote"] }),
    }).breakdown.find((b) => b.key === "work-mode");
    expect(bothKnown?.known).toBe(true);

    // Half-known still yields a number — it is just labelled as inferred.
    const oneKnown = scoreRule({
      ...perfectInput(),
      job: job({ workMode: "unknown", countryCode: null }),
      profile: profile({ countryCode: null, workModes: ["remote"] }),
    }).breakdown.find((b) => b.key === "work-mode");
    expect(oneKnown?.raw).toBeGreaterThan(NEUTRAL_RAW);
    expect(oneKnown?.known).toBe(false);
  });
});

describe("recency sub-score (10)", () => {
  it("is full marks for a posting from today", () => {
    const entry = scoreRule(perfectInput()).breakdown.find((b) => b.key === "recency");
    expect(entry?.raw).toBe(1);
  });

  it("decays monotonically — an older posting never scores higher (SCR-002)", () => {
    let previous = Infinity;
    for (const daysAgo of [0, 1, 7, 14, 21, 27, 28, 60, 365]) {
      const posted = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
      const entry = scoreRule({ ...perfectInput(), job: job({ postedAt: posted }) }).breakdown.find(
        (b) => b.key === "recency",
      );
      expect(entry?.raw, `${daysAgo} days ago`).toBeLessThanOrEqual(previous);
      previous = entry?.raw ?? 0;
    }
  });

  it("hits zero at the 28-day expiry boundary (docs/02b §6.4)", () => {
    const posted = new Date(NOW.getTime() - 28 * 86_400_000).toISOString();
    const entry = scoreRule({ ...perfectInput(), job: job({ postedAt: posted }) }).breakdown.find(
      (b) => b.key === "recency",
    );
    expect(entry?.raw).toBe(0);
  });

  it("clamps a future posted_at instead of scoring above full marks", () => {
    // A source clock problem must not outrank every real posting.
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    const entry = scoreRule({ ...perfectInput(), job: job({ postedAt: future }) }).breakdown.find(
      (b) => b.key === "recency",
    );
    expect(entry?.raw).toBe(1);
  });

  it("is neutral when posted_at is missing or unparseable", () => {
    for (const postedAt of [null, "not-a-date"]) {
      const entry = scoreRule({ ...perfectInput(), job: job({ postedAt }) }).breakdown.find(
        (b) => b.key === "recency",
      );
      expect(entry, String(postedAt)).toMatchObject({ raw: NEUTRAL_RAW, known: false });
    }
  });
});

describe("company-preference sub-score (10)", () => {
  it("is full marks for a preferred company", () => {
    const entry = scoreRule(perfectInput()).breakdown.find((b) => b.key === "company-preference");
    expect(entry?.raw).toBe(1);
  });

  it("is 0 for a company on a non-empty list that is not preferred", () => {
    const entry = scoreRule({
      ...perfectInput(),
      profile: profile({ preferredCompanies: ["initech"] }),
    }).breakdown.find((b) => b.key === "company-preference");
    expect(entry).toMatchObject({ raw: 0, known: true });
  });

  it("is neutral, not 0, when no preference was expressed", () => {
    // "No companies listed" is not "every company is unwanted".
    const entry = scoreRule({
      ...perfectInput(),
      profile: profile({ preferredCompanies: [] }),
    }).breakdown.find((b) => b.key === "company-preference");
    expect(entry).toMatchObject({ raw: NEUTRAL_RAW, known: false });
  });
});

describe("whole-score behaviour", () => {
  it("ranks a strong match above a weak one", () => {
    const strong = scoreRule(perfectInput()).score;
    const weak = scoreRule({
      ...perfectInput(),
      job: job({
        salaryMax: 300000,
        workMode: "onsite",
        remoteScope: "unknown",
        countryCode: "GB",
      }),
      profileSkills: [{ skillId: "go", level: "familiar" as const }],
    }).score;
    expect(strong).toBeGreaterThan(weak);
  });

  it("never exceeds 100 or drops below 0", () => {
    const worst = scoreRule({
      ...perfectInput(),
      job: job({
        salaryMax: 1,
        workMode: "onsite",
        remoteScope: "unknown",
        countryCode: "GB",
        postedAt: new Date(NOW.getTime() - 3650 * 86_400_000).toISOString(),
      }),
      profile: profile({ minSalary: 9000000, preferredCompanies: ["nope"] }),
      profileSkills: [{ skillId: "unrelated", level: "familiar" as const }],
    }).score;
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(strongest()).toBeLessThanOrEqual(100);
  });

  it("an all-unknown job still scores above 0 — absence is never total rejection", () => {
    const entry = scoreRule({
      job: {
        title: "Engineer",
        companyName: null,
        companyDomain: null,
        countryCode: null,
        workMode: "unknown",
        remoteScope: "unknown",
        seniority: "unknown",
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
        postedAt: null,
      },
      profile: profile({
        countryCode: null,
        workModes: [],
        minSalary: null,
        preferredCompanies: [],
      }),
      jobSkills: [],
      profileSkills: [],
      now: NOW,
    });
    expect(entry.score).toBe(50);
  });
});

function strongest(): number {
  return scoreRule(perfectInput()).score;
}