/**
 * normalise.ts — input normalisation for the onboarding wizard (ONB-002, ONB-005).
 *
 * ## Why this is client-side and not in the actions
 *
 * docs/05b flags two BE gaps: "titles are stored verbatim (no trim/dedupe)" and the
 * dealbreaker normaliser "is not a slug and is not shared". Widening the four existing request
 * schemas to normalise server-side would change an already-shipped seam, so the wizard
 * normalises before it calls them. That satisfies "Free-text titles are accepted and normalised
 * (trim, dedupe, case preserved for display)" for every path through this UI, and leaves the
 * action contract untouched.
 *
 * It is **not** a substitute for server-side normalisation: any other caller still writes
 * verbatim. Recorded as still-open rather than papered over.
 *
 * ## Case is preserved, comparison is not
 *
 * Titles are displayed back to the user ("Senior Frontend Engineer"), so folding case would
 * show them something they did not type. But "React" and "react" must not become two chips, so
 * the *comparison* key is lowercased while the *stored* value keeps its first-seen casing.
 * First-seen wins because the user typed that one first.
 */

/** Maximum entries per list, matching the `.max()` caps in `types/api.ts`. */
export const MAX_TITLES = 10;
export const MAX_LIST_ENTRIES = 50;

/**
 * Normalise a free-text list: trim, drop empties, de-duplicate case-insensitively.
 *
 * @param input   raw values, one per comma or Enter in the UI
 * @param max     cap; entries beyond it are dropped rather than erroring, because a wizard
 *                should not fail a save over the 11th keyword
 * @returns the surviving values in first-seen order, with their original casing
 */
export function normaliseList(input: readonly string[], max = MAX_LIST_ENTRIES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of input) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    // The comparison key is lowercased; the stored value keeps `trimmed`.
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }

  return out;
}

/**
 * Split a comma-separated string into normalised entries.
 *
 * Commas are the delimiter because that is what people paste, but titles legitimately contain
 * commas ("Sales, EMEA") — so a comma inside a bracket pair is not a split point. Good enough
 * for a wizard; a real fix is one entry per chip with Enter to commit, which the UI also does.
 */
export function splitAndNormalise(input: string, max = MAX_LIST_ENTRIES): string[] {
  return normaliseList(input.split(","), max);
}

/**
 * `true` when the step's minimum is met and Continue may be enabled (ONB-001).
 *
 * Exported so the wizard and its tests agree on the rule instead of each restating it: the
 * failure mode this replaces was a `disabled` attribute and a validation message that could
 * disagree.
 */
export function stepOneComplete(titles: readonly string[]): boolean {
  // ONB-002: "At least one title required to continue".
  return titles.filter((title) => title.trim() !== "").length >= 1;
}

/** ONB-003: "Minimum 3 skills to continue". Enforced again by `updateSkills`. */
export const MIN_SKILLS = 3;

export function stepTwoComplete(skillCount: number): boolean {
  return skillCount >= MIN_SKILLS;
}
