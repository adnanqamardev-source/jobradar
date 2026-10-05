/**
 * http.ts — timeout, retry and error-mapping tests (BE-101, docs/04 §5.9).
 *
 * Everything is injected: a fake `fetch` counts attempts, and `sleep` records the
 * requested backoff instead of waiting. A guard that can't fail is decoration, so
 * each rule is checked both ways: a retryable status *is* retried, a non-retryable
 * one is *not*, and a parse failure never retries.
 */

import { describe, expect, it, vi } from "vitest";

import { fetchJson } from "@/lib/connectors/http";
import { defaultRunCtx, type RunCtx } from "@/lib/connectors/types";

interface FakeCall {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(
  responses: (() => Promise<Response>)[],
): { ctx: RunCtx; slept: number[]; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const slept: number[] = [];
  let index = 0;

  const ctx: RunCtx = {
    ...defaultRunCtx("run-http", new AbortController().signal),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> | undefined, signal: init?.signal });
      const next = responses[Math.min(index, responses.length - 1)];
      index++;
      if (!next) throw new Error("no response queued");
      return next();
    }) as unknown as typeof fetch,
  };

  return { ctx, slept, calls };
}

describe("fetchJson", () => {
  it("returns parsed JSON on the first success", async () => {
    const { ctx, calls } = harness([() => Promise.resolve(jsonResponse(200, { jobs: [1] }))]);

    await expect(fetchJson("https://api.test/board", ctx, { label: "test" })).resolves.toEqual({
      jobs: [1],
    });
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 three times, then throws upstream_error", async () => {
    const { ctx, slept, calls } = harness([() => Promise.resolve(jsonResponse(429, {}))]);

    await expect(fetchJson("https://api.test/board", ctx, { label: "board" })).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(calls).toHaveLength(3);
    // Post-incremented exponent: 2^1 then 2^2 seconds.
    expect(slept).toEqual([2000, 4000]);
  });

  it("recovers when a retry succeeds", async () => {
    const { ctx, calls } = harness([
      () => Promise.resolve(jsonResponse(500, {})),
      () => Promise.resolve(jsonResponse(200, { ok: true })),
    ]);

    await expect(fetchJson("https://api.test/board", ctx, { label: "board" })).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 404 — a bad board is the caller's fault", async () => {
    const { ctx, slept, calls } = harness([() => Promise.resolve(jsonResponse(404, {}))]);

    await expect(fetchJson("https://api.test/board", ctx, { label: "board" })).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("maps a non-JSON body to scrape_parse_failed and does not retry it", async () => {
    const { ctx, calls } = harness([
      () => Promise.resolve(new Response("<html>nope</html>", { status: 200 })),
    ]);

    await expect(fetchJson("https://api.test/board", ctx, { label: "board" })).rejects.toMatchObject({
      code: "scrape_parse_failed",
    });
    expect(calls).toHaveLength(1);
  });

  it("maps an aborted request to upstream_timeout", async () => {
    const { ctx, calls } = harness([
      () => Promise.reject(new DOMException("aborted", "AbortError")),
    ]);

    await expect(fetchJson("https://api.test/board", ctx, { label: "board" })).rejects.toMatchObject({
      code: "upstream_timeout",
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("stops immediately when the run's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, slept, calls } = harness([() => Promise.resolve(jsonResponse(200, {}))]);
    const abortedCtx: RunCtx = { ...ctx, signal: controller.signal };

    await expect(
      fetchJson("https://api.test/board", abortedCtx, { label: "board" }),
    ).rejects.toMatchObject({ code: "upstream_timeout" });
    expect(calls).toHaveLength(0);
    expect(slept).toEqual([]);
  });

  it("passes headers and an abort signal to every attempt", async () => {
    const { ctx, calls } = harness([() => Promise.resolve(jsonResponse(200, {}))]);

    await fetchJson("https://api.test/board", ctx, {
      label: "board",
      headers: { "User-Agent": "JobRadar/1.0" },
    });

    expect(calls[0]?.headers).toEqual({ "User-Agent": "JobRadar/1.0" });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("honours a per-call retry override", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse(503, {})));
    const ctx: RunCtx = {
      ...defaultRunCtx("run-http", new AbortController().signal),
      sleep: () => Promise.resolve(),
      fetch: fetchSpy,
    };

    await expect(
      fetchJson("https://api.test/board", ctx, { label: "board", retries: 1 }),
    ).rejects.toMatchObject({ code: "upstream_error" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});