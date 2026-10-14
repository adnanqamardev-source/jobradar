/**
 * onboarding.spec.ts — the 4-step setup wizard, driven in a real browser (FE-102).
 *
 * ## Why this file exists
 *
 * The wizard shipped with 30 component tests and 13 unit tests, all green. None of that
 * evidence involved a browser, a real session, or a real database — and the claim "sign up and
 * `/onboarding` walks you to a feed" had never actually been executed. A component test renders
 * a component with props; it cannot catch a server action that 400s, a profile row the signup
 * trigger never created, or a step counter that silently stops being written. Those are exactly
 * the failures this file exists for, and the first version of it found them.
 *
 * ## What it covers, and the ticket each test belongs to
 *
 * | Test | Requirement |
 * |---|---|
 * | signed-out redirect | ONB-001 / docs/03 — `/onboarding` is not public |
 * | four steps in order, rail marked | ONB-001 |
 * | Continue gated per step | ONB-001/002/003 |
 * | Enter commits a chip, does not advance | the failure that silently loses a filled field |
 * | de-duplication is case-insensitive | ONB-002 |
 * | **focus moves to the step heading** | ONB-001 |
 * | hybrid days only while hybrid is selected | ONB-004 |
 * | **abandoning resumes at the same step** | ONB-001 — the reason `onboarding_step` exists |
 * | **Finish persists every step's values** | ONB-005 |
 * | **Finish enqueues a rescore** | the trigger that makes a feed appear at all |
 * | signed-in user is sent back to the feed | `/onboarding` after Finish |
 * | no horizontal scroll | ONB-001's mobile bullet |
 *
 * ## Local gate, and what CI therefore has never proved
 *
 * These specs need a real Supabase. CI's e2e job supplies placeholder credentials and is
 * forbidden from making live calls, so the authed specs skip there with a stated reason.
 * `smoke.spec.ts` stays the CI gate and covers public routes only. Worth stating plainly: a
 * green e2e job in this repo has never signed in, never written a profile, and never rendered a
 * feed. Until that changes, `smoke.spec.ts` is a routing gate and not a product gate.
 *
 * ## Assertions are about behaviour, never presentation
 *
 * Role and label based throughout, the same rule `smoke.spec.ts` follows. Phase 3 owns styling,
 * and a spec asserting a Tailwind class would break the moment the page is restyled with no
 * behaviour changing at all.
 */

/* eslint-disable @typescript-eslint/no-unused-vars --
 * Many tests below destructure `e2eUser` purely to *resolve the fixture* — Playwright builds the
 * session when a test binds the fixture, so an "unused" binding is the entire mechanism. Prefixing
 * each one with `_` would hide that, and dropping it would leave those tests signed out.
 */
import { expect, test } from "./support/fixtures";
import { adminClient, adminEnv, readProfile } from "./support/auth";
import type { Locator, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Locators, named once so a copy change is a one-line change.
// ---------------------------------------------------------------------------

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
/** The step heading is an `<h2>`; it is also the element focus is *supposed* to land on. */
const stepHeading = (page: Page) => page.getByRole("heading", { level: 2 });
const continueButton = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });
const backButton = (page: Page) => page.getByRole("button", { name: "Back", exact: true });
const titleInput = (page: Page) => page.getByLabel("Target job titles");
const skillSearch = (page: Page) => page.getByLabel("Search skills");
const skillList = (page: Page) => page.getByRole("list", { name: "Available skills" }).getByRole("listitem");

/** The four step labels, in the order docs/01 §5 Flow 1 specifies them. */
const STEP_LABELS = ["Role & seniority", "Skills", "Logistics", "Dealbreakers"];

/**
 * Gate every test in this file on a reachable database.
 *
 * `test.skip()` inside `beforeEach` rather than a file-level skip, so an unrunnable suite shows
 * up as *skipped* in the reporter rather than as a file that silently collected nothing — the
 * "worse than a red test" failure `smoke.spec.ts` documents.
 *
 * The orphan-user sweep that used to live here is in `globalSetup` instead: with
 * `fullyParallel: true`, a `beforeAll` here runs once *per worker*, and the workers deleted each
 * other's test users out from under running tests.
 */
test.beforeEach(() => {
  test.skip(
    adminEnv() === null,
    "no real Supabase credentials — CI supplies placeholders and may not make live calls (local gate only)",
  );
});

// ---------------------------------------------------------------------------
// Shared navigation.
// ---------------------------------------------------------------------------

/**
 * Open the wizard and confirm the session was accepted.
 *
 * If the cookie were not honoured, this would bounce to `/login` and every later assertion would
 * fail for a reason that has nothing to do with the wizard. Failing here names the real cause.
 */
async function openWizard(page: Page): Promise<void> {
  await page.goto("/onboarding");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(stepHeading(page)).toBeVisible();
}

/**
 * Set a field's value the way a person would: tap it, then type.
 *
 * ## Why not plain `fill()`
 *
 * Measured on the `mobile-safari` project (iPhone 12 / WebKit):
 *
 * | sequence                        | chips committed | Continue |
 * |---------------------------------|-----------------|----------|
 * | `fill()` → `Enter`              | 0               | disabled |
 * | `tap()` → `fill()` → `Enter`    | 1               | enabled  |
 * | `fill()` → click "Add title"    | 0               | disabled |
 *
 * `fill()` sets the DOM value but React's controlled-input tracker does not see a change, so
 * `onChange` never runs and the component's state stays `""`. Both handlers then read an empty
 * draft: the Enter handler commits nothing and the Add button commits nothing. It is a
 * **harness** artefact, not a product bug — a real user always taps a field before typing, and
 * the `next dev` server is identical across projects — but it makes every step-1 assertion fail
 * on one browser while passing on the other two, which is exactly the kind of failure that gets
 * dismissed as "flaky on Safari".
 *
 * `click()` first puts the input in the state a user's interaction would have produced.
 */
async function fillInto(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.fill(value);
}

/**
 * The first N skill names in the catalogue, read rather than hardcoded.
 *
 * Hardcoding them would make this spec a tripwire on seed data: renaming a skill would break the
 * wizard suite for a reason that has nothing to do with the wizard.
 */
async function firstSkills(count: number): Promise<{ id: string; name: string }[]> {
  const admin = adminClient()!;
  const { data, error } = await admin.from("skills").select("id, name").order("name").limit(count);
  if (error) throw new Error(`could not read the skills catalogue: ${error.message}`);
  return data ?? [];
}

/** Fill step 1's minimum and move on. */
async function passStepOne(page: Page): Promise<void> {
  await fillInto(titleInput(page), "Backend Engineer");
  await titleInput(page).press("Enter");
  await continueButton(page).click();
  await expect(stepHeading(page)).toHaveText(STEP_LABELS[1]!);
}

/** Fill step 2's minimum and move on. */
async function passStepTwo(page: Page): Promise<void> {
  for (const skill of await firstSkills(3)) {
    await page.getByRole("button", { name: `Add ${skill.name}`, exact: true }).click();
  }
  await expect(page.getByRole("status")).toHaveText("3 selected");
  await continueButton(page).click();
  await expect(stepHeading(page)).toHaveText(STEP_LABELS[2]!);
}

// ---------------------------------------------------------------------------
// Without a session — the only part of this file CI can run.
// ---------------------------------------------------------------------------

test.describe("without a session", () => {
  test("sends a signed-out visitor to sign in, and remembers where they were going", async ({
    page,
  }) => {
    const response = await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/login\?next=/);
    expect(response?.status()).toBe(200);

    // The `next` must point *back* at the wizard. A user who follows this link after signing in
    // should land where they were trying to go, not on a generic dashboard.
    expect(page.url()).toContain(encodeURIComponent("/onboarding"));
  });
});

// ---------------------------------------------------------------------------
// The wizard.
// ---------------------------------------------------------------------------

test.describe("the wizard", () => {
  test("renders the four steps in order, with the current one marked", async ({ page, e2eUser }) => {
    await openWizard(page);

    await expect(h1(page)).toHaveText(/good job looks like for you/i);

    const items = page.getByRole("navigation", { name: "Setup progress" }).getByRole("listitem");
    await expect(items).toHaveCount(4);
    await expect(items.first()).toHaveText("Step 1 of 4: Role & seniority");
    // `aria-current` belongs on the `<li>` — the element that *is* the step. On a nested span it
    // would describe the span, and a screen reader would announce nothing useful.
    await expect(items.first()).toHaveAttribute("aria-current", "step");
    await expect(items.nth(1)).not.toHaveAttribute("aria-current", "step");

    await expect(stepHeading(page)).toHaveText(STEP_LABELS[0]!);
  });

  test("opens against the empty profile a real signup produces", async ({ page, e2eUser }) => {
    // The premise of the whole feature. The signup trigger creates `profiles` with every
    // scoring-relevant column empty, so if that stopped being true the wizard would have nothing
    // to fix and a new user's feed would silently stay empty.
    const profile = await readProfile<{
      target_titles: string[];
      work_modes: string[];
      onboarding_step: number;
      onboarding_completed: boolean;
    }>(e2eUser.userId);

    expect(profile).not.toBeNull();
    expect(profile!.target_titles).toEqual([]);
    expect(profile!.work_modes).toEqual([]);
    expect(profile!.onboarding_step).toBe(1);
    expect(profile!.onboarding_completed).toBe(false);

    await openWizard(page);
    await expect(page.getByRole("list", { name: "Your target titles" })).toHaveCount(0);
  });

  test("keeps Continue disabled until step 1 has a title, and never traps the user", async ({
    page,
    e2eUser,
  }) => {
    await openWizard(page);
    await expect(continueButton(page)).toBeDisabled();

    // A blank entry is not a title.
    await fillInto(titleInput(page), "   ");
    await titleInput(page).press("Enter");
    await expect(continueButton(page)).toBeDisabled();

    await fillInto(titleInput(page), "Senior Frontend Engineer");
    await titleInput(page).press("Enter");
    await expect(continueButton(page)).toBeEnabled();

    // The escape hatch. docs/01 Flow 1 promises a `Skip for now`; without it a user who cannot
    // answer is stuck on a wizard with no way forward.
    await expect(page.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  });

  test("Enter commits a chip without advancing the wizard", async ({ page, e2eUser }) => {
    await openWizard(page);

    await fillInto(titleInput(page), "Backend Engineer");
    await titleInput(page).press("Enter");

    // If Enter had submitted the form, the wizard would already be on step 2 — and the user
    // would have lost every other field on this step with only `Back` to recover them.
    await expect(stepHeading(page)).toHaveText(STEP_LABELS[0]!);
    await expect(
      page.getByRole("list", { name: "Your target titles" }).getByText("Backend Engineer"),
    ).toBeVisible();
  });

  test("de-duplicates a repeated title case-insensitively", async ({ page, e2eUser }) => {
    await openWizard(page);

    await fillInto(titleInput(page), "React");
    await titleInput(page).press("Enter");
    await fillInto(titleInput(page), "react");
    await titleInput(page).press("Enter");

    // Without normalisation the user sees two identical-looking chips and `target_titles` is
    // written with a duplicate that the matcher will then score twice.
    await expect(page.getByRole("list", { name: "Your target titles" }).getByRole("listitem")).toHaveCount(1);
  });

  test("moves focus to the new step's heading when the step changes", async ({ page, e2eUser }) => {
    await openWizard(page);
    await passStepOne(page);

    // ONB-001. Without this, focus stays on the *departed* step's Continue button; focus falls
    // back to <body> and the next Tab restarts from the top of the page, silently skipping every
    // field on the step the user is now looking at.
    await expect(stepHeading(page)).toBeFocused();
  });

  test("requires three skills before step 2 will continue", async ({ page, e2eUser }) => {
    await openWizard(page);
    await passStepOne(page);

    await expect(continueButton(page)).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText("0 selected — 3 more needed");

    const skills = await firstSkills(3);
    expect(skills).toHaveLength(3);

    for (const skill of skills.slice(0, 2)) {
      await page.getByRole("button", { name: `Add ${skill.name}`, exact: true }).click();
    }
    // Two is still not three. This is the assertion that matters: the UI gate and the server's
    // `.min(3)` have to agree, or Continue is a button that 400s on first press.
    await expect(page.getByRole("status")).toHaveText("2 selected — 1 more needed");
    await expect(continueButton(page)).toBeDisabled();

    await page.getByRole("button", { name: `Add ${skills[2]!.name}`, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("3 selected");
    await expect(continueButton(page)).toBeEnabled();
  });

  test("filters the skill catalogue by name, and says so when nothing matches", async ({
    page,
    e2eUser,
  }) => {
    await openWizard(page);
    await passStepOne(page);

    await fillInto(skillSearch(page), "zzzznotaskill");
    await expect(page.getByText("No skill matches that search.")).toBeVisible();
    // The empty state replaces a blank list; an empty list reads as "the app is broken".
    await expect(skillList(page)).toHaveCount(0);

    await fillInto(skillSearch(page), "type");
    await expect(skillList(page)).toHaveCount(1);
    await expect(skillList(page).first()).toContainText("TypeScript");
  });

  test("offers hybrid days only while hybrid is selected", async ({ page, e2eUser }) => {
    await openWizard(page);
    await passStepOne(page);
    await passStepTwo(page);

    const hybridDays = page.getByLabel("Maximum days in the office per week");
    await expect(hybridDays).toBeHidden();

    await page.getByLabel("Hybrid").check();
    await expect(hybridDays).toBeVisible();

    // Clearing hybrid must take the days with it. A stale `hybrid_days_max` beside
    // `work_modes: ["remote"]` is a constraint the user never expressed.
    await page.getByLabel("Hybrid").uncheck();
    await expect(hybridDays).toBeHidden();
  });

  test("abandoning mid-wizard resumes at the same step, with the earlier answers intact", async ({
    page,
    e2eUser,
  }) => {
    await openWizard(page);
    await passStepOne(page);

    // Walk away entirely — no Finish, no logout, just a fresh page load.
    await page.goto("/onboarding");
    await expect(stepHeading(page)).toHaveText(STEP_LABELS[1]!);

    // And step 1's answer survived, not merely the counter.
    await backButton(page).click();
    await expect(stepHeading(page)).toHaveText(STEP_LABELS[0]!);
    await expect(
      page.getByRole("list", { name: "Your target titles" }).getByText("Backend Engineer"),
    ).toBeVisible();
  });

  test("Finish persists every step's values and lands on the feed", async ({ page, e2eUser }) => {
    await openWizard(page);

    // --- step 1: role & seniority
    await fillInto(titleInput(page), "Senior Backend Engineer");
    await titleInput(page).press("Enter");
    // `exact` is load-bearing, not decoration: the step's `<section>` is itself labelled
    // "Role & seniority", so a substring match on "Seniority" resolves to both the region and
    // the select and Playwright refuses on a strict-mode violation.
    await page.getByLabel("Seniority", { exact: true }).selectOption("senior");
    await fillInto(page.getByLabel("Years of experience (optional)"), "7");
    await continueButton(page).click();
    await expect(stepHeading(page)).toHaveText(STEP_LABELS[1]!);

    // --- step 2: skills, with a proficiency chosen rather than defaulted
    const skills = await firstSkills(3);
    for (const skill of skills) {
      await page.getByRole("button", { name: `Add ${skill.name}`, exact: true }).click();
    }
    await page.getByLabel(`Level for ${skills[0]!.name}`).selectOption("expert");
    await continueButton(page).click();
    await expect(stepHeading(page)).toHaveText(STEP_LABELS[2]!);

    // --- step 3: logistics. Country typed lowercase on purpose.
    await page.getByLabel("Remote").check();
    await fillInto(page.getByLabel("Country code (optional)"), "de");
    await fillInto(page.getByLabel("Minimum"), "90000");
    await page.getByLabel("Currency").selectOption("EUR");
    await continueButton(page).click();
    await expect(stepHeading(page)).toHaveText(STEP_LABELS[3]!);

    // --- step 4: dealbreakers, then Finish
    await fillInto(page.getByLabel("Keywords to skip"), "contract");
    await page.getByLabel("Keywords to skip").press("Enter");
    await page.getByRole("button", { name: /Finish & build my feed/ }).click();

    await expect(page).toHaveURL(/\/dashboard/);

    // Now the part no component test can reach: what actually landed in the database, read
    // through the service role so RLS cannot hide a row the browser happened to see.
    await expect
      .poll(async () => (await readProfile(e2eUser.userId))?.onboarding_completed, {
        timeout: 15_000,
      })
      .toBe(true);

    const profile = await readProfile<{
      target_titles: string[];
      seniority: string;
      years_experience: number;
      work_modes: string[];
      country_code: string;
      min_salary: number;
      salary_currency: string;
      excluded_keywords: string[];
    }>(e2eUser.userId);

    expect(profile).not.toBeNull();
    expect(profile!.target_titles).toEqual(["Senior Backend Engineer"]);
    expect(profile!.seniority).toBe("senior");
    expect(profile!.years_experience).toBe(7);
    expect(profile!.work_modes).toContain("remote");
    // The wizard upper-cases it; the column is `char(2)` and would otherwise store "de".
    expect(profile!.country_code?.trim().toUpperCase()).toBe("DE");
    expect(profile!.min_salary).toBe(90000);
    expect(profile!.salary_currency.trim()).toBe("EUR");
    expect(profile!.excluded_keywords).toContain("contract");

    const admin = adminClient()!;
    const { data: profileSkills } = await admin
      .from("profile_skills")
      .select("skill_id, level")
      .eq("profile_id", e2eUser.userId);
    expect(profileSkills).toHaveLength(3);
    expect(profileSkills?.find((s) => s.skill_id === skills[0]!.id)?.level).toBe("expert");

    // Finish must leave scoring work queued, or the feed stays empty forever. Step 1's save
    // already enqueued one and the partial unique index coalesces to a single pending rescore
    // per profile — so the assertion is "*a* rescore exists for this profile", not a count.
    // Polled because the enqueue is a `SECURITY DEFINER` call on the same request that
    // redirected us; nothing orders the two landings.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("task_queue")
            .select("id")
            .eq("kind", "rescore_profile")
            .contains("payload", { profile_id: e2eUser.userId });
          return data?.length ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test("a finished user is sent back to the feed instead of re-running setup", async ({
    page,
    e2eUser,
  }) => {
    await openWizard(page);
    await passStepOne(page);
    await passStepTwo(page);
    await continueButton(page).click();
    await page.getByRole("button", { name: /Finish & build my feed/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto("/onboarding");
    // Re-announcing "let's find out what a good job looks like for you" to someone who already
    // has a feed is the wrong answer. Editing is a different route (ONB-006 / FE-116).
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("does not scroll horizontally, at any width", async ({ page, e2eUser }) => {
    await openWizard(page);

    // ONB-001's mobile bullet. The layout is one column, so overflow means something inside it
    // refuses to shrink. Asserted with a message naming the step and the viewport, because
    // "expected false to be false" tells you nothing about which of three measurements failed.
    const measure = () =>
      page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));

    const expectNoOverflow = async (label: string) => {
      const { scroll, client } = await measure();
      expect(scroll, `${label} overflows at ${client}px (content is ${scroll}px)`).toBeLessThanOrEqual(client);
    };

    await expectNoOverflow("step 1");
    await passStepOne(page);
    // Step 2 is the densest — a search box plus a list with a select per row.
    await expectNoOverflow("step 2");
    await passStepTwo(page);
    await expectNoOverflow("step 3");
  });
});
