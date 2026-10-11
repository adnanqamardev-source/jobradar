/**
 * score-band.ts — the match-score band boundaries (docs/04 §1.3).
 *
 * Pure and framework-free so the feed card, the job detail page and the tests
 * all agree on where "good" ends and "strong" begins. The feed filters out
 * everything below 60 (BE-306), so in practice only strong/good/fair render —
 * but the function covers the full range because the detail page shows gated
 * jobs too (JOB-002).
 */

export type ScoreBand = "strong" | "good" | "fair" | "weak" | "gated";

export interface ScoreBandInfo {
  band: ScoreBand;
  label: string;
}

export function scoreBand(score: number): ScoreBandInfo {
  if (score >= 85) return { band: "strong", label: "Strong match" };
  if (score >= 70) return { band: "good", label: "Good match" };
  if (score >= 55) return { band: "fair", label: "Fair match" };
  if (score > 0) return { band: "weak", label: "Weak match" };
  return { band: "gated", label: "Filtered out" };
}
