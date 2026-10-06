/**
 * profile-mutations.db.test.ts — DB-level integration test for the BE-304 write paths.
 *
 * ## Why this file exists
 *
 * Three defects shipped through a fully green gate suite, all in this area:
 *   1. `updateLogistics` could never clear a salary floor (`null` was silently dropped).
 *   2. `updateSkills` deleted the user's rows and then failed to insert, leaving zero skills.
 *   3. The `updated_at` concurrency guard was absent, so two tabs silently clobbered each other.
 *
 * Every unit test for that code mocks Supabase, and a mock *defines* the answer — so it
 * cannot fail unless someone already suspects the bug. This file talks to a real Postgres
 * so the behaviours are observed rather than stipulated.
 *
 * ## What it actually proves
 *
 * The things a mock cannot: that an `UPDATE` scoped by a stale `updated_at` really returns
 * zero rows **and that Postgres reports that as success rather than an error** (the single
 * fact `updateOwnProfile` is built around), that `0005`'s trigger really creates the profile
 * row, that `ON DELETE CASCADE` really takes `profile_skills` with it, and that a duplicate
 * really violates the `(profile_id, skill_id)` PK.
 *
 * ## Running it
 *
 * Needs a live local Supabase stack (`pnpm db:reset`). Point it at that instance:
 *
 *   $env:TEST_SUPABASE_URL          = "http://127.0.0.1:54321"
 *   $env:TEST_SUPABASE_SERVICE_ROLE = "<service_role key from the local stack>"
 *   pnpm vitest run tests/integration/profile-mutations.db.test.ts
 *
 * Without those it **skips** rather than failing — CI has no local Postgres, and a red suite
 * for "no database" trains people to ignore red.
 *
 * ## Safety
 *
 * Hard-guarded to the local stack: the URL must be 127.0.0.1/localhost or nothing runs.
 * Every auth user created here is tagged with `INTEGRATION-` and deleted in `afterAll`,
 * which cascades to `profiles` and then to `profile_skills`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;

/** Refuse to run against anything that isn't a local stack. */
const IS_LOCAL = Boolean(URL && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(URL));

if (!IS_LOCAL || !SERVICE_ROLE) {
  console.warn(
    "[integration] skipping — set TEST_SUPABASE_URL (local) and TEST_SUPABASE_SERVICE_ROLE to run",
  );
}

const suite = IS_LOCAL && SERVICE_ROLE ? describe : describe.skip;

/** Recognisable prefix so cleanup can find anything this file leaves behind. */
const EMAIL_TAG = "integration-be304-";

let admin: SupabaseClient;
const createdUserIds: string[] = [];
const createdSkillIds: string[] = [];

suite("profile mutations against a real Postgres", () => {
  beforeAll(() => {
    // `suite` is only `describe` when IS_LOCAL && SERVICE_ROLE, so these are non-null here.
admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    // Cleanup must not throw: a failed teardown would mask a real failure above.
    const ignore = () => undefined;
    // Deleting the auth user cascades: auth.users → profiles → profile_skills.
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(ignore);
    }
    if (createdSkillIds.length > 0) {
      await admin.from("skills").delete().in("id", createdSkillIds).then(ignore, ignore);
    }
  });

  /**
   * Create a real auth user and return its id.
   *
   * Not a direct `profiles` insert: `profiles.id` FKs to `auth.users(id)`, so the only
   * legitimate way a profile row appears is through `0005`'s trigger. Going through
   * auth.users means this fixture also proves the trigger fires.
   */
  async function seedUser(label: string): Promise<string> {
    const email = `${EMAIL_TAG}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`create auth user ${label}: ${error?.message}`);
    createdUserIds.push(data.user.id);
    return data.user.id;
  }

  async function seedSkill(label: string): Promise<string> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("skills")
      .insert({ name: `it-${label}-${suffix}`, slug: `it-${label}-${suffix}` })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed skill ${label}: ${error?.message}`);
    createdSkillIds.push(data.id as string);
    return data.id as string;
  }

  it("0005's trigger really creates the profile row for a new auth user", async () => {
    const id = await seedUser("trigger");

    const { data, error } = await admin
      .from("profiles")
      .select("id, onboarding_completed")
      .eq("id", id)
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(id);
    // ONB-005's `Finish` has to flip this; it defaults false.
    expect(data?.onboarding_completed).toBe(false);
  });

  it("reports zero rows when updated_at is stale — and Postgres calls that success", async () => {
    const id = await seedUser("stale");

    // Two tabs read the same row.
    const { data: read, error: readError } = await admin
      .from("profiles")
      .select("city, updated_at")
      .eq("id", id)
      .single();
    if (readError) throw new Error(readError.message);

    // Move `updated_at` forward explicitly, standing in for the missing
    // `profiles_updated_at` trigger. See the note on the companion test below.
    await admin
      .from("profiles")
      .update({ city: "Bengaluru", updated_at: new Date(Date.now() + 1000).toISOString() })
      .eq("id", id)
      .select();
    const { data: afterFirst } = await admin
      .from("profiles")
      .select("updated_at")
      .eq("id", id)
      .single();
    expect(afterFirst?.updated_at).not.toBe(read.updated_at);

    // Tab two writes using the `updated_at` it read earlier. Same shape the action uses.
    const second = await admin
      .from("profiles")
      .update({ city: "Pune" })
      .eq("id", id)
      .eq("updated_at", read.updated_at)
      .select();

    // The whole reason `updateOwnProfile` inspects `data.length` and not just `error`:
    // this is success-with-zero-rows, NOT an error.
    expect(second.error).toBeNull();
    expect(second.data).toHaveLength(0);

    // And the first write survived — no silent clobber.
    const { data: final } = await admin.from("profiles").select("city").eq("id", id).single();
    expect(final?.city).toBe("Bengaluru");
  });

  it("BUG: profiles.updated_at does not move on UPDATE — the guard cannot work", async () => {
    const id = await seedUser("no-trigger");
    const before = await admin.from("profiles").select("updated_at").eq("id", id).single();

    // `resumes` has a `resumes_updated_at` BEFORE UPDATE trigger. `profiles` has none —
    // `updated_at` only has a `now()` default, which applies to INSERT.
    await admin.from("profiles").update({ city: "Chennai" }).eq("id", id);

    const after = await admin.from("profiles").select("updated_at").eq("id", id).single();

    // Fails today. This is the real state of the DB, not a test artefact: until a
    // `profiles_updated_at` trigger exists, `updateOwnProfile`'s guard always matches
    // and the two-tab case silently clobbers — exactly the pre-`2def404` behaviour.
    // Fix is migration 0006. Pinned here so the fix can't be forgotten.
    expect(after.data?.updated_at).not.toBe(before.data?.updated_at);
  });

  it("clears a salary floor to NULL, so 'no floor' is actually reachable", async () => {
    const id = await seedUser("salary");

    await admin.from("profiles").update({ min_salary: 120000 }).eq("id", id);

    const cleared = await admin
      .from("profiles")
      .update({ min_salary: null })
      .eq("id", id)
      .select("min_salary")
      .single();

    expect(cleared.error).toBeNull();
    // The regression: this stayed 120000 because the action dropped the null.
    expect(cleared.data?.min_salary).toBeNull();
  });

  it("leaves omitted columns untouched while clearing an explicit null", async () => {
    const id = await seedUser("partial");

    await admin
      .from("profiles")
      .update({ min_salary: 90000, city: "Delhi" })
      .eq("id", id);

    // Omitted salary → city-only update leaves min_salary alone.
    const partial = await admin
      .from("profiles")
      .update({ city: "Mumbai" })
      .eq("id", id)
      .select("city, min_salary")
      .single();

    expect(partial.data?.city).toBe("Mumbai");
    // `min_salary` is `numeric(12,0)`; PostgREST returns numeric as a JSON number.
    expect(Number(partial.data?.min_salary)).toBe(90000);

    // Explicit null → cleared. The two-state distinction the action depends on.
    const cleared = await admin
      .from("profiles")
      .update({ min_salary: null })
      .eq("id", id)
      .select("min_salary")
      .single();

    expect(cleared.data?.min_salary).toBeNull();
  });

  it("really cascades profile_skills when the auth user is deleted", async () => {
    const id = await seedUser("cascade");
    const skillId = await seedSkill("cascade");

    await admin
      .from("profile_skills")
      .insert({ profile_id: id, skill_id: skillId, level: "proficient" });

    const before = await admin.from("profile_skills").select("skill_id").eq("profile_id", id);
    expect(before.data).toHaveLength(1);

    // This is why `updateSkills`' compensation matters: these rows are the user's only
    // copy, and they are reachable for deletion by design.
    await admin.auth.admin.deleteUser(id);
    createdUserIds.splice(createdUserIds.indexOf(id), 1);

    const after = await admin.from("profile_skills").select("skill_id").eq("profile_id", id);
    expect(after.data).toHaveLength(0);
  });

  it("really rejects a duplicate (profile_id, skill_id) pair", async () => {
    const id = await seedUser("dup");
    const skillId = await seedSkill("dup");

    const first = await admin
      .from("profile_skills")
      .insert({ profile_id: id, skill_id: skillId, level: "familiar" });
    expect(first.error).toBeNull();

    const second = await admin
      .from("profile_skills")
      .insert({ profile_id: id, skill_id: skillId, level: "expert" });

    // A real PK violation. `updateSkills` rejects duplicates up front so the user sees
    // "Duplicate skill" instead of this.
    expect(second.error).not.toBeNull();
  });

  it("leaves another profile's skills untouched when deleting by profile_id", async () => {
    const mine = await seedUser("mine");
    const theirs = await seedUser("theirs");
    const skillA = await seedSkill("mine");
    const skillB = await seedSkill("theirs");

    await admin.from("profile_skills").insert([
      { profile_id: mine, skill_id: skillA, level: "proficient" },
      { profile_id: theirs, skill_id: skillB, level: "proficient" },
    ]);

    // The property `updateSkills`' delete-then-insert relies on to avoid clobbering
    // a different user: the delete is scoped by profile_id.
    await admin.from("profile_skills").delete().eq("profile_id", mine);

    const remaining = await admin.from("profile_skills").select("profile_id").eq("profile_id", theirs);
    expect(remaining.data).toHaveLength(1);
  });
});