/**
 * step-dealbreakers.tsx — Step 4: blocked companies, excluded keywords, and `Finish` (ONB-005).
 *
 * `Finish` writes the dealbreakers, then calls `completeOnboarding`, which sets
 * `onboarding_completed = true` and enqueues the rescore. The button says what happens next
 * rather than "Submit" — the user is finishing setup, not filling in a form.
 *
 * ## Companies are stored as typed text, not slugs
 *
 * ONB-005 asks for a typeahead that normalises to `slug`, shared with dedupe, and lists that as
 * an open BE gap. There is no `companies` catalogue populated with the corpus (it holds 0 rows
 * after a reset) and no shared slugifier wired to the action, so a typeahead would have nothing
 * to search and would be inventing a lookup. The chips store what the user typed, normalised
 * (trim, case-insensitive dedupe) by the existing action. Recorded as still-open rather than
 * faked with a free-text box that pretends to be a typeahead.
 */

"use client";

import { useState } from "react";

import type { OnboardingProfile } from "@/lib/db/queries/onboarding";
import { normaliseList } from "@/lib/onboarding/normalise";

/** A chip list: type, press Enter or comma to commit, click × to remove. */
function ChipList({
  id,
  legend,
  initial,
  placeholder,
  onChange,
}: {
  id: string;
  legend: string;
  initial: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [values, setValues] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const next = normaliseList([...values, raw]);
    setValues(next);
    setDraft("");
    onChange(next);
  };

  return (
    <div>
      <label htmlFor={id}>{legend}</label>
      <input
        id={id}
        name={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Commit the chip, and do not submit the enclosing form — which would finish
          // setup on every company the user adds.
          event.preventDefault();
          commit(draft);
        }}
      />
      <button type="button" onClick={() => commit(draft)}>
        Add
      </button>

      {values.length > 0 && (
        <ul aria-label={legend}>
          {values.map((value) => (
            <li key={value.toLowerCase()}>
              {value}
              <button
                type="button"
                onClick={() => {
                  const next = values.filter((entry) => entry !== value);
                  setValues(next);
                  onChange(next);
                }}
              >
                Remove {value}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface StepDealbreakersProps {
  profile: OnboardingProfile;
  busy: boolean;
  onFinish: (input: {
    blockedCompanies?: string[];
    excludedKeywords?: string[];
    preferredCompanies?: string[];
  }) => void;
  onBack: () => void;
}

export function StepDealbreakers({ profile, busy, onFinish, onBack }: StepDealbreakersProps) {
  const [blocked, setBlocked] = useState<string[]>(profile.blocked_companies);
  const [excluded, setExcluded] = useState<string[]>(profile.excluded_keywords);
  const [preferred, setPreferred] = useState<string[]>(profile.preferred_companies);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onFinish({
          blockedCompanies: blocked,
          excludedKeywords: excluded,
          preferredCompanies: preferred,
        });
      }}
    >
      <p>Everything here is optional. Leave it blank and you will simply see more roles.</p>

      <ChipList
        id="blocked-companies"
        legend="Companies to hide"
        initial={profile.blocked_companies}
        placeholder="Acme Corp"
        onChange={setBlocked}
      />

      <ChipList
        id="excluded-keywords"
        legend="Keywords to skip"
        initial={profile.excluded_keywords}
        placeholder="contract"
        onChange={setExcluded}
      />

      <ChipList
        id="preferred-companies"
        legend="Companies you would always say yes to"
        initial={profile.preferred_companies}
        placeholder="Globex"
        onChange={setPreferred}
      />

      <button type="submit" disabled={busy}>
        Finish &amp; build my feed
      </button>
      <button type="button" onClick={onBack} disabled={busy}>
        Back
      </button>
    </form>
  );
}
