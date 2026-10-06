/**
 * weights.ts — the scoring weights, in code (SCR-002, BE-202).
 *
 * docs/02c §3 rule 5: "Plan limits and scoring weights live in code
 * (`lib/billing/plans.ts`, `lib/scoring/weights.ts`) **behind feature flags** — not in
 * env vars — so they're reviewed and versioned."
 *
 * ## Why these are constants and not config
 *
 * The "flag-overridable" half of SCR-002 is **deferred, deliberately**. This repo has
 * no feature-flag table and no config table, and inventing one would be a schema change
 * to make a tuning value dynamic — a bad trade. SCR-007 exists precisely to deliver the
 * override path, and it stays open until that table is designed and authorised.
 *
 * What that costs is recorded rather than hidden: `RULE_MODEL_VERSION` below is written
 * to `job_scores.model_version`, so a score always states which weight set produced it,
 * and when the weights do change the stored scores become identifiable instead of
 * silently incomparable.
 *
 * ## The weights must sum to 100
 *
 * `assertWeightsSumTo100` runs at module load. A typo that made them sum to 98 would
 * silently rescale every score in the product, and no test would notice unless one
 * happened to assert a total. It is checked here because it is a property of the
 * *set*, not of any single scoring call.
 */

/**
 * One weighted component of the rule score.
 */
export interface WeightEntry {
  /** Stable key — this is what lands in `breakdown[].key` and in the FE label map. */
  key: string;
  /** Points available to this component. */
  weight: number;
}

/**
 * The six rule-score components. docs/02b §6.3: skills 35 · seniority 15 ·
 * compensation 15 · location/work-mode 15 · recency 10 · company preference 10.
 *
 * `key` values match the labels in docs/04 §3.4's breakdown rendering
 * ("Skills", "Seniority", "Compensation", "Work mode", "Recency", "Company pref"),
 * lowercased and hyphenated. The front end maps key → label, so a key change is a
 * rendering change.
 */
export const RULE_WEIGHTS = [
  { key: "skills", weight: 35 },
  { key: "seniority", weight: 15 },
  { key: "compensation", weight: 15 },
  { key: "work-mode", weight: 15 },
  { key: "recency", weight: 10 },
  { key: "company-preference", weight: 10 },
] as const satisfies readonly WeightEntry[];

/** Every component key, in breakdown order. */
export type RuleComponentKey = (typeof RULE_WEIGHTS)[number]["key"];

/** Points a component contributes. */
export function weightFor(key: RuleComponentKey): number {
  const entry = RULE_WEIGHTS.find((w) => w.key === key);
  if (!entry) throw new Error(`Unknown scoring weight: ${key}`);
  return entry.weight;
}

/**
 * The score a component returns when it has no information to offer.
 *
 * docs/03 §6.1 X-09 is the case that forces this: penalising a job for not disclosing
 * its salary buries good jobs, and there is no evidence on which to rank them.
 *
 * This is deliberately **not** a per-component flag. An earlier draft carried
 * `neutralWhenUnknown` on each weight; every entry set it to `true`, so the flag could
 * only ever describe itself. One uniform rule is shorter and cannot be configured into
 * the exact bug it was meant to prevent. The rule the composer applies:
 *
 *   a sub-score reports whether it knows; when it does not, the component scores
 *   `NEUTRAL_RAW` — not 0.
 */
export const NEUTRAL_RAW = 0.5;

/**
 * Throws if the weights do not sum to 100.
 *
 * Exported so a test can assert the invariant explicitly, and called at module load so
 * a bad edit fails immediately rather than at the first score.
 */
export function assertWeightsSumTo100(weights: readonly WeightEntry[] = RULE_WEIGHTS): void {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total !== 100) {
    throw new Error(
      `Rule score weights must sum to 100 (docs/02b §6.3); got ${total} from ` +
        weights.map((w) => `${w.key}=${w.weight}`).join(", "),
    );
  }
}

assertWeightsSumTo100();

/**
 * Bump when the weights, the sub-score formulas, or the neutral defaults change.
 *
 * Written to `job_scores.model_version`. Scores carrying different versions are not
 * directly comparable, so a change here means previously stored scores need a rescore
 * rather than a silent re-label.
 */
export const RULE_MODEL_VERSION = "rule-v1";

/**
 * The `final_score` blend: `0.5 · rule + 0.5 · semantic` (docs/02b §6.3).
 *
 * `SEMANTIC_BLEND` is kept here rather than inline in the composer because SCR-007
 * needs to override exactly this one number, and it is the only blend constant.
 */
export const SEMANTIC_BLEND = 0.5;