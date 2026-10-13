/**
 * schema-drift.db.test.ts — is the database this repo points at actually at the migrations?
 *
 * ## Why this file exists
 *
 * `migration-drift.test.ts` keeps the *SQL text* honest: numbering, the `v_ranked_jobs`
 * definition, `remote_scope` exposure, function grants. All static. It never opens a
 * connection, so it could not notice that the app's configured database was **three
 * migrations behind the code** for three days.
 *
 * The symptom was the worst kind: `/dashboard` returned Next's *"An error occurred in the
 * Server Components render"* and a digest, on every load, for every user, and no gate
 * anywhere was red. The feed was declared DONE in docs/06 on 2026-10-11. `pnpm db:reset`
 * was green — against a *different* database.
 *
 * So: one probe per migration's **observable** effect, run against whatever
 * `TEST_SUPABASE_URL` names. Point it at local and it is a second `db:reset` gate; point it
 * at staging/production and it is the check that should have run on day one.
 *
 * ## What it can and cannot see
 *
 * PostgREST exposes the `public` schema only, so the probes are **reads through the API**:
 * tables and views by selecting from them, columns by selecting them. That covers every
 * drift that has actually bitten this repo — a missing column (`42703`) or a missing table
 * (`PGRST205`) — because those are the shapes a never-pushed migration leaves behind.
 *
 * It cannot see **functions or triggers**: `rpc()` on a missing function is detectable
 * (`PGRST202`) but calling a present one to prove it exists means running it, and
 * `upsert_job` / `claim_tasks` write. Asserting existence by side effect is worse than not
 * asserting it, so functions are out of scope and noted below rather than faked.
 *
 * Skips without `TEST_SUPABASE_URL`, like every other `*.db.test.ts` here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;

const IS_LOCAL = Boolean(URL && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(URL));

if (!URL || !SERVICE_ROLE) {
  console.warn(
    "[integration] skipping schema drift — set TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE to run",
  );
}

const suite = URL && SERVICE_ROLE ? describe : describe.skip;

/**
 * One probe per migration. `since` is the version that introduced the object; the failure
 * message names it, so the output says "database is behind 0011" instead of "42703".
 *
 * `run` returns a `PromiseLike` because that is what a PostgREST query builder is — it is
 * thenable but not a `Promise`, and annotating it as one produced 18 type errors that said
 * nothing about the drift logic.
 */
interface ProbeResult {
  error: { code?: string; message: string } | null;
}

interface Probe {
  since: string;
  what: string;
  /** A `select` that succeeds only when the object exists. Must be read-only. */
  run: (admin: SupabaseClient) => PromiseLike<ProbeResult>;
}

const PROBES: Probe[] = [
  // 0001_init.sql — the core corpus and account tables the read path joins.
  { since: "0001", what: "table jobs", run: (a) => a.from("jobs").select("id").limit(1) },
  { since: "0001", what: "table profiles", run: (a) => a.from("profiles").select("id").limit(1) },
  { since: "0001", what: "table job_scores", run: (a) => a.from("job_scores").select("id").limit(1) },
  { since: "0001", what: "table job_events", run: (a) => a.from("job_events").select("at").limit(1) },
  { since: "0001", what: "table applications", run: (a) => a.from("applications").select("id").limit(1) },
  { since: "0001", what: "column profiles.last_seen_feed_at", run: (a) => a.from("profiles").select("last_seen_feed_at").limit(1) },
  { since: "0001", what: "column applications.next_action_at", run: (a) => a.from("applications").select("next_action_at").limit(1) },
  { since: "0001", what: "view v_ranked_jobs", run: (a) => a.from("v_ranked_jobs").select("id").limit(1) },

  // 0002_resumes.sql
  { since: "0002", what: "table resumes", run: (a) => a.from("resumes").select("id").limit(1) },
  { since: "0002", what: "table resume_versions", run: (a) => a.from("resume_versions").select("id").limit(1) },

  // 0003_remote_scope.sql
  { since: "0003", what: "column jobs.remote_scope", run: (a) => a.from("jobs").select("remote_scope").limit(1) },
  { since: "0003", what: "view exposes remote_scope", run: (a) => a.from("v_ranked_jobs").select("remote_scope").limit(1) },

  // 0009 / 0010 are functions and are not probeable read-only — see the header.

  // 0011_feed_search.sql — the two that were actually missing in production.
  { since: "0011", what: "column jobs.search_vector", run: (a) => a.from("jobs").select("search_vector").limit(1) },
  { since: "0011", what: "view v_ranked_jobs.first_seen_at", run: (a) => a.from("v_ranked_jobs").select("first_seen_at").limit(1) },
  { since: "0011", what: "view v_ranked_jobs.saved", run: (a) => a.from("v_ranked_jobs").select("saved").limit(1) },
  { since: "0011", what: "view v_ranked_jobs.search_vector", run: (a) => a.from("v_ranked_jobs").select("search_vector").limit(1) },

  // 0012_job_sightings.sql
  { since: "0012", what: "table job_sightings", run: (a) => a.from("job_sightings").select("job_id").limit(1) },
];

suite(`schema drift against ${IS_LOCAL ? "the local stack" : "the configured database"}`, () => {
  // Built in `beforeAll`, not in the suite body. A `describe.skip` body still *executes*, so
  // calling `createClient(undefined!, …)` at describe time threw "supabaseUrl is required"
  // instead of skipping cleanly — a suite that errors when unconfigured is worse than one that
  // skips, because it looks like a real failure in `pnpm test` with no database.
  let admin: SupabaseClient;

  beforeAll(() => {
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("has every table, view and column the migrations create", async () => {
    // Sequential on purpose: the first failure should be the *earliest* missing migration,
    // because that is the one to push. Running them in parallel and collecting would report
    // 0011 and 0012 without saying that 0011 is the root.
    const behind: string[] = [];

    for (const probe of PROBES) {
      const { error } = await probe.run(admin);
      if (error) {
        behind.push(`${probe.since} — ${probe.what}: ${error.code ?? ""} ${error.message}`.trim());
      }
    }

    if (behind.length > 0) {
      const earliest = behind[0]!.split(" — ")[0]!;
      throw new Error(
        `The database at TEST_SUPABASE_URL is missing ${behind.length} object(s) that ` +
          `supabase/migrations/ creates. The app code reads all of them, so requests that ` +
          `touch these fail with a PostgREST error — which, unhandled in a server component, ` +
          `surfaces as a digest-only "An error occurred in the Server Components render".\n` +
          `Earliest missing migration: ${earliest}.\n` +
          `Apply the outstanding migrations, or point TEST_SUPABASE_URL at a current database.\n` +
          behind.map((line) => `  - ${line}`).join("\n"),
      );
    }

    expect(behind).toEqual([]);
  });

  it("knows what it cannot check, so silence is not mistaken for coverage", () => {
    // A drift guard that silently skips half the migrations is worse than none: it reads as
    // green. The gaps are asserted as gaps.
    const covered = new Set(PROBES.map((p) => p.since));
    const migrationsWithNoProbe = ["0004", "0005", "0006", "0007", "0008", "0009", "0010"].filter(
      (v) => !covered.has(v),
    );

    // Each of these creates only functions or triggers, which PostgREST cannot read. If one
    // ever gains a table or column, add a probe here rather than letting it slip past.
    expect(migrationsWithNoProbe).toEqual([
      "0004", // is_admin()
      "0005", // handle_new_user()
      "0006", // profiles updated_at trigger
      "0007", // enqueue_rescore_profile()
      "0008", // grant changes only
      "0009", // claim_tasks()
      "0010", // upsert_job()
    ]);
  });

  it("fails on a table that does not exist, so the probe is not vacuous", async () => {
    // Guards the guard: if `run` swallowed errors, every probe would "pass" forever.
    const { error } = await admin
      .from("a_table_that_is_definitely_not_here")
      .select("id")
      .limit(1);
    expect(error).not.toBeNull();
    // And a missing *column* on a table that does exist — the other shape of drift, and the
    // one that actually took the dashboard down.
    const missingColumn = await admin.from("jobs").select("a_column_that_is_not_here").limit(1);
    expect(missingColumn.error?.code).toBe("42703");
  });
});
