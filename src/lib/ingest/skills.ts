/**
 * skills.ts — canonical skill matcher (BE-106).
 *
 * `jobs.skills` is documented (`docs/02b` §6.6, `src/types/canonical-job.ts` "Skills
 * (canonical slugs, populated by BE-106)") as an array of canonical **slugs**. Until this
 * module existed, `normaliseJob` passed the connector's `raw.skills` through untouched, so
 * the column held whatever free text each provider happened to use — or an empty array for
 * the providers that send none. Same failure shape as the `v_ranked_jobs` column list
 * (`docs/02b` §5.9): nothing errors, the field is simply always wrong.
 *
 * The vocabulary below is a **mirror of `supabase/seed.sql`**, not an independent list.
 * `tests/unit/ingest-skills.test.ts` parses the seed file and fails if the two disagree in
 * either direction, so adding a skill to the database without teaching this matcher about
 * it is a red test rather than a silent miss.
 *
 * Pure and deterministic: no clock, no network, no database.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export interface CanonicalSkill {
  /** Canonical slug — the value stored in `jobs.skills`. */
  readonly slug: string;
  /** Lower-case literal forms that identify this skill in free text. */
  readonly patterns: readonly string[];
}

export const CANONICAL_SKILLS: readonly CanonicalSkill[] = [
  { slug: "typescript", patterns: ["typescript", "ts"] },
  { slug: "react", patterns: ["react", "react.js", "reactjs"] },
  // `next` is deliberately NOT a pattern. It is a seed alias, but it is also an ordinary
  // English word: "the next step", "what's next" appear in a large share of job
  // descriptions, and a bare `\bnext\b` would tag a meaningful fraction of the corpus as
  // Next.js. The dotted and squashed spellings are unambiguous, so they carry the match.
  // See notes.md 2026-10-04 on `\b` and punctuation-adjacent literals.
  { slug: "nextjs", patterns: ["next.js", "nextjs"] },
  { slug: "postgresql", patterns: ["postgresql", "postgres", "psql"] },
  { slug: "tailwindcss", patterns: ["tailwind css", "tailwindcss", "tailwind"] },
  // `py` is a seed alias, kept because it is conventionally the Python extension in prose.
  // `\bpy\b` cannot match inside `pytorch` (no boundary after `py`) nor inside `k8s`.
  { slug: "python", patterns: ["python", "py"] },
  { slug: "aws", patterns: ["aws", "amazon web services"] },
  { slug: "docker", patterns: ["docker", "containerization"] },
  { slug: "kubernetes", patterns: ["kubernetes", "k8s"] },
  { slug: "graphql", patterns: ["graphql", "gql"] },
];

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

/** Characters that are literal in a pattern but special inside a regex. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(literal: string): string {
  return literal.replace(REGEX_METACHARACTERS, "\\$&");
}

/**
 * Wrap a literal in word boundaries.
 *
 * A `.` is escaped, so `next.js` cannot match `nextxjs`. The trailing boundary is only
 * meaningful when the literal ends in a word character — every pattern here does — and the
 * leading one only when it starts with one, which is why phrases are handled by the same
 * helper: spaces inside a phrase become `\s+` so line wrapping cannot hide a match.
 */
function boundaryWrap(literal: string): string {
  const escaped = escapeLiteral(literal).replace(/\s+/g, "\\s+");
  return `\\b${escaped}\\b`;
}

interface CompiledSkill {
  readonly slug: string;
  readonly matchers: readonly RegExp[];
}

const COMPILED: readonly CompiledSkill[] = CANONICAL_SKILLS.map((skill) => ({
  slug: skill.slug,
  matchers: skill.patterns.map((literal) => new RegExp(boundaryWrap(literal), "i")),
}));

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/**
 * Match free text against the canonical vocabulary.
 *
 * Accepts the several text fields a posting's skills can be evidenced in, and ignores
 * absent ones — a job with no description should still match on its title.
 *
 * Returns slugs sorted ascending and de-duplicated — two patterns of the same skill
 * (`python` / `py`) yield one entry, not two.
 */
export function matchSkills(...texts: readonly (string | null | undefined)[]): string[] {
  const haystack = texts
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");

  if (haystack.length === 0) {
    return [];
  }

  const matched = new Set<string>();
  for (const { slug, matchers } of COMPILED) {
    if (matchers.some((matcher) => matcher.test(haystack))) {
      matched.add(slug);
    }
  }

  return [...matched].sort();
}

/** Every slug this module can emit, for callers that need to validate a stored value. */
export function knownSkillSlugs(): string[] {
  return [...new Set(CANONICAL_SKILLS.map((skill) => skill.slug))].sort();
}
