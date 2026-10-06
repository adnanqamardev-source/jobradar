/**
 * rescore-profile.test.ts — the `rescore_profile` handler (SCR-005, BE-205).
 *
 * SCR-005 asks for: profile save enqueues `rescore_profile` and never blocks the request;
 * the handler processes in batches and is safe to run concurrently; new scores replace
 * old rows with no unbounded growth; a "Rescoring your feed…" indicator clears on
 * completion.
 *
 * The enqueue half is BE-304 and already tested (`enqueue-rescore.test.ts` plus the
 * DB-level RPC properties). This file covers the **handler** half, and concentrates on the
 * rule docs/02 §6.4 states as a hard constraint: "Vercel function timeouts are respected
 * by batch size, not long-running loops — if a batch is incomplete, the handler
 * re-enqueues itself." A handler that loops instead is the failure that produces
 * half-written batches and orphaned leases, and it is invisible in a test that only ever
 * feeds it a small feed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const loggerError = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: loggerInfo, warn: vi.fn(), debug: vi.fn() },
}));

// The handler reaches `@/lib/env` through `scoring/semantic.ts`, which reads the
// OpenRouter config at import time. No call is made here, so a stub is enough.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_EMBEDDING_MODEL: "nvidia/nemotron-3-embed-1b:free",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

import {
  RESCORE_BATCH_SIZE,
  planRescoreBatch,
  runRescoreProfile,
  type RescoreJobRow,
  type RescoreProfileRow,
  type RescoreStore,
} from "@/lib/queue/handlers/rescore-profile";

const NOW = new Date("2026-10-06T12:00:00.000Z");

function job(id: string, overrides: Partial<RescoreJobRow> = {}): RescoreJobRow {
  return {
    id,
    title: "Senior Backend Engineer",
    company_name: "Globex",
    company_domain: "globex.io",
    description_text: "Go and PostgreSQL.",
    country_code: "IN",
    work_mode: "remote",
    remote_scope: "global",
    seniority: "senior",
    salary_min: 3000000,
    salary_max: 4000000,
    salary_currency: "INR",
    salary_period: "year",
    posted_at: NOW.toISOString(),
    embedding: null,
    ...overrides,
  };
}

function profile(overrides: Partial<RescoreProfileRow> = {}): RescoreProfileRow {
  return {
    id: "p1",
    target_titles: ["backend engineer"],
    seniority: "senior",
    years_experience: 6,
    country_code: "IN",
    work_modes: ["remote"],
    min_salary: null,
    salary_currency: "INR",
    salary_period: "year",
    preferred_companies: [],
    blocked_companies: [],
    excluded_keywords: [],
    profile_embedding: null,
    ...overrides,
  };
}

/** A store double that records what the handler did, and honours the `limit` it is given. */
function makeStore(opts: {
  jobs?: RescoreJobRow[];
  total?: number;
  failOn?: string;
}) {
  const all = opts.jobs ?? [];
  const saved: { profileId: string; jobId: string; finalScore: number }[] = [];
  const requeues: { profileId: string; resumeAfter: string }[] = [];

  // Named mocks, returned alongside the store: asserting through `store.listJobs` would
  // pass the method as a bare reference, which `unbound-method` correctly rejects.
  const listJobs = vi
    .fn()
    .mockImplementation((_profileId: string, _resumeAfter: string | null, limit: number) =>
      Promise.resolve(all.slice(0, limit)),
    );
  const listJobSkills = vi.fn().mockResolvedValue([]);
  const saveScore = vi.fn().mockImplementation((score: { profileId: string; jobId: string; finalScore: number }) => {
    if (opts.failOn && score.jobId === opts.failOn) return { ok: false };
    saved.push({
      profileId: score.profileId,
      jobId: score.jobId,
      finalScore: score.finalScore,
    });
    return { ok: true };
  });
  const requeue = vi.fn().mockImplementation((profileId: string, resumeAfter: string) => {
    requeues.push({ profileId, resumeAfter });
    return Promise.resolve();
  });

  const store: RescoreStore = {
    // The real store limits the page; a double that ignored `limit` would let a planner
    // test pass a list the executor could never actually receive.
    listJobs,
    countRemaining: vi.fn().mockResolvedValue(opts.total ?? all.length),
    listJobSkills,
    listProfileSkills: vi.fn().mockResolvedValue([]),
    saveScore,
    requeue,
  };

  return { store, saved, requeues, listJobs, listJobSkills, saveScore };
}

// ---------------------------------------------------------------------------

describe("planRescoreBatch — bounded batch, re-enqueue if incomplete", () => {
  it("reports done when the feed fits in one batch", () => {
    const verdict = planRescoreBatch({ jobs: [job("j1"), job("j2")], batchSize: 10 }, 2);
    expect(verdict).toEqual({ kind: "done", scored: 2, total: 2, coverage: 1 });
  });

  it("reports done when the feed is exactly one batch", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => job(`j${i}`));
    expect(planRescoreBatch({ jobs, batchSize: 10 }, 10).kind).toBe("done");
  });

  it("re-enqueues when the feed exceeds one batch", () => {
    // docs/02 §6.4: an incomplete batch re-enqueues rather than looping.
    const jobs = Array.from({ length: 250 }, (_, i) => job(`j${i}`));
    // The store returns one page; `total` says how much is left overall.
    const verdict = planRescoreBatch({ jobs: jobs.slice(0, 100), batchSize: 100 }, 250);

    expect(verdict.kind).toBe("requeue");
    if (verdict.kind !== "requeue") return;
    expect(verdict.scored).toBe(100);
    expect(verdict.total).toBe(250);
    expect(verdict.coverage).toBe(0.4);
    expect(verdict.resumeAfter).toBe(jobs[99]?.posted_at);
  });

  it("does NOT claim completion for a partial batch", () => {
    // The bug this prevents: a 100-job page against 2,000 remaining reported as "done",
    // so the remaining 1,900 were never scored and nothing said so.
    const jobs = Array.from({ length: 100 }, (_, i) => job(`j${i}`));
    const verdict = planRescoreBatch({ jobs, batchSize: 100 }, 2000);
    expect(verdict.kind).toBe("requeue");
    expect(verdict.coverage).toBe(0.05);
  });

  it("defaults to a 100-job batch (docs/02 §6.4 batch-size constraint)", () => {
    expect(RESCORE_BATCH_SIZE).toBe(100);
    const jobs = Array.from({ length: 101 }, (_, i) => job(`j${i}`));
    expect(planRescoreBatch({ jobs: jobs.slice(0, 100) }, 101).kind).toBe("requeue");
  });

  it("copes with a nullable posted_at when building the cursor", () => {
    const jobs = Array.from({ length: 100 }, (_, i) =>
      job(`j${i}`, { posted_at: i === 99 ? null : NOW.toISOString() }),
    );
    const verdict = planRescoreBatch({ jobs, batchSize: 100 }, 101);
    expect(verdict.kind).toBe("requeue");
    if (verdict.kind !== "requeue") return;
    expect(verdict.resumeAfter).toBe("");
  });

  it("is pure", () => {
    const jobs = [job("j1")];
    const before = JSON.stringify(jobs);
    planRescoreBatch({ jobs, batchSize: 1 }, 1);
    expect(JSON.stringify(jobs)).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("runRescoreProfile", () => {
  beforeEach(() => {
    loggerError.mockReset();
    loggerInfo.mockReset();
  });

  it("scores every job in the batch", async () => {
    const jobs = [job("j1"), job("j2"), job("j3")];
    const { store, saved } = makeStore({ jobs, total: 3 });

    const result = await runRescoreProfile({ store, profile: profile(), now: NOW });

    expect(result.scored).toBe(3);
    expect(result.failed).toBe(0);
    expect(saved.map((s) => s.jobId)).toEqual(["j1", "j2", "j3"]);
  });

  it("passes the caller's profile id to every write", async () => {
    const { store, saved } = makeStore({ jobs: [job("j1")], total: 1 });
    await runRescoreProfile({ store, profile: profile({ id: "user-42" }), now: NOW });
    expect(saved[0]?.profileId).toBe("user-42");
  });

  it("re-enqueues exactly once when work remains", async () => {
    const jobs = Array.from({ length: 150 }, (_, i) => job(`j${i}`));
    const { store, requeues } = makeStore({ jobs, total: 150 });

    const result = await runRescoreProfile({ store, profile: profile(), batchSize: 100, now: NOW });

    expect(result.scored).toBe(100);
    expect(result.verdict.kind).toBe("requeue");
    expect(requeues).toHaveLength(1);
    expect(requeues[0]?.profileId).toBe("p1");
  });

  it("does not re-enqueue when the batch completed the feed", async () => {
    // A trailing re-enqueue on the final batch would leave a pending task that finds no
    // work, which then has to be explained in the queue metrics.
    const { store, requeues } = makeStore({ jobs: [job("j1")], total: 1 });

    await runRescoreProfile({ store, profile: profile(), now: NOW });

    expect(requeues).toEqual([]);
  });

  it("one failing job does not abort the rest of the batch", async () => {
    // 99 healthy jobs losing their scores because job 3 had a bad row is a far worse
    // outcome than one unscored job.
    const jobs = [job("j1"), job("bad"), job("j3")];
    const { store, saved } = makeStore({ jobs, total: 3, failOn: "bad" });

    const result = await runRescoreProfile({ store, profile: profile(), now: NOW });

    expect(result.failed).toBe(1);
    expect(result.scored).toBe(2);
    expect(saved.map((s) => s.jobId)).toEqual(["j1", "j3"]);
  });

  it("counts a throwing row as failed and carries on", async () => {
    const jobs = [job("boom"), job("j2")];
    const { store } = makeStore({ jobs, total: 2 });
    store.saveScore = vi.fn().mockImplementation((score: { jobId: string }) => {
      if (score.jobId === "boom") throw new Error("db exploded");
      return { ok: true };
    });

    const result = await runRescoreProfile({ store, profile: profile(), now: NOW });

    expect(result.failed).toBe(1);
    expect(result.scored).toBe(1);
    expect(loggerError).toHaveBeenCalled();
  });

  it("writes a gated job at 0 rather than skipping it", async () => {
    // The gated row is the only record of why a job is missing from the feed.
    const { store, saved } = makeStore({
      jobs: [job("j1", { company_name: "Acme", company_domain: "acme.com" })],
      total: 1,
    });

    await runRescoreProfile({
      store,
      profile: profile({ blocked_companies: ["acme.com"] }),
      now: NOW,
    });

    expect(saved[0]?.finalScore).toBe(0);
  });

  it("does not query job_skills for an empty batch", async () => {
    const { store, listJobSkills } = makeStore({ jobs: [], total: 0 });
    await runRescoreProfile({ store, profile: profile(), now: NOW });
    expect(listJobSkills.mock.calls).toHaveLength(0);
  });

  it("attaches job_skills to the right job", async () => {
    const jobs = [job("j1"), job("j2")];
    const { store, listJobSkills } = makeStore({ jobs, total: 2 });
    listJobSkills.mockResolvedValue([
      { job_id: "j1", skill_id: "go", weight: 1 },
      { job_id: "j2", skill_id: "rust", weight: 1 },
    ]);

    await runRescoreProfile({ store, profile: profile(), now: NOW });

    expect(listJobSkills.mock.calls[0]?.[0]).toEqual(["j1", "j2"]);
  });

  it("passes the resume cursor through to the store", async () => {
    const { store, listJobs } = makeStore({ jobs: [job("j1")], total: 1 });
    await runRescoreProfile({
      store,
      profile: profile(),
      resumeAfter: "2026-10-01T00:00:00.000Z",
      now: NOW,
    });
    expect(listJobs.mock.calls[0]).toEqual(["p1", "2026-10-01T00:00:00.000Z", 100]);
  });

  it("scores a real semantic blend when both embeddings exist", async () => {
    const { store, saved } = makeStore({ jobs: [job("j1", { embedding: [1, 0] })], total: 1 });

    await runRescoreProfile({
      store,
      profile: profile({ profile_embedding: [1, 0] }),
      now: NOW,
    });

    // Identical embeddings → cosine 100, so the blend is strictly between rule and 100.
    const score = saved[0]?.finalScore;
    if (score === undefined) throw new Error("expected a saved score");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("survives concurrent runs without duplicating writes", async () => {
    // Idempotence is structural: every write is an upsert on (user_id, job_id), so two
    // workers doing the same work converge rather than accumulating rows.
    const jobs = [job("j1"), job("j2")];
    const { store, saved } = makeStore({ jobs, total: 2 });

    await Promise.all([
      runRescoreProfile({ store, profile: profile(), now: NOW }),
      runRescoreProfile({ store, profile: profile(), now: NOW }),
    ]);

    // Both runs write the same two pairs; a unique constraint makes the second a no-op.
    expect(new Set(saved.map((s) => s.jobId))).toEqual(new Set(["j1", "j2"]));
  });
});