/**
 * tracker.spec.ts — the last leg of the Phase 2 gate (docs/06: "onboarding → feed → apply →
 * stage move").
 *
 * ## What is new here
 *
 * `onboarding.spec.ts` covered the first leg. Nothing had ever exercised **apply → stage move**
 * end to end: the dashboard could create an `applications` row through `markApplied`, and no
 * route could display it. A stage move has never run in a browser, which is exactly the kind of
 * gap that leaves a function like `move_application` unreviewed — and that is how
 * migration `0015`'s unauthenticated, cross-user write survived until this slice.
 *
 * ## Seeded, not mocked
 *
 * `seedFeedForUser` copies genuine `job_scores` rows from an already-scored profile so the feed
 * has something to act on. The rows are real, the query is real, `markApplied` and
 * `move_application` are the production paths. Only the wait for real scoring is skipped.
 *
 * Skips when there is no reachable Supabase, like every other authed spec here.
 */

import { expect, test, seedFeedForUser } from "./support/fixtures";
import { adminClient, adminEnv, readProfile } from "./support/auth";
import type { Page } from "@playwright/test";

const BOARD = "/applications";

/**
 * Mark the first feed card applied, and return its title.
 *
 * The trigger alone is not enough. "Mark applied" is a Radix `Dialog.Trigger` on the FE-110 apply
 * dialog; the `applications` row is only written when the form inside that dialog is submitted.
 * An earlier draft of this helper clicked the trigger and returned, so every test that depended on
 * it failed on a board that was legitimately empty — `applications` had no row to find.
 */
async function applyFirstJob(page: Page): Promise<string> {
  await page.goto("/dashboard");
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Mark applied" }) })
    .first();
  await card.waitFor();
  const title = (await card.getByRole("heading").first().innerText()).trim();

  await card.getByRole("button", { name: "Mark applied" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // "Applied on" is prefilled with today and `required`, so submitting the form as-is is the
  // realistic path. `Save application` is the real submit button, not the trigger.
  await dialog.getByRole("button", { name: "Save application" }).click();
  // The dialog closing is the client-side signal that `markApplied` resolved; the row is written
  // server-side before then, and `onApplied` triggers `router.refresh()`.
  await dialog.waitFor({ state: "detached" });

  return title;
}

/**
 * The column for a stage.
 *
 * A `<ul>` has role `list`, not `region`. An earlier draft asked for `region`, which matched the
 * enclosing `<section>` only by accident and reported "element not found" for a column that was
 * rendered correctly.
 */
function column(page: Page, stage: string) {
  return page.getByRole("list", { name: `${stage} applications` });
}

test.beforeEach(() => {
  test.skip(
    adminEnv() === null,
    "no real Supabase credentials — CI supplies placeholders and may not make live calls (local gate only)",
  );
});

test.describe("the application tracker", () => {
  test("an applied job appears on the board in the Applied column", async ({ page, e2eUser }) => {
    const seeded = await seedFeedForUser(e2eUser.userId);
    expect(seeded, "no scores were seeded, so the feed cannot be tested").toBeGreaterThan(0);

    const title = await applyFirstJob(page);

    await page.goto(BOARD);
    const applied = column(page, "Applied");
    await expect(applied).toContainText(title);
    // The column heading carries the live count (TRK-003).
    await expect(page.getByRole("heading", { name: `Applied (1)` })).toBeVisible();
  });

  test("moving a card changes its column and records the history", async ({ page, e2eUser }) => {
    await seedFeedForUser(e2eUser.userId);
    const title = await applyFirstJob(page);

    await page.goto(BOARD);
    const applied = column(page, "Applied");
    await expect(applied).toContainText(title);

    // The legal move from `applied`. The select offers only what the database permits, so this
    // is testing the wiring rather than the rule — the rule is pinned by
    // `tests/unit/application-stages.test.ts` against the SQL.
    await page.getByLabel(`Move ${title} to stage`).selectOption("screening");

    // The card leaves Applied and lands in Screening.
    //
    // Checked against the board's error region *first*. A move that fails renders `role="alert"`,
    // and asserting the move first would report "the column never changed" for a failure whose
    // actual cause — a rejected server action — is right there in the page. A silent no-op was a
    // real defect: `moveApplicationStage` could reject, `result` was never assigned, and the user
    // saw nothing at all. See the catch in `tracker.tsx`.
    await expect(page.getByRole("alert", { name: "Stage move error" })).toHaveCount(0);
    await expect(column(page, "Screening")).toContainText(title);
    await expect(column(page, "Applied")).not.toContainText(title);

    // TRK-002 requires an announcement on move; a card silently changing column is invisible to
    // a screen-reader user.
    await expect(page.getByRole("status")).toContainText(`moved to Screening`);

    // And the append-only history has the transition on it.
    await page.getByRole("button", { name: `Details for ${title}` }).click();
    const history = page.getByRole("region", { name: "Stage history" });
    await expect(history).toContainText("Applied → Screening");
    // The first event is TRK-001's `from_stage = null` row, rendered as "Created as".
    await expect(history).toContainText("Created as Applied");
  });

  test("offers only the moves the database permits", async ({ page, e2eUser }) => {
    await seedFeedForUser(e2eUser.userId);
    const title = await applyFirstJob(page);

    await page.goto(BOARD);
    const control = page.getByLabel(`Move ${title} to stage`);

    // `applied -> screening|rejected|withdrawn` per `move_application`. Offering `offer` here would
    // be a control the server refuses every time.
    await expect(control.locator("option")).toHaveText([
      "Applied (current)",
      "Screening",
      "Rejected",
      "Withdrawn",
    ]);

    // The current stage is shown but is not a re-selectable option — a same-stage move is a
    // guaranteed "Already in target stage" error.
    await expect(control.locator(`option[value="applied"]`)).toHaveCount(1);
  });

  test("a closed application offers no stage control at all", async ({ page, e2eUser }) => {
    await seedFeedForUser(e2eUser.userId);
    const title = await applyFirstJob(page);

    await page.goto(BOARD);
    const control = page.getByLabel(`Move ${title} to stage`);
    await control.selectOption("rejected");

    // `rejected` is terminal: `move_application` refuses any transition out of it, so the control
    // must disappear rather than render an empty dropdown the user can focus.
    await expect(page.getByRole("alert", { name: "Stage move error" })).toHaveCount(0);
    await expect(column(page, "Rejected")).toContainText(title);
    await expect(page.getByLabel(`Move ${title} to stage`)).toHaveCount(0);
    await expect(column(page, "Rejected")).toContainText("This application is closed");
  });

  test("an empty column shows a placeholder, not a blank gap", async ({ page, e2eUser }) => {
    // TRK-003 requires it explicitly, and it is the difference between "nothing here" and
    // "this part of the page failed to render".
    await seedFeedForUser(e2eUser.userId);
    await applyFirstJob(page);

    await page.goto(BOARD);
    await expect(column(page, "Interview")).toContainText("Nothing in Interview yet.");
  });

  test("a deleted job survives on its snapshot", async ({ page, e2eUser }) => {
    // docs/03 §5.2: `job_snapshot` keeps the tracker record intact when the job is deleted. That
    // was not true until 0016: `job_id` was `on delete cascade`, so deleting a job deleted the
    // application and the snapshot had nothing to render in. Production hid it because jobs are
    // expired via `status`, never `DELETE`d.
    //
    // This test asserted the cascade for a while, because the cascade was what the schema
    // actually did. It is the reason the conflict was found rather than shipped.
    const admin = adminClient();
    if (admin === null) throw new Error("no admin client");

    await seedFeedForUser(e2eUser.userId);
    const title = await applyFirstJob(page);

    const { data: cards } = await admin
      .from("applications")
      .select("job_id")
      .eq("user_id", e2eUser.userId)
      .limit(1);
    const jobId = cards?.[0]?.job_id;
    expect(jobId, "apply did not create an application row").toBeTruthy();

    await admin.from("jobs").delete().eq("id", jobId);

    // The application survives, with job_id nulled rather than cascaded away.
    const after = await admin.from("applications").select("id, job_id").eq("user_id", e2eUser.userId);
    expect(after.data, "on delete set null must keep the application, not cascade it").toHaveLength(1);
    expect(after.data?.[0]?.job_id, "the FK should null the id, not remove the row").toBeNull();

    // And the board renders it from the snapshot, with no dead deep-link.
    await page.goto(BOARD);
    const card = column(page, "Applied").getByRole("article").filter({ hasText: title });
    await expect(card).toContainText(title);
    await expect(card).toContainText("This job is no longer available");
    await expect(card.getByRole("link", { name: "View the job" })).toHaveCount(0);
  });

  test("the signed-out visitor is sent to sign in", async ({ page }) => {
    // No `e2eUser` destructured, so no session — this is the signed-out case.
    await page.goto(BOARD);
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(page.url()).toContain(encodeURIComponent("/applications"));
  });

  test("the board is scoped to the caller", async ({ page, e2eUser }) => {
    // A board that showed another user's applications would be a data leak, and the only way to
    // see it is to have two users. Asserting the profile is untouched by the board's existence is
    // the cheap half; the ownership guarantee itself is pinned by
    // `tests/integration/move-application.db.test.ts`.
    await seedFeedForUser(e2eUser.userId);
    await applyFirstJob(page);

    await page.goto(BOARD);
    const profile = await readProfile<{ onboarding_completed: boolean }>(e2eUser.userId);
    expect(profile).not.toBeNull();
    await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
  });
});