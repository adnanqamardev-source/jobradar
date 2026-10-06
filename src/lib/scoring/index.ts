/**
 * index.ts — score composition and persistence (SCR-004, BE-204).
 *
 * docs/02b §6.3: `final = 0.5·rule + 0.5·semantic`, written to `job_scores` with
 * `breakdown`, `model_version` and `scored_at`.
 *
 * ## The module is split in two on purpose
 *
 * - {@link composeScore} is **pure**: profile + job + skill rows in, one score object
 *   out. Fully unit-testable, and re-runnable for any user/job pair without a database.
 * - {@link persistScore} is the **only** function here that touches Supabase, and it
 *   takes a client by injection.
 *
 * The split is what makes SCR-004's re-scoring obligation testable: "re-scoring upserts
 * rather than duplicating" is a property of the write, and "coverage ≥98%" is a property
 * of composition over a set of pairs.
 *
 * ## Service role, deliberately
 *
 * `job_scores` has a **SELECT-only** RLS policy (`job_scores_owner_select`,
 * `0001_init.sql:652`). There is no INSERT or UPDATE policy for a user, so a
 * user-scoped client *cannot* write a score — and that is the right shape: scoring reads
 * one user's whole profile and writes on their behalf, which is worker territory.
 * {@link persistScore} therefore requires an explicitly-passed client rather than
 * constructing one, so the caller is visibly choosing the privilege.
 */

import { SEMANTIC_BLEND, RULE_MODEL_VERSION } from "@/lib/scoring/weights";
import { evaluateGates, type GateJob, type GateProfile, type GateReason } from "@/lib/scoring/gates";
import {
  scoreRule,
  type BreakdownEntry,
  type JobSkillInput,
  type ProfileSkillInput,
  type RuleJob,
  type RuleProfile,
} from "@/lib/scoring/rules";

/** The minimum of `job_scores` this module reads or writes. */
export interface ScoreRow {
  final_score: number;
  rule_score: number | null;
  semantic_score: number | null;
  gate_result: GateResultJson | null;
  breakdown: BreakdownEntry[];
  model_version: string | null;
  scored_at: string;
}

/** docs/02a §5.5: `{ "passed": false, "reasons": ["salary_below_floor"] }`. */
export interface GateResultJson {
  passed: boolean;
  reasons: GateReason[];
}

export interface ComposeScoreInput {
  profileId: string;
  jobId: string;
  job: RuleJob & GateJob;
  profile: RuleProfile & GateProfile;
  jobSkills: JobSkillInput[];
  profileSkills: ProfileSkillInput[];
  /**
   * Cosine-derived 0–100 score, or `null` when the job has no embedding or the
   * embedding call failed. `null` is a supported state, not an error — see
   * {@link composeScore}.
   */
  semanticScore: number | null;
  now: Date;
}

export interface ComposedScore {
  profileId: string;
  jobId: string;
  finalScore: number;
  ruleScore: number;
  semanticScore: number | null;
  gateResult: GateResultJson;
  breakdown: BreakdownEntry[];
  modelVersion: string;
  scoredAt: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Clamp a 0–100 score.
 *
 * Distinct from `clamp01` on purpose, and the distinction is load-bearing: an earlier
 * revision used `clamp01` here, which clamps to 0–1. Every blended score therefore came
 * out as exactly `1`, and every `semanticScore` outside 0–100 was clamped to `1` as
 * though it were a fraction. The function name read identically at the call site, which
 * is why it survived a green test suite — the tests asserted against the same wrong
 * scale.
 */
const clamp100 = (n: number): number => Math.min(100, Math.max(0, n));

/**
 * Compose one score. Pure and deterministic.
 *
 * ## Gated jobs still get a row
 *
 * A job that fails a gate is written with `final_score = 0` and a populated
 * `gate_result`, rather than skipped. The row is the only record of *why* a job is
 * absent from a user's feed; skipping the write would make an exclusion invisible and
 * unanswerable when the user asks. docs/02b §6.3 says "HIDE from feed", which is the
 * feed query's job — see `shouldAppearInFeed`.
 *
 * ## What happens without a semantic score
 *
 * `semanticScore: null` — no embedding yet, or the OpenRouter call failed — does **not**
 * yield a score of 0. A 0 would rank every not-yet-embedded job below every embedded
 * one, so a transient upstream failure would silently empty the feed. Instead the
 * remaining weight goes entirely to the rule score:
 *
 *   - with a semantic score: `0.5·rule + 0.5·semantic`
 *   - without:              `rule`
 *
 * docs/04 §5.9 requires that an embedding failure "does not block the feed", and a
 * degraded blend is how that is honoured rather than merely survived.
 */
export function composeScore(input: ComposeScoreInput): ComposedScore {
  const gate = evaluateGates(input.job, input.profile);

  if (!gate.passed) {
    // Still run the rule score. It is not shown, but writing it means a later
    // "why was this gated?" investigation has the evidence rather than a bare zero.
    const rule = scoreRule({
      job: input.job,
      profile: input.profile,
      jobSkills: input.jobSkills,
      profileSkills: input.profileSkills,
      now: input.now,
    });

    return {
      profileId: input.profileId,
      jobId: input.jobId,
      finalScore: 0,
      ruleScore: rule.score,
      semanticScore: input.semanticScore,
      gateResult: { passed: false, reasons: gate.reasons },
      breakdown: rule.breakdown,
      modelVersion: RULE_MODEL_VERSION,
      scoredAt: input.now.toISOString(),
    };
  }

  const rule = scoreRule({
    job: input.job,
    profile: input.profile,
    jobSkills: input.jobSkills,
    profileSkills: input.profileSkills,
    now: input.now,
  });

  const semantic = input.semanticScore;
  const final =
    semantic === null
      ? rule.score
      : rule.score * (1 - SEMANTIC_BLEND) + clamp100(semantic) * SEMANTIC_BLEND;

  return {
    profileId: input.profileId,
    jobId: input.jobId,
    finalScore: round2(clamp100(final)),
    ruleScore: rule.score,
    semanticScore: semantic,
    gateResult: { passed: true, reasons: [] },
    breakdown: rule.breakdown,
    modelVersion: RULE_MODEL_VERSION,
    scoredAt: input.now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The narrow slice of the Supabase client this module needs.
 *
 * Declared structurally rather than importing the concrete client type so tests can
 * pass a small double, and so the privilege requirement is visible in the signature.
 */
export interface ScoreWriter {
  from(table: "job_scores"): {
    upsert(
      values: unknown,
      options: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
  };
}

export type PersistResult =
  | { ok: true; score: ComposedScore }
  | { ok: false; error: { code: string; message: string } };

/**
 * Upsert one score.
 *
 * ## Why `upsert` and not insert
 *
 * `job_scores` has `unique (user_id, job_id)` (`0001_init.sql:310`), and SCR-004
 * requires re-scoring to **upsert rather than duplicate**. Every profile edit enqueues a
 * rescore (ONB-006), so the same pair is written many times over a user's lifetime; a
 * plain insert would either fail on the constraint or accumulate duplicates, and
 * SCR-005 additionally forbids unbounded growth of `job_scores`.
 *
 * The upsert updates the score columns but deliberately **not** `explanation`: the LLM
 * rationale is Pro-only and separately metered, and a rule rescore must not silently
 * discard a rationale that is still valid. Overwriting it with `null` on every profile
 * edit would be data loss dressed as a write.
 *
 * The client must be service-role (or otherwise RLS-exempt). `job_scores` has no INSERT
 * policy for users, so a user-scoped client fails here by design rather than silently
 * widening its own access.
 */
export async function persistScore(
  writer: ScoreWriter,
  score: ComposedScore,
): Promise<PersistResult> {
  const { error } = await writer.from("job_scores").upsert(
    {
      user_id: score.profileId,
      job_id: score.jobId,
      final_score: score.finalScore,
      rule_score: score.ruleScore,
      semantic_score: score.semanticScore,
      gate_result: score.gateResult,
      breakdown: score.breakdown,
      model_version: score.modelVersion,
      scored_at: score.scoredAt,
      // `explanation` is intentionally absent — see the docstring.
    },
    { onConflict: "user_id,job_id" },
  );

  if (error) {
    return {
      ok: false,
      error: { code: "DATABASE_ERROR", message: "Failed to persist job score" },
    };
  }

  return { ok: true, score };
}

// ---------------------------------------------------------------------------
// Coverage (SCR-004: "≥98% of active jobs have a score for an active profile")
// ---------------------------------------------------------------------------

/**
 * Fraction of the supplied pairs that produced a score row.
 *
 * `total` is the number of pairs the caller *attempted*, and `scored` how many carry a
 * score. Computing coverage here rather than in SQL keeps the definition in one place and
 * makes it testable without a database — the same reason composition is pure.
 */
export function coverage(scored: number, total: number): number {
  if (total <= 0) return 1;
  return round2(scored / total);
}