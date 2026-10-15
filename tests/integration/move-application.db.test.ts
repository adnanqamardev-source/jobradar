/**
 * move-application.db.test.ts — `move_application` must be reachable only by its owner.
 *
 * ## Why this file exists
 *
 * `move_application` (0001) is `SECURITY DEFINER`, so it bypasses RLS, and its only filter was
 * `where id = app_id`. Two defects, both **proven on the linked project** rather than reasoned
 * about:
 *
 * 1. `has_function_privilege('anon', …, 'EXECUTE')` was true, because Supabase's
 *    `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon` — the trap `0008` already had to close
 *    for `enqueue_rescore_profile`. Calling the RPC with the **anon key** returned
 *    `P0001 Application not found`, which is the function's own exception: the body ran, fully
 *    unauthenticated. A permission denial would have been `42501`.
 * 2. No ownership filter, so an authenticated caller could move **another user's** application.
 *
 * A server action wrapping this function would have inherited both. Migration `0015` fixes them.
 *
 * ## Why it needs a real database
 *
 * RLS bypass, `SECURITY DEFINER`, and function privileges are all Postgres behaviour that a mocked
 * Supabase client defines away. The unit suite for the tracker will assert what the *action*
 * passes; only this can assert who the database lets through.
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
    "[integration] skipping move_application security — set TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE and TEST_SUPABASE_ANON_KEY to run",
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
}

const created: Fixture[] = [];

/**
 * The password the fixture user signs in with.
 *
 * A throwaway constant, never a credential: it exists so the test can obtain a **real** Supabase
 * session. A forged JWT would be rejected by GoTrue before Postgres saw it, which would make the
 * happy-path assertion pass whether or not the function worked.
 */
const FIXTURE_PASSWORD = "move-application-test-only-7c1e";

const email = (tag: string) =>
  `moveapp-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`;

/**
 * A user with an application in `applied` — the only stage from which `screening` is legal.
 *
 * Goes through `auth.admin.createUser` so the profile row comes from the real `handle_new_user`
 * trigger, matching `profile-mutations.db.test.ts`. The application is written directly rather
 * than through `markApplied`, because this test is about who may *move* it, not how it was created.
 */
async function makeAppliedApplication(tag: string): Promise<Fixture> {
  const address = email(tag);

  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: address,
    password: FIXTURE_PASSWORD,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`createUser failed: ${userError?.message}`);

  // `jobs` requires source_url, dedupe_hash, title and company_name; there is no job_snapshot
  // column on jobs (that lives on applications).
  const { data: job, error: jobError } = await admin
    .from("jobs")
    .insert({
      external_id: `moveapp-${tag}-${Date.now()}`,
      source_url: `https://example.invalid/moveapp/${tag}`,
      dedupe_hash: `moveapp-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: `Move application fixture ${tag}`,
      company_name: "Fixture Co",
      description_text: "fixture",
      status: "active",
      raw: {},
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`job insert failed: ${jobError.message}`);

  const { data: application, error: appError } = await admin
    .from("applications")
    .insert({
      user_id: user.user.id,
      job_id: job.id,
      stage: "applied",
      job_snapshot: { title: `Move application fixture ${tag}`, company: "Fixture Co" },
    })
    .select("id")
    .single();
  if (appError) throw new Error(`application insert failed: ${appError.message}`);

  const fixture: Fixture = {
    userId: user.user.id,
    email: address,
    jobId: job.id,
    applicationId: application.id,
  };
  created.push(fixture);
  return fixture;
}

/** The current stage of an application, read through the service role so RLS cannot hide it. */
async function stageOf(applicationId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("applications")
    .select("stage")
    .eq("id", applicationId)
    .single();
  if (error) throw new Error(`could not read stage: ${error.message}`);
  return data.stage;
}

/** Event count, so a denied move is shown to have written nothing rather than "not committed". */
async function eventCount(applicationId: string): Promise<number> {
  const { count, error } = await admin
    .from("application_events")
    .select("id", { count: "exact", head: true })
    .eq("application_id", applicationId);
  if (error) throw new Error(`could not count events: ${error.message}`);
  return count ?? 0;
}

/**
 * A client holding a **real** session for `fixture`.
 *
 * Uses the password grant so GoTrue issues a genuine, signature-valid JWT. A hand-forged one is
 * rejected before Postgres sees the call, which would make every assertion here pass vacuously —
 * the deny tests would pass because the request never arrived, and the happy path would "pass"
 * because nothing was expected to change.
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

suite("move_application access control (migration 0015)", () => {
  beforeAll(() => {
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    for (const { userId, jobId } of created) {
      // `applications` and `application_events` cascade from these, but explicit is clearer than
      // relying on the order the service role happens to apply them in.
      await admin.from("job_events").delete().eq("job_id", jobId);
      await admin.from("jobs").delete().eq("id", jobId);
      await admin.auth.admin.deleteUser(userId);
    }
  });

  // Deliberately no assertion on `has_function_privilege` here. It is a pg_catalog function and
  // PostgREST exposes only the `public` schema, so it cannot be called from this harness —
  // an earlier draft tried, and both tests errored with PGRST202 rather than testing anything.
  //
  // Behaviour is the contract that matters, and the two tests below pin it directly: a call from
  // `anon` must fail, and a signed-in caller must not reach another user's row. A future
  // regrant to `anon` breaks the first; a future removal of the ownership filter breaks the
  // second. The grants in 0015 are the mechanism, not the promise.

  it("rejects an unauthenticated call without changing anything", async () => {
    const fixture = await makeAppliedApplication("anon");
    const before = await eventCount(fixture.applicationId);

    // The anon key, no session. Before 0015 this reached the function body and answered
    // "Application not found" as `P0001` — its own exception, which proved reachability.
    const anon = createClient(URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("move_application", {
      app_id: fixture.applicationId,
      note: "should not apply",
      to_stage: "screening",
    });

    expect(error, "anon must not be able to call move_application").not.toBeNull();
    expect(await stageOf(fixture.applicationId)).toBe("applied");
    expect(await eventCount(fixture.applicationId)).toBe(before);
  });

  it("refuses to move another user's application", async () => {
    const owner = await makeAppliedApplication("owner");
    const stranger = await makeAppliedApplication("stranger");
    const before = await eventCount(owner.applicationId);

    const asStranger = await signedInAs(stranger);
    const { error } = await asStranger.rpc("move_application", {
      app_id: owner.applicationId,
      note: "should not apply",
      to_stage: "screening",
    });

    expect(error, "a signed-in user must not move someone else's application").not.toBeNull();
    expect(await stageOf(owner.applicationId)).toBe("applied");
    expect(await eventCount(owner.applicationId)).toBe(before);
  });

  it("reports an unowned row the same way as a missing one", async () => {
    // Different messages would make the function an existence oracle: "not yours" confirms the id
    // exists. Asserting the messages match is the assertion that matters.
    const stranger = await makeAppliedApplication("oracle");
    const asStranger = await signedInAs(stranger);

    const unowned = await asStranger.rpc("move_application", {
      app_id: "00000000-0000-4000-8000-00000000dead",
      note: null,
      to_stage: "screening",
    });
    const missing = await asStranger.rpc("move_application", {
      app_id: "00000000-0000-4000-8000-00000000beef",
      note: null,
      to_stage: "screening",
    });

    expect(unowned.error?.message).toBe(missing.error?.message);
  });

  it("lets the owner move their own application, and writes the history row", async () => {
    // The guard must not be a blanket deny: if this fails, the tracker has no legal path forward.
    // Unlike the deny tests, this one asserts that something **changed** — so it fails if the
    // function is simply unreachable for everyone.
    const fixture = await makeAppliedApplication("happy");
    const before = await eventCount(fixture.applicationId);

    const asOwner = await signedInAs(fixture);
    const { error } = await asOwner.rpc("move_application", {
      app_id: fixture.applicationId,
      note: "moved by owner",
      to_stage: "screening",
    });

    expect(error, `owner move failed: ${error?.message}`).toBeNull();
    expect(await stageOf(fixture.applicationId)).toBe("screening");
    expect(await eventCount(fixture.applicationId)).toBe(before + 1);
  });

  it("still rejects an illegal transition for the owner", async () => {
    // `applied` -> `offer` is not a legal hop. Confirming 0015 did not loosen the rules while
    // adding the ownership filter.
    const fixture = await makeAppliedApplication("illegal");
    const before = await eventCount(fixture.applicationId);

    const asOwner = await signedInAs(fixture);
    const { error } = await asOwner.rpc("move_application", {
      app_id: fixture.applicationId,
      note: null,
      to_stage: "offer",
    });

    expect(error?.message).toContain("Invalid transition");
    expect(await stageOf(fixture.applicationId)).toBe("applied");
    expect(await eventCount(fixture.applicationId)).toBe(before);
  });
});