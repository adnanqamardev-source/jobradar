/**
 * (app)/layout.tsx — the post-auth application shell (FE-104).
 *
 * ## What this is
 *
 * Every authenticated route lives under `(app)`, so the shell wraps the feed,
 * the tracker, saved searches and settings. It owns exactly three structural
 * things — skip link, navigation, and the `<main>` landmark — and nothing
 * presentational. Phase 2 rule: unstyled but not unstructured. No utility
 * classes, no colours, no spacing decisions; real landmarks, real headings,
 * real links.
 *
 * ## What this is deliberately not
 *
 * Not an auth guard. Each page calls `requireUser()` itself and redirects to
 * /login with a return path on `unauthenticated` (the dashboard page already
 * does this; the other pages copy the pattern). A layout-level guard would
 * redirect before the page can say *why*, and would couple every route to
 * the session cookie's lifetime.
 */

import type { Metadata } from "next";

import { AppNav } from "@/components/layout/app-nav";

export const metadata: Metadata = {
  title: "JobRadar",
  description: "Your ranked job feed, applications, and saved searches.",
};

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/*
        Skip link is the first focusable element on every (app) page —
        docs/04 §4.6. It targets the `<main>` below by id.
      */}
      <a href="#main-content">Skip to content</a>
      <AppNav />
      <main id="main-content">{children}</main>
    </>
  );
}
