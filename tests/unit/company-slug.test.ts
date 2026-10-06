/**
 * company-slug.test.ts — the shared company-identity normaliser.
 *
 * The property that matters most is the *round trip*: a value written by
 * `update-dealbreakers` must match the same company as seen on a `jobs` row.
 * Before this module existed the write path stored `trim().toLowerCase()` while
 * docs/02a §5.3 says "normalised slugs", so "Acme Corp." was stored verbatim and
 * could never match a slugified job. `matchesBlockedCompany` pins that case.
 */

import { describe, expect, it } from "vitest";

import {
  companyDomainToSlug,
  companyNameToSlug,
  companySlugCandidates,
  normaliseCompanyInput,
  stripLegalSuffixes,
} from "@/lib/utils/company-slug";

describe("companyNameToSlug", () => {
  it("lowercases, collapses whitespace and punctuation to single hyphens", () => {
    expect(companyNameToSlug("Acme Corp.")).toBe("acme-corp");
    expect(companyNameToSlug("ACME  CORP")).toBe("acme-corp");
    expect(companyNameToSlug("  acme   corp  ")).toBe("acme-corp");
    expect(companyNameToSlug("Foo, Bar & Baz")).toBe("foo-bar-baz");
  });

  it("strips accents so non-ASCII names still slugify", () => {
    expect(companyNameToSlug("Café Ventures")).toBe("cafe-ventures");
  });

  it("returns an empty string when there is nothing sluggable", () => {
    expect(companyNameToSlug("")).toBe("");
    expect(companyNameToSlug("   ")).toBe("");
    expect(companyNameToSlug("!!!")).toBe("");
  });

  it("keeps legal suffixes by default — a blocklist is not a dedupe hash", () => {
    expect(companyNameToSlug("Acme Inc")).toBe("acme-inc");
    expect(companyNameToSlug("Acme")).toBe("acme");
    // Only an explicit opt-in collapses them.
    expect(companyNameToSlug("Acme Inc", { stripLegalSuffix: true })).toBe("acme");
  });
});

describe("stripLegalSuffixes", () => {
  it("is a no-op unless explicitly enabled", () => {
    expect(stripLegalSuffixes(["acme", "inc"])).toEqual(["acme", "inc"]);
  });

  it("removes repeated trailing suffixes", () => {
    expect(stripLegalSuffixes(["acme", "holdings", "inc"], { stripLegalSuffix: true })).toEqual([
      "acme",
      "holdings",
    ]);
  });

  it("never reduces a single-token name to nothing", () => {
    expect(stripLegalSuffixes(["inc"], { stripLegalSuffix: true })).toEqual(["inc"]);
  });
});

describe("companyDomainToSlug", () => {
  it("extracts the host from a full URL", () => {
    expect(companyDomainToSlug("https://boards.greenhouse.io/acme")).toBe("boards.greenhouse.io");
    expect(companyDomainToSlug("http://www.acme.com/jobs/1")).toBe("acme.com");
  });

  it("strips credentials and ports", () => {
    expect(companyDomainToSlug("https://user:pw@acme.com:8443/x")).toBe("acme.com");
  });

  it("returns null for values that are not domains", () => {
    // ATS paths and free text land in company_domain in practice; sloughing them
    // into a slug would let junk match a blocklist entry.
    expect(companyDomainToSlug("acme")).toBeNull();
    expect(companyDomainToSlug("acme.")).toBeNull();
    expect(companyDomainToSlug(".com")).toBeNull();
    expect(companyDomainToSlug("")).toBeNull();
    expect(companyDomainToSlug(null)).toBeNull();
    expect(companyDomainToSlug(undefined)).toBeNull();
  });
});

describe("normaliseCompanyInput", () => {
  it("accepts a name", () => {
    expect(normaliseCompanyInput("Acme Corp.")).toBe("acme-corp");
  });

  it("accepts a domain and keeps its dots, so the stored value still matches", () => {
    expect(normaliseCompanyInput("acme.com")).toBe("acme.com");
    expect(normaliseCompanyInput("https://www.acme.co.uk/careers")).toBe("acme.co.uk");
  });

  it("returns null so callers can drop empty entries", () => {
    expect(normaliseCompanyInput("")).toBeNull();
    expect(normaliseCompanyInput("   ")).toBeNull();
    expect(normaliseCompanyInput("!!!")).toBeNull();
  });
});

describe("companySlugCandidates", () => {
  it("offers the name, the domain and the bare label", () => {
    const candidates = companySlugCandidates({
      companyName: "Acme Corp.",
      companyDomain: "www.acme.com",
    });
    expect(candidates).toContain("acme-corp");
    expect(candidates).toContain("acme.com");
    expect(candidates).toContain("acme");
  });

  it("falls back to the name when the domain is unusable", () => {
    expect(companySlugCandidates({ companyName: "Acme", companyDomain: "n/a" })).toEqual(["acme"]);
  });

  it("returns an empty list when neither field yields a slug", () => {
    expect(companySlugCandidates({ companyName: "", companyDomain: null })).toEqual([]);
  });
});

describe("write/read round trip (the BE-304 latent bug)", () => {
  it("matches a blocked name against a job whose company_name differs in punctuation", () => {
    // What the user typed in onboarding:
    const blocked = [normaliseCompanyInput("Acme Corp.")].filter(
      (s): s is string => s !== null,
    );
    // What the ingestion pipeline recorded for the same employer:
    const candidates = companySlugCandidates({
      companyName: "ACME Corp",
      companyDomain: null,
    });

    expect(candidates.some((c) => blocked.includes(c))).toBe(true);
  });

  it("matches a blocked domain against a job with a www-prefixed domain", () => {
    const blocked = [normaliseCompanyInput("acme.com")].filter((s): s is string => s !== null);
    const candidates = companySlugCandidates({
      companyName: "Acme",
      companyDomain: "https://www.acme.com/jobs",
    });

    expect(candidates.some((c) => blocked.includes(c))).toBe(true);
  });

  it("does not match a different company", () => {
    const blocked = [normaliseCompanyInput("Acme Corp.")].filter(
      (s): s is string => s !== null,
    );
    const candidates = companySlugCandidates({
      companyName: "Globex",
      companyDomain: "globex.io",
    });

    expect(candidates.some((c) => blocked.includes(c))).toBe(false);
  });
});