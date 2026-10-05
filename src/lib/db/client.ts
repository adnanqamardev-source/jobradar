/**
 * client.ts — service-role Supabase client factory.
 *
 * For queue workers, cron handlers, and admin operations only. User-scoped work must use
 * `createUserClient` from `./user-client`, which fails closed until BE-302 exists.
 *
 * Security:
 * - Service-role bypasses RLS; never use it for a user-facing request
 * - All user-facing reads/writes go through RLS with the anon key
 *
 * Note: the `@supabase/supabase-js` import lives in `admin.ts` to comply with the ESLint
 * `no-restricted-imports` rule, which reserves that import for a single sanctioned module.
 */

import { createAdminClient } from "./admin";

/**
 * Create a Supabase client with the service-role key.
 *
 * WARNING: This client bypasses RLS. Use only for:
 * - Queue workers (ingest, scoring, digests)
 * - Cron handlers
 * - Admin operations
 * - Server-side operations that need to read across users
 *
 * Never use this client for user-facing requests. For user-scoped
 * operations, use `createUserClient` from `./user-client`.
 */
export function createClient() {
  return createAdminClient();
}