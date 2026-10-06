/**
 * semantic.ts — embeddings and cosine similarity (SCR-003, BE-203).
 *
 * docs/02b §6.3: `semantic score 0–100 → cosine(job.embedding, profile.embedding)`, and
 * SCR-003: `semantic_score = (1 - cosine_distance) * 100`, clamped 0–100.
 *
 * ## Everything here is non-fatal by construction
 *
 * docs/04 §5.9: "Embedding failure retries and does **not** block the feed." This is not
 * a `try/catch` the caller has to remember to write — {@link embedTexts} and
 * {@link cosineSimilarityPercent} return `null` on every failure path, so "no semantic
 * score" is a value the composer already handles by reweighting to the rule score. The
 * alternative, throwing, would put the obligation on three future callers.
 *
 * ## `dimensions` is deliberately omitted from the request
 *
 * docs/04 §5.3: this model **rejects any value other than its native 2048** with HTTP
 * 400, and `vector(2048)` in docs/02 §5 matches. Sending `dimensions: 1024` to save
 * bandwidth would 400 every request, so the field is not present in the body at all
 * rather than set to the right number — a comment cannot drift from a value.
 */

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/** Dimensions the configured embedding model returns; matches `vector(2048)`. */
export const EMBEDDING_DIMENSIONS = 2048;

/** docs/04 §5.3: "Batching mandatory", batches ≤100 inputs. */
export const MAX_EMBED_BATCH = 100;

const EMBEDDING_PATH = "/embeddings";
const BASE_DELAY_MS = 1000;
const MAX_RETRIES = 3;

interface OpenRouterEmbeddingResponse {
  data?: { embedding?: number[] }[];
}

/** Delay used between retries; injectable so tests never wait. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Embed a batch of texts. Returns one vector per input, or `null` if the call failed.
 *
 * ## Why the output is re-ordered by `index`
 *
 * The API is documented to return `data[i]` matching `input[i]`, but the response object
 * carries its own `index` field precisely because ordering is not something to assume.
 * An earlier revision zipped by array position; a response that returned items out of
 * order would silently pair the wrong text with the wrong vector, and because embeddings
 * are cached to `jobs.embedding` and `profiles.profile_embedding`, that mis-pairing would
 * persist for the life of the row and be invisible in every downstream score.
 *
 * ## Why batch size is enforced here
 *
 * A caller passing 250 inputs gets three calls rather than one 400. Splitting is silent
 * on success and reported on failure, so an oversized batch degrades instead of failing.
 */
export async function embedTexts(
  texts: string[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<number[][] | null> {
  const nonEmpty = texts.filter((t) => t.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  const doFetch = options.fetchImpl ?? fetch;
  const out: number[][] = [];

  for (let i = 0; i < nonEmpty.length; i += MAX_EMBED_BATCH) {
    const batch = nonEmpty.slice(i, i + MAX_EMBED_BATCH);
    const vectors = await embedBatch(batch, doFetch);
    // A partial result would misalign every later index, so the whole call is a failure.
    if (vectors === null) return null;
    out.push(...vectors);
  }

  return out;
}

async function embedBatch(
  batch: string[],
  doFetch: typeof fetch,
): Promise<number[][] | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await doFetch(`${env.OPENROUTER_BASE_URL}${EMBEDDING_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
          "X-Title": "JobRadar Scorer",
        },
        body: JSON.stringify({
          model: env.OPENROUTER_EMBEDDING_MODEL,
          input: batch,
          // No `dimensions` — see the module docstring.
        }),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const wait = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : BASE_DELAY_MS * 2 ** attempt;
        await delay(wait);
        continue;
      }

      if (!response.ok) {
        // Log and give up: docs/04 §5.9 says an embedding failure must not block the feed,
        // and the caller has a working rule score to fall back to.
        logger.warn("Embedding request failed", {
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const data = (await response.json()) as OpenRouterEmbeddingResponse;
      const vectors = orderByIndex(data, batch.length);
      if (vectors === null) return null;

      logger.info("Embedded batch", { count: vectors.length });
      return vectors;
    } catch (error) {
      logger.warn("Embedding request threw", {
        message: error instanceof Error ? error.message : String(error),
        attempt,
      });
      // Exhausting retries falls through to the null the caller already handles.
    }
  }

  return null;
}

/**
 * Type guard for a usable embedding vector.
 *
 * Written as a predicate rather than an inline `Array.isArray` check because
 * `Array.isArray` narrows `unknown` to `any[]`, and assigning that into a
 * `number[][]` is an unchecked cast — which ESLint correctly rejects. The predicate
 * carries the guarantee instead.
 */
function isNumberVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Re-order `data` by its own `index` field and validate the result.
 *
 * Returns `null` — never a partial array — when the response is short, has a duplicate or
 * out-of-range index, or carries a vector of the wrong width. A partial array would
 * silently shift every subsequent text onto the wrong embedding.
 */
function orderByIndex(data: OpenRouterEmbeddingResponse, expected: number): number[][] | null {
  const items: { index?: unknown; embedding?: unknown }[] | undefined = data.data;
  if (!Array.isArray(items) || items.length !== expected) return null;

  // `Array.from` rather than `new Array(expected)`: the latter is typed `any[]`, and
  // assigning it into a typed array is an unchecked cast that ESLint correctly rejects.
  const out: (number[] | undefined)[] = Array.from({ length: expected }, () => undefined);
  for (const item of items) {
    const index = typeof item.index === "number" ? item.index : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= expected) return null;
    if (out[index] !== undefined) return null; // duplicate index

    const embedding = item.embedding;
    if (!isNumberVector(embedding)) return null;
    if (embedding.length !== EMBEDDING_DIMENSIONS) return null;

    out[index] = embedding;
  }

  return out.every((v): v is number[] => v !== undefined) ? out : null;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity as a 0–100 score, or `null` when it cannot be computed.
 *
 * Implements SCR-003's `(1 - cosine_distance) * 100` directly rather than reaching for
 * pgvector's `<=>` operator, so the arithmetic is unit-testable without Postgres and
 * identical in both places.
 *
 * ## The degenerate cases, which are real rather than theoretical
 *
 * - **A zero vector** has no direction, so cosine is undefined. Dividing by its magnitude
 *   yields `NaN` or `Infinity`, and `NaN` propagating into `job_scores` would persist a
 *   score the UI cannot render. Returning `null` lets the composer reweight to the rule
 *   score instead.
 * - **A dimension mismatch** means the vectors came from different models, which is a
 *   full-reindex situation (docs/02 §7.1) and not something to paper over. Also `null`.
 * - **Out-of-range vectors** are clamped. This does mean a cosine >1 is silently hidden
 *   rather than surfaced as a data problem, which is a deliberate trade: a score outside
 *   0–100 would break the feed's ordering, and a clamped score is visibly odd but usable.
 */
export function cosineSimilarityPercent(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return null;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(similarity)) return null;

  // SCR-003: `(1 - cosine_distance) * 100`. pgvector's cosine *distance* is
  // `1 - similarity`, so the expression is algebraically just `similarity * 100`.
  // It is written in the distance form to match the ticket, but evaluated as the
  // simplified form — spelling out `1 - (1 - similarity)` at runtime would be
  // float noise dressed up as fidelity, and it could return 99.99999999999999.
  const percent = similarity * 100;
  return Math.min(100, Math.max(0, percent));
}