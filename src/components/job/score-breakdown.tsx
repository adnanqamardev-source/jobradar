/**
 * score-breakdown.tsx — the expandable score disclosure (FE-109, JOB-002, C3).
 *
 * docs/04 §3.4 specifies one row per component — name, points, mini bar — inside a
 * `disclosure` on the detail page, with the semantic blend shown **separately** because it is
 * not one of the six weighted components: `SEMANTIC_BLEND` is 0.5, so the semantic score is
 * averaged with the rule score rather than being one more line item.
 *
 * ## Structure, not styling
 *
 * `aria-expanded` + `aria-controls` and a real `<button>` are Phase 2 work (docs/06 §8.4): a
 * disclosure that cannot be operated by keyboard or announced by a screen reader is broken,
 * not unstyled. The reveal animation, bar colours and typography are Phase 3.
 *
 * A native `<details>`/`<summary>` would have needed no client component, but it cannot fire
 * `score_breakdown_opened`, cannot be controlled from the tracker, and gives Phase 3 nothing
 * to restyle beyond the marker.
 *
 * ## Why the client at all
 *
 * Only for the open state. The breakdown arrives fully computed from the server component —
 * no second fetch, no waterfalled render.
 */

"use client";

import { useId, useState } from "react";

import { SEMANTIC_BLEND } from "@/lib/scoring/weights";
import { explainGateReasons } from "@/lib/scoring/gates";

/**
 * `breakdown[].key` -> the label docs/04 §3.4 prints. The weights module documents that the
 * front end owns this map ("the front end maps key -> label, so a key change is a rendering
 * change"), so it lives here rather than in scoring.
 */
const COMPONENT_LABELS: Record<string, string> = {
  skills: "Skills",
  seniority: "Seniority",
  compensation: "Compensation",
  "work-mode": "Work mode",
  recency: "Recency",
  "company-preference": "Company pref",
};

interface BreakdownEntry {
  key: string;
  weight: number;
  raw: number;
  points: number;
  known: boolean;
}

export interface ScoreBreakdownProps {
  finalScore: number;
  ruleScore: number | null;
  semanticScore: number | null;
  breakdown: BreakdownEntry[] | null;
  /** `null` when the gate passed; the codes when it did not. */
  gateReasons: readonly string[] | null;
  explanation?: string | null;
}

export function ScoreBreakdown({
  finalScore,
  ruleScore,
  semanticScore,
  breakdown,
  gateReasons,
  explanation,
}: ScoreBreakdownProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonId = useId();

  const gated = gateReasons != null && gateReasons.length > 0;
  const entries = breakdown ?? [];
  const band = Math.round(finalScore);

  return (
    <section aria-labelledby={buttonId}>
      <h2>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          Why this score: {band} out of 100
        </button>
      </h2>

      <div id={panelId} hidden={!open}>
        {/*
          The sum is shown as text, not left to the reader to verify: "sums visibly to
          final_score" is a done-when, and six rows of decimals that silently fail to add up
          is the failure mode this line exists to rule out.
        */}
        <p>
          Total: <strong>{band}</strong> out of 100
          {ruleScore != null && (
            <>
              {" "}
              from rules (<strong>{Math.round(ruleScore)}</strong>)
              {semanticScore != null && (
                <>
                  {" "}
                  and meaning (<strong>{Math.round(semanticScore)}</strong>)
                </>
              )}
            </>
          )}
        </p>

        {/*
          The blend is a line of its own because it is not a component: the final score is
          the rule score and the semantic score averaged at SEMANTIC_BLEND, not a sum of the
          six weighted rows above it. Printing it as a seventh row would double-count it.
        */}
        {semanticScore != null && ruleScore != null && (
          <p>
            Meaning contributes {Math.round(SEMANTIC_BLEND * 100)}% and the rules{" "}
            {Math.round((1 - SEMANTIC_BLEND) * 100)}%.
          </p>
        )}

        {entries.length > 0 ? (
          <table>
            <caption>Points per component</caption>
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">Points</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const label = COMPONENT_LABELS[entry.key] ?? entry.key;
                const percent = entry.weight > 0 ? (entry.points / entry.weight) * 100 : 0;
                return (
                  <tr key={entry.key}>
                    <th scope="row">
                      {label}
                      {/*
                        `known: false` means the component had no data to judge and `raw` is
                        a neutral default. Saying so is the difference between "no skills
                        matched" and "we did not look" — the score is not evidence of either.
                      */}
                      {!entry.known && " (not enough data to judge)"}
                    </th>
                    <td>
                      {entry.points.toFixed(1)} / {entry.weight}
                      {/*
                        Proportion is structure, not decoration: a bar that does not show
                        proportion is not a bar (docs/04 §3.4). The numeric value is already
                        in the cell, so the bar itself is hidden from assistive technology
                        rather than announcing the same number twice.
                      */}
                      <span aria-hidden="true" data-percent={Math.round(percent)}>
                        <span
                          style={{
                            display: "inline-block",
                            width: `${Math.min(100, Math.max(0, percent))}%`,
                          }}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p>No component breakdown was recorded for this job.</p>
        )}

        {explanation && <p>{explanation}</p>}

        {/*
          JOB-002: a gated job has to say why it never appeared in the feed, in plain English.
          The stored codes are a data contract and meaningless to a reader, so they are
          translated; an unrecognised code falls through verbatim rather than rendering blank.
        */}
        {gated && (
          <div>
            <h3>Why this job is not in your feed</h3>
            <ul>
              {explainGateReasons(gateReasons as Parameters<typeof explainGateReasons>[0]).map(
                (reason) => (
                  <li key={reason}>{reason}</li>
                ),
              )}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
