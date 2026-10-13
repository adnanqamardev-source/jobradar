/**
 * job-card-actions.tsx — the feed card's action row (FE-107, FED-002).
 *
 * ## Optimistic update + rollback
 *
 * Each action applies its state change locally *before* the server call, and
 * rolls back to the pre-action state if the call fails. The failure path also
 * surfaces a `role="alert"` toast — an error the user cannot see is the same as
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
 * ## Mark Applied
 *
 * The third action opens the apply modal (FE-110), which does not exist yet.
 * The button is rendered disabled with its reason, rather than omitted — the
 * card's anatomy is fixed by docs/04 §3.3, and a missing button reads as a
 * layout bug rather than a pending feature.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveJob } from "@/app/api/actions/feed/save-job";
import { dismissJob } from "@/app/api/actions/feed/dismiss-job";

export interface CardActionsState {
  saved: boolean;
  dismissed: boolean;
}

export function JobCardActions({
  jobId,
  initialState,
}: {
  jobId: string;
  initialState: CardActionsState;
}) {
  const router = useRouter();
  const [state, setState] = useState<CardActionsState>(initialState);
  const [error, setError] = useState<string | null>(null);
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
        Dismiss
      </button>
      {/*
        FE-110: the apply modal. Disabled until it exists — see the header
        comment. `aria-describedby` would point at the reason once the modal
        lands.
      */}
      <button type="button" disabled title="Coming with the apply form">
        Mark applied
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
