/**
 * original-source.tsx — "View original" plus the alternate sightings (JOB-004, FED-005, JOB-001).
 *
 * ## Why these are one component and not two
 *
 * JOB-004's third done-when is "selecting an alternate updates which URL 'View original' uses".
 * That makes the two controls stateful *together*, so one client component owns the selection
 * and renders both. Splitting them means either two components disagreeing about which
 * posting is current, or lifting the state into the server-rendered page and making the whole
 * page a client component to do it. The narrow client boundary is the better trade.
 *
 * ## Why this is the last piece of FED-005
 *
 * `jobs.dedupe_hash` is UNIQUE, so a "duplicate cluster" is one `jobs` row and the feed card
 * could only say "seen on N sources" from an integer. Migration `0012_job_sightings.sql` added
 * the per-source record; this is where it becomes visible, and it is the done-when FED-005
 * could not satisfy before: "lists sources in the detail view".
 *
 * ## Every sighting is listed, including the primary
 *
 * Showing N-1 alternates next to a button that goes somewhere else is the confusing
 * arrangement: the reader cannot tell which row the main link points at. Listing all of them
 * and marking the current one answers that directly.
 *
 * `noopener noreferrer` on every external link — these are third-party pages, so the opened
 * window must not get a handle to ours (JOB-001's second done-when).
 */

"use client";

import { useId, useState } from "react";

import type { JobSighting } from "@/lib/db/queries/sightings";

/** Host shown as the source name. `job_sightings` stores no brand, so this is all we can say. */
function sourceLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A malformed URL in the corpus is a data problem, not a reason to fail the page.
    return "unknown source";
  }
}

export interface OriginalSourceProps {
  /** The job's own `source_url` — the default "View original" target. */
  primaryUrl: string;
  /** Null when the job has no `apply_url`, in which case no Apply button is offered. */
  applyUrl: string | null;
  sightings: JobSighting[];
}

export function OriginalSource({ primaryUrl, applyUrl, sightings }: OriginalSourceProps) {
  const [selected, setSelected] = useState(primaryUrl);
  const listHeadingId = useId();

  return (
    <div>
      <p>
        <a href={selected} rel="noopener noreferrer" target="_blank">
          View original
        </a>
        {applyUrl != null && applyUrl !== "" && (
          <>
            {" · "}
            {/*
              A user-supplied `apply_url` goes to the same third-party origin as the posting, so
              it carries the same rel. It is also rendered only when present: an Apply link that
              goes nowhere is worse than no Apply link.
            */}
            <a href={applyUrl} rel="noopener noreferrer" target="_blank">
              Apply
            </a>
          </>
        )}
      </p>

      {sightings.length === 0 ? (
        // Pre-0012 rows, or a job whose sightings were deleted. A normal state, not an error:
        // the page still works, it just cannot say where else this role was seen.
        <p>No other sources have recorded this role.</p>
      ) : (
        <section aria-labelledby={listHeadingId}>
          <h2 id={listHeadingId}>Where this role was seen</h2>
          <ul>
            {sightings.map((sighting) => {
              const isCurrent = sighting.source_url === selected;
              return (
                <li key={sighting.source_url}>
                  {isCurrent ? (
                    <span aria-current="true">{sourceLabel(sighting.source_url)}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSelected(sighting.source_url)}
                    >
                      {sourceLabel(sighting.source_url)}
                    </button>
                  )}
                  {isCurrent && <span> — view original</span>}
                  {sighting.sighting_count > 1 && (
                    <span> — seen {sighting.sighting_count} times</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
