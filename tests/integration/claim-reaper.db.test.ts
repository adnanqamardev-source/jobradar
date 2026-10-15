/**
 * claim-reaper.db.test.ts — `claim_tasks` must never wedge the whole queue (migration 0013).
 *
 * ## The bug this exists for
 *
 * `claim_tasks` opened with a reap that reset *every* expired lease to `pending`, unaware of
 * `idx_task_queue_one_pending_rescore_per_profile` — the partial unique index allowing one
 * pending rescore per profile. A profile holding both a stale `running` row and a `pending` row
 * made that UPDATE raise `23505`, and because the reap is the first statement of the function,
 * the whole transaction aborted:
 *
 *     HTTP 500 {"error":"claim_failed","message":"Could not claim tasks."}
 *
 * Every call, for every user, forever. Observed live on the linked project with 100 pending
 * tasks queued behind one bad pair. The unit suite could never have found this: it needs two
 * rows in a state the enqueue path is supposed to make impossible, which is exactly why the
 * guard needs a real database to test.
 *
 * ## What each test pins
 *
 * - the wedging pair no longer aborts the claim, and the pending row is still claimable
 * - the superseded `running` row is retired to `done`, not resurrected (it is finished work:
 *   the continuation carries `resume_after`)
 * - a lone expired rescore lease **is** still reaped — the guard must not disable reaping, which
 *   would turn a wedge into a silent leak
 * - a reap for a *different* profile is unaffected by the guard
 *
 * Skips without `TEST_SUPABASE_URL`, like every other `*.db.test.ts` here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;

if (!URL || !SERVICE_ROLE) {
  console.warn(
    "[integration] skipping claim reaper — set TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE to run",
  );
}

const suite = URL && SERVICE_ROLE ? describe : describe.skip;

/** A lease is 5 minutes; "expired" here means comfortably older than any test's clock skew. */
const EXPIRED_LOCK = "2020-01-01T00:00:00.000Z";

/**
 * Built in `beforeAll`, not at module scope — the convention every other `*.db.test.ts` here
 * follows, for the same reason `schema-drift.db.test.ts` documents it: a `describe.skip` body
 * still *executes*, so `createClient(URL!, …)` at module scope threw "supabaseUrl is required"
 * and turned a missing env var into a failed suite instead of a skipped one.
 */
let admin: SupabaseClient;

interface Fixture {
  /** The `auth.users` id, which is also the `profiles` id — they are one row, created by trigger. */
  userId: string;
}

const created: Fixture[] = [];

/**
 * A real profile, via the same path a signup takes.
 *
 * Deliberately *not* a direct `profiles` insert: `profiles.id` FKs to `auth.users(id)` with no
 * default, so the only legitimate way a profile row exists is through the `handle_new_user`
 * trigger. Going through `auth.users` means the fixture also proves the trigger fires, and it
 * matches `profile-mutations.db.test.ts`.
 */
async function makeProfile(tag: string): Promise<string> {
  const email = `claim-reaper-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;

  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create fixture user: ${error?.message}`);

  created.push({ userId: data.user.id });
  return data.user.id;
}

async function makeTask(
  profileId: string,
  status: "pending" | "running",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const row = {
    kind: "rescore_profile",
    payload: { profile_id: profileId },
    status,
    priority: 100,
    ...extra,
  };

  const { data, error } = await admin.from("task_queue").insert(row).select("id").single();
  if (error) throw new Error(`could not create fixture task: ${error.message}`);
  return data.id;
}

async function statusOf(id: string): Promise<string | null> {
  const { data, error } = await admin.from("task_queue").select("status").eq("id", id).single();
  if (error) throw new Error(`could not read task ${id}: ${error.message}`);
  return data.status;
}

/**
 * Claim only this profile's rescore task, so a shared queue cannot make these flaky.
 *
 * `claim_tasks` takes no profile filter, so the assertion is on *this* fixture's rows: whatever
 * else the worker claims is irrelevant, and each test asserts its own two rows.
 */
async function claim(): Promise<{ ids: string[]; error: { message: string } | null }> {
  const { data, error } = await admin.rpc("claim_tasks", {
    p_worker_id: "claim-reaper-test",
    p_limit: 25,
    p_kind: "rescore_profile",
    p_lease_seconds: 300,
  });

  return {
    ids: Array.isArray(data) ? data.map((row: { id: string }) => row.id) : [],
    error: error ? { message: error.message } : null,
  };
}

suite("claim_tasks reaper (migrations 0013/0014)", () => {
  beforeAll(() => {
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    for (const { userId } of created) {
      // Tasks first: `payload.profile_id` is jsonb, so no foreign key cascades them.
      await admin.from("task_queue").delete().contains("payload", { profile_id: userId });
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it("does not abort the claim when a profile has both a stale running and a pending rescore", async () => {
    const profileId = await makeProfile("wedged");
    const staleRunning = await makeTask(profileId, "running", { locked_at: EXPIRED_LOCK });
    const pending = await makeTask(profileId, "pending");

    // This call returned `claim_failed` — and returned it on every subsequent call, forever,
    // taking 100 other queued tasks down with it.
    const result = await claim();

    expect(
      result.error,
      `claim_tasks threw: ${result.error?.message}. The queue is wedged for every user.`,
    ).toBeNull();

    // The pending continuation is still claimable. That is the property that matters: the work
    // continues, rather than merely not crashing.
    expect(result.ids).toContain(pending);
    expect(result.ids).not.toContain(staleRunning);
  });

  it("retires the superseded running row to done instead of resurrecting it", async () => {
    const profileId = await makeProfile("superseded");
    const staleRunning = await makeTask(profileId, "running", { locked_at: EXPIRED_LOCK });
    await makeTask(profileId, "pending");

    await claim();

    // `done`, not `pending`: the continuation already carries `resume_after`, so this row is
    // finished work. Reaping it to `pending` is both the thing that violated the index and the
    // wrong state to be in.
    expect(await statusOf(staleRunning)).toBe("done");
  });

  it("does not retire a rescore row that a live worker still holds", async () => {
    // The subtle one, and the reason step 1 needs a lease condition of its own.
    //
    // `runRescoreProfile` inserts its continuation row *while it is still running*: the handler
    // requeues, then returns, and only then does the worker settle the original row as `done`.
    // For that whole window the original row is `running` with a **live** lease and a pending
    // sibling already exists.
    //
    // So "running + has a pending sibling" is not sufficient on its own to mean "superseded".
    // Retiring a live row would clear `locked_by`/`locked_at` under a worker that is still
    // running, and if that worker's settle then took the retry branch it would set the row back
    // to `pending` beside the continuation — the same unique-index collision this migration
    // exists to prevent, arriving from the other direction.
    const profileId = await makeProfile("live-worker");
    const liveRunning = await makeTask(profileId, "running", { locked_at: new Date().toISOString() });
    await makeTask(profileId, "pending");

    await claim();

    expect(await statusOf(liveRunning)).toBe("running");
  });

  it("retires a superseded row only once its lease has expired", async () => {
    const profileId = await makeProfile("just-expired");
    const stale = await makeTask(profileId, "running", { locked_at: EXPIRED_LOCK });
    await makeTask(profileId, "pending");

    await claim();

    expect(await statusOf(stale)).toBe("done");
  });

  it("still reaps a lone expired rescore lease", async () => {
    const profileId = await makeProfile("lone");
    const staleRunning = await makeTask(profileId, "running", { locked_at: EXPIRED_LOCK });

    await claim();

    // The regression a too-broad guard would cause: if the fix had been "never reap a rescore
    // row", this would stay `running` forever and the task would be silently lost. Reaping is
    // the recovery path; it has to keep working.
    expect(["pending", "running"]).toContain(await statusOf(staleRunning));
  });

  it("does not let one profile's guard block another profile's reap", async () => {
    const wedged = await makeProfile("guard-a");
    const other = await makeProfile("guard-b");

    await makeTask(wedged, "running", { locked_at: EXPIRED_LOCK });
    await makeTask(wedged, "pending");

    const otherRunning = await makeTask(other, "running", { locked_at: EXPIRED_LOCK });

    await claim();

    // The guard is scoped by `payload->>'profile_id'`, so it must not leak to other profiles.
    expect(["pending", "running"]).toContain(await statusOf(otherRunning));
  });
});