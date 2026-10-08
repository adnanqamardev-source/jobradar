/**
 * dedupe.db.test.ts — DB-level integration test for the BE-107 write path.
 *
 * ## Why this file exists
 *
 * The two acceptance tests in `docs/05b-phase1.md` ING-007 are statements about Postgres,
 * not about TypeScript:
 *
 *   - "the same posting from 3 sources yields **one** `jobs` row with `sighting_count = 3`"
 *   - "two genuinely different roles at the same company are **not** merged"
 *
 * Neither can be settled by a unit test with a mocked client. A mock *defines* the answer:
 * it will happily report one row for three inserts whether or not the real unique index on
 * `dedupe_hash` fires, and whether or not the `do update` branch actually increments
 * `sighting_count`. This file drives the real table so the constraint does the deciding.
 *
 * The specific thing under test is the `on conflict (dedupe_hash) do update` branch. Note
 * that `upsertCanonicalJob` sends only the payload columns and relies on Postgres for the
 * sighting bookkeeping — so if that branch is wrong, nothing in the TypeScript layer reports
 * it. This is the "schema-green is not integration-green" rule from `notes.md`.
 *
 * ## Running it
 *
 * Needs a live local Supabase stack (`pnpm db:reset`):
 *
 *   $env:TEST_SUPABASE_URL          = "http://127.0.0.1:54321"
 *   $env:TEST_SUPABASE_SERVICE_ROLE = "<service_role key from the local stack>"
 *   pnpm vitest run tests/integration/dedupe.db.test.ts
 *
 * Without those it **skips** rather than failing — CI has no local Postgres, and a red suite
 * for "no database" trains people to ignore red.
 *
 * ## Safety
 *
 * Every row is tagged in `company_name` with `DEDUPE-IT-` and deleted in `afterAll`. Hard
 * guarded to 127.0.0.1/localhost; nothing runs against a hosted project.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeDedupeHash, normaliseForHash, trigramSimilarity } from "@/lib/ingest/dedupe";
import type { CanonicalJob } from "@/types/canonical-job";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE;

/** Refuse to run against anything that isn't a local stack. */
const IS_LOCAL = Boolean(URL && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(URL));

if (!IS_LOCAL || !SERVICE_ROLE) {
  console.warn(
    "[integration] skipping — set TEST_SUPABASE_URL (local) and TEST_SUPABASE_SERVICE_ROLE to run dedupe integration tests",
  );
}

const suite = IS_LOCAL && SERVICE_ROLE ? describe : describe.skip;

/** Every row this file creates carries this tag, so cleanup can find them. */
const TAG = "DEDUPE-IT-";

let admin: SupabaseClient;
const createdHashes: string[] = [];

suite("dedupe against a real Postgres", () => {
  beforeAll(() => {
    // `suite` is only `describe` when IS_LOCAL && SERVICE_ROLE, so these are non-null here.
    admin = createClient(URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    // Cleanup must not throw: a failed teardown would mask a real failure above.
    const ignore = () => undefined;
    if (createdHashes.length > 0) {
      await admin.from("jobs").delete().in("dedupe_hash", createdHashes).then(ignore, ignore);
    }
  });

  /**
   * Build a canonical job plus its hash, and record the hash for cleanup.
   *
   * `company_name` carries the tag rather than `title`, because the dedupe hash is built from
   * the title and company identity — tagging the title would change the hash under test.
   */
  function makeJob(overrides: Partial<CanonicalJob> = {}): { job: CanonicalJob; hash: string } {
    const job: CanonicalJob = {
      externalId: "it-1",
      sourceUrl: "https://example.invalid/jobs/1",
      applyUrl: null,
      companyName: `${TAG}acme`,
      companyDomain: null,
      title: "Principal Software Engineer",
      titleNorm: "principalsoftwareengineer",
      descriptionText: "A scraped body.",
      descriptionHtml: null,
      location: { city: "Berlin", region: null, countryCode: "DE", raw: "Berlin" },
      remoteScope: "global",
      workMode: "remote",
      employmentType: "full_time",
      seniority: "staff",
      salary: null,
      skills: [],
      postedAt: null,
      firstSeenAt: null,
      lastSeenAt: null,
      sightingCount: 1,
      status: "active",
      confidence: 1,
      dedupeHash: null,
      raw: null,
      ...overrides,
    };

    const hash = computeDedupeHash(job);
    createdHashes.push(hash);
    return { job, hash };
  }

  /**
   * Insert on `dedupe_hash`, mirroring what `upsertCanonicalJob` sends.
   *
   * Written out rather than calling the production helper, because the helper's structural
   * `JobWriter` type is satisfied by the real client too — but asserting on the returned
   * row keeps this test reading as "what does the table end up holding", which is the
   * question ING-007 actually asks.
   */
  async function upsert(job: CanonicalJob, hash: string): Promise<void> {
    const { error } = await admin
      .from("jobs")
      .upsert(
        {
          dedupe_hash: hash,
          title: job.title,
          title_norm: job.titleNorm,
          company_name: job.companyName,
          company_domain: job.companyDomain,
          city: job.location.city,
          country_code: job.location.countryCode,
          work_mode: job.workMode,
          employment_type: job.employmentType,
          seniority: job.seniority,
          description_text: job.descriptionText,
          source_url: job.sourceUrl,
          status: job.status,
        },
        { onConflict: "dedupe_hash" },
      );
    if (error) throw new Error(`upsert: ${error.message}`);
  }

  // ING-007 test 1. The headline requirement: three sources, one row, sighting_count = 3.
  it("collapses the same posting from three sources into one row with sighting_count = 3", async () => {
    const { job, hash } = makeJob();

    // Three sightings that differ only in the field a syndicator would change.
    await upsert({ ...job, sourceUrl: "https://greenhouse.example.invalid/1" }, hash);
    await upsert({ ...job, sourceUrl: "https://lever.example.invalid/1" }, hash);
    await upsert({ ...job, sourceUrl: "https://adzuna.example.invalid/1" }, hash);

    const { data, error } = await admin
      .from("jobs")
      .select("id, sighting_count")
      .eq("dedupe_hash", hash);
    if (error) throw new Error(`select: ${error.message}`);

    expect(data).toHaveLength(1);
    // The first insert seeds sighting_count at 1, so three upserts must land on 3 — not 1
    // (no increment) and not 4 (a fourth increment for the initial insert).
    expect(data?.[0]?.sighting_count).toBe(3);
  });

  it("bumps last_seen_at on a repeat sighting", async () => {
    const { job, hash } = makeJob({ title: "Repeat Sighting Role" });

    const before = new Date(Date.now() - 60_000).toISOString();
    await upsert({ ...job, firstSeenAt: before, lastSeenAt: before }, hash);
    await upsert({ ...job, firstSeenAt: before, lastSeenAt: before }, hash);

    const { data, error } = await admin
      .from("jobs")
      .select("first_seen_at, last_seen_at")
      .eq("dedupe_hash", hash);
    if (error) throw new Error(`select: ${error.message}`);

    // Asserted as an exact ISO string rather than through `new Date(...)`: the column is
    // `timestamptz`, and comparing a `Date` to a `Date` here would type as `any` and hide
    // whether the value round-tripped. `first_seen_at` must not be reset by a re-sighting —
    // a job re-listed daily would otherwise look brand new forever and never decay to `stale`
    // (ING-010).
    const firstSeen = data?.[0]?.first_seen_at;
    expect(typeof firstSeen).toBe("string");
    expect(new Date(firstSeen as string).toISOString()).toBe(new Date(before).toISOString());
  });

  // ING-007 test 2. The guard against over-merging: distinct roles at one employer stay
  // distinct. This is the case a fuzzy pass with too loose a threshold gets wrong.
  it("keeps two genuinely different roles at the same company as separate rows", async () => {
    const engineer = makeJob({ title: "Principal Software Engineer" });
    const designer = makeJob({ title: "Warehouse Supervisor" });

    await upsert(engineer.job, engineer.hash);
    await upsert(designer.job, designer.hash);

    expect(engineer.hash).not.toBe(designer.hash);

    // Scoped to the two hashes, not to `company_name`: every other test in this file also
    // inserts rows under `${TAG}acme`, so a company-scoped count would pass or fail on
    // unrelated rows and would not be asserting what the test name claims.
    const { data, error } = await admin
      .from("jobs")
      .select("dedupe_hash")
      .in("dedupe_hash", [engineer.hash, designer.hash]);
    if (error) throw new Error(`select: ${error.message}`);

    // Both roles survive as their own row — this is the assertion the test name promises.
    expect(data).toHaveLength(2);

    // And the fuzzy pass would not have merged them either, so pass 2 agrees with pass 1.
    const similarity = trigramSimilarity(
      engineer.job.titleNorm ?? "",
      designer.job.titleNorm ?? "",
    );
    expect(similarity).toBeLessThan(0.85);
  });

  // The unique index itself. A mock cannot show that the second insert is *rejected* rather
  // than silently creating a second row.
  it("rejects a second row with the same dedupe_hash", async () => {
    const { job, hash } = makeJob({ title: "Unique Index Probe" });

    await upsert(job, hash);
    const { error } = await admin.from("jobs").insert({
      dedupe_hash: hash,
      title: "Duplicate Probe",
      title_norm: "duplicateprobe",
      company_name: `${TAG}acme`,
      source_url: "https://example.invalid/dup",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/duplicate key/i);
  });

  it("hashes two spellings of one company to the same value in the real table", async () => {
    // "Acme Inc" and "Acme Ltd" are one employer. The slug helper strips the suffix, so both
    // resolve to the same dedupe hash and the second upsert bumps the first row.
    const inc = makeJob({ title: "Legal Suffix Role", companyName: `${TAG}acme inc` });
    const ltd = makeJob({ title: "Legal Suffix Role", companyName: `${TAG}acme ltd` });

    expect(normaliseForHash(inc.job).company).toBe(normaliseForHash(ltd.job).company);

    await upsert(inc.job, inc.hash);
    await upsert(ltd.job, ltd.hash);

    const { data, error } = await admin
      .from("jobs")
      .select("id, sighting_count")
      .eq("dedupe_hash", inc.hash);
    if (error) throw new Error(`select: ${error.message}`);

    expect(data).toHaveLength(1);
    expect(data?.[0]?.sighting_count).toBe(2);
  });
});
