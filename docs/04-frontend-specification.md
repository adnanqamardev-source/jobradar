# 04 â€” Frontend Specification Document

**Last reviewed:** 2026-10-04


**Product:** JobRadar Â· **Version:** 1.0 â€” MVP
**Depends on:** [01 PRD](./01-prd.md), [02 Technical Architecture](./02-technical-architecture.md) Â· **Consumed by:** [05 Feature Tickets](./05-feature-ticket-list.md)
**Last updated:** 2026-10-03

> **Design intent â€” "Signal."** Job search is a noise problem. The UI should feel like a well-set editorial page rather than a dashboard template: warm paper background, near-black ink, one electric blue for *action*, one acid lime reserved **exclusively** for a strong match. Generous whitespace, a serif display face for the moments that carry meaning, and mono type wherever there's a number. Nothing rounded-and-grey, nothing that reads as a generic AI-generated admin panel.

---

## 1. Colour Palette

**Last reviewed:** 2026-10-04


All values are defined once as CSS custom properties in `src/styles/tokens.css` and consumed as Tailwind utilities. **No hex literals in components.**

### 1.1 Core

**Last reviewed:** 2026-10-04


| Token | Hex | Role |
|---|---|---|
| `--color-ink` | `#14161A` | Primary text, headings, icons |
| `--color-ink-2` | `#4A5160` | Secondary text, descriptions |
| `--color-ink-3` | `#5A6270` | Muted text, placeholders, timestamps |
| `--color-paper` | `#F6F4EF` | Page background (warm off-white) |
| `--color-surface` | `#FFFFFF` | Cards, panels, modals |
| `--color-surface-2` | `#EFEDE7` | Subtle fill, table stripes, hover |
| `--color-surface-3` | `#E7E4DC` | Pressed / active fill |
| `--color-line` | `#9A9282` | Default borders, dividers (AA 3:1 on surface) |
| `--color-line-strong` | `#908E7E` | Input borders, table rules (AA 3:1 on surface) |

### 1.2 Brand & semantic

**Last reviewed:** 2026-10-04


| Token | Hex | Role |
|---|---|---|
| `--color-brand` | `#2440F5` | Primary actions, links, focus ring |
| `--color-brand-press` | `#1A31C4` | Hover/pressed primary |
| `--color-brand-soft` | `#E7EBFF` | Tinted backgrounds, selected rows, badges |
| `--color-brand-ink` | `#1B2AB8` | Text on `brand-soft` |
| `--color-signal` | `#C6F24E` | **Strong match only** (score â‰¥ 85) |
| `--color-signal-ink` | `#3B4A0B` | Text/icons on `signal` |
| `--color-success` | `#167A4A` | Positive states, "sent", "applied" |
| `--color-success-soft` | `#D1E8DD` | Success backgrounds |
| `--color-success-ink` | `#0D5A33` | Text on `success-soft` |
| `--color-warning` | `#C47800` | Caution, stale data, approaching limit |
| `--color-warning-soft` | `#F5E1B8` | Warning backgrounds |
| `--color-warning-ink` | `#7A4A00` | Text on `warning-soft` |
| `--color-danger` | `#C0393C` | Errors, destructive actions, failed runs |
| `--color-danger-soft` | `#EBCDCD` | Error backgrounds |
| `--color-danger-ink` | `#7A2023` | Text on `danger-soft` |
| `--color-info` | `#26749A` | Neutral notices, "new" indicators |
| `--color-info-soft` | `#D0E8F5` | Info backgrounds |
| `--color-info-ink` | `#1A5A7A` | Text on `info-soft` |

### 1.3 Match-score scale (used by `ScoreMeter` and feed cards)

**Last reviewed:** 2026-10-04


| Band | Range | Bar / badge fill | Text | Label |
|---|---|---|---|---|
| Strong | 85â€“100 | `#C6F24E` | `#14161A` | Strong match |
| Good | 70â€“84 | `#9EDB3F` | `#14161A` | Good match |
| Fair | 55â€“69 | `#F5A524` | `#14161A` | Fair match |
| Weak | 1â€“54 | `#CFCCC3` | `#4A5160` | Weak match |
| Gated | 0 | `#E2DFD8` | `#5A6270` | Filtered out |

> **Rule:** score is *never* communicated by colour alone â€” every meter carries a numeric value (`78`) and a text label. Required by [03 Â§6.1 X-23](./03-security-and-access.md).

### 1.4 Contrast requirements

**Last reviewed:** 2026-10-04


Body text on `paper` or `surface` must reach **AA 4.5:1**; large display text and icons **AA 3:1**. `ink-3` is permitted only for non-essential metadata at **â‰¥12px** (matching the `xs` token). `signal` is never used as a text colour on light backgrounds â€” only as a fill with `ink` on top. Input borders and card dividers must reach **AA 3:1** (WCAG 1.4.11). Verified with an automated contrast check in CI (`vitest-axe` on the component gallery).

---

## 2. Typography

**Last reviewed:** 2026-10-04


**Fonts loaded via `next/font` (self-hosted, zero layout shift):**

| Role | Family | Weights | Fallback |
|---|---|---|---|
| **Display** | **Instrument Serif** | 400 (+ 400 italic) | `Georgia, serif` |
| **UI / body** | **Inter Tight** | 400, 500, 600 | `system-ui, sans-serif` |
| **Data / mono** | **JetBrains Mono** | 400, 500 | `ui-monospace, monospace` |

### 2.1 Type scale

**Last reviewed:** 2026-10-04


| Token | Family | Size / Line-height | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `display-xl` | Instrument Serif | `56 / 1.05` (clamp 40â†’56) | 400 | `-0.02em` | Marketing hero |
| `display-l` | Instrument Serif | `40 / 1.10` | 400 | `-0.015em` | Page hero, empty-state headline |
| `h1` | Inter Tight | `32 / 1.20` | 600 | `-0.02em` | Page titles (`dashboard`, `applications`) |
| `h2` | Inter Tight | `24 / 1.30` | 600 | `-0.01em` | Section headings, modal titles |
| `h3` | Inter Tight | `20 / 1.35` | 600 | `-0.01em` | Card group headings |
| `body-l` | Inter Tight | `17 / 1.60` | 400 | `0` | Lead paragraphs, job description |
| `body` | Inter Tight | `15 / 1.55` | 400 | `0` | Default UI text |
| `body-md` | Inter Tight | `15 / 1.55` | 500 | `0` | Buttons, emphasised body |
| `sm` | Inter Tight | `13 / 1.50` | 400 | `0` | Secondary UI, helper text |
| `xs` | Inter Tight | `12 / 1.40` | 500 | `0.01em` | Table cells, meta rows |
| `label` | JetBrains Mono | `11 / 1.30` | 500 | `0.08em`, UPPERCASE | Eyebrows, column headers, source badges |
| `mono` | JetBrains Mono | `13 / 1.50` | 400 | `0` | Salaries, scores, dates, IDs |
| `score-lg` | JetBrains Mono | `28 / 1.00` | 500 | `-0.02em` | Score on job detail |
| `score-sm` | JetBrains Mono | `15 / 1.00` | 500 | `0` | Score badge on cards |

**Rules:** never centre body copy (only display/empty states); max line length **68ch** for prose, **none** for the job description (which uses `body-l` with `Read more`); one `display` element per screen; numbers *always* in `mono` with `font-variant-numeric: tabular-nums`.

---

## 3. Component Styles

**Last reviewed:** 2026-10-04


Built on Radix primitives, styled with tokens. Every component has: default, hover, focus-visible, active, disabled, loading, and error states. All focus rings: `outline: 2px solid var(--color-brand); outline-offset: 2px;` â€” never removed.

### 3.1 Buttons

**Last reviewed:** 2026-10-04


| Variant | Background | Text | Border | Use |
|---|---|---|---|---|
| **primary** | `--color-brand` | `#FFFFFF` | â€” | One per view: `Finish & build my feed`, `Confirm` |
| **primary-press** | `--color-brand-press` | `#FFFFFF` | â€” | hover/active |
| **secondary** | `--color-surface` | `--color-ink` | `1px --color-line-strong` | `Save`, `View original` |
| **ghost** | transparent | `--color-ink-2` | â€” | `Dismiss`, toolbar, nav |
| **signal** | `--color-signal` | `--color-signal-ink` | â€” | Reserved: high-match CTA only |
| **danger** | `--color-danger` | `#FFFFFF` | â€” | `Delete account`, `Discard` |
| **danger-ghost** | transparent | `--color-danger` | `1px --color-danger` | Destructive but reversible |

| Size | Height | Padding X | Font | Radius |
|---|---|---|---|---|
| `sm` | 32px | 12px | `sm` / 500 | `8px` |
| `md` (default) | 40px | 16px | `body-md` | `8px` |
| `lg` | 48px | 22px | `body-md` | `8px` |

**States:** disabled = `opacity: .45` + `cursor: not-allowed`. Loading = keep label width, swap to 16px spinner, `aria-busy="true"`, button stays the same width (no layout shift). Icon-only buttons: 36Ã—36, must carry `aria-label`.

### 3.2 Inputs & form controls

**Last reviewed:** 2026-10-04


| Property | Spec |
|---|---|
| Height | 40px (`md`), 32px (`sm`) |
| Background | `--color-surface` |
| Border | `1px --color-line-strong`, radius `8px` |
| Padding | `0 12px`; text starts at 12px |
| Font | `body` (15/1.55) |
| Placeholder | `--color-ink-3` |
| Focus | border â†’ `--color-brand` + `box-shadow: 0 0 0 3px var(--color-brand-soft)` |
| Error | border â†’ `--color-danger`, `box-shadow: 0 0 0 3px var(--color-danger-soft)`, helper text in `danger-ink` at `sm`, **always with an icon + text** (not colour alone) |
| Disabled | `--color-surface-2` fill, `ink-3` text |

**Field anatomy:** label (above, `xs`/500, `ink-2`) â†’ control â†’ helper or error (below, `sm`). Never a floating placeholder. Required fields get a `*` *and* `aria-required`.
**Checkbox / switch:** 16px box, `brand` fill when checked, 44px touch target on mobile.
**Select / combobox (skills, titles):** input-style trigger + chips for multi-select; selected items render as `chip` with a remove Ã—.
**Textarea:** min-height 120px, vertical resize, same focus/error treatment.

### 3.3 Cards

**Last reviewed:** 2026-10-04


**Job card** (the workhorse â€” PRD D1)

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ [Acme Corp]  â— Strong match     seen on 2 sources   â‹¯ â”‚  â† company chip, score badge, overflow menu
â”‚ Senior Frontend Engineer                               â”‚  â† h3, 20/600
â”‚ Remote (US)  |  Full-time  |  $160kâ€“$190k  |  2d ago  â”‚  â† xs, ink-3, mono for salary, separated by |
â”‚ React Â· TypeScript Â· Next.js  +4                      â”‚  â† skill chips (secondary)
â”‚ â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–“â–‘â–‘â–‘  78 Good match                 â”‚  â† ScoreMeter
â”‚ [ Save ]  [ Dismiss ]  [ Mark applied ]                â”‚  â† action row (secondary/ghost)
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

| Property | Spec |
|---|---|
| Background / border | `--color-surface`, `1px --color-line`, radius `12px` |
| Padding | `16px 20px` |
| Gap (stacked) | `12px` |
| Hover | border â†’ `--color-line-strong`, `shadow-md`, `translateY(-1px)`, `150ms ease` |
| Focus-within | `2px solid --color-brand` outline, offset 2px |
| Dismissed | animate out (`opacity 0 â†’ height 0`, 180ms) then remove from DOM |
| Saved | left edge `3px --color-brand` accent |

**Generic card:** `surface`, `1px line`, radius `12px`, padding `20px`, `shadow-sm` only when elevated.
**Stat card:** `score-lg` number â†’ `xs` delta (`+3 this week`). (Eyebrow labels use semantic `<h4>`/`<caption>`, not the `.label` utility.)

### 3.4 ScoreMeter

**Last reviewed:** 2026-10-04


- Track: height `6px`, radius `999px`, fill `--color-surface-3`, width 100%.
- Fill: band colour from Â§1.3, `transition: width 400ms cubic-bezier(.2,.8,.2,1)`.
- Text: `score-sm` mono value + `xs` label, right-aligned, always present.
- `role="progressbar"` with `aria-valuenow/min/max` and `aria-label="Match score 78 out of 100, good match"`.
- Expanded **breakdown** (C3): each component as a row â€” `xs` name, mono `points`, mini bar â€” inside a `disclosure` on job detail.

```
Skills          â–“â–“â–“â–“â–“â–“â–“â–“â–“â–‘  24.9 / 35
Seniority       â–“â–“â–“â–“â–“â–“â–“â–‘â–‘â–‘  11.3 / 15
Compensation    â–“â–“â–“â–“â–“â–“â–“â–“â–‘â–‘  13.5 / 15
Work mode       â–“â–“â–“â–“â–“â–“â–“â–“â–“â–‘  14.2 / 15
Recency         â–“â–“â–“â–“â–“â–“â–‘â–‘â–‘â–‘   6.0 / 10
Company pref    â–“â–“â–“â–‘â–‘â–‘â–‘â–‘â–‘â–‘   3.0 / 10
Semantic        â–“â–“â–“â–“â–“â–“â–“â–“â–‘â–‘  80.2 / 100   â† blend at 50%
```

### 3.5 Modal / dialog

**Last reviewed:** 2026-10-04


| Property | Spec |
|---|---|
| Backdrop | `rgba(20,22,26,.45)`, `backdrop-filter: blur(2px)`, fade 150ms |
| Panel | `surface`, radius `16px`, `shadow-md`, max-width `480px` (wide: `640px`), padding `24px` |
| Entrance | `opacity 0â†’1` + `translateY(8px)â†’0`, 180ms ease-out |
| Title | `h2`; close Ã— top-right, 36px, `aria-label="Close"` |
| Footer | right-aligned, `ghost` then `primary`, gap `8px`, sticky on mobile |
| Focus | trapped; `Escape` closes; focus returns to trigger |
| Mobile | bottom sheet: full width, radius `16px 16px 0 0`, safe-area padding |

Used for: confirm stage move, apply modal, delete account, source pause. **Never** for paywall prompts (inline instead â€” PRD Flow 6).

### 3.6 Badges, chips & tags

**Last reviewed:** 2026-10-04


| Type | Height / radius | Style | Use |
|---|---|---|---|
| Score badge | 24px / `6px` | band fill + `ink` text, mono | card corner |
| Status badge | 24px / `999px` | soft bg + dedicated ink token (`success-ink`, `warning-ink`, `danger-ink`, `info-ink`) | `Applied`, `Interview`, `Stale`, `Sent` |
| Source badge | 22px / `6px` | `surface-2` + `ink-2`, **`label` mono uppercase** | `GREENHOUSE`, `FIRECRAWL` |
| Skill chip | 28px / `999px` | `surface-2` + `ink-2`, `sm` | filters, job skills |
| Chip (selected) | 28px / `999px` | `brand-soft` + `brand-ink`, Ã— button | active filters |
| Count pill | 20px / `999px` | `brand` + white, mono `xs` | `12 new` |

### 3.7 Other

**Last reviewed:** 2026-10-04


- **Toast:** bottom-right (bottom-centre mobile), `surface`, radius `10px`, `shadow-md`, max-width 380px, auto-dismiss 4s (errors: persistent + dismiss button). Icon + message + optional action. `role="status"` (polite) / `role="alert"` (errors).
- **Empty state:** centred, `display-l` headline, one sentence of `body-l` in `ink-2`, single primary action, optional simple SVG line illustration in `ink-3`. Never a bare "No data".
- **Skeleton:** `surface-2` blocks with a `shimmer` sweep (1.4s), **shape-matched** to final content â€” feed cards render as card-shaped skeletons, not spinners.
- **Tooltip:** `ink` bg, white text, `xs`, radius `6px`, 400ms open delay, triggered on hover *and* focus.
- **Tabs:** underline style, `2px --color-brand` active indicator, `body-md`, gap 24px.
- **Dropdown menu:** `surface`, radius `10px`, `shadow-md`, item height 36px, hover `surface-2`, destructive items in `danger`.

---

## 4. Spacing & Layout Rules

**Last reviewed:** 2026-10-04


### 4.1 Spacing scale (4px base)

**Last reviewed:** 2026-10-04


| Token | Value | Token | Value |
|---|---|---|---|
| `--space-1` | `4px` | `--space-8` | `32px` |
| `--space-2` | `8px` | `--space-10` | `40px` |
| `--space-3` | `12px` | `--space-12` | `48px` |
| `--space-4` | `16px` | `--space-16` | `64px` |
| `--space-5` | `20px` | `--space-24` | `96px` |
| `--space-6` | `24px` | | |

**Only these values.** No `13px`, no `17px` padding. Where a optical correction is genuinely needed, use a `-1px`/`-2px` *margin* and comment it.

### 4.2 Layout

**Last reviewed:** 2026-10-04


| Property | Value |
|---|---|
| Grid | 12 columns, gutter `24px`, max content width `1200px`, centred |
| Page gutters | `16px` mobile Â· `24px` tablet Â· `40px` desktop |
| App shell | Sidebar `240px` (fixed, `surface`, right border) + main content `max 960px` |
| App topbar | `64px` tall, sticky, `surface` + bottom border |
| Section spacing | `64px` between major sections Â· `32px` between subsections Â· `16px` between related items |
| Card grid | `repeat(auto-fill, minmax(340px, 1fr))`, gap `12px` |
| Forms | single column, max-width `560px`, field gap `20px`, labelâ†’control `6px` |

### 4.3 Responsive

**Last reviewed:** 2026-10-04


| Breakpoint | Behaviour |
|---|---|
| `< 640px` | Sidebar â†’ bottom tab bar (4 items); cards full-width; wizard steps stack; kanban â†’ vertical stage lists; modals â†’ bottom sheets; page gutter 16px |
| `640â€“1023px` | Sidebar collapsible (icon rail 64px); card grid 2-col |
| `â‰¥ 1024px` | Full sidebar; feed + optional right rail (`Needs attention`, stats) at â‰¥1280px |

### 4.4 Motion

**Last reviewed:** 2026-10-04


| Token | Value | Use |
|---|---|---|
| `--motion-fast` | `120ms ease` | colour, border, hover |
| `--motion-base` | `180ms ease-out` | entrances, toasts |
| `--motion-slow` | `300ms cubic-bezier(.2,.8,.2,1)` | score bar fill, layout |

Rules: animate `transform`/`opacity` only; never animate layout properties on scroll; respect `prefers-reduced-motion: reduce` (disable all but opacity); no infinite decorative animation on the dashboard (it's a daily-use tool).

### 4.5 Elevation

**Last reviewed:** 2026-10-04


| Token | Value | Use |
|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(20,22,26,.06)` | resting cards |
| `shadow-md` | `0 8px 24px -8px rgba(20,22,26,.12)` | hover, dropdowns, modals |
| `shadow-lg` | `0 24px 48px -12px rgba(20,22,26,.18)` | command palette |

Borders (`1px --color-line`) are preferred over shadows for separation â€” shadows are for things that genuinely float.

### 4.6 Accessibility baseline

**Last reviewed:** 2026-10-04


WCAG 2.1 AA. Hit targets â‰¥44Ã—44px. Visible focus on every interactive element. Landmarks (`nav`/`main`/`aside`) on the shell. `Skip to content` link. Headings in logical order. `prefers-reduced-motion` honoured. All colour pairings contrast-checked in CI. Kanban fully operable by keyboard (arrow keys + `Enter` to move).

---

## 5. API & Integration Spec

**Last reviewed:** 2026-10-04


Conventions for **all** integrations: base URLs and keys from env only ([02 Â§7](./02-technical-architecture.md)); every call wrapped with timeout (30s default), `AbortSignal`, retry Ã—3 with exponential backoff, and a `redact()`-ed structured log; failures map to the error codes in [03 Â§5.1](./03-security-and-access.md). The app only ever talks to these services **server-side**.

---

### 5.1 Firecrawl â€” scraping & discovery

**Last reviewed:** 2026-10-04


| | |
|---|---|
| **Role in app** | Renders JS-heavy career pages, extracts structured postings from arbitrary boards, discovers careers-page URLs. Used **only** where no official API exists (Tier 3 â€” [02 Â§6.1](./02-technical-architecture.md)). |
| **Base URL** | `https://api.firecrawl.dev/v2` |
| **Auth** | `Authorization: Bearer ${FIRECRAWL_API_KEY}` |
| **Where used** | `src/lib/connectors/firecrawl.ts` |

**Endpoints**

| Endpoint | Method | Used for |
|---|---|---|
| `/scrape` | POST | Fetch a career-page URL â†’ markdown + JSON-extracted posting fields |
| `/search` | POST | Discover postings matching a query (supplement aggregator gaps) |
| `/map` | POST | Enumerate a careers-site sitemap to find listing URLs |

**Request â€” `/scrape`**
```jsonc
POST /v2/scrape
{
  "url": "https://careers.acme.com/jobs",
  "formats": ["json"],
  "onlyMainContent": true,
  "maxAge": 43200000,                 // 12h cache â€” cost guard (02 Â§6.1)
  "timeout": 30000,
  "jsonOptions": {
    "schema": {                        // mirrors RawJob (02 Â§6.1)
      "type": "object",
      "properties": {
        "jobs": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title":          { "type": "string" },
              "companyName":    { "type": "string" },
              "location":       { "type": "string" },
              "workMode":       { "type": "string", "enum": ["remote","hybrid","onsite","unknown"] },
              "salaryRaw":      { "type": "string" },
              "postedAt":       { "type": "string" },
              "sourceUrl":      { "type": "string", "format": "uri" },
              "applyUrl":       { "type": "string", "format": "uri" },
              "descriptionHtml":{ "type": "string" }
            },
            "required": ["title","companyName","sourceUrl"]
          }
        }
      },
      "required": ["jobs"]
    }
  }
}
```
**Response**
```jsonc
{
  "success": true,
  "data": {
    "markdown": "# Careers\nâ€¦",

**Last reviewed:** 2026-10-04

    "json": { "jobs": [ { "title": "â€¦", "companyName": "â€¦", "sourceUrl": "â€¦" } ] },
    "metadata": { "statusCode": 200, "sourceUrl": "â€¦", "cached": true }
  }
}
```
**Failure:** non-`success` â†’ `upstream_error`/`upstream_timeout` â†’ task retry Ã—3. Malformed `json` against the Zod schema â†’ `scrape_parse_failed`, run marked `partial`, no user-visible error.

---

### 5.2 Job source APIs (Tier 1 & 2)

**Last reviewed:** 2026-10-04


All called from `src/lib/connectors/*.ts`, all mapped to `RawJob` â†’ `CanonicalJob`.

| Service | Endpoint | Auth / params | Request | Response â†’ mapping |
|---|---|---|---|---|
| **Greenhouse** | `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | none (public) | board slug from `sources.config` | `data.jobs[]` â†’ `externalId=id`, `title=title`, `sourceUrl=absolute_url`, `descriptionHtml=content` (HTML), `postedAt=updated_at`, `companyName` from board meta |
| **Lever** | `GET https://api.lever.co/v0/postings/{slug}?mode=json` | none | company slug | `[]` â†’ `externalId=id`, `title=text`, `sourceUrl=hostedUrl`, `location=text`, `postedAt=createdAt` (ms â†’ ISO), `applyUrl=applyUrl` |
| **Ashby** | `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | none | org slug | `{jobs[]}` â†’ `externalId=id`, `title=title`, `sourceUrl=jobUrl`, `descriptionHtml=descriptionPlain`/`descriptionHtml`, `salaryRaw=compensation.compensationTierSummary` |
| **Remotive** | `GET https://remotive.com/api/remote-jobs?search={q}&limit=50` | none (free, â‰¤1 req/1.5s) | query from `config.query` | `{jobs[]}` â†’ `externalId=id`, `title=job_title`, `companyName=company_name`, `location=candidate_required_location`, `descriptionHtml=description`, `postedAt publication_date` |
| **Arbeitnow** | `GET https://www.arbeitnow.com/api/job-board-api` | none | page param | `{data[]}` â†’ `externalId=slug`, `title=title`, `companyName=company_name`, `workMode` from `is_remote`, `sourceUrl=url` |
| **USAJOBS** | `GET https://data.usajobs.gov/api/search` | Headers: `Host: data.usajobs.gov`, `Authorization-Key: ${USAJOBS_AUTHORIZATION_KEY}`, `User-Agent` (**required**) | `?Keyword=&LocationName=&ResultsPerPage=25` | `SearchResult.Items[]` â†’ `externalId=MatchedObjectId`, `title=MatchedObjectDescriptor.PositionTitle`, `salaryRaw=PositionRemuneration[0].Value`, `location=PositionLocationDisplay` |
| **Adzuna** | `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}` | `?app_id=&app_key=` | `what`, `where`, `results_per_page=50` | `{results[]}` â†’ `externalId=id`, `title=display_title`, `salaryRaw= salary_min/max`, `descriptionHtml=description` (HTML), `postedAt=created` |
| *(optional)* **JSearch** (RapidAPI) | `GET https://jsearch.p.rapidapi.com/search` | Headers `X-RapidAPI-Key`, `X-RapidAPI-Host` | `query`, `num_pages` | `data[]` â†’ `job_id`, `job_title`, `job_apply_link`, `job_description` â€” **gated behind legal review (PRD R2)** |

**Shared post-processing for every source:** `normalize.ts` â†’ `dedupe.ts` â†’ `freshness.ts` ([02 Â§6.2](./02-technical-architecture.md)). Salary strings parsed by `utils/salary.ts`; seniority parsed from title by `utils/seniority.ts`; both return `unknown` rather than guessing.

---

### 5.3 OpenRouter (LLM gateway)

**Last reviewed:** 2026-10-04


| | |
|---|---|
| **Role** | `nvidia/nemotron-3-embed-1b:free` for semantic matching (C2); a free `:free` chat model for fit rationale (C5) and description cleanup. |
| **Base URL** | `https://openrouter.ai/api/v1` Â· **Auth** `Bearer ${OPENROUTER_API_KEY}` |
| **Where used** | `lib/scoring/semantic.ts`, `lib/scoring/rationale.ts` |

OpenRouter exposes an OpenAI-compatible `/embeddings` and `/chat/completions`, so the client
code is a plain OpenAI SDK pointed at a different `baseURL`. One key covers embeddings and
chat. **Free-model constraint:** every model id must carry the `:free` suffix, or the Â§8 cost
envelope in `02` stops holding.

**Embeddings â€” `POST /embeddings`**
```jsonc
// request
{ "model": "nvidia/nemotron-3-embed-1b:free",
  "input": ["Senior Frontend Engineer â€” React, TypeScriptâ€¦"] }   // batched â‰¤100
// response â†’ data[0].embedding : number[2048]  â†’ jobs.embedding / profiles.profile_embedding
```
`dimensions` is **omitted deliberately**: this model rejects any value other than its native
2048 with HTTP 400. `vector(2048)` in `02` Â§5 matches. Batching mandatory; embeddings are
written only when `description_text` changes (dedupe prevents re-embedding on every sighting).

**Rationale â€” `POST /chat/completions`** *(Pro only, jobs scoring â‰¥ 70, capped by `usage_events`)*
```jsonc
{ "model": "${OPENROUTER_CHAT_MODEL}",   // a :free chat model id
  "temperature": 0.2, "max_tokens": 160,
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "You compare a candidate profile to a job. Return JSON: {\"fit\":\"strong|good|fair\",\"summary\":\"2 sentences max\",\"gaps\":\"1 sentence or empty\"}. Be specific and factual. Never invent requirements not present in the job text. Under 45 words total." },
    { "role": "user", "content": "PROFILE:\n{â€¦}\n\nJOB:\n{â€¦}" }
  ] }
// response â†’ choices[0].message.content â†’ JSON.parse â†’ job_scores.explanation
```
**Failure:** rationale failure is **non-fatal** â€” the score still renders with `explanation = null` and the UI falls back to the computed breakdown. Never block a feed on an LLM.

---

### 5.4 Supabase (auth, database, storage)

**Last reviewed:** 2026-10-04


| Surface | Endpoint | Auth | Purpose |
|---|---|---|---|
| Magic link | `POST {SUPABASE_URL}/auth/v1/otp` | anon key | `{ email, create_user: true }` â†’ sends link |
| OAuth | `POST {SUPABASE_URL}/auth/v1/authorize` | anon key + PKCE | redirect to Google, returns `code` |
| Exchange | `GET /auth/callback` route | â€” | code â†’ session cookies |
| OTP verify | `POST /auth/v1/verify` | anon key | `{ token_hash, type: 'email' }` â†’ session |
| Sign out | `POST {SUPABASE_URL}/auth/v1/logout` | access token | invalidates refresh token |
| Data (user) | PostgREST `/{table}` | **anon key + user JWT** â†’ **RLS applies** | all reads/writes from Server Actions |
| Data (worker) | PostgREST `/{table}` | **service-role key** | queue/cron only |
| Upload rÃ©sumÃ© | `POST /storage/v1/object/resumes/{uid}/{uuid}.pdf` | user JWT, RLS bucket policy | private bucket; access via signed URL (`createSignedUrl`, 5 min) |

**Response shape (PostgREST):** array of rows; errors â†’ `{ code, message, details, hint }`. All errors mapped to `validation_failed` / `not_found` / `forbidden` â€” raw `details` never reaches the client ([03 Â§5.3](./03-security-and-access.md)).

**Feed query (the one that matters):**
```ts
supabase.from('v_ranked_jobs')
  .select('*, jobs(*)')
  .eq('user_id', uid)
  .gte('final_score', 60)
  .is('application', null)          // not yet tracked
  .order('final_score', { ascending: false })
  .range(0, 49)
```

---

### 5.5 Resend (email)

**Last reviewed:** 2026-10-04


| | |
|---|---|
| **Role** | Daily digest (F1), high-match alert (F4), magic links (Supabase handles delivery â€” *not* Resend), welcome, dunning. |
| **Base URL** | `https://api.resend.com` Â· **Auth** `Bearer ${RESEND_API_KEY}` |

**`POST /emails`**
```jsonc
{ "from": "JobRadar <hi@jobradar.app>",
  "to": ["maya@example.com"],
  "subject": "3 strong matches while you slept",
  "react": { /* DigestEmail React Email component */ },
  "headers": { "X-Entity-Ref-ID": "<digests.id>" } }   // idempotency
// response â†’ { id: "â€¦", created_at }  â†’ digests.message_id
```
**Behaviour:** zero qualifying jobs â†’ **no call**, row `skipped` ([03 Â§5.1](./03-security-and-access.md)). Failure â†’ retry once â†’ `failed` + admin tile. Every email carries a one-click unsubscribe; unsubscribe link works without a session.

---

### 5.6 Stripe (payments)

**Last reviewed:** 2026-10-04


| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/checkout/sessions` | POST | `{ mode:'subscription', line_items:[{price:STRIPE_PRICE_ID_PRO}], success_url, cancel_url, client_reference_id: uid, customer_email }` â†’ `session.url` â†’ redirect |
| `/v1/customer_portal/sessions` | POST | `{ customer, return_url }` â†’ `portal.url` for manage/cancel |
| `/v1/webhooks` | POST (inbound) | Verify `stripe-signature` with `STRIPE_WEBHOOK_SECRET` using the raw body |

**Handled events:** `checkout.session.completed` â†’ set `pro`; `customer.subscription.updated` â†’ sync `status`, `current_period_end`, `plan`; `customer.subscription.deleted` â†’ `plan='free'`; `invoice.payment_failed` â†’ `past_due` + banner. All writes use the **service-role key**; `profiles.plan` is client-writable only by this path ([03 Â§6.2 S-04](./03-security-and-access.md)). Replayed `event.id` is a no-op.

---

### 5.7 PostHog (analytics)

**Last reviewed:** 2026-10-04


| | |
|---|---|
| **Role** | Funnel + retention tracking against the PRD Â§7 metric tree; feature flags for scoring weights. |
| **Ingest** | `https://us.i.posthog.com/capture` (or EU host) Â· `api_key` = `NEXT_PUBLIC_POSTHOG_KEY` |

**Events (exact names â€” do not invent new ones without updating this table):**

| Event | Properties | Fired when |
|---|---|---|
| `signup_completed` | `method` (magic_link/google) | session established |
| `onboarding_step_completed` | `step` 1â€“4, `duration_s` | each wizard step |
| `onboarding_completed` | `duration_s` | finish clicked |
| `feed_viewed` | `job_count`, `new_count` | dashboard render |
| `job_viewed` | `job_id`, `score`, `source` | job detail open |
| `job_saved` / `job_dismissed` / `job_applied` | `job_id`, `score` | action |
| `score_breakdown_opened` | `job_id`, `score` | C3 disclosure |
| `application_stage_changed` | `from`, `to` | kanban move |
| `digest_opened` | `digest_id`, `job_id` | deep link from email |
| `saved_search_created` | `filters_count` | F2 save |
| `paywall_viewed` | `limit` | G4 inline prompt |
| `subscription_started` | `plan`, `value` | Stripe success |
| `limit_reached` | `metric` | quota check fires |

---

### 5.8 Sentry (errors)

**Last reviewed:** 2026-10-04


`Sentry.init()` in `instrumentation.ts`, DSN from env, traces at 20%, `sendDefaultPii: false` (no rÃ©sumÃ© content, no email in breadcrumbs). Every caught `AppError` reports with `{ code, requestId, userId }` â€” matching the `requestId` shown on 5xx pages ([03 Â§5.3](./03-security-and-access.md)).

---

### 5.9 Integration failure summary

**Last reviewed:** 2026-10-04


| Service | Timeout | Retries | On final failure | User impact |
|---|---|---|---|---|
| Firecrawl | 30s | 3 (**2s/4s/8s** — see note) | source paused at 5 consecutive | **None** — corpus keeps serving |

> **Note on the retry column (corrected 2026-10-09).** This table previously read
> "3 (30s/2m/8m)", which is the **queue's** ladder, not the connector's. A connector retry
> happens *inside* one leased task execution, so a 630s ladder against the 5-minute lease in
> [02b §6.4](./02b-subsystems.md) would let `claim_tasks` reap the row mid-sleep and a second
> worker would start the same task — duplicate ingestion. The connector ladder is 2s/4s/8s
> (14s total), and `src/lib/backoff.ts` throws at import if it ever grows to meet the lease.
> The **task** retry ladder is 30s/2m/8m, because that wait happens between invocations with
> no lease held. Both are named for their context; do not unify them.
| Job APIs | 15s | 3 | run `partial`, source amber/red | **None** |
| OpenRouter embeddings | 20s | 2 | job queued, scored when embedding lands | Slight delay. **Free tier returns HTTP 429 under load â€” treat 429 as retryable, honour `Retry-After`** |
| OpenRouter rationale | 20s | 1 | `explanation = null` | Fallback to breakdown |
| Resend | 10s | 1 | `digests.status='failed'` | Email missed, admin sees it |
| Stripe webhook | â€” | Stripe retries 3d | reconciliation job self-heals | Delayed entitlement, never lost |
| PostHog | 5s | 0 (fire-and-forget) | dropped | **None** â€” never blocks UI |

**Golden rule: no third-party failure may ever block, blank, or break the core feed.**

---

*Component code lives in `src/components/ui/`. Tokens live in `src/styles/tokens.css`. Build order for all of the above is in [05 Feature Tickets](./05-feature-ticket-list.md).*

