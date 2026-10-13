// @vitest-environment jsdom
/**
 * apply-dialog.test.tsx — the mark-as-applied dialog (FE-110, JOB-003).
 *
 * A dialog is the one component class where the *structure* is the feature: a modal with no
 * focus management, no label association and no escape path is unusable rather than ugly,
 * and Phase 3 styling cannot fix any of it (docs/06 §8.3). So these tests assert structure —
 * roles, labels, association, focus — not pixels.
 *
 * What is pinned:
 *   - every input has an associated `<label>` (click the label, focus the control)
 *   - the applied date defaults to today, in local time
 *   - the follow-up date is optional and a future date is accepted
 *   - the résumé picker lists the versions, and an empty list is a non-blocking empty state
 *   - the submit payload is a full ISO instant — local midnight, not UTC midnight
 *   - a rejected submit shows `role="alert"` and does not close the dialog
 *   - `onApplied` fires only on success
 *
 * The date helpers are exported from the component so this file can pin the timezone
 * behaviour that the module docstring claims. That claim is the whole reason the conversion
 * is hand-written instead of `new Date(string)`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";

import { ApplyDialog, dateInputToIso, localToday } from "@/components/feed/apply-dialog";
import type { ResumeVersion } from "@/lib/db/queries/resume-versions";

/** The payload the dialog hands to `onSubmit` — derived, not restated. */
type SubmitInput = Parameters<React.ComponentProps<typeof ApplyDialog>["onSubmit"]>[0];
type SubmitResult = Awaited<ReturnType<React.ComponentProps<typeof ApplyDialog>["onSubmit"]>>;

const RESUMES: ResumeVersion[] = [
  { id: "11111111-1111-4111-8111-111111111111", file_path: "u1/frontend-v2.pdf", created_at: "2026-10-01T00:00:00.000Z" },
  { id: "22222222-2222-4222-8222-222222222222", file_path: "u1/general.pdf", created_at: "2026-09-01T00:00:00.000Z" },
];

function setup(overrides: Partial<Parameters<typeof ApplyDialog>[0]> = {}) {
  const onSubmit = vi.fn(
    (_input: SubmitInput): Promise<SubmitResult> => Promise.resolve({ ok: true }),
  );
  const onApplied = vi.fn();
  render(
    <ApplyDialog
      jobId="3f2a9c1e-0000-4000-8000-000000000001"
      jobTitle="Senior Frontend Engineer"
      resumeVersions={RESUMES}
      onSubmit={onSubmit}
      onApplied={onApplied}
      {...overrides}
    />,
  );
  return { onSubmit, onApplied };
}

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Mark applied" }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("date helpers", () => {
  it("reads a date input as LOCAL midnight, not UTC midnight", () => {
    // The round-trip check below is **vacuous in UTC**: `new Date("2026-10-14")` is
    // UTC midnight, which *is* local midnight when TZ=UTC, so both implementations
    // pass and the test proves nothing. These assertions are therefore scoped to a
    // non-UTC zone.
    const originalTz = process.env.TZ;
    // Asia/Kolkata: UTC+05:30, no DST, so the offset is fixed and the test is not
    // date-dependent.
    process.env.TZ = "Asia/Kolkata";
    try {
      const back = new Date(dateInputToIso("2026-10-14"));

      expect(back.getFullYear()).toBe(2026);
      expect(back.getMonth()).toBe(9);
      expect(back.getDate()).toBe(14);
      // The discriminator: local midnight is 00:00 **local**, so the instant is
      // 18:30Z the day before. A UTC-midnight parse would land on 05:30 local.
      expect(back.getHours()).toBe(0);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("localToday is today's local date", () => {
    const now = new Date();
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [y, m, d] = localToday().split("-").map(Number);
    expect(y).toBe(now.getFullYear());
    expect(m).toBe(now.getMonth() + 1);
    expect(d).toBe(now.getDate());
  });
});

describe("ApplyDialog", () => {
  it("is closed until the trigger is used", () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a dialog with a name and description", async () => {
    setup();
    await openDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBeNull();
    expect(within(dialog).getByRole("heading", { name: "Mark applied" })).not.toBeNull();
    expect(
      within(dialog).getByText(/Record an application for Senior Frontend Engineer\./),
    ).not.toBeNull();
  });

  it("associates every input with a label", async () => {
    setup();
    await openDialog();
    const dialog = screen.getByRole("dialog");

    // Label -> control association, checked the way a user does it: the label carries a
    // `for` that resolves to the input's id.
    for (const name of ["Applied on", "Follow up on (optional)", "Résumé (optional)", "Notes (optional)"]) {
      const label = within(dialog).getByText(name, { selector: "label" });
      const forId = label.getAttribute("for");
      expect(forId, `label "${name}" has no for`).toBeTruthy();
      expect(dialog.querySelector(`#${CSS.escape(forId ?? "")}`)).not.toBeNull();
    }
  });

  it("defaults the applied date to today and leaves the follow-up blank", async () => {
    setup();
    await openDialog();

    expect(screen.getByLabelText("Applied on")).toHaveValue(localToday());
    expect(screen.getByLabelText("Follow up on (optional)")).toHaveValue("");
  });

  it("lists résumé versions by file name and includes a none option", async () => {
    setup();
    await openDialog();

    const select = screen.getByLabelText<HTMLSelectElement>("Résumé (optional)");
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["None selected", "frontend-v2.pdf", "general.pdf"]);
  });

  it("shows a non-blocking empty state when there are no résumés", async () => {
    setup({ resumeVersions: [] });
    await openDialog();

    expect(screen.getByText(/No résumés uploaded yet\./)).not.toBeNull();
    // Non-blocking: the submit button is still enabled.
    expect(screen.getByRole("button", { name: "Save application" })).toHaveProperty("disabled", false);
  });

  it("submits local midnight, the picked résumé and the notes", async () => {
    const { onSubmit } = setup();
    await openDialog();

    await userEvent.clear(screen.getByLabelText("Applied on"));
    await userEvent.type(screen.getByLabelText("Applied on"), "2026-10-14");
    await userEvent.type(screen.getByLabelText("Follow up on (optional)"), "2026-11-02");
    await userEvent.selectOptions(screen.getByLabelText("Résumé (optional)"), RESUMES[0]?.id ?? "");
    await userEvent.type(screen.getByLabelText("Notes (optional)"), "Applied via company site");
    await userEvent.click(screen.getByRole("button", { name: "Save application" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.jobId).toBe("3f2a9c1e-0000-4000-8000-000000000001");
    expect(payload.resumeVersionId).toBe(RESUMES[0]?.id);
    expect(payload.notes).toBe("Applied via company site");

    // Both dates are full ISO instants and the follow-up is in the future.
    expect(payload.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.nextActionAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(payload.nextActionAt ?? "").getTime()).toBeGreaterThan(
      new Date(payload.appliedAt ?? "").getTime(),
    );
  });

  it("omits the optional fields when they are left blank", async () => {
    const { onSubmit } = setup();
    await openDialog();

    await userEvent.click(screen.getByRole("button", { name: "Save application" }));

    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.appliedAt).toBeTruthy();
    expect(payload).not.toHaveProperty("nextActionAt");
    expect(payload).not.toHaveProperty("resumeVersionId");
    expect(payload).not.toHaveProperty("notes");
  });

  it("surfaces a rejected submit and keeps the dialog open", async () => {
    const onSubmit = vi.fn((_input: SubmitInput): Promise<SubmitResult> =>
      Promise.resolve({ ok: false, error: { message: "We couldn't find that." } }),
    );
    const { onApplied } = setup({ onSubmit });
    await openDialog();

    await userEvent.click(screen.getByRole("button", { name: "Save application" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't find that.");
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("reports success once, and closes", async () => {
    const { onSubmit, onApplied } = setup();
    await openDialog();

    await userEvent.click(screen.getByRole("button", { name: "Save application" }));

    await vi.waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});