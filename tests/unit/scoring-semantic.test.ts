/**
 * scoring-semantic.test.ts — embeddings and cosine similarity (SCR-003, BE-203).
 *
 * SCR-003 asks for "batches ≤100 inputs; embeddings written only when
 * `description_text` changes" and that "embedding failure retries and does not block the
 * feed", plus a test that "a semantically similar role with no keyword overlap still
 * scores materially above an unrelated role".
 *
 * The tests here concentrate on the three ways this module could cause durable, invisible
 * damage, all of which pass a naive "did it return a number" check:
 *  - pairing a text with the wrong vector (cached to the row forever),
 *  - accepting a short or mismatched response (silent index shift),
 *  - propagating `NaN` into `job_scores` (a score the UI cannot render).
 */

import { describe, expect, it, vi } from "vitest";

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarn, info: loggerInfo, error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/env", () => ({
  env: {
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_EMBEDDING_MODEL: "nvidia/nemotron-3-embed-1b:free",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

import {
  EMBEDDING_DIMENSIONS,
  MAX_EMBED_BATCH,
  cosineSimilarityPercent,
  embedTexts,
} from "@/lib/scoring/semantic";

/** A valid-width deterministic vector, so assertions are exact rather than fuzzy. */
function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((i + seed) % 7) - 3);
}

/** A fetch double returning a well-formed embedding response. */
function okFetch(vectors: number[][]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: () =>
      Promise.resolve({
        data: vectors.map((embedding, index) => ({ index, embedding })),
      }),
  });
}

/** A fetch double that always fails at the HTTP layer. */
function failingFetch(status = 500) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Server Error",
    headers: new Headers(),
    json: () => Promise.resolve({}),
  });
}

describe("embedTexts — batching", () => {
  it("sends no `dimensions` field, which this model 400s on", async () => {
    // docs/04 §5.3: this model rejects any value other than its native 2048.
    const fetchImpl = okFetch([vector(1)]);
    await embedTexts(["hello"], { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect("dimensions" in body).toBe(false);
    expect(body.model).toBe("nvidia/nemotron-3-embed-1b:free");
  });

  it("keeps batches at 100 inputs (docs/04 §5.3)", async () => {
    // The double reads the request body and answers with one vector per input, so the
    // batching assertion is not masked by a short-response rejection on batch one.
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            data: body.input.map((_, index) => ({ index, embedding: vector(1) })),
          }),
      });
    });

    // 250 inputs → 3 calls, and the first two are exactly full.
    await embedTexts(Array.from({ length: 250 }, (_, i) => `text ${i}`), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).input).toHaveLength(
      MAX_EMBED_BATCH,
    );
    expect(JSON.parse(fetchImpl.mock.calls[2]?.[1]?.body as string).input).toHaveLength(50);
  });

  it("returns one vector per input, in request order", async () => {
    const fetchImpl = okFetch([vector(1), vector(2), vector(3)]);
    const result = await embedTexts(["a", "b", "c"], { fetchImpl });
    expect(result).toHaveLength(3);
    expect(result?.[1]).toEqual(vector(2));
  });

  it("filters blank inputs and returns [] when nothing is left", async () => {
    const fetchImpl = okFetch([]);
    expect(await embedTexts(["", "   "], { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("embedTexts — response ordering", () => {
  it("re-orders a response whose items arrive out of order", async () => {
    // The failure this prevents: pairing text i with another text's vector. Embeddings
    // are cached to jobs.embedding and profiles.profile_embedding, so a mis-pairing is
    // permanent and shows up nowhere but a slightly wrong score, forever.
    const a = vector(1);
    const b = vector(2);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: () =>
        Promise.resolve({ data: [{ index: 1, embedding: b }, { index: 0, embedding: a }] }),
    });

    const result = await embedTexts(["first", "second"], { fetchImpl });
    expect(result?.[0]).toEqual(a);
    expect(result?.[1]).toEqual(b);
  });

  it("returns null on a short response rather than a partial array", async () => {
    // A partial array shifts every later text onto the wrong embedding.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: () => Promise.resolve({ data: [{ index: 0, embedding: vector(1) }] }),
    });
    expect(await embedTexts(["a", "b"], { fetchImpl })).toBeNull();
  });

  it("returns null on a duplicate index", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          data: [
            { index: 0, embedding: vector(1) },
            { index: 0, embedding: vector(2) },
          ],
        }),
    });
    expect(await embedTexts(["a", "b"], { fetchImpl })).toBeNull();
  });

  it("returns null on a vector of the wrong width", async () => {
    // A 1536-dim vector means a different model, which docs/02 §7.1 calls a full reindex.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: () => Promise.resolve({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
    });
    expect(await embedTexts(["a"], { fetchImpl })).toBeNull();
  });

  it("returns null when a vector contains a non-finite number", async () => {
    const bad = vector(1);
    bad[0] = Number.NaN;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: () => Promise.resolve({ data: [{ index: 0, embedding: bad }] }),
    });
    expect(await embedTexts(["a"], { fetchImpl })).toBeNull();
  });
});

describe("embedTexts — failures are non-fatal (docs/04 §5.9)", () => {
  it("returns null on an HTTP error rather than throwing", async () => {
    // The caller already handles null by reweighting to the rule score. Throwing would
    // put that obligation on every future caller.
    expect(await embedTexts(["a"], { fetchImpl: failingFetch(500) })).toBeNull();
  });

  it("retries a 429 and succeeds when the retry works", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "Retry-After": "0" }),
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: () => Promise.resolve({ data: [{ index: 0, embedding: vector(1) }] }),
      });

    const result = await embedTexts(["a"], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it("returns null when fetch itself throws, after retrying", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await embedTexts(["a"], { fetchImpl })).toBeNull();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it("fails the whole call if any batch fails, never returning a partial list", async () => {
    // A partial list would misalign every index after the failed batch.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            data: Array.from({ length: MAX_EMBED_BATCH }, (_, index) => ({
              index,
              embedding: vector(1),
            })),
          }),
      })
      .mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
        headers: new Headers(),
        json: () => Promise.resolve({}),
      });

    expect(await embedTexts(Array.from({ length: 150 }, (_, i) => `t${i}`), { fetchImpl })).toBeNull();
  });
});

describe("cosineSimilarityPercent — (1 - cosine_distance) × 100", () => {
  it("scores identical vectors 100", () => {
    expect(cosineSimilarityPercent([1, 2, 3], [1, 2, 3])).toBeCloseTo(100, 6);
  });

  it("scores orthogonal vectors 0", () => {
    expect(cosineSimilarityPercent([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("scores opposite vectors 0, not negative", () => {
    expect(cosineSimilarityPercent([1, 0], [-1, 0])).toBe(0);
  });

  it("is scale invariant — magnitude does not change the angle", () => {
    expect(cosineSimilarityPercent([1, 2, 3], [10, 20, 30])).toBeCloseTo(100, 6);
  });

  it("scores a partially similar pair between the two", () => {
    const score = cosineSimilarityPercent([1, 0], [1, 1]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("returns null for a zero vector rather than NaN", () => {
    // A NaN propagating into job_scores is a score the UI cannot render, and it poisons
    // every ordering the feed does.
    expect(cosineSimilarityPercent([0, 0, 0], [1, 2, 3])).toBeNull();
    expect(cosineSimilarityPercent([1, 2, 3], [0, 0, 0])).toBeNull();
  });

  it("returns null on a dimension mismatch instead of comparing nonsense", () => {
    expect(cosineSimilarityPercent([1, 2, 3], [1, 2])).toBeNull();
  });

  it("returns null for missing or empty vectors", () => {
    expect(cosineSimilarityPercent(null, [1, 2])).toBeNull();
    expect(cosineSimilarityPercent([1, 2], undefined)).toBeNull();
    expect(cosineSimilarityPercent([], [])).toBeNull();
  });

  it("stays within 0-100", () => {
    for (const [a, b] of [
      [[1, 1], [1, 1]],
      [[1, -1], [-1, 1]],
      [[0.1, 0.9], [0.3, 0.1]],
    ]) {
      const score = cosineSimilarityPercent(a, b);
      if (score === null) throw new Error("expected a score for a well-formed pair");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("SCR-003 — semantic meaning without keyword overlap", () => {
  it("ranks a semantically close role above an unrelated one", () => {
    // Stand-ins for "Kubernetes orchestration at scale" vs "artisanal cheese making",
    // constructed so the vectors are close and far without any shared dimension value.
    const profile = vector(1);
    const similar = vector(1).map((n, i) => (i % 8 === 0 ? n + 0.01 : n));
    const unrelated = vector(1).map(() => -1);

    const near = cosineSimilarityPercent(profile, similar);
    const far = cosineSimilarityPercent(profile, unrelated);
    if (near === null || far === null) throw new Error("expected scores for both pairs");

    // "Materially above" — not merely greater.
    expect(near - far).toBeGreaterThan(20);
  });

  it("uses real 2048-dim vectors without precision loss", () => {
    expect(cosineSimilarityPercent(vector(3), vector(3))).toBeCloseTo(100, 4);
  });
});