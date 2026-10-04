/**
 * Types for `eslint.config.mjs`.
 *
 * The config is plain ESM JavaScript — it must stay that way, because ESLint loads it
 * directly and the project has no `jiti` or TS loader in that path. But
 * `tests/unit/eslint-guard.test.ts` imports the two allow-lists so it can assert the
 * config against the policy it declares rather than restating that policy.
 *
 * Without this file that import is an implicit `any` under `strict`. Declaring only the
 * two exports the test consumes keeps the surface honest: anything else added to the
 * config stays untyped here on purpose.
 *
 * These are the paths permitted to reach the service-role client — docs/02 §4 rule 3.
 */
export declare const SERVICE_ROLE_ALLOWED: string[];

/** Paths permitted to import `src/lib/db/admin.ts` — docs/02 §4 rule 3. */
export declare const ADMIN_ALLOWED: string[];