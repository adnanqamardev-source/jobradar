/**
 * app-nav.tsx — the (app) shell's primary navigation (FE-104).
 *
 * ## Phase 2 rules applied
 *
 * Unstyled but not unstructured: semantic `<nav>`/`<header>`, real `<a>` and
 * `<button>` elements, one `aria-label` per landmark, `aria-expanded` /
 * `aria-controls` on the mobile menu toggle, and an `aria-current="page"` on the
 * active link. No utility classes — presentation is Phase 3's job.
 *
 * ## Why this is a client component
 *
 * Active-state needs `usePathname`, and the mobile menu needs local state. Both
 * are presentational; the links themselves are plain `<a>` (or `<form>` for
 * sign-out), so the page works with JS disabled for everything except the
 * active marker and the menu toggle.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * The product's navigation, in order. `built: false` marks a destination that is specified
 * in docs/05c but has no route yet — `/applications` is FE-111/112/113, `/saved-searches`
 * is FE-115, `/settings` is FE-116.
 *
 * The links stay, because the nav is the product's structure and Phase 2 is functional, not
 * cosmetic: removing them would hide work that is planned and specified. What is suppressed
 * is the *prefetch*. `<Link>` prefetches its RSC payload on viewport entry, so three
 * not-yet-built routes produced three 404s in the browser console on every page load —
 * noise that trains you to ignore the console, which is exactly how the real dashboard crash
 * hid in plain sight. `prefetch={false}` keeps the link and drops the request; the 404 still
 * happens when someone actually clicks, which is honest.
 *
 * Drop the flag as each route lands — `prefetch` is not a permanent property of a nav item.
 */
const NAV_ITEMS = [
  { href: "/dashboard", label: "Feed", built: true },
  { href: "/applications", label: "Applications", built: false },
  { href: "/saved-searches", label: "Saved Searches", built: false },
  { href: "/settings", label: "Settings", built: false },
] as const;

export function AppNav() {
  const pathname = usePathname();
  // Default open: with no CSS yet there is no "always-visible on desktop"
  // rule, so a closed-by-default menu would hide the nav on every viewport.
  // The toggle still collapses it for narrow screens (FE-104).
  const [menuOpen, setMenuOpen] = useState(true);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  return (
    <header>
      <nav aria-label="Primary">
        <Link href="/dashboard">JobRadar</Link>

        {/*
          The mobile toggle is always in the DOM so it is reachable; on wide
          screens the menu is always open and the toggle is hidden by Phase 3's
          CSS. Until then the toggle is the only way to reach the menu on a
          narrow viewport — which is the functional requirement.
        */}
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="primary-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? "Close menu" : "Open menu"}
        </button>

        <ul id="primary-menu" hidden={!menuOpen}>
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={item.built}
                aria-current={isActive(item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/*
        Sign-out is a POST form, not a link: it must not be prefetchable or
        crawlable, and it must not GET. The route is /api/auth/logout (BE-301).
      */}
      <form action="/api/auth/logout" method="POST">
        <button type="submit">Sign out</button>
      </form>
    </header>
  );
}
