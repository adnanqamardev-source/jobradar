/**
 * auth-guard.test.ts — the resume actions must fail closed until BE-302 exists.
 *
 * These are guard tests, not behaviour tests. `requireUser()` and `createUserClient()`
 * exist only to *refuse* to run, and the temptation they exist to resist is the
 * "obvious" fix: hand the action the service-role key so it works. That change would
 * pass every query in the resume flow and silently disable the `resumes_*_own` RLS
 * policies in `0002_resumes.sql` — every user able to read every other user's resume.
 *
 * So the refusal is pinned here. Deleting these assertions is the signal that whatever
 * replaced them re-established ownership checks by some other means.
 */

import { describe, it, expect } from "vitest";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";

describe("requireUser", () => {
  it("rejects rather than returning an unverified identity", async () => {
    await expect(requireUser()).rejects.toThrow(/BE-302/);
  });

  it("never resolves to an identity", async () => {
    // A resolved promise here would mean some caller could act on an unverified user.
    const settled = await requireUser().then(
      () => "resolved",
      () => "rejected",
    );
    expect(settled).toBe("rejected");
  });
});

describe("createUserClient", () => {
  it("throws instead of falling back to the service-role client", () => {
    expect(() => createUserClient("any-token-at-all")).toThrow(/not implemented/);
  });

  it("names the reason, so the error is actionable in a log", () => {
    expect(() => createUserClient("token")).toThrow(/row-level security|RLS/i);
  });

  it("does not leak the token into the error message", () => {
    const secretish = "super-secret-jwt-value";
    let message = "";
    try {
      createUserClient(secretish);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretish);
  });
});