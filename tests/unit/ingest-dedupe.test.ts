/**
 * ingest-dedupe.test.ts — two-pass deduplication (BE-107, `docs/02b` §6.2,
 * `docs/05b-phase1.md` ING-007).
 *
 * Covers the pure decision logic — hash construction, trigram similarity, merge
 * selection — plus the shape of the write. The hash and similarity functions are pure, so
 * the thresholds in §6.2 are asserted here rather than only being reachable through a
 * database.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalJob } from "@/types/canonical-job";

import {
  FUZZY_THRESHOLD,
  computeDedupeHash,
  findFuzzyMatch,
  normaliseForHash,
  pickSurvivor,
  trigramSimilarity,
  trigrams,
  upsertCanonicalJob,
  type FuzzyCandidate,
  type JobWriter,
} from "@/lib/ingest/dedupe";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<CanonicalJob> = {}): CanonicalJob {
  return {
    externalId: "job-1",
    sourceUrl: "https://example.com/jobs/1",
    applyUrl: null,
    companyName: "Acme Corp",
    companyDomain: "acme.com",
    title: "Senior Backend Engineer",
    titleNorm: "seniorbackendengineer",
    descriptionText: "A description.",
    descriptionHtml: null,
    location: { city: "Berlin", region: null, countryCode: "DE", raw: "Berlin, Germany" },
    remoteScope: "global",
    workMode: "remote",
    employmentType: "full_time",
    seniority: "senior",
    salary: { min: 80000, max: 100000, currency: "EUR", period: "year", raw: "80k-100k" },
    skills: ["typescript"],
    postedAt: null,
    firstSeenAt: null,
    lastSeenAt: null,
    sightingCount: 1,
    status: "active",
    confidence: 1,
    dedupeHash: null,
    raw: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<FuzzyCandidate> = {}): FuzzyCandidate {
  return {
    id: "job-uuid-1",
    titleNorm: "principalsoftwareengineer",
    descriptionText: "A description.",
    sightingCount: 1,
    sourceUrl: "https://example.com/jobs/1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — exact hash
// ---------------------------------------------------------------------------

describe("computeDedupeHash", () => {
  it("is a 64-character lowercase hex sha256", () => {
    expect(computeDedupeHash(makeJob())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    expect(computeDedupeHash(makeJob())).toBe(computeDedupeHash(makeJob()));
  });

  // The core promise of the exact pass: a re-listing that differs only in casing, spacing
  // or punctuation is the same posting and must not create a second feed card.
  it("ignores case, punctuation and repeated whitespace in the title", () => {
    const base = computeDedupeHash(makeJob({ title: "Senior Backend Engineer" }));
    expect(computeDedupeHash(makeJob({ title: "SENIOR   backend, Engineer!" }))).toBe(base);
    expect(computeDedupeHash(makeJob({ title: "  senior backend engineer  " }))).toBe(base);
  });

  it("ignores a trailing legal suffix on the company name", () => {
    const withSuffix = computeDedupeHash(
      makeJob({ companyName: "Acme Inc", companyDomain: null }),
    );
    const withoutSuffix = computeDedupeHash(makeJob({ companyName: "Acme", companyDomain: null }));
    expect(withSuffix).toBe(withoutSuffix);
  });

  it("ignores a scheme, www prefix and path on the company domain", () => {
    const bare = computeDedupeHash(makeJob({ companyDomain: "acme.com" }));
    expect(computeDedupeHash(makeJob({ companyDomain: "https://www.acme.com/careers" }))).toBe(
      bare,
    );
  });

  // Each field is separated, so shifting a character across the boundary cannot produce a
  // collision between two different jobs.
  it("changes when any one of the four fields changes", () => {
    const base = computeDedupeHash(makeJob());
    expect(computeDedupeHash(makeJob({ title: "Senior Frontend Engineer" }))).not.toBe(base);
    expect(
      computeDedupeHash(makeJob({ location: { city: "Munich", region: null, countryCode: "DE", raw: "" } })),
    ).not.toBe(base);
    expect(computeDedupeHash(makeJob({ workMode: "hybrid" }))).not.toBe(base);
    expect(computeDedupeHash(makeJob({ companyDomain: "globex.com" }))).not.toBe(base);
  });

  it("separates the fields so a boundary shift cannot collide", () => {
    // "AB" at "C Corp" and "A" at "BC Corp" both concatenate to "abc" — legal-suffix
    // stripping takes "Corp" off both, leaving "c" and "bc". Naively joined they are one
    // string, so the `|` separator is the only thing keeping two different jobs apart.
    // Asserted on the hash, because the unseparated form is exactly what must NOT match.
    const a = normaliseForHash(makeJob({ title: "AB", companyDomain: null, companyName: "C Corp" }));
    const b = normaliseForHash(makeJob({ title: "A", companyDomain: null, companyName: "BC Corp" }));
    expect(`${a.title}${a.company}`).toBe(`${b.title}${b.company}`);
    expect(computeDedupeHash(makeJob({ title: "AB", companyDomain: null, companyName: "C Corp" }))).not.toBe(
      computeDedupeHash(makeJob({ title: "A", companyDomain: null, companyName: "BC Corp" })),
    );
  });

  // Without a domain, two unrelated employers posting the same title in the same city would
  // hash identically and collapse into one row. This is the fallback that prevents it.
  it("falls back to the company name when no usable domain is present", () => {
    const acme = computeDedupeHash(makeJob({ companyDomain: null, companyName: "Acme Corp" }));
    const globex = computeDedupeHash(makeJob({ companyDomain: null, companyName: "Globex" }));
    expect(acme).not.toBe(globex);
  });

  it("prefers the domain over the name when both are present", () => {
    const byDomain = normaliseForHash(makeJob({ companyDomain: "acme.com", companyName: "Acme" }));
    // The dot is stripped like any other punctuation, so the hashed component is "acme com",
    // not "acme.com". That is the same `normaliseToken` every field goes through, which is
    // what keeps "acme.com" and "Acme Com" hashing alike rather than as two employers.
    expect(byDomain.company).toBe("acme com");
  });

  it("normalises accents rather than dropping the letters", () => {
    const accented = normaliseForHash(makeJob({ title: "Ingénieur Café" }));
    expect(accented.title).toBe("ingenieur cafe");
  });

  it("treats an absent city as empty rather than throwing or hashing 'null'", () => {
    // A remote posting legitimately has no city, and `location.city` is nullable. Two
    // city-less postings at the same company must still collapse onto one row.
    const noCity = normaliseForHash(
      makeJob({ location: { city: null, region: null, countryCode: null, raw: "Remote" } }),
    );
    expect(noCity.city).toBe("");

    const hash = computeDedupeHash(
      makeJob({ location: { city: null, region: null, countryCode: null, raw: "Remote" } }),
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Pass 2 — trigram similarity
// ---------------------------------------------------------------------------

describe("trigrams", () => {
  it("pads a short string so it still yields trigrams", () => {
    // "ab" padded is "  ab  ", giving four trigrams. Without padding this would be empty and
    // every short title would compare as dissimilar to everything.
    expect([...trigrams("ab").keys()].sort()).toEqual(["  a", " ab", "ab ", "b  "]);
  });

  it("counts repeats in the multiset", () => {
    // "  aaaa  " yields 5 trigrams, and only "aaa" occurs twice.
    expect(trigrams("aaaa").get("aaa")).toBe(2);
  });
});

describe("trigramSimilarity", () => {
  it("scores identical strings as 1", () => {
    expect(trigramSimilarity("backend engineer", "backend engineer")).toBe(1);
  });

  it("scores unrelated strings near 0", () => {
    // Not exactly 0: both strings are padded, so any two that end in the same character
    // share one boundary trigram ("r  " here). That floor is 1/39 for this pair — far below
    // the 0.85 merge threshold, which is what matters.
    const score = trigramSimilarity("backend engineer", "warehouse supervisor");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.1);
  });

  // Counting occurrences rather than intersecting as multisets would score this above a
  // genuine match, because "aa" contributes three of its four trigrams to "aaaa".
  it("takes the multiset minimum, not the sum, for repeated trigrams", () => {
    expect(trigramSimilarity("aa", "aaaa")).toBeLessThan(1);
  });

  it("is symmetric", () => {
    const a = "senior backend engineer";
    const b = "senior backend engineering";
    expect(trigramSimilarity(a, b)).toBeCloseTo(trigramSimilarity(b, a), 10);
  });

  it("treats a one-sided empty string as 0", () => {
    expect(trigramSimilarity("", "backend")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pass 2 — merge selection
// ---------------------------------------------------------------------------

describe("findFuzzyMatch", () => {
  it("merges a near-identical title from another source", () => {
    // A trailing space, as one source might emit, scores 0.9643 and merges.
    const match = findFuzzyMatch("principalsoftwareengineer", [
      candidate({ titleNorm: "principalsoftwareengineer " }),
    ]);
    expect(match).not.toBeNull();
  });

  // Worth knowing when triaging a "the fuzzy pass didn't merge it" report: at the §6.2
  // threshold, the pass only absorbs near-identical titles. A plural "s" scores 0.8333 and a
  // roman-numeral suffix 0.7778, so both stay separate rows. That is the specified
  // behaviour, not a bug — but it does mean the fuzzy pass is a safety net for whitespace
  // and casing drift, not a synonym matcher.
  it("does not merge a merely-similar title that falls under the threshold", () => {
    const plural = trigramSimilarity(
      "principalsoftwareengineer",
      "principalsoftwareengineers",
    );
    expect(plural).toBeLessThanOrEqual(FUZZY_THRESHOLD);
    expect(
      findFuzzyMatch("principalsoftwareengineer", [
        candidate({ titleNorm: "principalsoftwareengineers" }),
      ]),
    ).toBeNull();
  });

  it("does not merge two genuinely different roles at the same company", () => {
    // ING-007's second required test. Domain equality is the caller's filter; this is the
    // title decision, and it must leave a different job alone.
    const match = findFuzzyMatch("principal software engineer", [
      candidate({ titleNorm: "warehouse supervisor" }),
    ]);
    expect(match).toBeNull();
  });

  it("respects the §6.2 threshold", () => {
    // A candidate just under the bar must not be absorbed; the comparison is strictly `>`.
    const near = "principal software engineer";
    const weak = candidate({ titleNorm: "principal software engineer platform reliability" });
    const score = trigramSimilarity(near, weak.titleNorm ?? "");
    expect(score).toBeLessThanOrEqual(FUZZY_THRESHOLD);
    expect(findFuzzyMatch(near, [weak])).toBeNull();
  });

  it("picks the most similar candidate rather than the first", () => {
    const match = findFuzzyMatch("principal software engineer", [
      candidate({ id: "weak", titleNorm: "principal software engineer platform reliability" }),
      candidate({ id: "exact", titleNorm: "principal software engineer" }),
    ]);
    expect(match?.id).toBe("exact");
  });

  it("breaks a similarity tie toward the row with more sightings", () => {
    const match = findFuzzyMatch("principal software engineer", [
      candidate({ id: "new", titleNorm: "principal software engineer", sightingCount: 1 }),
      candidate({ id: "established", titleNorm: "principal software engineer", sightingCount: 7 }),
    ]);
    expect(match?.id).toBe("established");
  });

  it("skips a candidate with a null title_norm", () => {
    expect(findFuzzyMatch("backend", [candidate({ titleNorm: null })])).toBeNull();
  });

  it("returns null for no candidates", () => {
    expect(findFuzzyMatch("backend engineer", [])).toBeNull();
  });
});

describe("pickSurvivor", () => {
  it("keeps the row with the richer description", () => {
    const thin = candidate({ id: "thin", descriptionText: "Short." });
    const rich = candidate({ id: "rich", descriptionText: "A much longer scraped body." });
    expect(pickSurvivor(thin, rich).survivor.id).toBe("rich");
    expect(pickSurvivor(rich, thin).survivor.id).toBe("rich");
  });

  it("treats a null description as empty, not as the richer one", () => {
    const rich = candidate({ id: "rich", descriptionText: "A long scraped body." });
    const none = candidate({ id: "none", descriptionText: null });
    expect(pickSurvivor(none, rich).survivor.id).toBe("rich");
  });

  it("breaks an equal-length tie on sightings so the merge is stable", () => {
    const a = candidate({ id: "a", descriptionText: "Same length.", sightingCount: 1 });
    const b = candidate({ id: "b", descriptionText: "Same length.", sightingCount: 4 });
    expect(pickSurvivor(a, b).survivor.id).toBe("b");
    expect(pickSurvivor(b, a).survivor.id).toBe("b");
  });

  it("always reports a distinct loser", () => {
    const a = candidate({ id: "a" });
    const b = candidate({ id: "b" });
    const result = pickSurvivor(a, b);
    expect(result.survivor.id).not.toBe(result.loser.id);
  });
});

// ---------------------------------------------------------------------------
// Persistence shape
// ---------------------------------------------------------------------------

describe("upsertCanonicalJob", () => {
  function fakeWriter(result: { error: { message: string } | null }): {
    writer: JobWriter;
    calls: { values: Record<string, unknown>; options: { onConflict: string } }[];
  } {
    const calls: { values: Record<string, unknown>; options: { onConflict: string } }[] = [];
    const writer: JobWriter = {
      from: () => ({
        upsert: (values: unknown, options: { onConflict: string }) => {
          const record = values;
          if (record !== null && typeof record === "object") {
            calls.push({ values: record as Record<string, unknown>, options });
          }
          return Promise.resolve({ data: null, error: result.error });
        },
      }),
    };
    return { writer, calls };
  }

  it("targets the dedupe_hash conflict target", () => {
    // Without this the unique index rejects the second sighting and the same posting from
    // three sources becomes three feed cards.
    const { writer, calls } = fakeWriter({ error: null });
    void upsertCanonicalJob(writer, makeJob(), "hash-1");
    expect(calls[0]?.options.onConflict).toBe("dedupe_hash");
  });

  it("writes the computed hash as the upsert key", () => {
    const { writer, calls } = fakeWriter({ error: null });
    void upsertCanonicalJob(writer, makeJob(), "hash-1");
    expect(calls[0]?.values.dedupe_hash).toBe("hash-1");
  });

  it("maps camelCase fields to their snake_case columns", () => {
    const { writer, calls } = fakeWriter({ error: null });
    void upsertCanonicalJob(writer, makeJob(), "hash-1");
    const values = calls[0]?.values ?? {};
    expect(values.company_name).toBe("Acme Corp");
    expect(values.description_text).toBe("A description.");
    expect(values.country_code).toBe("DE");
    expect(values.salary_min).toBe(80000);
    expect(values.salary_currency).toBe("EUR");
  });

  it("writes null rather than undefined for absent salary and description", () => {
    const { writer, calls } = fakeWriter({ error: null });
    void upsertCanonicalJob(
      writer,
      makeJob({ salary: null, descriptionText: null, applyUrl: null }),
      "hash-1",
    );
    const values = calls[0]?.values ?? {};
    expect(values.salary_min).toBeNull();
    expect(values.description_text).toBeNull();
    expect(values.apply_url).toBeNull();
  });

  it("reports a typed error instead of throwing", async () => {
    const { writer } = fakeWriter({ error: { message: "duplicate key" } });
    const result = await upsertCanonicalJob(writer, makeJob(), "hash-1");
    expect(result).toEqual({
      ok: false,
      error: { code: "dedupe_upsert_failed", message: "duplicate key" },
    });
  });

  it("reports success when the writer returns no error", async () => {
    const { writer } = fakeWriter({ error: null });
    expect(await upsertCanonicalJob(writer, makeJob(), "hash-1")).toEqual({ ok: true });
  });
});
