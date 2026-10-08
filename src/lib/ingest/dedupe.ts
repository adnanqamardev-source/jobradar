/**
 * dedupe.ts — two-pass deduplication (BE-107, `docs/02b` §6.2).
 *
 * A posting is seen many times: the same role on Greenhouse and Lever, re-listed the next
 * day, syndicated to an aggregator. Each sighting must collapse onto **one** `jobs` row or
 * the feed shows the same job three times with three scores. `docs/02b` §6.2 specifies the
 * two passes, and the order is not interchangeable:
 *
 * 1. **Exact** — `sha256(norm_title | norm_company_domain | norm_city | work_mode)`, upserted
 *    on the unique `dedupe_hash`, so a repeat sighting bumps `last_seen_at` and
 *    `sighting_count` instead of inserting a second row.
 * 2. **Fuzzy** — trigram similarity on `title_norm` within one `company_domain`, above
 *    0.85, merging into the survivor with the richer `description_text`. Runs on
 *    **newly inserted rows only**: re-running it on every sighting would let a near-miss
 *    title creep toward a neighbour's row on each pass, and `sighting_count` would drift
 *    from the number of real sightings.
 *
 * ## Why the company identity falls back to the name
 *
 * §6.2 specifies `norm_company_domain`. Many sources send no domain, and leaving it `null`
 * would make every same-titled, same-city role at *any* domain-less employer hash
 * identically — Acme and Globex both "Senior Engineer / Remote / Berlin" would become one
 * row. So the hash uses the domain when there is one and the company **name** slug
 * otherwise. It is deliberately never the provider name: `docs/02b` §6.1 records that
 * Ashby and Lever send no company field, and falling back to `cfg.name` would attribute
 * every posting to the provider and collapse the whole feed into one company.
 *
 * ## Why trigram similarity is computed here rather than in SQL
 *
 * `pg_trgm` is enabled and both GIN trigram indexes exist (`0001_init.sql:275-276`), but
 * PostgREST cannot call `similarity()` without an RPC function in the exposed schema, and
 * adding one is a migration — an ask-first decision, not a detail. So this module
 * reimplements pg_trgm's Dice coefficient over trigram multisets in TypeScript and
 * narrows candidates with an indexed `company_domain` equality first.
 *
 * The reimplementation is faithful to the default `pg_trgm` settings (no `KEEPONLYALNUM`,
 * two spaces of padding, multiset intersection, Dice denominator), and it is what makes
 * the >0.85 threshold testable without a database. The trade-off is stated plainly: the
 * GIN trigram indexes are **not** used by this pass, because the similarity is evaluated
 * in the client. If the candidate set per company grows large enough to matter, the fix is
 * one SQL function — see the open item in `docs/05b-phase1.md` ING-007.
 */

import { createHash } from "node:crypto";

import type { CanonicalJob } from "@/types/canonical-job";

import { companyDomainToSlug, companyNameToSlug } from "@/lib/utils/company-slug";

/** `docs/02b` §6.2. The `|` separator cannot occur in a normalised token. */
const FIELD_SEPARATOR = "|";

/** `docs/02b` §6.2: `similarity(title_norm, $t) > 0.85`. */
export const FUZZY_THRESHOLD = 0.85;

/** The four fields §6.2 hashes, normalised. Exported so tests can assert each in isolation. */
export interface DedupeHashParts {
  readonly title: string;
  readonly company: string;
  readonly city: string;
  readonly workMode: string;
}

// ---------------------------------------------------------------------------
// Pass 1 — exact
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace and strip punctuation from a hash component.
 *
 * Punctuation is removed rather than replaced with a separator, so `"Senior Engineer
 * (Remote)"` and `"Senior Engineer - Remote"` normalise to the same token run. That is the
 * intent: the hash answers "the same posting", not "the same string".
 */
function normaliseToken(value: string | null | undefined): string {
  // A null component normalises to the empty string rather than throwing or becoming
  // "null": an absent city is a real state for a remote posting, and it must still hash.
  if (!value) return "";

  return value
    .normalize("NFKD")
    // Strip combining marks, so "Café" -> "cafe" rather than "caf". Written as an escape
    // range, not literal characters: the literals are invisible in a diff and are mangled by
    // any editor that does not preserve combining forms.
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Build the four normalised components of the dedupe hash.
 *
 * `company` prefers the domain and falls back to the name — see the module docstring for
 * why that fallback is load-bearing rather than cosmetic.
 */
export function normaliseForHash(
  job: Pick<CanonicalJob, "title" | "companyName" | "companyDomain" | "location" | "workMode">,
): DedupeHashParts {
  const domain = companyDomainToSlug(job.companyDomain);
  // `companyNameToSlug` is called with `stripLegalSuffix: true` — the one caller the helper's
  // docstring reserves this for. "Acme Inc" and "Acme Ltd" are the same employer posting the
  // same role, and §6.2 requires legal suffixes stripped.
  const company = domain ?? companyNameToSlug(job.companyName, { stripLegalSuffix: true });

  return {
    title: normaliseToken(job.title),
    company: normaliseToken(company),
    city: normaliseToken(job.location.city),
    workMode: job.workMode,
  };
}

/**
 * `sha256(norm_title | norm_company_domain | norm_city | work_mode)`.
 *
 * SHA-256 rather than a readable composite key because the value is an index key that is
 * never displayed, and a human-readable one invites someone to parse it.
 */
export function computeDedupeHash(
  job: Pick<CanonicalJob, "title" | "companyName" | "companyDomain" | "location" | "workMode">,
): string {
  const parts = normaliseForHash(job);
  const composite = [
    parts.title,
    parts.company,
    parts.city,
    parts.workMode,
  ].join(FIELD_SEPARATOR);

  return createHash("sha256").update(composite, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pass 2 — fuzzy (trigram)
// ---------------------------------------------------------------------------

/**
 * Trigram multiset of a string, matching `pg_trgm`'s defaults.
 *
 * The string is lower-cased and padded with two spaces at each end, then every three
 * character window is taken. Padding is what makes short strings comparable: `"ab"` yields
 * `"  a"`, `" ab"`, `"ab "`, `"b  "` — four trigrams — so it is not a special case that
 * collapses to nothing.
 */
export function trigrams(value: string): Map<string, number> {
  const padded = `  ${value.toLowerCase()}  `;
  const counts = new Map<string, number>();

  for (let i = 0; i + 3 <= padded.length; i += 1) {
    const gram = padded.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  return counts;
}

/**
 * pg_trgm's `similarity()`: the Dice coefficient over trigram multisets.
 *
 * `shared / (|A| + |B| - |shared|)`, where `shared` is the multiset intersection — so a
 * trigram repeated three times in A and once in B contributes one, not three. Counting
 * occurrences instead would score `"aaaa"` against `"aa"` above a real match.
 *
 * Two empty strings are 1 (they are trivially identical); one empty string is 0.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const [gram, count] of left) {
    const other = right.get(gram);
    if (other !== undefined) shared += Math.min(count, other);
  }

  if (shared === 0) return 0;

  const total = [...left.values()].reduce((sum, count) => sum + count, 0);
  const totalRight = [...right.values()].reduce((sum, count) => sum + count, 0);

  return shared / (total + totalRight - shared);
}

/** The subset of an existing `jobs` row the fuzzy pass needs to decide a merge. */
export interface FuzzyCandidate {
  readonly id: string;
  readonly titleNorm: string | null;
  readonly descriptionText: string | null;
  readonly sightingCount: number;
  readonly sourceUrl: string;
}

/**
 * Pick the row a new job should merge into, or `null` for a genuinely new one.
 *
 * Candidates must already be narrowed to one `company_domain` — the caller does that with an
 * equality filter, which is the only part of this pass an index can serve.
 *
 * Best match wins rather than first match, so the most similar existing row absorbs the
 * newcomer. A tie on similarity goes to the row with more sightings, which is the one
 * other sources are already pointing at.
 */
export function findFuzzyMatch(
  titleNorm: string,
  candidates: readonly FuzzyCandidate[],
  threshold: number = FUZZY_THRESHOLD,
): FuzzyCandidate | null {
  let best: { candidate: FuzzyCandidate; score: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.titleNorm === null) continue;

    const score = trigramSimilarity(titleNorm, candidate.titleNorm);
    if (score <= threshold) continue;

    if (
      best === null ||
      score > best.score ||
      (score === best.score && candidate.sightingCount > best.candidate.sightingCount)
    ) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? null;
}

/**
 * Which of two rows survives a merge.
 *
 * §6.2: "keep the row with the richer `description_text`". Richer is measured by length —
 * the scraped body versus a one-line summary — with `sighting_count` as the tiebreak so a
 * merge is stable rather than flipping when two descriptions happen to match in length.
 */
export function pickSurvivor(
  incumbent: FuzzyCandidate,
  newcomer: FuzzyCandidate,
): { survivor: FuzzyCandidate; loser: FuzzyCandidate } {
  const incumbentLength = incumbent.descriptionText?.length ?? 0;
  const newcomerLength = newcomer.descriptionText?.length ?? 0;

  const incumbentWins =
    incumbentLength > newcomerLength ||
    (incumbentLength === newcomerLength && incumbent.sightingCount >= newcomer.sightingCount);

  return incumbentWins
    ? { survivor: incumbent, loser: newcomer }
    : { survivor: newcomer, loser: incumbent };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The narrow slice of the Supabase client this module needs.
 *
 * Structural, like `ScoreWriter` in `lib/scoring`, so tests pass a small double and the
 * privilege requirement is visible in the signature. Ingestion is service-role work: it
 * writes the shared corpus, which no single user owns.
 */
export interface JobWriter {
  from(table: "jobs"): {
    upsert(
      values: unknown,
      options: { onConflict: string },
    ): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

export type UpsertOutcome =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

/**
 * Upsert one canonical job on `dedupe_hash`.
 *
 * `onConflict: "dedupe_hash"` is what makes the exact pass an upsert rather than an insert:
 * the unique index rejects the second sighting, and the `do update` branch bumps
 * `last_seen_at` and `sighting_count`. Without it the same posting from three sources is
 * three rows and three feed cards — the failure `docs/02b` §6.2 exists to prevent.
 *
 * Only the sighting bookkeeping is updated on conflict. The payload columns are left alone
 * on purpose: the first sighting is the one whose `source_id` and `raw` payload the rest of
 * the pipeline attributes, and letting a later sighting overwrite them would repoint an
 * already-scored row at a different source.
 */
export async function upsertCanonicalJob(
  writer: JobWriter,
  job: CanonicalJob,
  hash: string,
): Promise<UpsertOutcome> {
  const { error } = await writer.from("jobs").upsert(
    {
      dedupe_hash: hash,
      title: job.title,
      title_norm: job.titleNorm,
      company_name: job.companyName,
      company_domain: job.companyDomain,
      location_raw: job.location.raw,
      city: job.location.city,
      region: job.location.region,
      country_code: job.location.countryCode,
      work_mode: job.workMode,
      employment_type: job.employmentType,
      seniority: job.seniority,
      salary_min: job.salary?.min ?? null,
      salary_max: job.salary?.max ?? null,
      salary_currency: job.salary?.currency ?? null,
      salary_period: job.salary?.period ?? null,
      salary_raw: job.salary?.raw ?? null,
      description_text: job.descriptionText,
      description_html: job.descriptionHtml,
      skills: job.skills,
      posted_at: job.postedAt,
      source_url: job.sourceUrl,
      apply_url: job.applyUrl,
      status: job.status,
      confidence: job.confidence,
      raw: job.raw,
    },
    { onConflict: "dedupe_hash" },
  );

  if (error) {
    return { ok: false, error: { code: "dedupe_upsert_failed", message: error.message } };
  }
  return { ok: true };
}
