/**
 * job-detail.db.test.ts — `queryJobDetail` against a real Postgres (FE-108, FE-109, JOB-004).
 *
 * ## Why this file exists
 *
 * Because of what happened to the feed. `feedRowSchema` rejected 100% of real rows — the
 * strict `z.string().datetime()` cannot parse PostgREST's `+00:00` timestamptz — and 26 green
 * unit tests could not see it, because their client double returned hand-written `.000Z`.
 * Three of this page's own fields are `timestamptz` (`posted_at`, `first_seen_at`,
 * `last_seen_at`) and two more are nullable columns, so the identical trap is armed here.
 *
 * So: the production query, the production schemas, real rows, a real signed-in JWT. Nothing
 * stubbed. Plus the three behaviours JOB-001 actually specifies, which are all claims about
 * the database rather than about code shape:
 *
 *   1. An id that does not exist returns `null` — so the page can 404.
 *   2. A **malformed** id returns `null` rather than a PostgREST `22P02` error, which is what
 *      makes a hand-edited URL produce the same 404 as a real miss (JOB-001's fifth
 *      done-when: "byte-identical to a real miss").
 *   3. Another user's score is invisible: `job_scores` is owner-only under RLS, so the detail
 *      page cannot leak a score, and a row with no score of its own still renders.
 *
 * Skips without a local stack, like every other `*.db.test.ts` here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { queryJobDetail } from "@/lib/db/queries/job-detail";

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

const TAG = "job-detail-it";

let admin: SupabaseClient;
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];

suite("queryJobDetail against a real Postgres", () => {
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

  /** A signed-in user whose JWT resolves to them, exactly as `createUserClient` builds it. */
  async function signedIn(label: string) {
    const email = `${TAG}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.invalid`;
    const password = "Job-Detail-Test-123!";
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`createUser ${label}: ${createErr?.message}`);
    createdUserIds.push(created.user.id);
    await admin.auth.admin.updateUserById(created.user.id, { password });

    const anon = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr || !session.session) throw new Error(`signIn ${label}: ${signInErr?.message}`);

    return {
      client: createClient(URL!, ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
      }),
      userId: created.user.id,
    };
  }

  /** A job whose `skills` are NULL — the shape that took the feed down. */
  async function seedJob(label: string): Promise<string> {
    const hash = `${TAG}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await admin
      .from("jobs")
      .insert({
        dedupe_hash: hash,
        title: `${TAG} Senior Frontend Engineer`,
        company_name: `${TAG} Co`,
        company_domain: "acme.example",
        source_url: `https://boards.greenhouse.example/${hash}`,
        apply_url: `https://acme.example/apply/${hash}`,
        location_raw: "Remote (US)",
        city: "Austin",
        country_code: "US",
        work_mode: "remote",
        remote_scope: "global",
        employment_type: "full_time",
        seniority: "senior",
        salary_min: 160000,
        salary_max: 190000,
        salary_currency: "USD",
        salary_period: "year",
        description_text: "Plain text description.",
        description_html: "<p>Rich <strong>description</strong>.</p>",
        // skills deliberately unset: nullable `text[]` with no default.
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed job ${label}: ${error?.message}`);
    createdJobIds.push(data.id as string);
    return data.id as string;
  }

  it("returns the job with the caller's score, sightings and application", async () => {
    const { client, userId } = await signedIn("full");
    const jobId = await seedJob("full");

    const hash = `hash-${jobId}`;
    const { error: scoreErr } = await admin.from("job_scores").insert({
      user_id: userId,
      job_id: jobId,
      final_score: 78.42,
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

    const { error: appErr } = await admin.from("applications").insert({
      user_id: userId,
      job_id: jobId,
      stage: "applied",
      applied_at: new Date().toISOString(),
      next_action_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      notes: "Applied via company site.",
      source: "manual",
      job_snapshot: { title: "snapshot" },
    });
    if (appErr) throw new Error(`insert applications: ${appErr.message}`);

    // The sighting, written through the RPC that 0012 replaced — the same path ingestion uses.
    const { data: source } = await admin
      .from("sources")
      .insert({ name: `${TAG}-src-${Date.now()}`, kind: "api_greenhouse" })
      .select("id")
      .single();
    const { error: rpcErr } = await admin.rpc("upsert_job", {
      p_row: {
        dedupe_hash: `sight-${jobId}`,
        title: `${TAG} sighting`,
        company_name: `${TAG} Co`,
        source_url: `https://jobs.lever.example/${jobId}`,
        source_id: source?.id ?? null,
      },
    });
    if (rpcErr) throw new Error(`upsert_job: ${rpcErr.message}`);
    const { data: leverJob } = await admin
      .from("jobs")
      .select("id")
      .eq("dedupe_hash", `sight-${jobId}`)
      .single();
    if (leverJob) createdJobIds.push(leverJob.id as string);

    const detail = await queryJobDetail(client as never, jobId);

    expect(detail).not.toBeNull();
    expect(detail?.job.id).toBe(jobId);
    expect(detail?.job.title).toContain(TAG);
    expect(detail?.job.source_url).toContain("greenhouse");
    expect(detail?.job.apply_url).toContain("acme.example/apply");
    expect(detail?.job.description_html).toContain("<strong>");
    // The NULL skills column survived validation — this is the feed's bug, on this page's row.
    expect(detail?.job.skills).toBeNull();
    // Timestamps came back in PostgREST's offset form and parsed anyway.
    expect(detail?.job.last_seen_at).not.toMatch(/Z$/);
    expect(Number.isNaN(new Date(detail?.job.last_seen_at ?? "").getTime())).toBe(false);

    expect(detail?.score?.final_score).toBe(78.42);
    expect(detail?.score?.breakdown).toHaveLength(2);
    expect(detail?.application?.stage).toBe("applied");
    expect(detail?.application?.notes).toBe("Applied via company site.");

    void hash;
  });

  it("returns the job with a score of 0 and its gate reasons when a gate fired", async () => {
    // A gated job is still written (SCR-004), and JOB-002 requires the detail page to explain
    // it. If `queryJobDetail` dropped gated rows, the explanation would be unreachable.
    const { client, userId } = await signedIn("gated");
    const jobId = await seedJob("gated");

    const { error } = await admin.from("job_scores").insert({
      user_id: userId,
      job_id: jobId,
      final_score: 0,
      rule_score: 0,
      semantic_score: null,
      gate_result: { passed: false, reasons: ["blocked_company", "salary_below_floor"] },
      breakdown: [],
      scored_at: new Date().toISOString(),
      model_version: "test",
    });
    if (error) throw new Error(`insert job_scores: ${error.message}`);

    const detail = await queryJobDetail(client as never, jobId);

    expect(detail).not.toBeNull();
    expect(detail?.score?.final_score).toBe(0);
    expect(detail?.score?.gate_result?.passed).toBe(false);
    expect(detail?.score?.gate_result?.reasons).toEqual(["blocked_company", "salary_below_floor"]);
    // `semantic_score: null` is a supported state (no embedding), not an error.
    expect(detail?.score?.semantic_score).toBeNull();
  });

  it("returns the job with a null score when the caller has never been scored", async () => {
    // The normal state for a job ingested after the caller's last rescore. Rendering a zero
    // here would claim the job is a terrible match, which is a different and false statement.
    const { client } = await signedIn("unscored");
    const jobId = await seedJob("unscored");

    const detail = await queryJobDetail(client as never, jobId);

    expect(detail).not.toBeNull();
    expect(detail?.score).toBeNull();
    expect(detail?.application).toBeNull();
  });

  it("does not leak another user's score", async () => {
    // `job_scores` is owner-only (0001:652). Two users, one score: the second must see the job
    // with no score rather than the first user's number.
    const owner = await signedIn("owner");
    const other = await signedIn("other");
    const jobId = await seedJob("rls");

    const { error } = await admin.from("job_scores").insert({
      user_id: owner.userId,
      job_id: jobId,
      final_score: 99,
      rule_score: 99,
      semantic_score: null,
      gate_result: { passed: true, reasons: [] },
      breakdown: [{ key: "skills", weight: 35, raw: 1, points: 35, known: true }],
      scored_at: new Date().toISOString(),
      model_version: "test",
    });
    if (error) throw new Error(`insert job_scores: ${error.message}`);

    const asOwner = await queryJobDetail(owner.client as never, jobId);
    const asOther = await queryJobDetail(other.client as never, jobId);

    expect(asOwner?.score?.final_score).toBe(99);
    expect(asOther?.score).toBeNull();
    // `jobs` is shared corpus, so both still see the job itself — only the score is private.
    expect(asOther?.job.id).toBe(jobId);
  });

  it("returns null for an id that does not exist", async () => {
    const { client } = await signedIn("missing");
    expect(await queryJobDetail(client as never, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("returns null for a MALFORMED id rather than a PostgREST error", async () => {
    // JOB-001's fifth done-when: the 404 for an unseen id must be byte-identical to the 404
    // for a real miss. A malformed id reaches PostgREST as `22P02 invalid_input_syntax`, and
    // if that surfaced as an error the two 404s would differ. The page also validates the uuid
    // before querying; this is the second line of defence behind it.
    const { client } = await signedIn("malformed");
    for (const bad of ["not-a-uuid", "123", "", "../../etc/passwd", "'; drop table jobs; --"]) {
      expect(await queryJobDetail(client as never, bad), bad).toBeNull();
    }
  });
});
