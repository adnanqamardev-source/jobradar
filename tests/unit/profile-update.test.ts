/**
 * profile-update.test.ts — the shared `profiles` write path (BE-304).
 *
 * The behaviour that matters here is the docs/03 §5.2 optimistic-concurrency
 * guard. Until it existed the three profile actions did a bare
 * `.update(...).eq("id", userId)`, so two tabs editing the same profile meant the
 * second silently clobbered the first. These tests pin that the guard now turns
 * that case into a 409-shaped `edit_conflict` rather than a lost write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const revalidatePathMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
  revalidateTag: vi.fn(),
}));

import { updateOwnProfile } from "@/lib/db/profile-update";

/**
 * A Supabase double that records every `.eq()` filter, so a test can assert the
 * UPDATE was scoped by `updated_at` and not just by `id`.
 */
function makeClient(rows: unknown[] | null, error: { message: string } | null = null) {
  const filters: Record<string, unknown>[] = [];

  const select = vi.fn().mockResolvedValue({ data: rows, error });
  const chain: { eq?: unknown; select?: unknown } = { select };
  const eq = vi.fn((column: string, value: unknown) => {
    filters.push({ column, value });
    return chain;
  });
  chain.eq = eq;

  const from = vi.fn(() => ({ update: vi.fn(() => chain) }));

  return { from, filters };
}

beforeEach(() => {
  revalidatePathMock.mockReset();
});

const ROW = { id: "u1", updated_at: "2026-10-06T00:00:00.000Z" };

describe("updateOwnProfile — optimistic concurrency (docs/03 §5.2)", () => {
  it("scopes the update by updated_at when the caller supplies one", async () => {
    const client = makeClient([ROW]);

    const res = await updateOwnProfile(
      client as never,
      "u1",
      { city: "Bengaluru" },
      "2026-10-06T00:00:00.000Z",
      "Failed",
    );

    expect(res.ok).toBe(true);
    expect(client.filters).toEqual([
      { column: "id", value: "u1" },
      { column: "updated_at", value: "2026-10-06T00:00:00.000Z" },
    ]);
  });

  it("reports edit_conflict when the guard matches zero rows", async () => {
    // Zero rows, no error — this is what "another tab wrote first" looks like.
    const client = makeClient([]);

    const res = await updateOwnProfile(
      client as never,
      "u1",
      { city: "Bengaluru" },
      "2026-10-06T00:00:00.000Z",
      "Failed",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("edit_conflict");
      // Verbatim copy from docs/03 §5.2.
      expect(res.error.message).toBe(
        "This changed in another tab. Reload to see the latest.",
      );
    }
    // A rejected write must not refresh caches.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("does not add the updated_at filter when the caller omits it", async () => {
    const client = makeClient([ROW]);

    const res = await updateOwnProfile(client as never, "u1", { city: "Bengaluru" }, undefined, "Failed");

    expect(res.ok).toBe(true);
    expect(client.filters).toEqual([{ column: "id", value: "u1" }]);
  });

  it("reports not_found (not edit_conflict) when unguarded and zero rows", async () => {
    const client = makeClient([]);

    const res = await updateOwnProfile(client as never, "u1", { city: "X" }, undefined, "Failed");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("reports DATABASE_ERROR on a genuine database error", async () => {
    const client = makeClient(null, { message: "permission denied" });

    const res = await updateOwnProfile(
      client as never,
      "u1",
      { city: "Bengaluru" },
      "2026-10-06T00:00:00.000Z",
      "Failed to update profile",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("DATABASE_ERROR");
      // The upstream message is not surfaced to the user.
      expect(res.error.message).toBe("Failed to update profile");
      expect(res.error.message).not.toContain("permission denied");
    }
  });

  it("revalidates the caller's own paths on success (docs/02:183)", async () => {
    const client = makeClient([ROW]);

    await updateOwnProfile(client as never, "u1", { city: "Bengaluru" }, undefined, "Failed");

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("returns the updated row", async () => {
    const client = makeClient([{ ...ROW, city: "Bengaluru" }]);

    const res = await updateOwnProfile(client as never, "u1", { city: "Bengaluru" }, undefined, "Failed");

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.profile.city).toBe("Bengaluru");
  });
});