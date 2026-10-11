/**
 * score-meter.tsx — the match-score meter (docs/04 §3.4, FED-001 card element).
 *
 * ## Accessibility contract (pinned now, not in Phase 3)
 *
 * `role="progressbar"` with `aria-valuenow/min/max` and a text label that
 * carries the number *and* the band name — score is never communicated by
 * colour alone (docs/03 §6.1 X-23). The numeric value is always present.
 *
 * The band boundaries live in `lib/utils/score-band.ts` so they are importable
 * from tests and the detail page without pulling in JSX.
 */

import { scoreBand } from "@/lib/utils/score-band";

export { scoreBand };

export function ScoreMeter({ score }: { score: number }) {
  const { label } = scoreBand(score);
  const clamped = Math.min(100, Math.max(0, score));

  return (
    <div
      role="progressbar"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Match score ${score} out of 100, ${label}`}
    >
      {/*
        The width is structure — a meter that does not show proportion is not
        a meter — not a design decision. Phase 3 owns track/fill styling.
      */}
      <div aria-hidden="true">
        <div style={{ width: `${clamped}%` }} />
      </div>
      <span>{score}</span>
      <span>{label}</span>
    </div>
  );
}
