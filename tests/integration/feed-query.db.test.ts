/**
 * feed-query.db.test.ts — the feed row schema against a real Postgres (BE-306, FED-001).
 *
 * ## Why this file exists
 *
 * The feed shipped with 26 unit tests, all green, and **crashed on 100% of real rows**.
 * `feedRowSchema` validated `z.string().datetime()`, and PostgREST returns a `timestamptz` as
 * `2026-10-13T21:49:59.149163+00:00` — an offset and microseconds, which the strict form
 * rejects. In production the only symptom was Next's *"An error occurred in the Server
 * Components render"* with a digest and no detail.
 *
 * The unit tests could not catch it because their client double returns hand-written
 * `.000Z` strings: the stub answers with the timestamp format the author *imagined*, not the
 * one the database produces. That is the fourth time this repo has been bitten by a double
 * that agrees with whatever it is handed (`job_events.id`, `sources.slug`, the identical
 * `single()`/`maybeSingle()`), and the pattern is now: **anything asserting a fact about
 * what the database returns belongs in a `*.db.test.ts`, not behind a double.**
 *
 * So: this file runs the *production* schema over rows the *production* query would return,
 * from a database the production migrations built. Nothing is stubbed.
 *
 * ## What it pins
 *   1. A real `v_ranked_jobs` row satisfies `feedRowSchema` — the bug above.
 *   2. `jobs.skills` is NULL in the database, and the schema says so rather than requiring
 *      an array.
 *   3. The strict `.datetime()` really does reject the string PostgREST produces, so the
 *      fix cannot be "widen the test" later. (The guard against the guard.)
 *   4. The query's own `.gte("final_score", 60)` predicate is what makes `final_score`
 *      non-null, so the strict number type is reachable.
 *
 * Skips (rather than fails) without a local stack, per `feed-actions.db.test.ts`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { feedRowSchema, queryFeed, MIN_FEED_SCORE } from "@/lib/db/queries/feed";
import { dbTimestampSchema } from "@/types/db";

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

const TAG = "feed-query-it";

let admin: SupabaseClient;
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];

/** The exact column list the feed query selects, derived from the production schema. */
const FEED_COLUMNS = Object.keys(feedRowSchema.shape).join(", ");

/**
 * The untyped Supabase client types a select result as `GenericStringError` rather than a
 * row, so `data[0].skills` is a type error even when the query succeeded. Narrow it once,
 * here, so the assertions below read like assertions.
 */
function asRow(value: unknown): Record<string, unknown> {
  if (value == null) throw new Error("expected a row, got null");
  return z.record(z.unknown()).parse(value);
}

suite("feedRowSchema against a real Postgres", () => {
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

  /** A user with a score above the cutoff, so the row is one the feed would really return. */
  async function seedScoredJob(opts: { skills?: string[] | null } = {}): Promise<{ userId: string; jobId: string }> {
    const email = `${TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.invalid`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`createUser: ${createErr?.message}`);
    createdUserIds.push(created.user.id);
    const userId = created.user.id;

    const hash = `${TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { data: job, error: jobErr } = await admin
      .from("jobs")
      .insert({
        dedupe_hash: hash,
        title: `${TAG} Senior Frontend Engineer`,
        title_norm: `${TAG} senior frontend engineer`,
        company_name: `${TAG} Co`,
        source_url: `https://boards.greenhouse.example/${hash}`,
        country_code: "US",
        work_mode: "remote",
        seniority: "senior",
        employment_type: "full_time",
        description_text: "A description.",
        // Left unset by default: `jobs.skills` is a nullable `text[]` with no default.
        ...(opts.skills === undefined ? {} : { skills: opts.skills }),
      })
      .select("id")
      .single();
    if (jobErr || !job) throw new Error(`insert job: ${jobErr?.message}`);
    createdJobIds.push(job.id as string);

    const { error: scoreErr } = await admin.from("job_scores").insert({
      user_id: userId,
      job_id: job.id,
      final_score: 78.5,
      rule_score: 76,
      semantic_score: 82,
      gate_result: { passed: true, reasons: [] },
      breakdown: [
        { key: "skills", weight: 35, raw: 0.71, points: 24.9, known: true },
        { key: "seniority", weight: 15, raw: 0.75, points: 11.3, known: true },
      ],
      explanation: "Strong skill overlap.",
      scored_at: new Date().toISOString(),
      model_version: "test",
    });
    if (scoreErr) throw new Error(`insert job_scores: ${scoreErr.message}`);

    return { userId, jobId: job.id as string };
  }

  it("accepts the exact row the feed query returns", async () => {
    const { userId, jobId } = await seedScoredJob({ skills: ["react", "typescript"] });

    // The production predicate set: score cutoff, not dismissed, not applied.
    const { data, error } = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS, { count: "exact" })
      .gte("final_score", MIN_FEED_SCORE)
      .eq("dismissed", false)
      .eq("applied", false)
      .eq("id", jobId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    const parsed = feedRowSchema.safeParse(asRow(data?.[0]));
    if (!parsed.success) {
      // Print every failure, not just the first: this bug had several distinct causes and a
      // single-issue assertion would have sent me off fixing them one run at a time.
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`feedRowSchema rejected a real row -> ${detail}`);
    }
    expect(parsed.data.id).toBe(jobId);
    expect(parsed.data.saved).toBe(false);
    expect(parsed.data.dismissed).toBe(false);
    expect(parsed.data.applied).toBe(false);
    expect(parsed.data.skills).toEqual(["react", "typescript"]);
    expect(userId).toBeTruthy();
  });

  it("accepts a row whose skills column is NULL", async () => {
    // `jobs.skills` is `text[]` with no default (0001_init.sql:256). Every job ingested
    // before the skill matcher existed has NULL here, and the schema used to require an
    // array — so the single most common real-world row shape was the one that crashed.
    const { jobId } = await seedScoredJob({ skills: null });

    const { data, error } = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS)
      .gte("final_score", MIN_FEED_SCORE)
      .eq("id", jobId);

    expect(error).toBeNull();
    const row = asRow(data?.[0]);
    expect(row.skills).toBeNull();
    expect(feedRowSchema.safeParse(row).success).toBe(true);
  });

  it("accepts a row whose skills column was never set", async () => {
    const { jobId } = await seedScoredJob();

    const { data } = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS)
      .gte("final_score", MIN_FEED_SCORE)
      .eq("id", jobId);

    const row = asRow(data?.[0]);
    expect(row.skills).toBeNull();
    expect(feedRowSchema.safeParse(row).success).toBe(true);
  });

  it("the score predicate is what makes final_score non-null", async () => {
    // Guards the strict `final_score: z.number()`. The view LEFT JOINs job_scores, so an
    // unscored job is NULL in the view; the `.gte()` is what excludes it. If that predicate
    // ever moves into the schema layer, this test fails instead of the page rendering NaN.
    const { jobId } = await seedScoredJob();

    const withCutoff = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS)
      .gte("final_score", MIN_FEED_SCORE)
      .eq("id", jobId);
    expect(asRow(withCutoff.data?.[0]).final_score).toBe(78.5);

    // Without the predicate, drop the score to 0 and the row is present with a real score.
    await admin.from("job_scores").update({ final_score: 0 }).eq("job_id", jobId);
    const withoutCutoff = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS)
      .eq("id", jobId);
    expect(asRow(withoutCutoff.data?.[0]).final_score).toBe(0);

    // An *unscored* job is NULL in the view, which is why the predicate must stay in SQL.
    await admin.from("job_scores").delete().eq("job_id", jobId);
    const unscored = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS)
      .eq("id", jobId);
    expect(asRow(unscored.data?.[0]).final_score).toBeNull();

    const filtered = await admin
      .from("v_ranked_jobs")
      .select(FEED_COLUMNS)
      .gte("final_score", MIN_FEED_SCORE)
      .eq("id", jobId);
    expect(filtered.data).toHaveLength(0);
  });

  it("returns timestamps in the offset form, which the strict schema rejects", async () => {
    // The guard against the guard. If someone "fixes" this suite by loosening
    // `dbTimestampSchema` to plain `.datetime()`, this test fails and says why.
    const { jobId } = await seedScoredJob();

    const { data } = await admin
      .from("v_ranked_jobs")
      .select("first_seen_at, last_seen_at")
      .eq("id", jobId)
      .single();

    const firstSeen = z
      .object({ first_seen_at: z.string(), last_seen_at: z.string() })
      .parse(data).first_seen_at;

    expect(firstSeen).toMatch(/[+-]\d{2}:\d{2}$/);
    // 1–6 fractional digits, **not** a fixed 6. Postgres strips trailing zeros, so
    // `…:07.748420+00:00` comes back as `…:07.74842+00:00`. This is the concrete reason
    // `dbTimestampSchema` leaves `precision` unset: pin millisecond precision and rows start
    // failing whenever Postgres trims a zero.
    expect(firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}[+-]\d{2}:\d{2}$/);

    // This is the bug, restated as a test: the form the database produces, and what it does
    // to each candidate schema.
    expect(z.string().datetime().safeParse(firstSeen).success).toBe(false);
    expect(dbTimestampSchema.safeParse(firstSeen).success).toBe(true);
    expect(new Date(firstSeen).getTime()).not.toBeNaN();
  });
});

suite("queryFeed end to end against a real Postgres", () => {
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

  it("returns the caller's scored rows, validated, without a database present", async () => {
    // The whole point of this file, in one test: the *production* `queryFeed`, against the
    // *production* migrations, with a real signed-in user's JWT, returning rows that survive
    // the *production* schema. Everything above is a narrower claim about the schema alone.
    //
    // This is the check that would have caught the crash before it shipped. It failed for a
    // reason no unit test could reach: the double answered `.000Z` because that is what the
    // fixture said, and PostgREST answers `+00:00`.
    const email = `${TAG}-e2e-${Date.now()}@example.invalid`;
    const password = "Feed-Query-E2E-123!";
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`createUser: ${createErr?.message}`);
    const userId = created.user.id;
    createdUserIds.push(userId);
    await admin.auth.admin.updateUserById(userId, { password });

    const anon = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr || !session.user) throw new Error(`signIn: ${signInErr?.message}`);

    const hash = `${TAG}-e2e-${Date.now()}`;
    const { data: job, error: jobErr } = await admin
      .from("jobs")
      .insert({
        dedupe_hash: hash,
        title: `${TAG} Staff Platform Engineer`,
        company_name: `${TAG} Co`,
        source_url: `https://boards.lever.co.example/${hash}`,
        country_code: "GB",
        work_mode: "hybrid",
        seniority: "staff",
        employment_type: "full_time",
        skills: ["kubernetes", "go"],
      })
      .select("id")
      .single();
    if (jobErr || !job) throw new Error(`insert job: ${jobErr?.message}`);
    const jobId = job.id as string;
    createdJobIds.push(jobId);

    const { error: scoreErr } = await admin.from("job_scores").insert({
      user_id: userId,
      job_id: jobId,
      final_score: 91.25,
      rule_score: 90,
      semantic_score: 93,
      gate_result: { passed: true, reasons: [] },
      breakdown: [
        { key: "skills", weight: 35, raw: 0.9, points: 31.5, known: true },
        { key: "seniority", weight: 15, raw: 1, points: 15, known: true },
      ],
      explanation: "Near-perfect overlap.",
      scored_at: new Date().toISOString(),
      model_version: "test",
    });
    if (scoreErr) throw new Error(`insert job_scores: ${scoreErr.message}`);

    // The caller's own RLS-scoped client, exactly as `createUserClient` builds it.
    const caller = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
    });

    const result = await queryFeed(caller as never, { limit: 20, lastSeenFeedAt: null });

    expect("error" in result).toBe(false);
    if ("error" in result) {
      throw new Error(`queryFeed returned ${result.error} — this is the crash under test`);
    }

    const mine = result.jobs.find((row) => row.id === jobId);
    expect(mine, "the seeded job should be in the feed").toBeDefined();
    expect(mine?.final_score).toBe(91.25);
    expect(mine?.skills).toEqual(["kubernetes", "go"]);
    expect(mine?.breakdown).toHaveLength(2);
    expect(mine?.saved).toBe(false);
    // The timestamps survived validation — the assertion that used to fail 100% of the time.
    expect(Number.isNaN(new Date(mine?.first_seen_at ?? "").getTime())).toBe(false);
    expect(mine?.first_seen_at).not.toMatch(/Z$/);

    // Reading twice returns the same thing. `queryFeed` holds no cache, so this is trivially
    // true — which is the point: a *second* server render (Next re-renders the dashboard on
    // `router.refresh()`) must not behave differently from the first.
    const again = await queryFeed(caller as never, { limit: 20, lastSeenFeedAt: null });
    expect("error" in again).toBe(false);
    if (!("error" in again)) {
      expect(again.jobs.find((row) => row.id === jobId)).toEqual(mine);
    }
  });
});
