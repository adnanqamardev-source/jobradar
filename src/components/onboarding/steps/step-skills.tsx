/**
 * step-skills.tsx — Step 2: the skills picker (ONB-003).
 *
 * Searchable over `skills` name **and** aliases, per-skill proficiency, minimum three to
 * continue. Every control is a real `<button>` inside a list, so the whole picker is keyboard
 * operable without a roving-tabindex implementation.
 *
 * ## Search is client-side over the loaded catalogue
 *
 * `page.tsx` loads the full `skills` table (10 seeded rows, and the table is small and
 * authenticated-readable) and filters in memory. That avoids a round-trip per keystroke and
 * makes the ≤200ms debounce in ONB-003 trivially satisfied — there is no network to wait for.
 * If the catalogue ever grows past a few hundred rows this needs a server query, and the
 * `useDeferredValue` below is the seam to change.
 *
 * ## Free text is not offered, deliberately
 *
 * docs/05b ONB-003 lists "Free-text adds create a pending skill entry" as an **open BE gap**:
 * `updateSkills` rejects unknown ids outright, and inventing a `skills` row means writing to a
 * shared corpus table from a user action. Both are decisions, not omissions — so the picker
 * offers the canonical list only, and the gap stays visible rather than half-built.
 */

"use client";

import { useDeferredValue, useMemo, useState } from "react";

import type { SkillOption } from "../wizard";
import { MIN_SKILLS } from "@/lib/onboarding/normalise";

export type SkillLevel = "familiar" | "proficient" | "expert";

export interface SkillSelection {
  skillId: string;
  level: SkillLevel;
}

const LEVELS: { value: SkillLevel; label: string }[] = [
  { value: "familiar", label: "Familiar" },
  { value: "proficient", label: "Proficient" },
  { value: "expert", label: "Expert" },
];

export interface StepSkillsProps {
  skills: SkillOption[];
  initialSelection: SkillSelection[];
  busy: boolean;
  onContinue: (selection: SkillSelection[]) => void;
  onBack: () => void;
}

export function StepSkills({
  skills,
  initialSelection,
  busy,
  onContinue,
  onBack,
}: StepSkillsProps) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<SkillSelection[]>(initialSelection);

  // Deferred rather than debounced: typing stays responsive, and the (cheap) filter re-runs
  // when the value settles. With an in-memory filter over ~10 rows this is well under the
  // 200ms ONB-003 budget without a timer to leak.
  const deferredQuery = useDeferredValue(query);

  const results = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (needle === "") return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.aliases.some((alias) => alias.toLowerCase().includes(needle)),
    );
  }, [skills, deferredQuery]);

  const selectedIds = new Set(selection.map((entry) => entry.skillId));

  function toggle(skillId: string) {
    setSelection((current) =>
      current.some((entry) => entry.skillId === skillId)
        ? current.filter((entry) => entry.skillId !== skillId)
        // Default proficiency, not `familiar`: `proficient` is the neutral middle and matches
        // the column default, so an unedited selection reads as a deliberate "I'm fine at this".
        : [...current, { skillId, level: "proficient" }],
    );
  }

  function setLevel(skillId: string, level: SkillLevel) {
    setSelection((current) =>
      current.map((entry) => (entry.skillId === skillId ? { ...entry, level } : entry)),
    );
  }

  const complete = selection.length >= MIN_SKILLS;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete) return;
        onContinue(selection);
      }}
    >
      <div>
        <label htmlFor="onboarding-skill-search">Search skills</label>
        <input
          id="onboarding-skill-search"
          name="skillSearch"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-describedby="onboarding-skill-help"
        />
        <p id="onboarding-skill-help">
          Matches names and aliases. Choose at least {MIN_SKILLS}.
        </p>
      </div>

      <p role="status">
        {selection.length} selected
        {complete ? "" : ` — ${MIN_SKILLS - selection.length} more needed`}
      </p>

      <ul aria-label="Available skills">
        {results.map((skill) => {
          const picked = selectedIds.has(skill.id);
          return (
            <li key={skill.id}>
              {/*
                A checkbox would look right and be wrong here: the row also carries a
                proficiency `<select>`, and nesting an interactive control inside a `<label>`
                for a checkbox makes the label's activation ambiguous. Two sibling buttons is
                unambiguous and keyboard-operable.
              */}
              <button
                type="button"
                aria-pressed={picked}
                onClick={() => toggle(skill.id)}
              >
                {picked ? "Remove" : "Add"} {skill.name}
              </button>
              {picked && (
                <>
                  <label htmlFor={`level-${skill.id}`}>Level for {skill.name}</label>
                  <select
                    id={`level-${skill.id}`}
                    name={`level-${skill.id}`}
                    value={selection.find((entry) => entry.skillId === skill.id)?.level ?? "proficient"}
                    onChange={(event) => setLevel(skill.id, event.target.value as SkillLevel)}
                  >
                    {LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        {level.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {results.length === 0 && <p>No skill matches that search.</p>}

      <button type="submit" disabled={!complete || busy}>
        Continue
      </button>
      <button type="button" onClick={onBack} disabled={busy}>
        Back
      </button>
    </form>
  );
}
