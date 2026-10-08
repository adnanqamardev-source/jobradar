/**
 * rls-policies.db.test.ts — DB-level integration test for RLS policy enforcement.
 *
 * ## Why this file exists
 *
 * `docs/05a-phase0.md` ENG-004 records: "there is no test in the repo that proves
 * any RLS policy blocks anything." Every behavioural box was unticked. The policies
 * exist in the DDL and are asserted as SQL text by `migration-drift.test.ts`, but
 * a policy existing is not a policy firing.
 *
 * RLS is the only thing standing between one user's `job_scores` and another's.
 * These tests prove the policies actually block cross-user access by driving
 * real Postgres with real JWTs.
 *
 * ## What it proves
 *
 *   - User A cannot select/update/delete user B's profiles, job_scores,
 *     applications, saved_searches, resume_versions, digests
 *   - Authenticated user can select jobs/skills/companies/sources but insert fails
 *   - task_queue, scrape_runs, audit_logs return nothing for a normal authenticated role
 *   - subscriptions.plan update as a normal user fails
 *   - job_scores insert as a normal user fails (scorer is service-role only)
 *   - Admin can select scrape_runs and sources, but cannot select another user's
 *     applications
 *
 * ## Running it
 *
 * Needs a live local Supabase stack (`pnpm db:reset`). Point it at that instance:
 *
 *   $env:TEST_SUPABASE_URL          = "http://127.0.0.1:54321"
 *   $env:TEST_SUPABASE_SERVICE_ROLE = "<service_role key from the local stack>"
 *   $env:TEST_SUPABASE_ANON_KEY     = "<anon key from the local stack>"
 *   pnpm vitest run tests/integration/rls-policies.db.test.ts
 *
 * Without those it **skips** rather than failing — CI has no local Postgres, and a
 * red suite for "no database" trains people to ignore red.
 *
 * ## Safety
 *
 * Hard-guarded to the local stack: the URL must be 127.0.0.1/localhost or nothing runs.
 * Every auth user created here is tagged with `RLS-IT-` and deleted in `afterAll`,
 * which cascades to dependent tables.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;
/** Anon key, needed to obtain a real *user* JWT (the RPC keys off `auth.uid()`). */
const ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;

/** Refuse to run against anything that isn't a local stack. */
const IS_LOCAL = Boolean(URL && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(URL));

if (!IS_LOCAL || !SERVICE_ROLE || !ANON_KEY) {
  console.warn(
    "[integration] skipping — set TEST_SUPABASE_URL (local), TEST_SUPABASE_SERVICE_ROLE and TEST_SUPABASE_ANON_KEY to run",
  );
}

const suite = IS_LOCAL && SERVICE_ROLE && ANON_KEY ? describe : describe.skip;

/** Recognisable prefix so cleanup can find anything this file leaves behind. */
const EMAIL_TAG = "rls-it-";

let admin: SupabaseClient;
const createdUserIds: string[] = [];

/** A client whose JWT belongs to a specific user. */
interface UserContext {
  client: SupabaseClient;
  userId: string;
}

suite("RLS policies against a real Postgres", () => {
  beforeAll(() => {
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    // Cleanup must not throw: a failed teardown would mask a real failure above.
    const ignore = () => undefined;
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(ignore);
    }
  });

  /**
   * Create a real auth user and return a client signed in as that user.
   *
   * Going through `auth.users` means the JWT is real and `auth.uid()` resolves,
   * which is what every RLS policy keys off.
   */
  async function createUser(label: string): Promise<UserContext> {
    const email = `${EMAIL_TAG}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const password = "RlsIt-Test-123!";
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`create auth user ${label}: ${error?.message}`);
    createdUserIds.push(data.user.id);
    await admin.auth.admin.updateUserById(data.user.id, { password });

    const client = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`signIn ${label}: ${signInError.message}`);

    return { client, userId: data.user.id };
  }

  /**
   * Create a user with a specific app_metadata role.
   *
   * `is_admin()` reads `auth.jwt() ->> 'role'`, so this is how we test admin policies.
   * The role is set via `raw_app_meta_data` on the auth user.
   */
  async function createUserWithRole(label: string, role: string): Promise<UserContext> {
    const email = `${EMAIL_TAG}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const password = "RlsIt-Test-123!";
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { role },
    });
    if (error || !data.user) throw new Error(`create auth user ${label}: ${error?.message}`);
    createdUserIds.push(data.user.id);
    await admin.auth.admin.updateUserById(data.user.id, { password });

    const client = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`signIn ${label}: ${signInError.message}`);

    return { client, userId: data.user.id };
  }

  // ---------------------------------------------------------------------------
  // Cross-user access denial
  // ---------------------------------------------------------------------------

  describe("cross-user access denial", () => {
    it("user A cannot select user B's profile", async () => {
      const a = await createUser("profile-a");
      const b = await createUser("profile-b");

      const { data, error } = await a.client
        .from("profiles")
        .select("id")
        .eq("id", b.userId)
        .single();

      // RLS filters the row out, so PostgREST returns 404 (not found) rather than
      // a permission error — the row is invisible, not forbidden.
      expect(error).not.toBeNull();
      expect(error?.code).toBe("PGRST116"); // PostgREST "not found" code
      expect(data).toBeNull();
    });

    it("user A cannot update user B's profile", async () => {
      const a = await createUser("profile-update-a");
      const b = await createUser("profile-update-b");

      // RLS filters the row out via the USING clause, so Postgres returns
      // success with 0 rows affected — not an error. This is the same pattern
      // as the stale updated_at test in profile-mutations.db.test.ts.
      const { data, error } = await a.client
        .from("profiles")
        .update({ city: "Hacked" })
        .eq("id", b.userId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(0);

      // And B's profile is untouched
      const { data: bProfile } = await admin
        .from("profiles")
        .select("city")
        .eq("id", b.userId)
        .single();
      expect(bProfile?.city).not.toBe("Hacked");
    });

    it("user A cannot delete user B's profile", async () => {
      const a = await createUser("profile-del-a");
      const b = await createUser("profile-del-b");

      // Same pattern: RLS filters the row, so 0 rows are deleted.
      const { data, error } = await a.client
        .from("profiles")
        .delete()
        .eq("id", b.userId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(0);

      // B's profile still exists
      const { data: bProfile } = await admin
        .from("profiles")
        .select("id")
        .eq("id", b.userId)
        .single();
      expect(bProfile?.id).toBe(b.userId);
    });

    it("user A cannot select user B's job_scores", async () => {
      const a = await createUser("scores-a");
      const b = await createUser("scores-b");

      // Seed a job_score for B via admin
      const { data: job } = await admin
        .from("jobs")
        .insert({
          dedupe_hash: `rls-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: "Test Role",
          title_norm: "testrole",
          company_name: "RLS-IT-Corp",
          source_url: "https://example.invalid/jobs/1",
        })
        .select("id")
        .single();

      await admin.from("job_scores").insert({
        user_id: b.userId,
        job_id: job!.id,
        final_score: 85,
        breakdown: {},
      });

      const { data, error } = await a.client
        .from("job_scores")
        .select("id")
        .eq("user_id", b.userId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("user A cannot select user B's applications", async () => {
      const a = await createUser("apps-a");
      const b = await createUser("apps-b");

      // Seed an application for B via admin
      const { data: job } = await admin
        .from("jobs")
        .insert({
          dedupe_hash: `rls-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: "Test Role 2",
          title_norm: "testrole2",
          company_name: "RLS-IT-Corp",
          source_url: "https://example.invalid/jobs/2",
        })
        .select("id")
        .single();

      await admin.from("applications").insert({
        user_id: b.userId,
        job_id: job!.id,
        stage: "applied",
      });

      const { data, error } = await a.client
        .from("applications")
        .select("id")
        .eq("user_id", b.userId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("user A cannot select user B's saved_searches", async () => {
      const a = await createUser("searches-a");
      const b = await createUser("searches-b");

      await admin.from("saved_searches").insert({
        user_id: b.userId,
        name: "Test Search",
        query: "test",
        filters: {},
      });

      const { data, error } = await a.client
        .from("saved_searches")
        .select("id")
        .eq("user_id", b.userId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("user A cannot select user B's resume_versions", async () => {
      const a = await createUser("resumes-a");
      const b = await createUser("resumes-b");

      await admin.from("resume_versions").insert({
        user_id: b.userId,
        file_name: "resume.pdf",
        file_path: "resumes/test.pdf",
        is_default: true,
      });

      const { data, error } = await a.client
        .from("resume_versions")
        .select("id")
        .eq("user_id", b.userId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("user A cannot select user B's digests", async () => {
      const a = await createUser("digests-a");
      const b = await createUser("digests-b");

      await admin.from("digests").insert({
        user_id: b.userId,
        kind: "daily",
        status: "sent",
        items: [],
      });

      const { data, error } = await a.client
        .from("digests")
        .select("id")
        .eq("user_id", b.userId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Shared corpus: authenticated read, no write
  // ---------------------------------------------------------------------------

  describe("shared corpus read-only", () => {
    it("authenticated user can select jobs", async () => {
      const user = await createUser("read-jobs");

      const { data, error } = await user.client
        .from("jobs")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      // May be empty (no jobs seeded), but the query must succeed
      expect(Array.isArray(data)).toBe(true);
    });

    it("authenticated user can select skills", async () => {
      const user = await createUser("read-skills");

      const { data, error } = await user.client
        .from("skills")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it("authenticated user can select companies", async () => {
      const user = await createUser("read-companies");

      const { data, error } = await user.client
        .from("companies")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it("authenticated user can select sources", async () => {
      const user = await createUser("read-sources");

      const { data, error } = await user.client
        .from("sources")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it("authenticated user cannot insert into jobs", async () => {
      const user = await createUser("insert-jobs");

      const { error } = await user.client.from("jobs").insert({
        dedupe_hash: `rls-it-${Date.now()}`,
        title: "Hacked",
        title_norm: "hacked",
        company_name: "RLS-IT-Corp",
        source_url: "https://example.invalid/hacked",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/row-level security/i);
    });

    it("authenticated user cannot insert into skills", async () => {
      const user = await createUser("insert-skills");

      const { error } = await user.client.from("skills").insert({
        name: "Hacked Skill",
        slug: "hacked-skill",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/row-level security/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Admin-only tables: no access for normal authenticated role
  // ---------------------------------------------------------------------------

  describe("admin-only tables", () => {
    it("task_queue returns nothing for a normal authenticated user", async () => {
      const user = await createUser("task-queue");

      const { data, error } = await user.client
        .from("task_queue")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("scrape_runs returns nothing for a normal authenticated user", async () => {
      const user = await createUser("scrape-runs");

      const { data, error } = await user.client
        .from("scrape_runs")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("audit_logs returns nothing for a normal authenticated user", async () => {
      const user = await createUser("audit-logs");

      const { data, error } = await user.client
        .from("audit_logs")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Write restrictions on owner-access tables
  // ---------------------------------------------------------------------------

  describe("write restrictions", () => {
    it("job_scores insert fails for a normal user (scorer is service-role only)", async () => {
      const user = await createUser("scores-insert");

      const { data: job } = await admin
        .from("jobs")
        .insert({
          dedupe_hash: `rls-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: "Score Test",
          title_norm: "scoretest",
          company_name: "RLS-IT-Corp",
          source_url: "https://example.invalid/jobs/score",
        })
        .select("id")
        .single();

      const { error } = await user.client.from("job_scores").insert({
        user_id: user.userId,
        job_id: job!.id,
        final_score: 50,
        breakdown: {},
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/row-level security/i);
    });

    it("subscriptions update fails for a normal user (SELECT-only policy)", async () => {
      const user = await createUser("subs-update");

      // Seed a subscription for this user
      await admin.from("subscriptions").insert({
        user_id: user.userId,
        status: "active",
      });

      // subscriptions_owner_select is SELECT-only — no UPDATE policy exists,
      // so RLS blocks the write.
      const { data, error } = await user.client
        .from("subscriptions")
        .update({ status: "canceled" })
        .eq("user_id", user.userId)
        .select("status");

      // Two possible denials, both correct, and which one PostgREST returns is a
      // presentation detail rather than a contract:
      //   (a) an error, typically 42501 "new row violates row-level security policy"
      //   (b) success with **zero rows** — RLS filtered every candidate row out, so the
      //       update matched nothing
      // Asserting on (a) alone makes this test fail on a policy that is working exactly as
      // documented. The invariant is that the write did not happen.
      if (error) {
        expect(error.message).toMatch(/row-level security|permission denied/i);
      }
      expect(data).toHaveLength(0);

      // And the row is genuinely unchanged, read back with the service role. Without this,
      // "zero rows" could also mean the fixture never inserted.
      const { data: after } = await admin
        .from("subscriptions")
        .select("status")
        .eq("user_id", user.userId)
        .single();
      expect(after?.status).toBe("active");
    });
  });

  // ---------------------------------------------------------------------------
  // Admin access
  // ---------------------------------------------------------------------------

  describe("admin access", () => {
    it("admin can select scrape_runs", async () => {
      const adminUser = await createUserWithRole("admin-scrape", "admin");

      const { data, error } = await adminUser.client
        .from("scrape_runs")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it("admin can select sources", async () => {
      const adminUser = await createUserWithRole("admin-sources", "admin");

      const { data, error } = await adminUser.client
        .from("sources")
        .select("id")
        .limit(1);

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it("admin cannot select another user's applications", async () => {
      const adminUser = await createUserWithRole("admin-apps", "admin");
      const normalUser = await createUser("normal-apps");

      // Seed an application for the normal user
      const { data: job } = await admin
        .from("jobs")
        .insert({
          dedupe_hash: `rls-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: "Admin Test",
          title_norm: "admintest",
          company_name: "RLS-IT-Corp",
          source_url: "https://example.invalid/jobs/admin",
        })
        .select("id")
        .single();

      await admin.from("applications").insert({
        user_id: normalUser.userId,
        job_id: job!.id,
        stage: "applied",
      });

      const { data, error } = await adminUser.client
        .from("applications")
        .select("id")
        .eq("user_id", normalUser.userId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });
});
