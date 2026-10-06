/**
 * update-dealbreakers.test.ts — the ONB-005 dealbreaker write path (BE-304).
 *
 * The behaviour under test is normalisation, and specifically that company values are
 * written as **slugs** while keyword values stay lowercased free text.
 *
 * This was a latent bug rather than a crash. The action applied
 * `trim().toLowerCase()` to all three lists, so "Acme Corp." was stored verbatim. The
 * SCR-001 `blocked_company` gate compares against `companySlugCandidates`, which
 * yields `acme-corp` — so every blocked-company entry written before the fix matched
 * nothing, and the dealbreaker was silently inert. Nothing failed: the write reported
 * success and the gate had not been written yet to disagree.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const requireUserMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());
const updateOwnProfileMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/require-user", () => ({ requireUser: requireUserMock }));
vi.mock("@/lib/db/user-client", () => ({ createUserClient: createUserClientMock }));
vi.mock("@/lib/db/profile-update", () => ({ updateOwnProfile: updateOwnProfileMock }));

import { updateDealbreakers } from "@/app/api/actions/profile/update-dealbreakers";

/** The `updates` object the action handed to the shared write path. */
function capturedUpdates(): Record<string, unknown> {
  const call = updateOwnProfileMock.mock.calls.at(-1);
  if (!call) throw new Error("updateOwnProfile was never called");
  return call[2] as Record<string, unknown>;
}

beforeEach(() => {
  requireUserMock.mockReset();
  createUserClientMock.mockReset();
  updateOwnProfileMock.mockReset();
  requireUserMock.mockResolvedValue({ id: "u1", accessToken: "jwt" });
  createUserClientMock.mockResolvedValue({});
  updateOwnProfileMock.mockResolvedValue({
    ok: true,
    data: { profile: { id: "u1" }, rescoreTaskId: "t1" },
  });
});

describe("updateDealbreakers — company normalisation", () => {
  it("stores blocked companies as slugs, not lowercased display names", async () => {
    await updateDealbreakers({ blockedCompanies: ["Acme Corp."] });
    expect(capturedUpdates().blocked_companies).toEqual(["acme-corp"]);
  });

  it("keeps a domain as a domain so the gate can match it", async () => {
    await updateDealbreakers({ blockedCompanies: ["https://www.acme.com/careers"] });
    expect(capturedUpdates().blocked_companies).toEqual(["acme.com"]);
  });

  it("dedupes after normalising, so spelling variants collapse to one entry", async () => {
    await updateDealbreakers({ blockedCompanies: ["Acme Corp.", "acme corp", "ACME  CORP"] });
    expect(capturedUpdates().blocked_companies).toEqual(["acme-corp"]);
  });

  it("drops entries that slugify to nothing rather than storing empty strings", async () => {
    await updateDealbreakers({ blockedCompanies: ["Acme", "", "   ", "!!!"] });
    expect(capturedUpdates().blocked_companies).toEqual(["acme"]);
  });

  it("applies the same normalisation to preferred companies", async () => {
    await updateDealbreakers({ preferredCompanies: ["Globex Inc."] });
    expect(capturedUpdates().preferred_companies).toEqual(["globex-inc"]);
  });
});

describe("updateDealbreakers — keyword normalisation is unchanged", () => {
  it("lowercases and trims excluded keywords, since they are matched as free text", async () => {
    await updateDealbreakers({ excludedKeywords: ["  Golang ", "JAVA"] });
    expect(capturedUpdates().excluded_keywords).toEqual(["golang", "java"]);
  });

  it("does not slugify keywords — a phrase must survive intact", async () => {
    await updateDealbreakers({ excludedKeywords: ["Python Remote"] });
    expect(capturedUpdates().excluded_keywords).toEqual(["python remote"]);
  });

  it("drops blank keywords", async () => {
    await updateDealbreakers({ excludedKeywords: ["golang", "  ", ""] });
    expect(capturedUpdates().excluded_keywords).toEqual(["golang"]);
  });
});

describe("updateDealbreakers — request handling", () => {
  it("passes expectedUpdatedAt through to the concurrency guard", async () => {
    await updateDealbreakers({
      blockedCompanies: ["Acme"],
      expectedUpdatedAt: "2026-10-06T00:00:00.000Z",
    });
    const call = updateOwnProfileMock.mock.calls.at(-1);
    expect(call?.[3]).toBe("2026-10-06T00:00:00.000Z");
  });

  it("returns NO_FIELDS when nothing was supplied", async () => {
    const result = await updateDealbreakers({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_FIELDS");
    expect(updateOwnProfileMock).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a bad payload rather than writing it", async () => {
    // Cast: the point of the case is what happens when the runtime value does not
    // match the declared type, which is exactly what a Server Action receives.
    const bad = { blockedCompanies: "not-an-array" } as unknown as Parameters<
      typeof updateDealbreakers
    >[0];
    const result = await updateDealbreakers(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(updateOwnProfileMock).not.toHaveBeenCalled();
  });
});