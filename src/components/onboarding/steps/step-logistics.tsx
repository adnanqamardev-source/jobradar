/**
 * step-logistics.tsx — Step 3: country, work mode, compensation, visa (ONB-004).
 *
 * ## Hybrid days only appear when hybrid is selected
 *
 * ONB-004 requires the conditional. It is also the only honest rendering: `hybrid_days_max`
 * alongside `work_modes = ["remote"]` describes a preference the user did not express, and the
 * gate reads work modes, so a stale value could look like a constraint that is not there.
 *
 * ## Currency is a fixed allowlist, not a text field
 *
 * ONB-004: "Currency list is a fixed allowlist". The BE only length-checks 3 characters
 * (documented gap), so the UI is the only place the list is enforced — which is why it is a
 * `<select>` and not an input. A 3-letter free-text field would accept "XXX".
 *
 * ## An empty salary clears the floor rather than writing zero
 *
 * BE-304 fixed this on the server: `minSalary: null` writes NULL (clear), omitted leaves it
 * untouched, and `0` is rejected by `.positive()`. So the field maps empty → `null`, and a
 * salary of 0 is simply not expressible — which is correct, since 0 is not a floor.
 */

"use client";

import { useState } from "react";

import type { OnboardingProfile } from "@/lib/db/queries/onboarding";

const WORK_MODES = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
] as const;

type WorkMode = (typeof WORK_MODES)[number]["value"];

/** Fixed allowlist (ONB-004). ISO 4217 codes a job board is likely to carry. */
const CURRENCIES = ["EUR", "USD", "GBP", "INR", "CAD", "AUD", "CHF", "SEK", "JPY", "SGD"];
const PERIODS = [
  { value: "year", label: "per year" },
  { value: "month", label: "per month" },
  { value: "hour", label: "per hour" },
] as const;

export interface StepLogisticsProps {
  profile: OnboardingProfile;
  busy: boolean;
  onContinue: (input: {
    countryCode?: string;
    workModes?: WorkMode[];
    hybridDaysMax?: number;
    minSalary?: number | null;
    salaryCurrency?: string;
    salaryPeriod?: "year" | "month" | "hour";
    visaRequired?: boolean;
  }) => void;
  onBack: () => void;
}

export function StepLogistics({ profile, busy, onContinue, onBack }: StepLogisticsProps) {
  // `"unknown"` is in the column enum but is not a preference, so it is filtered out of the
  // initial selection — otherwise the picker would preselect nothing and the user could not
  // tell that "any" is the default.
  const [workModes, setWorkModes] = useState<WorkMode[]>(() =>
    profile.work_modes.filter((mode): mode is WorkMode =>
      WORK_MODES.some((option) => option.value === mode),
    ),
  );
  const [country, setCountry] = useState(profile.country_code ?? "");
  const [hybridDays, setHybridDays] = useState(
    profile.hybrid_days_max == null ? "" : String(profile.hybrid_days_max),
  );
  const [minSalary, setMinSalary] = useState(profile.min_salary == null ? "" : String(profile.min_salary));
  const [currency, setCurrency] = useState(profile.salary_currency ?? "EUR");
  const [period, setPeriod] = useState<"year" | "month" | "hour">(
    profile.salary_period === "month" || profile.salary_period === "hour"
      ? profile.salary_period
      : "year",
  );
  const [visaRequired, setVisaRequired] = useState(profile.visa_required === true);

  const hybrid = workModes.includes("hybrid");

  function toggleMode(mode: WorkMode) {
    setWorkModes((current) =>
      current.includes(mode) ? current.filter((entry) => entry !== mode) : [...current, mode],
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const salary = minSalary.trim() === "" ? null : Number(minSalary);
        onContinue({
          ...(country.trim().length === 2 ? { countryCode: country.trim().toUpperCase() } : {}),
          ...(workModes.length > 0 ? { workModes } : {}),
          // Only sent while hybrid is selected, so clearing hybrid also clears the days
          // rather than leaving a stale value behind.
          ...(hybrid && hybridDays.trim() !== ""
            ? { hybridDaysMax: Number(hybridDays) }
            : {}),
          ...(salary !== null && Number.isFinite(salary) && salary > 0 ? { minSalary: salary } : {}),
          ...(salary !== null && Number.isFinite(salary) && salary > 0
            ? { salaryCurrency: currency, salaryPeriod: period }
            : {}),
          visaRequired,
        });
      }}
    >
      <fieldset>
        <legend>Where can you work?</legend>
        {WORK_MODES.map((mode) => (
          <div key={mode.value}>
            <input
              type="checkbox"
              id={`work-mode-${mode.value}`}
              name="workModes"
              value={mode.value}
              checked={workModes.includes(mode.value)}
              onChange={() => toggleMode(mode.value)}
            />
            <label htmlFor={`work-mode-${mode.value}`}>{mode.label}</label>
          </div>
        ))}
      </fieldset>

      {hybrid && (
        <div>
          <label htmlFor="onboarding-hybrid-days">Maximum days in the office per week</label>
          <input
            id="onboarding-hybrid-days"
            name="hybridDaysMax"
            type="number"
            min={0}
            max={5}
            value={hybridDays}
            onChange={(event) => setHybridDays(event.target.value)}
          />
        </div>
      )}

      <div>
        <label htmlFor="onboarding-country">Country code (optional)</label>
        <input
          id="onboarding-country"
          name="countryCode"
          type="text"
          maxLength={2}
          placeholder="DE"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          aria-describedby="onboarding-country-help"
        />
        <p id="onboarding-country-help">Two letters, e.g. DE, US, IN.</p>
      </div>

      <fieldset>
        <legend>Minimum salary (optional)</legend>
        <label htmlFor="onboarding-min-salary">Minimum</label>
        <input
          id="onboarding-min-salary"
          name="minSalary"
          type="number"
          min={1}
          value={minSalary}
          onChange={(event) => setMinSalary(event.target.value)}
        />
        <label htmlFor="onboarding-salary-currency">Currency</label>
        <select
          id="onboarding-salary-currency"
          name="salaryCurrency"
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <label htmlFor="onboarding-salary-period">Period</label>
        <select
          id="onboarding-salary-period"
          name="salaryPeriod"
          value={period}
          onChange={(event) => setPeriod(event.target.value as "year" | "month" | "hour")}
        >
          {PERIODS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </fieldset>

      <div>
        <input
          type="checkbox"
          id="onboarding-visa"
          name="visaRequired"
          checked={visaRequired}
          onChange={(event) => setVisaRequired(event.target.checked)}
        />
        <label htmlFor="onboarding-visa">I need visa sponsorship</label>
      </div>

      <button type="submit" disabled={busy}>
        Continue
      </button>
      <button type="button" onClick={onBack} disabled={busy}>
        Back
      </button>
    </form>
  );
}
