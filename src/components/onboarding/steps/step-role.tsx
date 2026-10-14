/**
 * step-role.tsx — Step 1: target roles & seniority (ONB-002).
 *
 * Titles are chips with remove, plus free text committed with Enter or the Add button — never
 * a comma-separated blob, because "Sales, EMEA" is a real title and splitting on commas loses
 * it. The `Enter` handler stops propagation so it does not also submit an enclosing form.
 *
 * `Continue` is disabled until at least one title exists (ONB-001/ONB-002) and `Skip for now`
 * is always available, which is what keeps a user from being trapped: a profile with no titles
 * still gets a feed, just a weaker one.
 */

"use client";

import { useState } from "react";

import type { Seniority } from "@/types/db";
import type { OnboardingProfile } from "@/lib/db/queries/onboarding";
import { MAX_TITLES, normaliseList, stepOneComplete } from "@/lib/onboarding/normalise";

/** The same nine values as `seniority` in 0001_init.sql; `unknown` is the default. */
const SENIORITY_OPTIONS: { value: Seniority; label: string }[] = [
  { value: "intern", label: "Intern" },
  { value: "junior", label: "Junior" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "lead", label: "Lead" },
  { value: "staff", label: "Staff" },
  { value: "principal", label: "Principal" },
  { value: "director", label: "Director" },
  { value: "exec", label: "Executive" },
];

export interface StepRoleProps {
  profile: OnboardingProfile;
  busy: boolean;
  onContinue: (input: { targetTitles: string[]; seniority: Seniority; yearsExperience?: number }) => void;
  onSkip: () => void;
}

export function StepRole({ profile, busy, onContinue, onSkip }: StepRoleProps) {
  const [titles, setTitles] = useState<string[]>(() => normaliseList(profile.target_titles, MAX_TITLES));
  const [draft, setDraft] = useState("");
  const [seniority, setSeniority] = useState<Seniority>(profile.seniority);
  const [years, setYears] = useState(profile.years_experience == null ? "" : String(profile.years_experience));

  function addTitle() {
    const added = normaliseList([...titles, draft], MAX_TITLES);
    setTitles(added);
    setDraft("");
  }

  function removeTitle(title: string) {
    setTitles((current) => current.filter((entry) => entry !== title));
  }

  const complete = stepOneComplete(titles);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete) return;
        const yearsExperience = years.trim() === "" ? undefined : Number(years);
        onContinue({
          targetTitles: titles,
          seniority,
          ...(yearsExperience !== undefined && Number.isFinite(yearsExperience)
            ? { yearsExperience }
            : {}),
        });
      }}
    >
      <div>
        <label htmlFor="onboarding-title-draft">Target job titles</label>
        <input
          id="onboarding-title-draft"
          name="title"
          type="text"
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter commits the chip. `preventDefault` stops the implicit form submit, which
            // would advance the wizard on every chip the user adds.
            if (event.key !== "Enter") return;
            event.preventDefault();
            addTitle();
          }}
          aria-describedby="onboarding-title-help"
        />
        <p id="onboarding-title-help">
          Press Enter to add a title. Add at least one; up to {MAX_TITLES}.
        </p>
        <button type="button" onClick={addTitle}>
          Add title
        </button>
      </div>

      {titles.length > 0 && (
        <ul aria-label="Your target titles">
          {titles.map((title) => (
            <li key={title.toLowerCase()}>
              {title}
              <button type="button" onClick={() => removeTitle(title)}>
                Remove {title}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <label htmlFor="onboarding-seniority">Seniority</label>
        <select
          id="onboarding-seniority"
          name="seniority"
          value={seniority}
          onChange={(event) => setSeniority(event.target.value as Seniority)}
        >
          {SENIORITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="onboarding-years">Years of experience (optional)</label>
        <input
          id="onboarding-years"
          name="yearsExperience"
          type="number"
          min={0}
          max={60}
          step={0.5}
          value={years}
          onChange={(event) => setYears(event.target.value)}
        />
      </div>

      <button type="submit" disabled={!complete || busy}>
        Continue
      </button>
      <button type="button" onClick={onSkip} disabled={busy}>
        Skip for now
      </button>
    </form>
  );
}
