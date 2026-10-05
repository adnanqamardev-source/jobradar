/**
 * extract-rules.ts — rule-based resume profile extraction (BE-315).
 *
 * Extracts structured profile data from resume text using pattern matching
 * and heuristics. This is the first-pass extractor; if confidence is below
 * threshold, the LLM extractor (extract-llm.ts) is used as a fallback.
 *
 * All extraction is deterministic — same input produces same output.
 */

import type { ExtractedProfile } from "@/types/resume";
import { parseSalary as parseSalaryFragment, parseLocation as parseLocationFragment } from "@/lib/ingest/normalize";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

// Common section headers.
// `:` is optional because "Education:" is as common as "EDUCATION".
const SECTION_HEADERS = {
  summary: /^(summary|objective|profile|about|introduction)\s*:?\s*$/i,
  experience: /^(experience|employment|work history|professional experience|career)\s*:?\s*$/i,
  education: /^(education|academic|qualifications)\s*:?\s*$/i,
  skills: /^(skills|technologies|tech stack|competencies|expertise)\s*:?\s*$/i,
  projects: /^(projects|portfolio)\s*:?\s*$/i,
  certifications: /^(certifications|certificates|licenses)\s*:?\s*$/i,
};

// Seniority keywords
const SENIORITY_KEYWORDS = {
  intern: /\b(intern|internship|trainee)\b/i,
  junior: /\b(junior|jr\.?|entry[- ]level|0[- ]2\s*years?)\b/i,
  mid: /\b(mid[- ]level|intermediate|2[- ]5\s*years?)\b/i,
  senior: /\b(senior|sr\.?|lead|principal|staff|5\+\s*years?|8\+\s*years?)\b/i,
  lead: /\b(lead|team lead|tech lead|engineering lead)\b/i,
  staff: /\b(staff engineer|staff developer)\b/i,
  principal: /\b(principal engineer|principal developer)\b/i,
  director: /\b(director|head of|vp|vice president)\b/i,
  exec: /\b(cto|ceo|cio|chief)\b/i,
};

// Work mode keywords
const WORK_MODE_KEYWORDS = {
  remote: /\b(remote|work from home|wfh|distributed|anywhere)\b/i,
  hybrid: /\b(hybrid|flexible|partial remote)\b/i,
  onsite: /\b(on[- ]site|in[- ]office|office[- ]based)\b/i,
};

// Salary patterns
/**
 * Keyword-scoped salary fragments.
 *
 * The number itself is deliberately *not* captured — the matched fragment is handed to
 * the shared parser, which owns grouping, currency, and period. These only decide
 * *where* in the text a salary was stated.
 */
const SALARY_PATTERNS = [
  /(?:expected|desired|target)?\s*(?:salary|compensation|ctc|ctc|pay|package)\s*[:\s-]*(?:₹|\$|€|£)?\s*[\d][\d,]*(?:\.\d{1,2})?\s*(?:l|lakh|cr|crore)?(?:\s*(?:per|\/)\s*(?:year|annum|yr|month|mo|hour|hr))?/i,
  /(?:₹|\$|€|£)\s*[\d][\d,]*(?:\.\d{1,2})?\s*(?:l|lakh|cr|crore)?(?:\s*(?:per|\/)\s*(?:year|annum|yr|month|mo|hour|hr))?/i,
  /\b[\d][\d,]*(?:\.\d{1,2})?\s*(?:l|lakh|cr|crore)\b(?:\s*(?:per|\/)\s*(?:year|annum|yr|month|mo))?/i,
];

// Common skills (subset — full list in skills-canonical.ts)
const COMMON_SKILLS = [
  "JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "Go", "Rust", "Ruby", "PHP",
  "React", "Angular", "Vue", "Next.js", "Node.js", "Express", "Django", "Flask", "Spring",
  "AWS", "Azure", "GCP", "Docker", "Kubernetes", "Terraform", "CI/CD", "Git", "Agile", "Scrum",
  "SQL", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "GraphQL", "REST",
  "Machine Learning", "Deep Learning", "NLP", "Computer Vision", "Data Science", "Analytics",
  "Product Management", "Project Management", "Leadership", "Communication", "Collaboration",
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function extractSection(text: string, sectionName: keyof typeof SECTION_HEADERS): string | null {
  const lines = text.split("\n");
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this line is a section header
    if (SECTION_HEADERS[sectionName].test(trimmed)) {
      inSection = true;
      continue;
    }

    // Check if we've hit another section header
    if (inSection) {
      const isOtherHeader = Object.values(SECTION_HEADERS).some((pattern) =>
        pattern.test(trimmed),
      );
      if (isOtherHeader && trimmed.length < 50) {
        break;
      }
    }

    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.length > 0 ? sectionLines.join("\n").trim() : null;
}

function extractEmails(text: string): string[] {
  const all = text.match(EMAIL_PATTERN) ?? [];
  return [...new Set(all.map((e) => e.toLowerCase()))];
}

function extractPhones(text: string): string[] {
  const all = text.match(PHONE_PATTERN) ?? [];
  return [...new Set(all.map((p) => p.replace(/\s+/g, " ").trim()))];
}

function extractSkills(text: string): string[] {
  const found: string[] = [];
  const lowerText = text.toLowerCase();

  for (const skill of COMMON_SKILLS) {
    const pattern = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(lowerText)) {
      found.push(skill);
    }
  }

  return found;
}

function extractSeniority(text: string): ExtractedProfile["seniority"] {
  const experienceSection = extractSection(text, "experience") ?? text;

  for (const [level, pattern] of Object.entries(SENIORITY_KEYWORDS)) {
    if (pattern.test(experienceSection)) {
      return level as ExtractedProfile["seniority"];
    }
  }

  // Try to infer from years of experience
  const yearsMatch = /(\d+)\+?\s*years?/i.exec(experienceSection);
  if (yearsMatch?.[1]) {
    const years = parseInt(yearsMatch[1], 10);
    if (years < 2) return "junior";
    if (years < 5) return "mid";
    if (years < 8) return "senior";
    return "lead";
  }

  return null;
}

function extractYearsExperience(text: string): number | null {
  const patterns = [
    /(\d+)\+?\s*years?\s*(?:of\s*)?experience/i,
    /experience[:\s]*(\d+)\+?\s*years?/i,
    /(\d+)\+?\s*years?\s*(?:in|of)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

function extractWorkModes(text: string): ("remote" | "hybrid" | "onsite")[] {
  const modes: ("remote" | "hybrid" | "onsite")[] = [];
  const lowerText = text.toLowerCase();

  for (const [mode, pattern] of Object.entries(WORK_MODE_KEYWORDS)) {
    if (pattern.test(lowerText)) {
      modes.push(mode as "remote" | "hybrid" | "onsite");
    }
  }

  return modes;
}

/**
 * Find the salary figure the candidate actually stated.
 *
 * Scoped to a keyword ("expected", "salary", "ctc", …) on purpose: a resume is full of
 * numbers, so an unscoped scan would happily return a graduation year. Once the fragment
 * is located, the numeric parsing is delegated to the shared job parser so Indian
 * grouping (`₹15,00,000`) and lakh/crore notation are handled in one place.
 */
function extractSalary(text: string): {
  min: number | null;
  currency: string | null;
  period: "year" | "month" | "hour" | null;
} {
  for (const pattern of SALARY_PATTERNS) {
    const match = pattern.exec(text);
    const fragment = match?.[0];
    if (fragment) {
      const parsed = parseSalaryFragment(fragment);
      return { min: parsed.min, currency: parsed.currency, period: parsed.period };
    }
  }

  return { min: null, currency: null, period: null };
}

/**
 * Locate a `City, Region, Country` line and parse it.
 *
 * The comma-splitting and country→ISO mapping are delegated to the shared job
 * location parser, which already handles both western (`San Francisco, CA, USA`)
 * and Indian (`Bangalore, India`) forms. Re-implementing them here is how the two
 * parsers drift apart.
 */
function extractLocation(text: string): {
  city: string | null;
  region: string | null;
  countryCode: string | null;
} {
  const candidates = [
    // An explicit "Location:" label is the strongest signal.
    ...(text.match(/location\s*:\s*(.+)/gi) ?? []),
    // Otherwise, any line that looks like a comma-separated place list.
    ...text
      .split("\n")
      .filter((line) => /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s*,\s*[A-Za-z ]+)?\s*$/.test(line.trim())),
  ];

  for (const candidate of candidates) {
    const raw = candidate.replace(/^location\s*:\s*/i, "").trim();
    const parsed = parseLocationFragment(raw);
    if (parsed.city) {
      return {
        city: parsed.city,
        region: parsed.region,
        countryCode: parsed.countryCode,
      };
    }
  }

  return { city: null, region: null, countryCode: null };
}

function extractTitles(text: string): string[] {
  const titles: string[] = [];

  // Look for job title patterns in experience section
  const experienceSection = extractSection(text, "experience") ?? text;
  const expLines = experienceSection.split("\n");

  const titlePatterns = [
    /^(senior|junior|lead|principal|staff|director|vp|head of|chief)?\s*(software|frontend|backend|full[- ]stack|devops|data|product|project|engineering)?\s*(engineer|developer|manager|designer|analyst|consultant|architect)/i,
    /^(software|frontend|backend|full[- ]stack|devops|data|product|project|engineering)\s*(engineer|developer|manager|designer|analyst|consultant|architect)/i,
  ];

  for (const line of expLines) {
    const trimmed = line.trim();
    if (trimmed.length > 5 && trimmed.length < 100) {
      for (const pattern of titlePatterns) {
        if (pattern.test(trimmed)) {
          const firstPart = trimmed.split(/[-–|]/)[0];
          if (firstPart) {
            titles.push(firstPart.trim());
          }
          break;
        }
      }
    }
  }

  return [...new Set(titles)].slice(0, 10);
}

function extractEducation(text: string): { degree: string; institution: string; year: number | null }[] {
  const education: { degree: string; institution: string; year: number | null }[] = [];
  const educationSection = extractSection(text, "education");

  if (!educationSection) return education;

  const lines = educationSection.split("\n");
  const degreePattern = /(b\.?s\.?|m\.?s\.?|b\.?a\.?|m\.?a\.?|b\.?tech|m\.?tech|b\.?e\.?|m\.?e\.?|ph\.?d\.?|bachelor|master|doctorate)/i;
  const yearPattern = /(19|20)\d{2}/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (degreePattern.test(trimmed)) {
      const yearMatch = yearPattern.exec(trimmed);
      education.push({
        degree: trimmed,
        institution: "", // Would need more sophisticated parsing
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
      });
    }
  }

  return education;
}

function extractSummary(text: string): string | null {
  const summarySection = extractSection(text, "summary");
  if (summarySection && summarySection.length > 20) {
    return summarySection.slice(0, 500);
  }

  // Fallback: first few non-empty lines
  const lines = text.split("\n").filter((l) => l.trim().length > 20);
  if (lines.length > 0) {
    return lines.slice(0, 3).join(" ").slice(0, 500);
  }

  return null;
}

function extractFullName(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  // Heuristic: first non-empty line that looks like a name
  for (const line of lines.slice(0, 5)) {
    const trimmed = line.trim();
    // Name pattern: 2-4 words, each starting with capital letter
    if (/^[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}$/.test(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Confidence calculation
// ---------------------------------------------------------------------------

function calculateConfidence(profile: Partial<ExtractedProfile>): number {
  let score = 0;
  let maxScore = 0;

  // Email (high weight — almost always present)
  maxScore += 20;
  if (profile.email) score += 20;

  // Phone (medium weight)
  maxScore += 10;
  if (profile.phone) score += 10;

  // Location (medium weight)
  maxScore += 15;
  if (profile.location?.city || profile.location?.countryCode) score += 15;

  // Titles (high weight)
  maxScore += 20;
  if (profile.titles && profile.titles.length > 0) score += 20;

  // Skills (high weight)
  maxScore += 20;
  if (profile.skills && profile.skills.length > 0) score += 20;

  // Seniority (medium weight)
  maxScore += 10;
  if (profile.seniority) score += 10;

  // Summary (low weight)
  maxScore += 5;
  if (profile.summary) score += 5;

  return maxScore > 0 ? score / maxScore : 0;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract a structured profile from resume text using rule-based heuristics.
 *
 * This is deterministic — same input always produces same output.
 * If confidence is below the threshold, consider using the LLM extractor.
 */
export function extractProfileFromText(text: string): ExtractedProfile {
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  const skills = extractSkills(text);
  const seniority = extractSeniority(text);
  const yearsExperience = extractYearsExperience(text);
  const workModes = extractWorkModes(text);
  const salary = extractSalary(text);
  const location = extractLocation(text);
  const titles = extractTitles(text);
  const education = extractEducation(text);
  const summary = extractSummary(text);
  const fullName = extractFullName(text);

  const profile: Partial<ExtractedProfile> = {
    fullName,
    email: emails[0] ?? null,
    phone: phones[0] ?? null,
    location,
    titles,
    seniority,
    yearsExperience,
    skills,
    workModes,
    minSalary: salary.min,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    education,
    summary,
  };

  const confidence = calculateConfidence(profile);

  return {
    ...profile,
    confidence,
    needsReview: confidence < 0.6 || !profile.email || !profile.titles || profile.titles.length === 0,
  } as ExtractedProfile;
}
