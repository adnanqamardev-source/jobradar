/**
 * enqueue-rescore.test.ts — the ONB-006 rescore enqueue seam.
 *
 * The security-critical half (who may enqueue, and for whom) lives in the database and
 * is covered by `tests/integration/` against a real Postgres. What is pinned here is the
 * contract of the caller: never throw, because the profile write has already committed by
 * the time this runs, and a thrown error would turn a saved profile into a failed save.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logger", () => ({
  logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { enqueueRescoreProfile } from "@/lib/db/enqueue-rescore";

beforeEach(() => {
  loggerErrorMock.mockReset();
});

describe("enqueueRescoreProfile", () => {
  it("returns the task id from the RPC", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: "task-abc", error: null }),
    };

    const id = await enqueueRescoreProfile(supabase as never);

    expect(id).toBe("task-abc");
    expect(supabase.rpc).toHaveBeenCalledWith("enqueue_rescore_profile");
  });

  it("returns null and logs on an RPC error — never throws", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "permission denied for function" },
      }),
    };

    const id = await enqueueRescoreProfile(supabase as never);

    expect(id).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("returns null and logs when the RPC throws", async () => {
    const supabase = {
      rpc: vi.fn().mockRejectedValue(new Error("network down")),
    };

    const id = await enqueueRescoreProfile(supabase as never);

    // The write it follows has already committed; surfacing a throw here would report a
    // failed save for a profile that was actually saved.
    expect(id).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("passes no arguments beyond the function name — nothing forgeable", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: "task-1", error: null }),
    };

    await enqueueRescoreProfile(supabase as never);

    // profile_id is forced to auth.uid() inside the function. A second argument here
    // would mean a caller could ask to rescore someone else.
    expect(supabase.rpc).toHaveBeenCalledWith("enqueue_rescore_profile");
    expect(supabase.rpc.mock.calls[0]).toHaveLength(1);
  });

  it("treats a null id from a coalesced call as success-with-no-task", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const id = await enqueueRescoreProfile(supabase as never);

    expect(id).toBeNull();
    // Not an error path — no log expected.
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});