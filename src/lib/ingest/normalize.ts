/**
 * normalize.ts — job normalisation pipeline (BE-106, BE-317).
 *
 * Maps RawJob → CanonicalJob. Handles:
 * - Salary parsing
 * - Seniority extraction
 * - Location parsing (including India/International remote scope)
 * - Skill matching against canonical skills
 *
 * All functions are pure and deterministic.
 */

import type { RawJob, CanonicalJob, RemoteScope } from "@/types/canonical-job";

// ---------------------------------------------------------------------------
// Remote scope detection (BE-317)
// ---------------------------------------------------------------------------

const INDIA_REMOTE_PATTERNS = [
  /\bpan\s*india\b/i,
  /\banywhere\s+in\s+india\b/i,
  /\bindia\s*remote\b/i,
  /\bremote\s*[-–]\s*india\b/i,
  /\bwork\s+from\s+home\s+india\b/i,
  // "Work from India" / "WFH India" without an explicit "home".
  /\bwork\s+from\s+india\b/i,
  /\bindia\s*wfh\b/i,
  /\bwfh\s+india\b/i,
  // No trailing `\b`: `)` is a non-word character, so there is no boundary to
  // assert after it at end-of-string.
  /\bremote\s*\(india\)/i,
  /\bremote\s*-\s*india\b/i,
];

const GLOBAL_REMOTE_PATTERNS = [
  /\bworldwide\b/i,
  /\bglobal\b/i,
  /\banywhere\b/i,
  /\binternational\s+remote\b/i,
  /\bremote\s*[-–]\s*anywhere\b/i,
  /\bremote\s*[-–]\s*global\b/i,
  /\bremote\s*[-–]\s*worldwide\b/i,
  /\bwork\s+from\s+anywhere\b/i,
  /\blocation\s+agnostic\b/i,
  /\btime\s*zone\s+agnostic\b/i,
  /\bremote\s*\(global\)/i,
  /\bremote\s*\(worldwide\)/i,
  /\bremote\s*\(anywhere\)/i,
];

/**
 * Country names recognised when resolving a country code from free text.
 *
 * Kept separate from the code map so the text scan is a cheap pre-filter: only
 * these names are worth trying to map, rather than every key in the map.
 */
const COUNTRY_NAMES = [
  "India",
  "United States",
  "USA",
  "United Kingdom",
  "Canada",
  "Australia",
  "Germany",
  "France",
  "Netherlands",
  "Singapore",
  "United Arab Emirates",
] as const;

/**
 * Detect the remote scope (India vs Global) from job text.
 *
 * Returns "india" for India-specific remote roles, "global" for
 * internationally distributed roles, or "unknown" if undetermined.
 */
export function detectRemoteScope(text: string): RemoteScope {
  const lowerText = text.toLowerCase();

  // Check India-specific patterns first (more specific)
  for (const pattern of INDIA_REMOTE_PATTERNS) {
    if (pattern.test(lowerText)) {
      return "india";
    }
  }

  // Check global patterns
  for (const pattern of GLOBAL_REMOTE_PATTERNS) {
    if (pattern.test(lowerText)) {
      return "global";
    }
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Location parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw location string into structured location data.
 *
 * Handles formats like:
 * - "Bangalore, India"
 * - "Mumbai, Maharashtra, India"
 * - "Remote – India"
 * - "New York, NY, USA"
 * - "London, UK"
 * - "Remote – Anywhere"
 */
export function parseLocation(raw: string): {
  city: string | null;
  region: string | null;
  countryCode: string | null;
  remoteScope: RemoteScope;
} {
  const remoteScope = detectRemoteScope(raw);

  // If it's a remote-only location, city/region may be null. The country is stated
  // inline ("Remote – India") or in parentheses ("Remote (India)"), so look for a
  // country token anywhere in the string rather than requiring the parenthesised form.
  if (remoteScope !== "unknown" && /^(remote|work from home|wfh|anywhere|work from)/i.test(raw.trim())) {
    const parenthesised = /\(([^)]+)\)/.exec(raw);
    if (parenthesised?.[1]) {
      return {
        city: null,
        region: null,
        countryCode: mapCountryToCode(parenthesised[1].trim()),
        remoteScope,
      };
    }

    // Fall back to any country name mentioned in the text.
    for (const country of COUNTRY_NAMES) {
      if (new RegExp(`\\b${country}\\b`, "i").test(raw)) {
        return { city: null, region: null, countryCode: mapCountryToCode(country), remoteScope };
      }
    }

    return { city: null, region: null, countryCode: null, remoteScope };
  }

  // Try to parse "City, Region, Country" or "City, Country"
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length === 0) {
    return { city: null, region: null, countryCode: null, remoteScope };
  }

  const firstPart = parts[0] ?? null;
  const secondPart = parts[1] ?? null;
  const lastPart = parts[parts.length - 1] ?? null;

  if (parts.length === 1) {
    // Just a city or country
    const countryCode = firstPart ? mapCountryToCode(firstPart) : null;
    return {
      city: countryCode ? null : firstPart,
      region: null,
      countryCode,
      remoteScope,
    };
  }

  if (parts.length === 2) {
    // "City, Country" or "City, Region"
    const countryCode = secondPart ? mapCountryToCode(secondPart) : null;
    if (countryCode) {
      return { city: firstPart, region: null, countryCode, remoteScope };
    }
    return { city: firstPart, region: secondPart, countryCode: null, remoteScope };
  }

  // "City, Region, Country"
  const countryCode = lastPart ? mapCountryToCode(lastPart) : null;
  return {
    city: firstPart,
    region: secondPart,
    countryCode,
    remoteScope,
  };
}

/**
 * Map a country name to ISO 3166-1 alpha-2 code.
 */
function mapCountryToCode(country: string): string | null {
  const map: Record<string, string> = {
    "india": "IN",
    "in": "IN",
    "united states": "US",
    "usa": "US",
    "us": "US",
    "united kingdom": "GB",
    "uk": "GB",
    "gb": "GB",
    "canada": "CA",
    "ca": "CA",
    "australia": "AU",
    "au": "AU",
    "germany": "DE",
    "de": "DE",
    "france": "FR",
    "fr": "FR",
    "netherlands": "NL",
    "nl": "NL",
    "singapore": "SG",
    "sg": "SG",
    "uae": "AE",
    "united arab emirates": "AE",
    "japan": "JP",
    "jp": "JP",
  };

  return map[country.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Salary parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw salary string into structured salary data.
 *
 * Handles formats like:
 * - "₹15,00,000 per year"
 * - "$120,000 - $150,000"
 * - "15L - 20L"
 * - "₹1,50,000/month"
 */
export function parseSalary(raw: string): {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "year" | "month" | "hour" | null;
} {
  if (!raw || raw.trim() === "") {
    return { min: null, max: null, currency: null, period: null };
  }

  // Detect period
  let period: "year" | "month" | "hour" = "year";
  if (/month|\/mo|per mo/i.test(raw)) period = "month";
  if (/hour|\/hr|per hr/i.test(raw)) period = "hour";

  // LPA ("lakh per annum") is the standard CTC suffix on Indian resumes — the exact
  // audience of BE-317 — and it must be matched before the lakh pattern. "12 LPA" does
  // NOT match the lakh regex: that requires a word boundary after "l", and "L" is
  // followed by "P", two word characters, so no boundary exists. It therefore fell
  // through to the generic number scan and returned 12 USD, which is wrong by six
  // orders of magnitude *and* in the wrong currency.
  const lpa = /(\d+(?:\.\d+)?)\s*lpa\b/i.exec(raw);
  if (lpa?.[1]) {
    return { min: parseFloat(lpa[1]) * 100000, max: null, currency: "INR", period: "year" };
  }

  // Lakh/crore notation is unambiguously INR and is *scaled*, so it is resolved before
  // the general number scan — otherwise "15L" reads as 15.
  //
  // Ranges are collected with matchAll rather than exec: "15L - 20L" is an advertised
  // format, and taking only the first match silently dropped the upper bound.
  const lakh = collectScaledFigures(raw, /(?:l|lakh)s?\b/i, 100000);
  if (lakh) return { ...lakh, currency: "INR", period };

  const crore = collectScaledFigures(raw, /(?:cr|crore)s?\b/i, 10000000);
  if (crore) return { ...crore, currency: "INR", period };

  // Detect currency
  let currency = "USD";
  if (/₹|\binr\b|\brs\.?\b/i.test(raw)) currency = "INR";
  if (/€|\beur\b/i.test(raw)) currency = "EUR";
  if (/£|\bgbp\b/i.test(raw)) currency = "GBP";

  // Extract numbers. Indian grouping is `1,50,000` (3-2-3) and western is
  // `1,500,000`, so match any comma-grouped run and strip the separators.
  const numbers = raw.match(/[\d][\d,]*(?:\.\d{1,2})?/g) ?? [];

  if (numbers.length === 0) {
    return { min: null, max: null, currency, period };
  }

  // parseFloat, not parseInt: "$120,000.50" was truncating to 120000. Salary figures
  // are not integers (hourly rates, GBP/INR paise), and a floor that silently rounds
  // down changes which jobs clear a salary gate.
  const parsed = numbers.map((n) => parseFloat(n.replace(/,/g, "")));

  const firstNum = parsed[0] ?? null;
  const secondNum = parsed[1] ?? null;

  if (parsed.length === 1) {
    return { min: firstNum, max: null, currency, period };
  }

  return { min: firstNum, max: secondNum, currency, period };
}

/**
 * Every `<number><scale-suffix>` figure in the text, scaled to an absolute amount.
 *
 * Returns null when the suffix never appears, so the caller can fall through to the next
 * notation. Handles both a single value ("15L") and a range ("15L - 20L").
 */
function collectScaledFigures(
  raw: string,
  suffix: RegExp,
  multiplier: number,
): { min: number; max: number | null } | null {
  const figure = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${suffix.source}`, "gi");
  const values = [...raw.matchAll(figure)].map((m) => parseFloat(m[1] ?? "0") * multiplier);

  const first = values[0];
  if (first === undefined) return null;

  // Only treat a second figure as a range bound when it is scaled by the same suffix;
  // a bare number elsewhere in the string (a year, a headcount) is not a bound.
  const second = values[1];

  return { min: first, max: second ?? null };
}

// ---------------------------------------------------------------------------
// Seniority extraction
// ---------------------------------------------------------------------------

const SENIORITY_PATTERNS = {
  intern: /\b(intern|internship|trainee|fresher)\b/i,
  junior: /\b(junior|jr\.?|entry[- ]level|0[- ]2\s*years?|1[- ]2\s*years?)\b/i,
  mid: /\b(mid[- ]level|intermediate|2[- ]5\s*years?|3[- ]5\s*years?)\b/i,
  senior: /\b(senior|sr\.?|5\+\s*years?|8\+\s*years?|7\+\s*years?)\b/i,
  lead: /\b(lead|team lead|tech lead|engineering lead)\b/i,
  staff: /\b(staff engineer|staff developer|staff)\b/i,
  principal: /\b(principal engineer|principal developer|principal)\b/i,
  director: /\b(director|head of|vp|vice president)\b/i,
  exec: /\b(cto|ceo|cio|chief)\b/i,
};

/**
 * Extract seniority from job title and description.
 */
export function extractSeniority(title: string, description: string): CanonicalJob["seniority"] {
  const text = `${title} ${description}`;

  for (const [level, pattern] of Object.entries(SENIORITY_PATTERNS)) {
    if (pattern.test(text)) {
      return level as CanonicalJob["seniority"];
    }
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Main normalisation function
// ---------------------------------------------------------------------------

/**
 * Normalise a RawJob into a CanonicalJob.
 *
 * This is the main entry point for the normalisation pipeline (BE-106).
 * It applies all parsing and extraction rules to produce a clean,
 * structured job record ready for deduplication and storage.
 */
export function normaliseJob(raw: RawJob): CanonicalJob {
  const location = parseLocation(raw.locationRaw ?? "");
  const salary = parseSalary(raw.salaryRaw ?? "");
  const seniority = extractSeniority(raw.title, raw.descriptionText ?? "");

  // Detect remote scope from location + title + description
  const remoteScope = detectRemoteScope(
    `${raw.locationRaw ?? ""} ${raw.title} ${raw.descriptionText ?? ""}`,
  );

  return {
    externalId: raw.externalId,
    sourceUrl: raw.sourceUrl,
    applyUrl: raw.applyUrl ?? null,
    companyName: raw.companyName,
    companyDomain: raw.companyDomain ?? null,
    title: raw.title,
    titleNorm: raw.title.toLowerCase().replace(/[^a-z0-9]/g, ""),
    descriptionText: raw.descriptionText ?? null,
    descriptionHtml: null, // Would be populated by HTML sanitiser
    location: {
      city: location.city,
      region: location.region,
      countryCode: location.countryCode,
      raw: raw.locationRaw ?? "",
    },
    remoteScope,
    workMode: raw.workMode ?? "unknown",
    employmentType: raw.employmentType ?? "unknown",
    seniority: raw.seniority ?? seniority,
    salary: {
      min: salary.min,
      max: salary.max,
      currency: salary.currency,
      period: salary.period,
      raw: raw.salaryRaw ?? null,
    },
    skills: raw.skills,
    postedAt: raw.postedAt ?? null,
    firstSeenAt: null, // Set by dedupe pipeline
    lastSeenAt: null, // Set by dedupe pipeline
    sightingCount: 1,
    status: "active",
    confidence: 1.0,
    dedupeHash: null, // Computed by dedupe pipeline
    raw: raw.raw ?? null,
  };
}
