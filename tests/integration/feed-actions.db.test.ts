/**
 * feed-actions.db.test.ts — the feed actions' *database* assumptions (BE-305).
 *
 * `tests/unit/feed-actions.test.ts` pins the TypeScript logic against a client
 * double. This file pins the two claims that only a real PostgREST can settle:
 *
 *   1. **An ignored duplicate is not returned.** With
 *      `Prefer: resolution=ignore-duplicates`, a conflicting row is omitted from
 *      the returned representation. `markApplied` depends on this: it treats a
 *      returned row as "created" and resolves the id by a second read otherwise.
 *      If this file shows the duplicate *is* returned, that fallback becomes
 *      dead code and `.single()` would have been fine.
 *   2. **`.maybeSingle()` fails on duplicate `job_events` rows.** The primary key
 *      is `(user_id, job_id, event, at)` — `at` is in the key, so two inserts of
 *      the same event both succeed, and a later `maybeSingle()` is a PostgREST
 *      error rather than a row. `saveJob`/`dismissJob` read with `.limit(1)`.
 *
 * These run the action's exact query sequence against the local stack. The
 * Server Actions themselves cannot be called here — `requireUser()` needs a
 * cookie-bound session — so what is under test is the query shape, which is the
 * part that was wrong.
 *
 * Skips (rather than fails) without a local stack, per `dedupe.db.test.ts`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;
const ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;

const IS_LOCAL = Boolean(URL && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(URL));

if (!IS_LOCAL || !SERVICE_ROLE || !ANON_KEY) {
  console.warn(
    "[integration] skipping — set TEST_SUPABASE_URL (local), TEST_SUPABASE_SERVICE_ROLE and TEST_SUPABASE_ANON_KEY to run",
  );
}

const suite = IS_LOCAL && SERVICE_ROLE && ANON_KEY ? describe : describe.skip;

const TAG = "feed-actions-it";

let admin: SupabaseClient;
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];

suite("feed actions against a real Postgres", () => {
  beforeAll(() => {
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    const ignore = () => undefined;
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(ignore);
    }
    if (createdJobIds.length > 0) {
      await admin.from("jobs").delete().in("id", createdJobIds).then(ignore, ignore);
    }
  });

  async function seedUser(label: string): Promise<string> {
    const email = `${TAG}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`create auth user ${label}: ${error?.message}`);
    createdUserIds.push(data.user.id);
    return data.user.id;
  }

  async function seedJob(label: string): Promise<string> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { data, error } = await admin
      .from("jobs")
      .insert({
        source_url: `https://${TAG}.example/${label}/${suffix}`,
        dedupe_hash: `${TAG}-${suffix}`,
        title: `${TAG} ${label}`,
        company_name: `${TAG} Co ${suffix}`,
        skills: ["react"],
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed job ${label}: ${error?.message}`);
    createdJobIds.push(data.id as string);
    return data.id as string;
  }

  const snapshot = { title: "t", company_name: "c", source_url: "https://x/y" };

  /** The `markApplied` write path, minus auth — kept deliberately literal. */
  async function markAppliedSequence(userId: string, jobId: string) {
    const { data: applicationRow, error: upsertError } = await admin
      .from("applications")
      .upsert(
        {
          user_id: userId,
          job_id: jobId,
          stage: "applied",
          source: "manual",
          job_snapshot: snapshot,
        },
        { onConflict: "user_id,job_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (upsertError) throw upsertError;

    const applicationId =
      applicationRow !== null
        ? applicationRow.id
        : (
            await admin
              .from("applications")
              .select("id")
              .eq("user_id", userId)
              .eq("job_id", jobId)
              .maybeSingle()
          ).data?.id;

    if (!applicationId) throw new Error("no application id resolved");

    const { data: existingEvent } = await admin
      .from("application_events")
      .select("id")
      .eq("application_id", applicationId as string)
      .is("from_stage", null)
      .eq("to_stage", "applied")
      .limit(1)
      .maybeSingle();

    if (!existingEvent) {
      const { error } = await admin
        .from("application_events")
        .insert({ application_id: applicationId, from_stage: null, to_stage: "applied" });
      if (error) throw error;
    }
    return applicationId;
  }

  it("returns the row on first apply and nothing on the duplicate", async () => {
    const userId = await seedUser("upsert");
    const jobId = await seedJob("upsert");

    const first = await admin
      .from("applications")
      .upsert(
        { user_id: userId, job_id: jobId, stage: "applied", job_snapshot: snapshot },
        { onConflict: "user_id,job_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    expect(first.error).toBeNull();
    expect(first.data).not.toBeNull();

    const second = await admin
      .from("applications")
      .upsert(
        { user_id: userId, job_id: jobId, stage: "applied", job_snapshot: snapshot },
        { onConflict: "user_id,job_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    // The whole point: an ignored duplicate comes back EMPTY.
    expect(second.error).toBeNull();
    expect(second.data).toBeNull();
  });

  it("would have thrown PGRST116 with .single() — the bug that was fixed", async () => {
    const userId = await seedUser("single");
    const jobId = await seedJob("single");

    const insert = () =>
      admin
        .from("applications")
        .upsert(
          { user_id: userId, job_id: jobId, stage: "applied", job_snapshot: snapshot },
          { onConflict: "user_id,job_id", ignoreDuplicates: true },
        )
        .select("id");

    const first = await insert().maybeSingle();
    expect(first.data).not.toBeNull();

    // Second call, `.single()` instead of `.maybeSingle()`:
    const second = await insert().single();
    expect(second.data).toBeNull();
    expect(second.error?.code).toBe("PGRST116");
  });

  it("is idempotent end to end — two applies, one application, one event", async () => {
    const userId = await seedUser("idem");
    const jobId = await seedJob("idem");

    const firstId = await markAppliedSequence(userId, jobId);
    const secondId = await markAppliedSequence(userId, jobId);
    expect(secondId).toBe(firstId);

    const { data: applications, error: appErr } = await admin
      .from("applications")
      .select("id")
      .eq("user_id", userId)
      .eq("job_id", jobId);
    expect(appErr).toBeNull();
    expect(applications).toHaveLength(1);

    const { data: events, error: evErr } = await admin
      .from("application_events")
      .select("id, from_stage, to_stage")
      .eq("application_id", firstId);
    expect(evErr).toBeNull();
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({ from_stage: null, to_stage: "applied" });
  });

  it("repairs a missing initial event without duplicating it", async () => {
    const userId = await seedUser("repair");
    const jobId = await seedJob("repair");

    const applicationId = await markAppliedSequence(userId, jobId);

    // Simulate a run that died between the application and its history row.
    const { error: delErr } = await admin
      .from("application_events")
      .delete()
      .eq("application_id", applicationId);
    expect(delErr).toBeNull();

    await markAppliedSequence(userId, jobId);
    await markAppliedSequence(userId, jobId);

    const { data: events } = await admin
      .from("application_events")
      .select("id")
      .eq("application_id", applicationId);
    expect(events).toHaveLength(1);
  });

  it("job_events holds duplicate rows, and only .limit(1) survives it", async () => {
    const userId = await seedUser("events");
    const jobId = await seedJob("events");

    // `at` is part of the primary key, so two inserts of the same event both land.
    for (let i = 0; i < 2; i++) {
      const { error } = await admin
        .from("job_events")
        .insert({ user_id: userId, job_id: jobId, event: "save", at: new Date(1000 * i).toISOString() });
      expect(error).toBeNull();
    }

    const { data: all, error: allErr } = await admin
      .from("job_events")
      .select("at")
      .eq("user_id", userId)
      .eq("job_id", jobId)
      .eq("event", "save");
    expect(allErr).toBeNull();
    expect(all).toHaveLength(2);

    // `.maybeSingle()` on two rows is a PostgREST error — this is what would
    // have turned a plain save into a 500.
    const single = await admin
      .from("job_events")
      .select("at")
      .eq("user_id", userId)
      .eq("job_id", jobId)
      .eq("event", "save")
      .maybeSingle();
    expect(single.error?.code).toBe("PGRST116");

    // `.limit(1)` — what saveJob/dismissJob now do — is unaffected.
    const limited = await admin
      .from("job_events")
      .select("at")
      .eq("user_id", userId)
      .eq("job_id", jobId)
      .eq("event", "save")
      .limit(1);
    expect(limited.error).toBeNull();
    expect(limited.data).toHaveLength(1);
  });

  it("rejects a select of a column job_events does not have", async () => {
    // Regression guard for the bug this file was written to find:
    // `saveJob` selected "id", which does not exist on this table.
    const { data, error } = await admin.from("job_events").select("id").limit(1);
    expect(data).toBeNull();
    expect(error?.code).toBe("42703");
  });
});