/**
 * env/index.ts — binds the environment contract to `process.env`.
 *
 * docs/02 §7.2 rule 3: "a Zod `envSchema` throws on missing vars so misconfiguration
 * fails at deploy, not at first user request." This module is that behaviour, and it is
 * the entire reason it exists.
 *
 * Everything else lives in `./schema` and is pure. Application code imports `env` from
 * here; tests and tooling import `parseEnv` from `@/lib/env/schema` instead, which never
 * touches `process.env` and therefore never throws on import.
 *
 * ## Why the binding is its own file
 *
 * When the schema and this binding shared one module, importing the module evaluated the
 * binding — so a test could not touch the schema without first satisfying the entire
 * contract through a global. Splitting the *function* out was not enough; the *module*
 * boundary is what removes `process.env` from the test surface.
 */

import { formatEnvProblems, parseEnv, type Env, type EnvParseResult } from "./schema";

/**
 * The validated environment, bound to `process.env`.
 *
 * Throws at import time when misconfigured, naming every offending variable at once so a
 * single deploy run surfaces all of them.
 */
function bindProcessEnv(): Env {
  const result = parseEnv(process.env);
  if (!result.ok) throw new Error(formatEnvProblems(result.problems));
  return result.env;
}

export const env: Env = bindProcessEnv();

export { formatEnvProblems, parseEnv } from "./schema";
export type { Env, EnvInput, EnvParseResult, EnvProblem } from "./schema";

/** Re-exported for tests that must assert against a known-good record. */
export type { EnvParseResult as ParseResult };