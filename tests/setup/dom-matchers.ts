/**
 * jest-dom matchers for component tests.
 *
 * `@testing-library/jest-dom` is already a devDependency but was never wired: the repo had
 * no component tests, so there was nothing to register matchers for. Importing the `/vitest`
 * entry registers them on vitest's `expect` — the bare entry expects Jest's global.
 *
 * This runs for `node`-environment tests too, where no matcher from this package is used.
 * It is import-safe there (it only extends `expect`), so a per-environment setup file would
 * cost more than it saves.
 */

import "@testing-library/jest-dom/vitest";