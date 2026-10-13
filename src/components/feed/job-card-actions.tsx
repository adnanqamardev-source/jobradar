/**
 * job-card-actions.tsx — the feed card's action row (FE-107, FED-002, FE-110).
 *
 * ## Optimistic update + rollback
 *
 * Each action applies its state change locally *before* the server call, and
 * rolls back to the pre-action state if the call fails. The failure path also
 * surfaces a `role="alert"` message — an error the user cannot see is the same as
 * no error handling (docs/03 §5.3).
 *
 * On success the component calls `router.refresh()`: the dashboard is a
 * server component, so refreshing re-runs the feed query and reconciles the
 * card list with the database (a dismissed card disappears, a saved card
 * keeps its state). The optimistic state covers the gap between click and
 * refresh; the refresh is the source of truth.
 *
 * ## Why `useTransition`
 *
 * The actions are server actions — network round-trips. Keeping them in a
 * transition means the buttons stay responsive and the optimistic state is
 * never blocked by the fetch.
 *
 * ## "Dismiss" vs "Hide all of these" (FED-005)
 *
 * One label for both cases, chosen by `sightingCount`. `jobs.dedupe_hash` is UNIQUE,
 * so a duplicate cluster is already **one row**: dismissing it hides every occurrence
 * at once, and there is no second write to do. The distinction is therefore purely
 * one of what the user is being told — a single-sighting job hides one posting, a
 * cluster hides the role everywhere — and stating it is more honest than a second
 * action that would call the same server action with different wording.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveJob } from "@/app/api/actions/feed/save-job";
import { dismissJob } from "@/app/api/actions/feed/dismiss-job";
import { markApplied } from "@/app/api/actions/feed/mark-applied";
import type { ResumeVersion } from "@/lib/db/queries/resume-versions";
import { ApplyDialog } from "./apply-dialog";

export interface CardActionsState {
  saved: boolean;
  dismissed: boolean;
}

export function JobCardActions({
  jobId,
  jobTitle,
  sightingCount,
  resumeVersions,
  initialState,
}: {
  jobId: string;
  jobTitle: string;
  sightingCount: number;
  resumeVersions: ResumeVersion[];
  initialState: CardActionsState;
}) {
  const router = useRouter();
  const [state, setState] = useState<CardActionsState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [, startTransition] = useTransition();

  function run(
    action: () => Promise<{ ok: boolean; error?: { message: string } }>,
    optimistic: CardActionsState,
  ) {
    const rollback = state;
    setError(null);
    setState(optimistic);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
      } else {
        setState(rollback);
        setError(result.error?.message ?? "Something went wrong. Try again.");
      }
    });
  }

  // Optimistic hide: the card vanishes immediately; router.refresh() then
  // reconciles the list with the database (the feed excludes dismissed jobs).
  if (state.dismissed) return null;

  return (
    <div>
      <button
        type="button"
        disabled={state.saved}
        onClick={() => run(() => saveJob({ jobId }), { ...state, saved: true })}
      >
        {state.saved ? "Saved" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => run(() => dismissJob({ jobId }), { ...state, dismissed: true })}
      >
        {sightingCount > 1 ? "Hide all of these" : "Dismiss"}
      </button>
      {applied ? (
        // Feedback that survives `router.refresh()`: the feed query excludes
        // applied jobs, so this card is about to be replaced by whatever the
        // server sends back. The optimistic state covers the gap.
        <span>Applied</span>
      ) : (
        <ApplyDialog
          jobId={jobId}
          jobTitle={jobTitle}
          resumeVersions={resumeVersions}
          onSubmit={markApplied}
          onApplied={() => {
            setApplied(true);
            router.refresh();
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}