/**
 * tracker.tsx — the tracker board and its drawer (FE-111, FE-112).
 *
 * ## Structure, not styling (Phase 2 rule, docs/06 §8.4)
 *
 * Columns are a `<ul>` of `<li>`; each card is an `<article>` with a real heading; the stage
 * control is a native `<select>` with a real `<label>`. No utility classes — the desktop
 * multi-column layout, the mobile stacking rule (docs/04 §4.3) and the `stage-badge` styling are
 * Phase 3.
 *
 * ## Why a `<select>` and not drag-and-drop
 *
 * TRK-003 says "drag-and-drop / keyboard-accessible" and requires "an equal keyboard path". A
 * drag library would be a new dependency (AGENTS.md: ask first) *and* would need a custom keyboard
 * alternative built on top, because HTML5 drag events carry no keyboard affordance at all. A
 * native `<select>` is keyboard operable, screen-reader labelled and touch native for free, and it
 * is the same control on every stage. Drag-and-drop can be layered on in Phase 3 as an
 * *additional* path without changing what the board means — provided the semantics live here
 * rather than in a drag handler.
 *
 * Only legal moves are offered, from `legalMoves()`. The database rejects the rest; a dropdown
 * listing them would be a control that reliably errors.
 *
 * ## No optimistic update, by choice
 *
 * A move writes to the server first, and only then updates the local `stages` map. So there is no
 * speculative copy to reconcile: if the write is rejected, the map was never touched and the card is
 * simply still where it was, which is exactly the truth. The alternative — flip the column
 * immediately, then undo it on failure — buys a faster-looking UI at the cost of a state that can
 * be briefly wrong, and a move is one round trip, not something to optimise. On success the local
 * update lands first and `router.refresh()` reconciles against the server.
 *
 * ## The move is announced
 *
 * `aria-live="polite"` on the status region, because a card silently changing column is invisible
 * to a screen-reader user. TRK-002 requires an announcement on move.
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { moveApplicationStage } from "@/app/api/actions/feed/move-stage";
import {
  BOARD_STAGES,
  STAGE_LABELS,
  legalMoves,
  type ApplicationStage,
} from "@/lib/tracker/stages";
import type { TrackerCard, TrackerEvent } from "@/lib/db/queries/applications";

export interface TrackerBoardProps {
  cards: TrackerCard[];
  /** History per application, so the drawer needs no fetch of its own. */
  events: Record<string, TrackerEvent[]>;
}

/** A card's live stage, held locally so a rejected move cannot leave it in the wrong column. */
function useStageMap(initial: TrackerCard[]) {
  const [stages, setStages] = useState<Record<string, ApplicationStage>>(() =>
    Object.fromEntries(initial.map((card) => [card.applicationId, card.stage])),
  );
  return { stages, setStages };
}

export function TrackerBoard({ cards, events }: TrackerBoardProps) {
  const { stages, setStages } = useStageMap(cards);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function move(card: TrackerCard, toStage: ApplicationStage) {
    const from = stages[card.applicationId] ?? card.stage;
    if (from === toStage) return;

    setError(null);
    startTransition(async () => {
      // The action is a network call that can reject (server 500, dropped connection, a dev
      // server that gives up under load). Without this catch, a rejection never reaches `result`,
      // so nothing was set: no optimistic copy to roll back, no error message, and the card sat
      // in its original column looking like the click did nothing. Found by tests/e2e running
      // parallel against `next dev`, where two of eight stage moves failed this way.
      let result: Awaited<ReturnType<typeof moveApplicationStage>>;
      try {
        result = await moveApplicationStage({
          applicationId: card.applicationId,
          toStage,
          note: null,
        });
      } catch {
        setError("We could not reach the server. Your application stayed where it was.");
        return;
      }

      if (!result.ok) {
        // No optimistic update was applied, so there is nothing to roll back — the card is still
        // in its original column. Saying so is the rollback.
        setError(result.error?.message ?? "We could not move that application.");
        return;
      }

      setStages((current) => ({ ...current, [card.applicationId]: toStage }));
      setStatus(`${card.title} moved to ${STAGE_LABELS[toStage]}`);
      router.refresh();
    });
  }

  const open = openId === null ? null : cards.find((card) => card.applicationId === openId) ?? null;

  return (
    <div>
      <h1>Applications</h1>

      {/* Announced after a move; empty otherwise so it does not read on every render. */}
      <p role="status" aria-live="polite">
        {status ?? ""}
      </p>

      {/* Named, because `next dev` injects its own `role="alert"` element for the dev-tools overlay.
          A bare `getByRole("alert")` therefore matches two things, and the test ends up
          asserting against the framework's badge rather than this message. */}
      {error !== null && (
        <p role="alert" aria-label="Stage move error">
          {error} Your application stayed where it was.
        </p>
      )}

      <div>
        {BOARD_STAGES.map((stage) => {
          const inStage = cards.filter((card) => (stages[card.applicationId] ?? card.stage) === stage);

          return (
            <section key={stage} aria-labelledby={`stage-${stage}`}>
              <h2 id={`stage-${stage}`}>
                {STAGE_LABELS[stage]} ({inStage.length})
              </h2>

              {/*
                A `<ul>` because the cards are a list; TRK-003 requires an empty column to show a
                muted placeholder rather than a blank gap, and an empty `<ul>` renders as nothing
                at all — so the placeholder is explicit.
              */}
              <ul aria-label={`${STAGE_LABELS[stage]} applications`}>
                {inStage.length === 0 && <li>Nothing in {STAGE_LABELS[stage]} yet.</li>}

                {inStage.map((card) => (
                  <li key={card.applicationId}>
                    <article aria-labelledby={`card-${card.applicationId}`}>
                      <h3 id={`card-${card.applicationId}`}>{card.title}</h3>

                      <p>{card.company ?? "Company unknown"}</p>
                      {card.salary !== null && <p>{card.salary}</p>}

                      {/* The live job deep-links; a missing one falls back to the snapshot.

                          Unreachable today: `applications.job_id` is `on delete cascade`, so a
                          hard-deleted job takes the application row with it and this embed can
                          never be null. Kept because TRK-004 requires the behaviour and the FK
                          will need relaxing to `set null` for `job_snapshot` to mean anything —
                          but it is NOT covered by a test today, because no test can reach it.
                          `tests/e2e/tracker.spec.ts` asserts the cascade that makes it
                          unreachable, so the conflict is recorded rather than hidden. */}
                      {card.jobLive ? (
                        <Link href={`/jobs/${card.jobId}`}>View the job</Link>
                      ) : (
                        <p>This job is no longer available. Details kept from when you applied.</p>
                      )}

                      <button
                        type="button"
                        onClick={() => setOpenId(card.applicationId)}
                        aria-expanded={openId === card.applicationId}
                        aria-controls={`detail-${card.applicationId}`}
                      >
                        Details for {card.title}
                      </button>

                      <StageControl
                        card={card}
                        currentStage={stages[card.applicationId] ?? card.stage}
                        busy={isPending}
                        onMove={(toStage) => move(card, toStage)}
                      />
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {open !== null && (
        <ApplicationDrawer
          card={open}
          stage={stages[open.applicationId] ?? open.stage}
          events={events[open.applicationId] ?? []}
          busy={isPending}
          onMove={(toStage) => move(open, toStage)}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function StageControl({
  card,
  currentStage,
  busy,
  onMove,
}: {
  card: TrackerCard;
  currentStage: ApplicationStage;
  busy: boolean;
  onMove: (toStage: ApplicationStage) => void;
}) {
  const options = legalMoves(currentStage);

  // A terminal stage has no legal moves, so no control is rendered at all — an empty `<select>`
  // would be a focusable dead end.
  if (options.length === 0) {
    return <p>This application is closed. Its stage cannot change.</p>;
  }

  return (
    <div>
      <label htmlFor={`move-${card.applicationId}`}>
        Move {card.title} to stage
      </label>
      <select
        id={`move-${card.applicationId}`}
        name="toStage"
        value={currentStage}
        disabled={busy}
        onChange={(event) => onMove(event.target.value as ApplicationStage)}
      >
        {/* The current stage is shown but not selectable: `move_application` rejects a same-stage
            move with "Already in target stage", so offering it would be a guaranteed error. */}
        <option value={currentStage}>{STAGE_LABELS[currentStage]} (current)</option>
        {options.map((stage) => (
          <option key={stage} value={stage}>
            {STAGE_LABELS[stage]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The detail drawer (FE-112).
 *
 * TRK-002 wants the timeline newest-first; TRK-004 wants notes and `next_action_at` editable
 * inline. The notes editor is **not** in this slice — it needs its own autosave action, and a
 * half-built autosave that silently loses keystrokes is worse than none. Stated as remaining
 * rather than stubbed.
 */
function ApplicationDrawer({
  card,
  stage,
  events,
  busy,
  onMove,
  onClose,
}: {
  card: TrackerCard;
  stage: ApplicationStage;
  events: TrackerEvent[];
  busy: boolean;
  onMove: (toStage: ApplicationStage) => void;
  onClose: () => void;
}) {
  return (
    <aside id={`detail-${card.applicationId}`} aria-label={`Details for ${card.title}`}>
      <h2>{card.title}</h2>

      <button type="button" onClick={onClose} autoFocus>
        Close details
      </button>

      <dl>
        <dt>Company</dt>
        <dd>{card.company ?? "Unknown"}</dd>
        <dt>Stage</dt>
        <dd>{STAGE_LABELS[stage]}</dd>
        {card.appliedAt !== null && (
          <>
            <dt>Applied</dt>
            <dd>{card.appliedAt}</dd>
          </>
        )}
        {card.nextActionAt !== null && (
          <>
            <dt>Next action</dt>
            <dd>{card.nextActionAt}</dd>
          </>
        )}
      </dl>

      <StageControl card={card} currentStage={stage} busy={busy} onMove={onMove} />

      <section aria-labelledby={`history-${card.applicationId}`}>
        <h3 id={`history-${card.applicationId}`}>Stage history</h3>
        {events.length === 0 && <p>No history recorded yet.</p>}

        <ol>
          {events.map((event) => (
            <li key={event.id}>
              {/* `from_stage` is null on the first event — TRK-001's initial row. Saying
                  "Created" rather than rendering an empty cell keeps the timeline readable. */}
              {event.fromStage === null
                ? `Created as ${STAGE_LABELS[event.toStage]}`
                : `${STAGE_LABELS[event.fromStage]} → ${STAGE_LABELS[event.toStage]}`}
              <span> — {event.occurredAt}</span>
              {event.note !== null && <p>{event.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}