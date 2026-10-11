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

const NAV_ITEMS = [
  { href: "/dashboard", label: "Feed" },
  { href: "/applications", label: "Applications" },
  { href: "/saved-searches", label: "Saved Searches" },
  { href: "/settings", label: "Settings" },
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
