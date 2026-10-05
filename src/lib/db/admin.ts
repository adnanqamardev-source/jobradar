/**
 * admin.ts — service-role Supabase client (docs/02 §2, §3).
 *
 * This is the ONLY module allowed to import `@supabase/supabase-js` directly.
 * All other modules that need service-role access must import from here.
 *
 * Security:
 * - Service-role key never crosses the client boundary
 * - This client bypasses RLS — use only for workers, cron, and admin operations
 * - Never use this client for user-facing requests
 */

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Re-exported so callers can annotate a client without importing
 * `@supabase/supabase-js` directly — the ESLint `no-restricted-imports` rule reserves
 * that import for this module.
 */
export type { SupabaseClient };

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
 * operations, create a client with the user's JWT.
 */
export function createAdminClient() {
  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
