/**
 * wizard.tsx — the 4-step onboarding shell (FE-102, ONB-001).
 *
 * docs/01 §5 Flow 1: role & seniority → skills → logistics → dealbreakers, with a progress
 * rail, `Back`/`Continue`, per-step validation, and progress persisted on every step.
 *
 * ## Structure, not styling (Phase 2 rule, docs/06 §8.4)
 *
 * The rail is an ordered list with `aria-current="step"`; each step is an `<h2>` region with its
 * own accessible name. No utility classes — the mobile single-column layout and the rail's
 * desktop presentation are Phase 3.
 *
 * ## Focus moves to the step heading, not to the top of the document
 *
 * ONB-001: "focus moves to the step heading on change". A client-side navigation that only
 * swaps content leaves a keyboard user's focus on the *Continue* button of a step that no longer
 * exists — focus falls back to `<body>` and the next Tab starts from the top of the page,
 * silently skipping every field they just filled in. Moving focus to the new heading announces
 * the step and puts the next Tab inside it. Implemented with a `ref` + `focus()` on a heading
 * that carries `tabIndex={-1}` (focusable, but not a tab stop).
 *
 * ## One client boundary
 *
 * The whole wizard is one client component because the step index is shared state and each step
 * unmounts the previous one. The data arrives as props from the server component, so there is
 * no client fetch and no waterfall: `page.tsx` loads the profile and the skill catalogue in one
 * render and hands them down.
 */

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setOnboardingStep } from "@/app/api/actions/profile/set-onboarding-step";
import type { OnboardingProfile } from "@/lib/db/queries/onboarding";
import { StepDealbreakers } from "./steps/step-dealbreakers";
import { StepLogistics } from "./steps/step-logistics";
import { StepRole } from "./steps/step-role";
import { StepSkills } from "./steps/step-skills";

/**
 * A row of the canonical `skills` catalogue.
 *
 * Declared here rather than imported from the query module because this is the *component*
 * boundary: the page hands the wizard plain data, and the wizard does not care that it came
 * from a database read. Re-declaring a five-field shape is cheaper than coupling every client
 * component to a server-side module.
 */
export interface SkillOption {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
}

export interface WizardStepMeta {
  id: number;
  label: string;
  /** Rendered under the rail; each step states what it collects before the user starts. */
  summary: string;
}

export const WIZARD_STEPS: WizardStepMeta[] = [
  { id: 1, label: "Role & seniority", summary: "The roles you want and your level." },
  { id: 2, label: "Skills", summary: "At least three, so the matcher has something to work with." },
  { id: 3, label: "Logistics", summary: "Where you work and what you need to be paid." },
  { id: 4, label: "Dealbreakers", summary: "What should never show up in your feed." },
];

export interface WizardProps {
  profile: OnboardingProfile;
  skills: SkillOption[];
  /** The caller's existing `profile_skills`, so step 2 opens showing what is already set. */
  selectedSkills: { skillId: string; level: "familiar" | "proficient" | "expert" }[];
  /** 1–4. Where to open; `onboarding_step` from the profile. */
  initialStep: number;
}

export function Wizard({ profile, skills, selectedSkills, initialStep }: WizardProps) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [isPending, startTransition] = useTransition();
  // Errors that belong to a step the wizard has already left. ONB-002: "Validation error
  // renders inline under the field, not as a toast" — so a failed save keeps the user on the
  // step with the message beside the field, and this region announces it for screen readers.
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Move to `next`, persisting the resume point first.
   *
   * ## Why this awaits instead of firing and forgetting
   *
   * It used to `void setOnboardingStep({ step: next })` and change step immediately. The E2E run
   * caught why that was wrong: `onboarding_step` is the *only* record of how far the user got, and
   * a user who closes the tab, hits back, or loses connection right after clicking Continue lost
   * it — the wizard reopened at step 1 with their answers already saved, which reads as "setup
   * forgot everything" and is the exact failure ONB-001's resume requirement exists to prevent.
   *
   * Awaiting costs one extra round trip per step change, on a four-step flow, immediately after a
   * save that already round-tripped. Paying it makes the guarantee real and testable.
   *
   * The step number is written *before* the step changes so the stored marker never runs ahead of
   * what the user can see. A failure is deliberately swallowed: `setOnboardingStep` returns a
   * result rather than throwing for exactly this case, and losing a resume marker must never cost
   * the user the step transition they asked for.
   */
  async function goToStep(next: number) {
    try {
      await setOnboardingStep({ step: next });
    } catch {
      // No user-visible consequence by design; see the note above.
    }
    setStep(next);
    setSaveError(null);
  }

  // Focus the step heading after the new step renders.
  //
  // An effect keyed on `step` rather than a `requestAnimationFrame` in `goToStep`: the rAF
  // callback can fire before React has committed the new step (the ref would still point at the
  // old heading), and it does not re-run when the DOM settles. The effect runs after commit, by
  // construction, which is also what makes it assertable in a test.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const meta = WIZARD_STEPS[step - 1] ?? WIZARD_STEPS[0]!;

  return (
    <div>
      <h1>Let&apos;s find out what a good job looks like for you</h1>

      {/*
        The rail is an ordered list, not decorative dots: a screen reader reads "step 2 of 4",
        and `aria-current="step"` marks which one this is. It goes on the `<li>` — the element
        that *is* the item — rather than on a nested span, where it would describe the span
        rather than the step.
      */}
      <nav aria-label="Setup progress">
        <ol>
          {WIZARD_STEPS.map((entry) => (
            <li key={entry.id} aria-current={entry.id === step ? "step" : undefined}>
              Step {entry.id} of {WIZARD_STEPS.length}: {entry.label}
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="wizard-step-heading">
        {/*
          `tabIndex={-1}` makes the heading programmatically focusable without adding it to the
          tab order — the whole point is that focus *moves* here, not that you can Tab to it.
        */}
        <h2 id="wizard-step-heading" ref={headingRef} tabIndex={-1}>
          {meta.label}
        </h2>
        <p>{meta.summary}</p>

        {saveError !== null && (
          <p role="alert">
            {saveError} Your answers on this step are saved — try again, or go back.
          </p>
        )}

        {step === 1 && (
          <StepRole
            profile={profile}
            busy={isPending}
            onContinue={(input) =>
              startTransition(async () => {
                const { updateProfile } = await import("@/app/api/actions/profile/update-profile");
                const result = await updateProfile(input);
                if (!result.ok) {
                  setSaveError(result.error?.message ?? "We could not save your roles.");
                  return;
                }
                await goToStep(2);
              })
            }
            onSkip={() => void goToStep(2)}
          />
        )}

        {step === 2 && (
          <StepSkills
            skills={skills}
            initialSelection={selectedSkills}
            busy={isPending}
            onContinue={(selection) =>
              startTransition(async () => {
                const { updateSkills } = await import("@/app/api/actions/profile/update-skills");
                const result = await updateSkills({ skills: selection });
                if (!result.ok) {
                  setSaveError(result.error?.message ?? "We could not save your skills.");
                  return;
                }
                await goToStep(3);
              })
            }
            onBack={() => void goToStep(1)}
          />
        )}

        {step === 3 && (
          <StepLogistics
            profile={profile}
            busy={isPending}
            onContinue={(logistics) =>
              startTransition(async () => {
                const { updateLogistics } = await import(
                  "@/app/api/actions/profile/update-logistics"
                );
                const result = await updateLogistics(logistics);
                if (!result.ok) {
                  setSaveError(result.error?.message ?? "We could not save your preferences.");
                  return;
                }
                await goToStep(4);
              })
            }
            onBack={() => void goToStep(2)}
          />
        )}

        {step === 4 && (
          <StepDealbreakers
            profile={profile}
            busy={isPending}
            onFinish={(dealbreakers) =>
              startTransition(async () => {
                const { updateDealbreakers } = await import(
                  "@/app/api/actions/profile/update-dealbreakers"
                );
                const result = await updateDealbreakers(dealbreakers);
                if (!result.ok) {
                  setSaveError(result.error?.message ?? "We could not save your dealbreakers.");
                  return;
                }
                const { completeOnboarding } = await import(
                  "@/app/api/actions/profile/complete-onboarding"
                );
                const done = await completeOnboarding({ fromStep: 4 });
                if (!done.ok) {
                  setSaveError(done.error?.message ?? "We could not finish setup.");
                  return;
                }
                router.push("/dashboard");
                router.refresh();
              })
            }
            onBack={() => void goToStep(3)}
          />
        )}
      </section>
    </div>
  );
}
