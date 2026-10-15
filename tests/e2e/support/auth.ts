/**
 * support/auth.ts — a real session for E2E, with no test-only backdoor in the app.
 *
 * ## The problem
 *
 * Every route this suite wants to exercise — `/onboarding`, `/dashboard` — sits behind
 * `requireUser()`. Testing them needs a session, and a session is the part of an app most
 * likely to get faked badly.
 *
 * The fakes, and why each was rejected:
 *
 *  - **A test-only login route.** A second way into the app that exists only for tests is a
 *    backdoor, and it is the kind of thing that survives a refactor and reaches production.
 *  - **Hand-written auth cookies.** `@supabase/ssr`'s cookie format is an implementation detail;
 *    a hand-built one tests the cookie, not the sign-in — and would pass while the app silently
 *    stopped reading it.
 *  - **`admin.generateLink` + following the link.** Implemented and rejected: it mints an
 *    *implicit*-flow link, so GoTrue redirects with `#access_token=…` in the **fragment** rather
 *    than `?code=`. The app's `/auth/callback` only reads `code`, so the browser lands on
 *    `/auth/auth_code_error`. That is the harness's limitation, not an app bug — a real magic
 *    link is minted by `signInWithOtp` in a browser, which registers a PKCE challenge and gets
 *    `?code=` instead. Worth knowing, because the failure looks exactly like a broken callback.
 *  - **Reading Mailpit.** Mailpit only receives mail for the *local* stack, and `.env.local`
 *    targets the remote project — so there is no inbox to read at all.
 *
 * ## What this does instead
 *
 * Tokens come from a **real GoTrue grant** (`grant_type=password`, the same endpoint any
 * password sign-in uses), and the session cookie is written by **`@supabase/ssr` itself** —
 * the same library, and the same `sb-<ref>-auth-token` name, that the app's own server client
 * reads. Nothing about the cookie format is reimplemented here, so a drift in the library would
 * fail these tests rather than pass them.
 *
 * ## Exactly what is bypassed
 *
 * Two things, both stated so nobody mistakes this for full coverage:
 *
 *  1. **The inbox.** The user is created and confirmed through the admin API instead of arriving
 *     by email. The tokens are still minted by Supabase, not by us.
 *  2. **`/auth/callback`.** The production code-exchange route is not exercised, because it is
 *     Phase-0 code with its own error handling and needs a real `?code=`. If that route breaks,
 *     these tests stay green and login breaks for users. `smoke.spec.ts` does not cover it
 *     either. Worth a test of its own if magic-link sign-in ever matters more than the wizard.
 *
 * The profile is created by the real `handle_new_user` trigger, so the wizard opens against the
 * genuinely empty row a real signup produces — `target_titles: []`, `work_modes: []`,
 * `onboarding_step: 1`, `onboarding_completed: false`.
 *
 * ## CI cannot run this
 *
 * The CI e2e job supplies **placeholder** Supabase values (`https://placeholder.supabase.co`,
 * see `.github/workflows/ci.yml`) and AGENTS.md forbids live API calls in CI, so `adminEnv()`
 * returns `null` there and the authed specs skip with a stated reason. This is a *local* gate.
 * `smoke.spec.ts` remains the CI gate and covers public routes only — which is the honest
 * summary of what a green e2e job has ever proven.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BrowserContext } from "@playwright/test";

/** Emails this harness creates are prefixed so cleanup can find only its own. */
export const E2E_EMAIL_PREFIX = "e2e-onboarding-";

/**
 * A fixed throwaway password.
 *
 * It is never a credential for anything real and the account is deleted in `teardownUser`. Fixed
 * rather than generated so a failing run can be reproduced.
 */
const THROWAWAY_PASSWORD = "e2e-only-not-a-real-secret-9f3a";

/** Hosts `.github/workflows/ci.yml` uses as placeholders. A URL matching these has no database. */
const PLACEHOLDER_HOSTS = ["placeholder", "example"];

interface AdminEnv {
  url: string;
  key: string;
  /** The publishable/anon key. `@supabase/ssr` needs it to name the cookie correctly. */
  anonKey: string;
}

/**
 * Read the credentials this harness needs, or `null` when there is nothing real to talk to.
 *
 * Returns `null` — rather than throwing — for the CI placeholder case specifically, so the
 * calling spec can *skip with a reason*. Throwing would turn "this gate cannot run here" into a
 * red suite, which trains people to ignore red.
 */
export function adminEnv(): AdminEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || !anonKey) return null;
  if (PLACEHOLDER_HOSTS.some((host) => url.includes(host))) return null;

  return { url, key, anonKey };
}

/** An untyped-client admin handle, or `null` when there is no real database to reach. */
export function adminClient(): SupabaseClient | null {
  const env = adminEnv();
  if (env === null) return null;

  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Create a brand-new user and give the browser a session as them.
 *
 * @param context the Playwright context; comes back holding a real session cookie
 * @param baseURL the origin to scope the cookie to
 * @returns the new user's id and email, for `teardownUser`
 */
export async function signInAsFreshUser(
  context: BrowserContext,
  baseURL: string,
): Promise<{ userId: string; email: string }> {
  const env = adminEnv();
  if (env === null) {
    throw new Error("signInAsFreshUser called without reachable Supabase credentials");
  }

  const admin = createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const email = `${E2E_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;

  // `email_confirm: true` because `generateLink({type:"signup"})` — the one admin call that does
  // create-and-link in one request — is what cannot produce a `?code=` link (see the header).
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: THROWAWAY_PASSWORD,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    throw new Error(`createUser failed: ${createError?.message ?? "no user returned"}`);
  }

  const tokens = await passwordGrant(env, email);
  await applySessionCookie(context, baseURL, env, tokens);

  return { userId: created.user.id, email };
}

/**
 * Exchange the throwaway credentials for real tokens from GoTrue.
 *
 * `grant_type=password` is a supported, first-party grant — the app simply does not expose a
 * password form. Failures are surfaced with the status, because a 400 here means the local
 * project's auth settings reject the grant (e.g. email confirmation enforced), which is a
 * genuine finding about the environment rather than a harness bug.
 */
async function passwordGrant(
  env: AdminEnv,
  email: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: THROWAWAY_PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(
      `password grant rejected with ${response.status}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!body.access_token || !body.refresh_token) {
    throw new Error("password grant returned no token pair");
  }

  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

/**
 * Write the session cookie **via `@supabase/ssr`**, then hand it to the browser.
 *
 * The `Map` is a cookie jar in the shape `@supabase/ssr` expects; `setSession` populates it
 * exactly as the app's `/auth/callback` populates one on a real sign-in, including the chunked
 * `sb-<ref>-auth-token` name derived from the project URL. Handing those cookies to Playwright
 * means the browser is in the same state a real user's browser would be in — and if the library
 * ever changed how it names or shapes that cookie, this would stop working loudly.
 */
async function applySessionCookie(
  context: BrowserContext,
  baseURL: string,
  env: AdminEnv,
  tokens: { access_token: string; refresh_token: string },
): Promise<void> {
  const jar = new Map<string, string>();

  const client = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (all) => {
        for (const cookie of all) jar.set(cookie.name, cookie.value);
      },
    },
  });

  const { error } = await client.auth.setSession(tokens);
  if (error) throw new Error(`setSession failed: ${error.message}`);

  const cookies = [...jar].map(([name, value]) => ({
    name,
    value,
    // Scoped by `url` rather than `domain` so Playwright derives the right host and the
    // `secure` flag from the scheme — which matters when this runs against an https preview.
    url: baseURL.replace(/\/$/, ""),
  }));

  if (cookies.length === 0) {
    throw new Error("setSession wrote no cookie; the browser would be signed out");
  }

  await context.addCookies(cookies);
}

/**
 * Delete a user this harness created.
 *
 * ## Why the tasks are deleted first
 *
 * `task_queue.payload` is `jsonb`, so it carries no foreign key to `profiles`. Deleting the auth
 * user cascades the `profiles` row but leaves every queued task behind, and the worker keeps
 * claiming tasks for a profile that no longer exists. Measured on the linked project: **95 of 100
 * pending rescore tasks referenced a deleted profile.** `sweepOrphanUsers` exists to clear that
 * damage, but a suite that keeps creating it is making the problem worse on every run.
 *
 * So teardown removes the user's tasks, then the user. The task delete is scoped to
 * `payload.profile_id = userId`, and `userId` only ever comes from `signInAsFreshUser`, so it
 * cannot reach another account's rows.
 *
 * The deeper fix is a real foreign key, which a jsonb payload cannot express, so an account
 * deleted through any other path (the Supabase dashboard) still leaves orphans. That gap is open
 * and recorded in migration `0013`.
 */
export async function teardownUser(userId: string): Promise<void> {
  const admin = adminClient();
  if (admin === null) return;

  const { error: taskError } = await admin
    .from("task_queue")
    .delete()
    .contains("payload", { profile_id: userId });
  if (taskError) {
    console.warn(`[e2e] could not clear tasks for ${userId}: ${taskError.message}`);
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  // A cleanup failure must not fail the test it is cleaning up after: the assertions already
  // ran, and reporting them as failed because a delete 500s would be actively misleading.
  if (error) {
    console.warn(`[e2e] could not delete throwaway user ${userId}: ${error.message}`);
  }
}

/**
 * Delete every `e2e-onboarding-*` / `e2e-probe-*` user left behind by earlier runs.
 *
 * Exists because the first version of this harness failed 12 tests *after* creating 12 users,
 * and a test suite that litters the project it tests is a defect of its own. Safe by prefix:
 * it cannot match a real account, because nobody signs up with an `example.invalid` address.
 */
export async function sweepOrphanUsers(): Promise<number> {
  const admin = adminClient();
  if (admin === null) return 0;

  const prefixes = [E2E_EMAIL_PREFIX, "e2e-probe-", "e2e-mailpit-"];
  let removed = 0;

  // `listUsers` pages; 1000 per call is the API maximum and is enough to cover every orphan a
  // broken run can leave in one go.
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data.users.length) break;

    const orphans = data.users.filter((user) =>
      prefixes.some((prefix) => user.email?.startsWith(prefix)),
    );

    for (const orphan of orphans) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(orphan.id);
      if (!deleteError) removed++;
    }

    if (data.users.length < 1000) break;
  }

  return removed;
}

/**
 * Read a `profiles` row through the service role, bypassing RLS.
 *
 * For asserting on what the UI actually persisted. Goes through PostgREST rather than the
 * browser because the browser cannot see the row it is not allowed to read.
 */
export async function readProfile<T extends Record<string, unknown>>(
  userId: string,
): Promise<T | null> {
  const admin = adminClient();
  if (admin === null) return null;

  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();

  if (error) throw new Error(`readProfile failed: ${error.message}`);
  return (data as T) ?? null;
}
