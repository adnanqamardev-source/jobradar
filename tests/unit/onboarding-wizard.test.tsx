// @vitest-environment jsdom
/**
 * onboarding-wizard.test.tsx — the wizard shell and its steps (FE-102, ONB-001..004).
 *
 * ## What is worth a test here
 *
 * The wizard's value is entirely in its *gates* and its *state transitions*; the visuals are
 * Phase 3. So these assert:
 *
 *  - **Gates.** `Continue` is disabled until each step's minimum is met, and the minimum is the
 *    one the server action will also enforce — a UI that enables Continue at 2 skills produces
 *    a button that 400s, which is the worst possible onboarding experience.
 *  - **Enter commits, never submits.** Adding a chip with Enter must not advance the wizard.
 *    This is the single easiest way to break a multi-field step and it is invisible until a user
 *    loses their input.
 *  - **Conditional fields.** Hybrid days exist only while hybrid is selected, so a stale value
 *    cannot be saved alongside `work_modes: ["remote"]`.
 *  - **Focus moves to the new step's heading.** Without it, a keyboard user's focus falls back
 *    to `<body>` on step change and the next Tab restarts from the top of the page.
 *  - **A failed save keeps the user on the step** with an inline `role="alert"`, not a toast and
 *    not a silent advance (ONB-002).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Every mock is created inside `vi.hoisted`.
 *
 * `vi.mock` calls are hoisted above the imports, and an ESM import of `wizard.tsx` evaluates
 * before this file's body — so a factory referencing a module-body `const` hits the temporal
 * dead zone ("Cannot access 'setOnboardingStep' before initialization"). `vi.hoisted` is the
 * documented way to get initialised values into a factory.
 */
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  setOnboardingStep: vi.fn(),
  updateProfile: vi.fn(),
  updateSkills: vi.fn(),
  updateLogistics: vi.fn(),
  updateDealbreakers: vi.fn(),
  completeOnboarding: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("@/app/api/actions/profile/set-onboarding-step", () => ({
  setOnboardingStep: mocks.setOnboardingStep,
}));
vi.mock("@/app/api/actions/profile/update-profile", () => ({ updateProfile: mocks.updateProfile }));
vi.mock("@/app/api/actions/profile/update-skills", () => ({ updateSkills: mocks.updateSkills }));
vi.mock("@/app/api/actions/profile/update-logistics", () => ({
  updateLogistics: mocks.updateLogistics,
}));
vi.mock("@/app/api/actions/profile/update-dealbreakers", () => ({
  updateDealbreakers: mocks.updateDealbreakers,
}));
vi.mock("@/app/api/actions/profile/complete-onboarding", () => ({
  completeOnboarding: mocks.completeOnboarding,
}));

import { Wizard, WIZARD_STEPS, type SkillOption } from "@/components/onboarding/wizard";
import type { OnboardingProfile } from "@/lib/db/queries/onboarding";

const SKILLS: SkillOption[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "TypeScript", slug: "typescript", aliases: ["ts"] },
  { id: "22222222-2222-4222-8222-222222222222", name: "React", slug: "react", aliases: ["reactjs"] },
  { id: "33333333-3333-4333-8333-333333333333", name: "Python", slug: "python", aliases: ["py"] },
  { id: "44444444-4444-4444-8444-444444444444", name: "Go", slug: "go", aliases: ["golang"] },
];

function profile(overrides: Partial<OnboardingProfile> = {}): OnboardingProfile {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "probe@example.invalid",
    full_name: "Probe",
    avatar_url: null,
    role: "user",
    plan: "free",
    target_titles: [],
    seniority: "unknown",
    years_experience: null,
    headline: null,
    country_code: null,
    city: null,
    time_zone: null,
    work_modes: [],
    hybrid_days_max: null,
    min_salary: null,
    salary_currency: "EUR",
    salary_period: null,
    visa_required: null,
    blocked_companies: [],
    excluded_keywords: [],
    preferred_companies: [],
    onboarding_completed: false,
    onboarding_step: 1,
    last_digest_at: null,
    last_seen_feed_at: null,
    created_at: "2026-10-14T00:00:00.000000+00:00",
    updated_at: "2026-10-14T00:00:00.000000+00:00",
    ...overrides,
  };
}

function renderWizard(overrides: Partial<Parameters<typeof Wizard>[0]> = {}) {
  render(
    <Wizard
      profile={profile()}
      skills={SKILLS}
      selectedSkills={[]}
      initialStep={1}
      {...overrides}
    />,
  );
}

const stepHeading = () => screen.getByRole("heading", { level: 2 });
const continueButton = () => screen.getByRole("button", { name: "Continue" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setOnboardingStep.mockResolvedValue({ ok: true });
  mocks.updateProfile.mockResolvedValue({ ok: true });
  mocks.updateSkills.mockResolvedValue({ ok: true });
  mocks.updateLogistics.mockResolvedValue({ ok: true });
  mocks.updateDealbreakers.mockResolvedValue({ ok: true });
  mocks.completeOnboarding.mockResolvedValue({
    ok: true,
    data: { onboardingCompleted: true, onboardingStep: 4 },
  });
});

afterEach(() => cleanup());

describe("wizard shell", () => {
  it("lists the four steps in order and marks the current one", () => {
    renderWizard();
    const items = within(screen.getByRole("navigation", { name: "Setup progress" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Step 1 of 4: Role & seniority");
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items[1]).not.toHaveAttribute("aria-current");
  });

  it("opens at the resume step, not always step 1", () => {
    // ONB-001: "abandoning at step 2 resumes at step 2 next login".
    renderWizard({ initialStep: 2 });
    expect(stepHeading()).toHaveTextContent("Skills");
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("moves focus to the new step's heading on change", async () => {
    renderWizard();
    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");
    await userEvent.click(continueButton());

    await waitFor(() => expect(stepHeading()).toHaveTextContent("Skills"));
    // tabIndex={-1} makes it focusable without adding a tab stop.
    expect(stepHeading()).toHaveFocus();
    expect(stepHeading()).toHaveAttribute("tabindex", "-1");
  });

  it("records the resume point on every step change", async () => {
    renderWizard();
    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");
    await userEvent.click(continueButton());

    await waitFor(() => expect(stepHeading()).toHaveTextContent("Skills"));
    expect(mocks.setOnboardingStep).toHaveBeenCalledWith({ step: 2 });
  });

  it("persists progress even when the step is skipped", async () => {
    renderWizard();
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(stepHeading()).toHaveTextContent("Skills"));
    expect(mocks.setOnboardingStep).toHaveBeenCalledWith({ step: 2 });
    // Skipping must not write a profile: ONB-002 says it "uses defaults", not that it invents
    // titles the user did not type.
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });
});

describe("step 1 — role & seniority (ONB-002)", () => {
  it("keeps Continue disabled until a title exists", async () => {
    renderWizard();
    expect(continueButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Target job titles"), "   {Enter}");
    // A blank entry is not a title.
    expect(continueButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");
    expect(continueButton()).toBeEnabled();
  });

  it("commits a chip on Enter without submitting the form", async () => {
    renderWizard();
    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");

    // If Enter had submitted, the wizard would already be on step 2.
    expect(stepHeading()).toHaveTextContent("Role & seniority");
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(within(screen.getByRole("list", { name: "Your target titles" })).getByText("Engineer")).toBeInTheDocument();
  });

  it("de-duplicates a repeated title case-insensitively", async () => {
    renderWizard();
    const input = screen.getByLabelText("Target job titles");
    await userEvent.type(input, "React{Enter}");
    await userEvent.type(input, "react{Enter}");

    const list = screen.getByRole("list", { name: "Your target titles" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    // First-seen casing is what the user typed first.
    expect(within(list).getByText("React")).toBeInTheDocument();
  });

  it("removes a title", async () => {
    renderWizard();
    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Remove Engineer" }));

    expect(continueButton()).toBeDisabled();
  });

  it("sends seniority and years with the titles", async () => {
    renderWizard();
    await userEvent.selectOptions(screen.getByLabelText("Seniority"), "senior");
    await userEvent.type(screen.getByLabelText("Years of experience (optional)"), "7");
    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");
    await userEvent.click(continueButton());

    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalled());
    expect(mocks.updateProfile).toHaveBeenCalledWith({
      targetTitles: ["Engineer"],
      seniority: "senior",
      yearsExperience: 7,
    });
  });

  it("stays on the step and shows an inline alert when the save fails", async () => {
    mocks.updateProfile.mockResolvedValue({
      ok: false,
      error: { code: "internal_error", message: "We could not save your roles." },
    });
    renderWizard();
    await userEvent.type(screen.getByLabelText("Target job titles"), "Engineer{Enter}");
    await userEvent.click(continueButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not save your roles.");
    expect(stepHeading()).toHaveTextContent("Role & seniority");
    // And it must not advance: the profile change did not land.
    expect(mocks.setOnboardingStep).not.toHaveBeenCalled();
  });
});

describe("step 2 — skills (ONB-003)", () => {
  it("requires three skills before Continue", () => {
    renderWizard({ initialStep: 2 });
    expect(continueButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("0 selected — 3 more needed");
  });

  it("counts up and enables Continue at three", async () => {
    renderWizard({ initialStep: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Add TypeScript" }));
    await userEvent.click(screen.getByRole("button", { name: "Add React" }));
    expect(continueButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add Python" }));

    expect(continueButton()).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("3 selected");
  });

  it("filters on name and on alias", async () => {
    renderWizard({ initialStep: 2 });
    const search = screen.getByLabelText("Search skills");

    await userEvent.type(search, "type");
    expect(within(screen.getByRole("list", { name: "Available skills" })).getAllByRole("listitem"))
      .toHaveLength(1);

    await userEvent.clear(search);
    await userEvent.type(search, "golang");
    const results = within(screen.getByRole("list", { name: "Available skills" })).getAllByRole(
      "listitem",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveTextContent("Go");
  });

  it("says so when nothing matches, instead of showing an empty list", async () => {
    renderWizard({ initialStep: 2 });
    await userEvent.type(screen.getByLabelText("Search skills"), "cobol");
    expect(screen.getByText("No skill matches that search.")).toBeInTheDocument();
  });

  it("toggles a skill off again, which can strand Continue", async () => {
    renderWizard({ initialStep: 2 });
    const add = screen.getByRole("button", { name: "Add TypeScript" });
    await userEvent.click(add);
    expect(screen.getByRole("button", { name: "Remove TypeScript" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove TypeScript" }));
    expect(screen.getByRole("button", { name: "Add TypeScript" })).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it("exposes a labelled level control per selected skill and sends it", async () => {
    renderWizard({ initialStep: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Add TypeScript" }));
    await userEvent.click(screen.getByRole("button", { name: "Add React" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Python" }));

    // Default is `proficient`, matching the column default — not `familiar`.
    expect(screen.getByLabelText("Level for TypeScript")).toHaveValue("proficient");
    await userEvent.selectOptions(screen.getByLabelText("Level for React"), "expert");
    await userEvent.click(continueButton());

    await waitFor(() => expect(mocks.updateSkills).toHaveBeenCalled());
    expect(mocks.updateSkills).toHaveBeenCalledWith({
      skills: [
        { skillId: SKILLS[0]!.id, level: "proficient" },
        { skillId: SKILLS[1]!.id, level: "expert" },
        { skillId: SKILLS[2]!.id, level: "proficient" },
      ],
    });
  });

  it("opens showing the profile's existing skills", () => {
    renderWizard({
      initialStep: 2,
      selectedSkills: [{ skillId: SKILLS[0]!.id, level: "expert" }],
    });
    expect(screen.getByRole("button", { name: "Remove TypeScript" })).toBeInTheDocument();
    expect(screen.getByLabelText("Level for TypeScript")).toHaveValue("expert");
    expect(screen.getByRole("status")).toHaveTextContent("1 selected");
  });
});

describe("step 3 — logistics (ONB-004)", () => {
  it("shows hybrid days only while hybrid is selected", async () => {
    renderWizard({ initialStep: 3 });
    expect(screen.queryByLabelText("Maximum days in the office per week")).toBeNull();

    await userEvent.click(screen.getByLabelText("Hybrid"));
    expect(screen.getByLabelText("Maximum days in the office per week")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Hybrid"));
    // Clearing hybrid must also drop the days, or a stale value ships alongside remote-only.
    expect(screen.queryByLabelText("Maximum days in the office per week")).toBeNull();
  });

  it("sends work modes and omits hybrid days when hybrid is off", async () => {
    renderWizard({ initialStep: 3 });
    await userEvent.click(screen.getByLabelText("Remote"));
    await userEvent.type(screen.getByLabelText("Country code (optional)"), "de");
    await userEvent.click(continueButton());

    await waitFor(() => expect(mocks.updateLogistics).toHaveBeenCalled());
    expect(mocks.updateLogistics).toHaveBeenCalledWith({
      workModes: ["remote"],
      // Upper-cased for the `char(2)` column, which would otherwise store "de".
      countryCode: "DE",
      visaRequired: false,
    });
  });

  it("treats an empty salary as no floor rather than zero", async () => {
    renderWizard({ initialStep: 3 });
    // The field starts empty; submit without touching it.
    await userEvent.click(continueButton());

    await waitFor(() => expect(mocks.updateLogistics).toHaveBeenCalled());
    const input = mocks.updateLogistics.mock.calls[0]![0] as Record<string, unknown>;
    // `minSalary` is absent, which the action reads as "leave untouched"; 0 would be rejected by
    // `.positive()` and a floor of zero is not a preference.
    expect(input).not.toHaveProperty("minSalary");
    expect(input).not.toHaveProperty("salaryCurrency");
  });

  it("sends the salary with currency and period when one is given", async () => {
    renderWizard({ initialStep: 3 });
    await userEvent.type(screen.getByLabelText("Minimum"), "90000");
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "USD");
    await userEvent.selectOptions(screen.getByLabelText("Period"), "month");
    await userEvent.click(continueButton());

    await waitFor(() => expect(mocks.updateLogistics).toHaveBeenCalled());
    expect(mocks.updateLogistics).toHaveBeenCalledWith(
      expect.objectContaining({
        minSalary: 90000,
        salaryCurrency: "USD",
        salaryPeriod: "month",
      }),
    );
  });

  it("offers a fixed currency allowlist, not free text", () => {
    renderWizard({ initialStep: 3 });
    const currencies = within(screen.getByLabelText("Currency")).getAllByRole("option");
    expect(currencies.length).toBeGreaterThan(3);
    // Every option is a real ISO 4217 code; the BE only length-checks, so the UI is the only
    // enforcement point.
    for (const option of currencies) {
      expect(option.textContent).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("step 4 — dealbreakers & finish (ONB-005)", () => {
  it("names the finishing action for what it does", () => {
    renderWizard({ initialStep: 4 });
    expect(screen.getByRole("button", { name: /Finish & build my feed/ })).toBeInTheDocument();
  });

  it("commits chips on Enter without finishing setup", async () => {
    renderWizard({ initialStep: 4 });
    await userEvent.type(screen.getByLabelText("Companies to hide"), "Acme{Enter}");

    expect(mocks.completeOnboarding).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("list", { name: "Companies to hide" })).getByText("Acme"),
    ).toBeInTheDocument();
  });

  it("finishes, marks onboarding complete and lands on the dashboard", async () => {
    renderWizard({ initialStep: 4 });
    await userEvent.type(screen.getByLabelText("Keywords to skip"), "contract{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /Finish & build my feed/ }));

    await waitFor(() => expect(mocks.completeOnboarding).toHaveBeenCalled());
    expect(mocks.updateDealbreakers).toHaveBeenCalledWith({
      blockedCompanies: [],
      excludedKeywords: ["contract"],
      preferredCompanies: [],
    });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/dashboard"));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("does not navigate when the dealbreaker save fails", async () => {
    mocks.updateDealbreakers.mockResolvedValue({
      ok: false,
      error: { code: "internal_error", message: "We could not save your dealbreakers." },
    });
    renderWizard({ initialStep: 4 });
    await userEvent.click(screen.getByRole("button", { name: /Finish & build my feed/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not save your dealbreakers.",
    );
    expect(mocks.completeOnboarding).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("stays put and reports when completion fails", async () => {
    mocks.completeOnboarding.mockResolvedValue({
      ok: false,
      error: { code: "internal_error", message: "We could not confirm your setup." },
    });
    renderWizard({ initialStep: 4 });
    await userEvent.click(screen.getByRole("button", { name: /Finish & build my feed/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not confirm your setup.");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("navigation between steps", () => {
  it("goes back without saving", async () => {
    renderWizard({ initialStep: 3 });
    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(stepHeading()).toHaveTextContent("Skills"));
    expect(mocks.updateSkills).not.toHaveBeenCalled();
  });

  it("has four steps, matching the docs' count", () => {
    expect(WIZARD_STEPS).toHaveLength(4);
    expect(WIZARD_STEPS.map((entry) => entry.label)).toEqual([
      "Role & seniority",
      "Skills",
      "Logistics",
      "Dealbreakers",
    ]);
  });
});
