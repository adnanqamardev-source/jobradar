/**
 * update-skills.test.ts — unit tests for the ONB-003 Server Action.
 *
 * Pins the contract: `requireUser()` resolves the caller, the skill ids are
 * verified against the `skills` table, and the existing `profile_skills` rows
 * are replaced with the new list.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: () => [], set: () => undefined }),
}));

const getUserMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: getUserMock, getSession: getSessionMock },
  }),
}));

const mockFrom = vi.hoisted(() => vi.fn());
const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { updateSkills } from "@/app/api/actions/profile/update-skills";

beforeEach(() => {
  getUserMock.mockReset();
  getSessionMock.mockReset();
  mockFrom.mockReset();
  createClientMock.mockReset();
  createClientMock.mockReturnValue({ from: mockFrom });
});

describe("updateSkills", () => {
  it("requires a verified session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(
      updateSkills({
        skills: [
          { skillId: "skill-1", level: "proficient" },
          { skillId: "skill-2", level: "expert" },
          { skillId: "skill-3", level: "familiar" },
        ],
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("validates minimum 3 skills", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
    });

    const res = await updateSkills({ skills: [{ skillId: "skill-1", level: "proficient" }] });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("verifies skill ids exist", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
    });

    const inMock = vi.fn().mockResolvedValue({ data: [{ id: "skill-1" }], error: null });
    const selectMock = vi.fn().mockReturnValue({ in: inMock });

    mockFrom.mockImplementation((table) => {
      if (table === "skills") {
        return { select: selectMock };
      }
      return {};
    });

    const res = await updateSkills({
      skills: [
        { skillId: "skill-1", level: "proficient" },
        { skillId: "skill-2", level: "expert" },
        { skillId: "skill-3", level: "familiar" },
      ],
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_FOUND");
    expect(inMock).toHaveBeenCalled();
  });

  it("accepts valid input with matching skills", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", app_metadata: {} } },
      error: null,
    });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
    });

    const inMock = vi.fn().mockResolvedValue({
      data: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      error: null,
    });
    const skillsSelect = vi.fn().mockReturnValue({ in: inMock });

    const eqDeleteMock = vi.fn().mockResolvedValue({ error: null });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqDeleteMock });

    const insertMock = vi.fn().mockResolvedValue({ error: null });

    const singleMock = vi.fn().mockResolvedValue({
      data: { id: "u1", email: "test@example.com" },
      error: null,
    });
    const eqProfileMock = vi.fn().mockReturnValue({ single: singleMock });
    const profileSelect = vi.fn().mockReturnValue({ eq: eqProfileMock });

    mockFrom.mockImplementation((table) => {
      if (table === "skills") return { select: skillsSelect };
      if (table === "profile_skills") return { delete: deleteMock, insert: insertMock };
      if (table === "profiles") return { select: profileSelect };
      throw new Error(`Unexpected table: ${table}`);
    });

    const res = await updateSkills({
      skills: [
        { skillId: "s1", level: "proficient" },
        { skillId: "s2", level: "expert" },
        { skillId: "s3", level: "familiar" },
      ],
    });

    expect(res.ok).toBe(true);
    expect(eqDeleteMock).toHaveBeenCalledWith("profile_id", "u1");
    expect(insertMock).toHaveBeenCalled();
    expect(singleMock).toHaveBeenCalled();
  });
});