/**
 * apply-dialog.tsx — the mark-as-applied dialog (FE-110 / JOB-003, TRK-001).
 *
 * ## Structure only — Phase 2 rule
 *
 * Radix `Dialog` unstyled, no utility classes, no colour. docs/06 §8.4: behaviour (focus
 * trap, escape, `aria-*` wiring) is Phase 2, visuals are Phase 3. Hand-rolling this out of
 * `<div>`s would mean Phase 3 rewrites it rather than restyles it.
 *
 * The fields are exactly docs/05c JOB-003: applied date (default today), follow-up date,
 * résumé version, notes.
 *
 * ## Dates
 *
 * `<input type="date">` gives `yyyy-mm-dd`, which has no timezone; `appliedAt` in the seam is
 * a full ISO datetime. The conversion is **local-midnight → ISO**, not `new Date(string)`:
 * `new Date("2026-10-14")` parses as UTC midnight, so a user in UTC+5 applying on the 14th
 * would record the 15th. The reverse (`isoToDateInput`) is a slice, which is safe because
 * ISO is always UTC-suffixed.
 *
 * The follow-up date is optional and may be in the future — JOB-003 requires accepting one.
 *
 * ## Résumé picker
 *
 * Loaded by the server component that renders the dialog and passed in as props, not fetched
 * from inside the client component: the picker is only visible when the dialog opens, and a
 * query that runs on every card render would be N queries for a feed of N cards. An empty
 * list is a non-blocking empty state, per JOB-003 — the submit button does not require one.
 */

"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useId, useState } from "react";

import type { ResumeVersion } from "@/lib/db/queries/resume-versions";

/** `yyyy-mm-dd` for `<input type="date">`, in the browser's local calendar. */
function isoToDateInput(iso: string): string {
  return iso.slice(0, 10);
}

/** Local midnight on `dateString`, as an ISO instant. */
function dateInputToIso(dateString: string): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toISOString();
}

/** Today in local time — `toISOString().slice(0,10)` would be UTC and can be tomorrow. */
function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * `my-resume-v2.pdf` from `resumes/u1/my-resume-v2.pdf`.
 *
 * The picker shows this rather than the raw storage path: the path is an implementation
 * detail of a private bucket and reads as noise in a dropdown.
 */
function resumeLabel(version: ResumeVersion): string {
  const segments = version.file_path.split("/");
  return segments[segments.length - 1] ?? version.file_path;
}

export interface ApplyDialogProps {
  jobId: string;
  jobTitle: string;
  resumeVersions: ResumeVersion[];
  onSubmit: (input: {
    jobId: string;
    appliedAt: string;
    nextActionAt?: string;
    resumeVersionId?: string;
    notes?: string;
  }) => Promise<{ ok: boolean; error?: { message: string } }>;
  onApplied: () => void;
}

export function ApplyDialog({
  jobId,
  jobTitle,
  resumeVersions,
  onSubmit,
  onApplied,
}: ApplyDialogProps) {
  const [open, setOpen] = useState(false);
  const [appliedOn, setAppliedOn] = useState(localToday);
  const [followUpOn, setFollowUpOn] = useState("");
  const [resumeVersionId, setResumeVersionId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Radix wires aria-labelledby/aria-describedby to these ids, so the trigger's label and
  // the dialog's description are associated by the primitive rather than by hand.
  const titleId = useId();
  const descriptionId = useId();
  const appliedOnId = useId();
  const followUpOnId = useId();
  const resumeId = useId();
  const notesId = useId();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setPending(true);
    try {
      const result = await onSubmit({
        jobId,
        appliedAt: dateInputToIso(appliedOn),
        ...(followUpOn ? { nextActionAt: dateInputToIso(followUpOn) } : {}),
        ...(resumeVersionId ? { resumeVersionId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });

      if (!result.ok) {
        setError(result.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setOpen(false);
      onApplied();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger type="button">Mark applied</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content aria-describedby={descriptionId}>
          <Dialog.Title id={titleId}>Mark applied</Dialog.Title>
          <Dialog.Description id={descriptionId}>
            Record an application for {jobTitle}.
          </Dialog.Description>
          <Dialog.Close asChild>
            <button type="button">Close</button>
          </Dialog.Close>

          <form
            onSubmit={(event) => {
              // `handleSubmit` is async; passing it straight to onSubmit returns a Promise
              // where React expects void, which is how an unhandled rejection escapes.
              void handleSubmit(event);
            }}
          >
            <div>
              <label htmlFor={appliedOnId}>Applied on</label>
              <input
                id={appliedOnId}
                name="appliedOn"
                type="date"
                required
                value={appliedOn}
                onChange={(e) => setAppliedOn(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor={followUpOnId}>Follow up on (optional)</label>
              <input
                id={followUpOnId}
                name="followUpOn"
                type="date"
                value={followUpOn}
                onChange={(e) => setFollowUpOn(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor={resumeId}>Résumé (optional)</label>
              <select
                id={resumeId}
                name="resumeVersionId"
                value={resumeVersionId}
                onChange={(e) => setResumeVersionId(e.target.value)}
              >
                <option value="">None selected</option>
                {resumeVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {resumeLabel(version)}
                  </option>
                ))}
              </select>
              {resumeVersions.length === 0 && <p>No résumés uploaded yet.</p>}
            </div>

            <div>
              <label htmlFor={notesId}>Notes (optional)</label>
              <textarea
                id={notesId}
                name="notes"
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && <p role="alert">{error}</p>}

            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save application"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { dateInputToIso, isoToDateInput, localToday };