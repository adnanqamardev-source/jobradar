/**
 * constants.ts — the wizard's shape, shared by the page, the components and the actions.
 *
 * ## Why this file exists
 *
 * `ONBOARDING_STEPS` started life as an export from `complete-onboarding.ts`, and the build
 * failed: Next requires a `"use server"` module to export **only async functions**, so a
 * `const` alongside them is a hard error ("Only async functions are allowed to be exported in
 * a 'use server' file"). It is a number, not an action, so it lives here instead of being
 * inlined in three places that could then disagree.
 */

export const ONBOARDING_STEPS = 4;

/**
 * The value `onboarding_step` takes once setup is finished.
 *
 * One past the last step, so a clamped reader (`Math.min(step, ONBOARDING_STEPS)`) still
 * lands on a real step rather than on a step that does not exist.
 */
export const ONBOARDING_COMPLETE_STEP = ONBOARDING_STEPS;
