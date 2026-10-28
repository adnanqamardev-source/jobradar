/**
 * application-snapshot.db.test.ts — `applications.job_id` must not take the application with it.
 *
 * ## Why this file exists
 *
 * docs/03 §5.2 ("Deleted job while an application references it") claims `job_snapshot` "keeps
 * title/company/salary; detail shows ... with the tracker record intact". That was **false** until
 * migration `0016`: the column was
 * `not null references jobs(id) on delete cascade`, so deleting a job deleted the application row
 * and the snapshot had nothing to render in.
 *
 * The conflict is invisible in normal operation because production never hard-deletes a job —
 * freshness moves `jobs.status` to `expired` — so the only way to reach the cascade was a test.
 * That is why this is a database test and not a component test: the claim is about what the
 * database is *permitted* to do, and a stubbed client answers any column name and any constraint.
 *
 * ## What it pins
 *
 *  1. Deleting the job leaves the application standing, with `job_id` nulled.
 *  2. `job_snapshot` survives intact, because that is the only remaining source of display data.
 *  3. The tracker is not rendered from here, but `v_ranked_jobs` must not mark an unrelated live
 *     job as `applied` because a user once applied to a deleted one. `a.job_id = j.id` over a NULL
 *     is NULL, which is not true — and if someone "fixes" that subquery with a coalesce, this test
 *     is what notices.
 *
 * Skips without `TEST_SUPABASE_URL`, like every other `*.db.test.ts` here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;
const ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;

if (!URL || !SERVICE_ROLE || !ANON_KEY) {
  console.warn(
    "[integration] skipping application snapshot FK — set TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE and TEST_SUPABASE_ANON_KEY to run",
  );
}

const suite = URL && SERVICE_ROLE && ANON_KEY ? describe : describe.skip;

/** Built in `beforeAll`: a `describe.skip` body still executes, so this cannot be module scope. */
let admin: SupabaseClient;

interface Fixture {
  userId: string;
  email: string;
  jobId: string;
  applicationId: string;
  /** A second live job, used to prove the deleted application does not leak onto it. */
  otherJobId: string;
}

const created: Fixture[] = [];

/** A throwaway credential so the test can hold a real session. Never a real secret. */
const FIXTURE_PASSWORD = "application-snapshot-test-only-4b2d";

const email = (tag: string) =>
  `appsnap-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`;

/**
 * `jobs` requires source_url, dedupe_hash, title and company_name.
 *
 * Inserted one at a time rather than as a batch: a batch needs its rows disambiguated
 * afterwards, and the obvious way to do that is `.select("id").order("external_id")` — ordering by
 * a column that is *not* in the select list, which PostgREST rejects, and which surfaced as the
 * misleading `column jobs.external_id does not exist`. Returning the ids directly is both simpler
 * and immune to that.
 */
async function insertJob(tag: string, suffix: string, title: string, company: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data, error } = await admin
    .from("jobs")
    .insert({
      external_id: `appsnap-${tag}-${suffix}-${stamp}`,
      source_url: `https://example.invalid/appsnap/${tag}/${suffix}`,
      dedupe_hash: `appsnap-${tag}-${suffix}-${stamp}`,
      title,
      company_name: company,
      status: "active",
      raw: {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`job insert failed: ${error.message}`);
  return data.id;
}

async function makeFixture(tag: string): Promise<Fixture> {
  const address = email(tag);

  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: address,
    password: FIXTURE_PASSWORD,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`createUser failed: ${userError?.message}`);

  const jobId = await insertJob(tag, "a", `Snapshot fixture ${tag}`, "Fixture Co");
  const otherJobId = await insertJob(tag, "b", `Unrelated live job ${tag}`, "Other Co");

  const { data: application, error: appError } = await admin
    .from("applications")
    .insert({
      user_id: user.user.id,
      job_id: jobId,
      stage: "applied",
      job_snapshot: { title: `Snapshot fixture ${tag}`, company: "Fixture Co" },
    })
    .select("id")
    .single();
  if (appError) throw new Error(`application insert failed: ${appError.message}`);

  const fixture: Fixture = {
    userId: user.user.id,
    email: address,
    jobId,
    otherJobId,
    applicationId: application.id,
  };
  created.push(fixture);
  return fixture;
}

/**
 * A client holding a **real** session.
 *
 * The password grant, so GoTrue issues a genuine signature-valid JWT. The caller's email is
 * carried on the fixture rather than reconstructed — guessing it produced a fixture that
 * "signs in" as nobody.
 */
async function signedInAs(fixture: Fixture): Promise<SupabaseClient> {
  const client = createClient(URL!, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: fixture.email,
    password: FIXTURE_PASSWORD,
  });
  if (error) throw new Error(`signInWithPassword failed: ${error.message}`);
  return client;
}

suite("applications.job_id on delete set null (migration 0016)", () => {
  beforeAll(() => {
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    for (const { userId, jobId, otherJobId } of created) {
      // applications and application_events cascade from the user; jobs do not cascade from it.
      await admin.from("jobs").delete().in("id", [jobId, otherJobId]);
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it("keeps the application and nulls job_id when the job is deleted", async () => {
    const fixture = await makeFixture("survive");

    await admin.from("jobs").delete().eq("id", fixture.jobId);

    const { data, error } = await admin
      .from("applications")
      .select("id, job_id, job_snapshot")
      .eq("id", fixture.applicationId)
      .maybeSingle();

    if (error) throw new Error(`read failed: ${error.message}`);

    // The whole point: the row is still there. Under the old `on delete cascade` this was null.
    expect(data, "deleting a job must not delete the application").not.toBeNull();
    expect(data?.job_id, "the FK should null the reference, not remove the row").toBeNull();
    expect(data?.job_snapshot).toMatchObject({ title: expect.stringContaining("Snapshot fixture") });
  });

  it("leaves job_id intact when the job is NOT deleted", async () => {
    // The complement, so 0016 cannot be "satisfied" by simply dropping the column's meaning.
    const fixture = await makeFixture("intact");

    const { data, error } = await admin
      .from("applications")
      .select("job_id")
      .eq("id", fixture.applicationId)
      .single();
    if (error) throw new Error(`read failed: ${error.message}`);

    expect(data?.job_id).toBe(fixture.jobId);
  });

  it("does not mark an unrelated live job as applied", async () => {
    // `v_ranked_jobs` computes `applied` as
    //   exists (select 1 from applications a where a.job_id = j.id and a.user_id = auth.uid())
    // For a snapshot-only application that is NULL, so it must not suppress a different live job.
    // A `coalesce(a.job_id, ...)` "fix" in that subquery would show up here.
    const fixture = await makeFixture("bleed");

    await admin.from("jobs").delete().eq("id", fixture.jobId);

    const client = await signedInAs(fixture);
    const { data, error } = await client
      .from("v_ranked_jobs")
      .select("id, applied")
      .eq("id", fixture.otherJobId)
      .maybeSingle();

    if (error) throw new Error(`view read failed: ${error.message}`);
    expect(data?.applied, "a deleted application must not mark another job as applied").toBe(false);
  });

  it("still refuses a second application for the same live job", async () => {
    // `unique (user_id, job_id)` stops constraining rows whose job_id is NULL, because PostgreSQL
    // treats NULLs as distinct. It must keep constraining the rows that still have a job, or the
    // idempotency guarantee `markApplied` depends on is gone.
    const fixture = await makeFixture("unique");

    const { error } = await admin.from("applications").insert({
      user_id: fixture.userId,
      job_id: fixture.jobId,
      stage: "applied",
      job_snapshot: { title: "duplicate" },
    });

    expect(error, "unique (user_id, job_id) must still hold for a live job").not.toBeNull();
    expect(error?.code).toBe("23505");
  });
});