# 06 — Work Breakdown: Front-End, Back-End & Design Sequencing

**Product:** JobRadar · **Version:** 1.0 — MVP
**Source & Spec Reference:** [05 Feature Ticket List](./05-feature-ticket-list.md)
**Architecture Reference:** [02 Technical Architecture](./02-technical-architecture.md) · [03 Security & Access](./03-security-and-access.md) · [04 Frontend Spec](./04-frontend-specification.md)
**Last updated:** 2026-10-03

---

## 1. Guiding Principle: "Engine First, Form Last"

To ensure rapid, verifiable progress and eliminate rework, we strictly decouple application logic from visual styling:

1. **Back-End First:** Build the core database, connectors, ingestion pipelines, deduplication, scoring algorithms, queue consumers, and typed Server Actions / Route Handlers. Test everything using automated test suites and fixtures without touching CSS.
2. **Front-End Functional Second:** Build screens, forms, routing, client state, and data fetching with pure semantic HTML and barebones functional UI (unstyled or minimal utility frames). The app must be 100% interactive and feature-complete before visual design begins.
3. **Design & Polish Done Last:** Apply the "Signal" design tokens (`src/styles/tokens.css`), custom typography (Instrument Serif, Inter Tight, JetBrains Mono), custom component styles, animations, responsive breakpoints, WCAG contrast verification, and empty-state illustrations as a final, focused aesthetic pass.

```
┌────────────────────────────────────────────────────────┐
│ PHASE 0: SHARED FOUNDATION                             │
│ Scaffold, TypeScript configs, Supabase DB & RLS       │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ PHASE 1: BACK-END (Track BE)                           │
│ Schema, Connectors, Ingest, Scorer, Queue, Auth/APIs   │
│ (Verified via Unit & Integration Tests, no UI)         │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ PHASE 2: FRONT-END FUNCTIONAL (Track FE)               │
│ Routes, State, Forms, Server Actions, Kanban Logic     │
│ (Verified via E2E Happy Paths with unstyled/raw UI)    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ PHASE 3: DESIGN SYSTEM & POLISH (Track DS — LAST)      │
│ "Signal" palette, Instrument Serif type, ScoreMeter,   │
│ card styling, animations, responsive polish, a11y      │
└────────────────────────────────────────────────────────┘
```

---

## 2. The Seam Contract (Type Safety Across the Boundary)

Before Phase 1 and Phase 2 split, the contract between Back-End and Front-End is defined in `src/types/`:
- **`src/types/canonical-job.ts`**: The canonical job data shape.
- **`src/types/db.ts`**: Supabase table row and enum types.
- **`src/types/api.ts`**: Zod schemas for all Server Action payloads and API responses.

The Back-End exposes typed Server Actions in `src/app/api/actions/` and Route Handlers in `src/app/api/`. The Front-End imports these typed functions directly with zero schema drift.

---

## 3. Phase 0 — Shared Foundation

These tickets must be completed before Track BE branches off.

| ID | Title | Origin Ticket | Priority | Deliverable |
|---|---|---|---|---|
| **FND-001** | Repo Scaffold & Strict Tooling | `ENG-001` | MUST | Monorepo/project structure, TypeScript strict configs, linting, Vitest & Playwright configs. |
| **FND-002** | Core Database Schema & Migrations | `ENG-003` | MUST | `supabase/migrations/0001_init.sql` containing all 16 enums, 20 tables, pgvector, pg_cron, and seed data. |
| **FND-003** | Row-Level Security (RLS) & Policies | `ENG-004` | MUST | RLS policies on all tables, `is_admin()` helper, security integration tests. |
| **FND-004** | Structured Logger, Errors & Sentry | `ENG-005` | MUST | `lib/logger.ts` with secret redaction, `lib/errors/` error taxonomy, Sentry init. |
| **FND-005** | CI Pipeline & Client Secret Scanner | `ENG-006` | MUST | GitHub Actions workflow for lint, test, build, and client bundle secret grep. |

---

## 4. Phase 1 — Back-End Track (`BE`)

No styling or UI components are built here. Work is completed when automated unit and integration tests pass with recorded fixtures.

### 4.1 Ingestion & Connectors (Subsystem)
| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **BE-101** | Connector Interface & Registry | `ING-001` | MUST | `SourceConnector` interface, `RawJob` schema, and dynamic registry. |
| **BE-102** | Tier 1 ATS Connectors (GH, Lever, Ashby) | `ING-002` | MUST | Public API clients parsing boards into `RawJob`. |
| **BE-103** | Remote & Federal Connectors (Remotive, Arbeitnow, USAJOBS) | `ING-003` | MUST | Throttled API clients, USAJOBS custom auth headers. |
| **BE-104** | Aggregator Connector (Adzuna) | `ING-004` | MUST | Country search, salary extraction, quota accounting. |
| **BE-105** | Firecrawl Generic Scraper & Discovery | `ING-005` | MUST | JSON schema-driven extraction via `/v2/scrape`, `/v2/search`, `/v2/map`. |
| **BE-106** | Normalisation Pipeline | `ING-006` | MUST | Salary parser, seniority extractor, regex skill matcher against canonical skills. |
| **BE-107** | Deduplication Engine (Exact + Trigram) | `ING-007` | MUST | SHA-256 dedupe hash upsert + pg_trgm fuzzy similarity merger. |
| **BE-108** | Task Queue Engine & Leases | `ING-008` | MUST | `FOR UPDATE SKIP LOCKED` claim logic, 5-minute leases, exponential backoff. |
| **BE-109** | Cron Ingress Handlers | `ING-009` | MUST | Constant-time `CRON_SECRET` validation on `/api/cron/*` routes. |
| **BE-110** | Freshness & Expiry Lifecycle | `ING-010` | MUST | Status decay (`active` → `stale` → `expired`) & freshness sub-score decay. |
| **BE-111** | Run Logging & Observability | `ING-011` | MUST | `scrape_runs` metrics recorder, duration, error capture, API call attribution. |
| **BE-112** | Manual Trigger Server Action | `ING-012` | SHOULD | `runNow` action with rate-limiting and quota verification. |

### 4.2 Matching & Scoring (Subsystem)
| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **BE-201** | Hard Gate Filters | `SCR-001` | MUST | `gates.ts`: Knockout rules (blocked companies, keywords, salary floor, work mode). |
| **BE-202** | Deterministic Rule-Based Scorer | `SCR-002` | MUST | 0–100 scoring model with weight breakdown JSON builder. |
| **BE-203** | pgvector Embedding Pipeline | `SCR-003` | MUST | OpenAI `text-embedding-3-small` batching and cosine distance calculation. |
| **BE-204** | Score Composition & Persistence | `SCR-004` | MUST | Blends rule + semantic score into `job_scores`, maintains `v_ranked_jobs`. |
| **BE-205** | Batch Profile Rescorer | `SCR-005` | MUST | Requeues user's jobs asynchronously on preference update. |
| **BE-206** | LLM Rationale Generator | `SCR-006` | SHOULD | Structured `gpt-4o-mini` prompt generating 2-sentence fit + gaps rationale. |
| **BE-207** | Dynamic Weight Flags | `SCR-007` | NICE | Flag-overridable weights without code deployments. |

### 4.3 Auth, User Data & Server Actions
| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **BE-301** | Magic Link & OAuth Auth Endpoints | `AUT-001`, `AUT-002` | MUST | Server-side auth handlers, PKCE callback, cookie manager (`httpOnly`). |
| **BE-302** | Session Helpers & Route Guards | `AUT-003`, `AUT-004` | MUST | `requireUser()`, `requireAdmin()`, admin bootstrap script via `ADMIN_EMAILS`. |
| **BE-303** | OTP Verification Backend | `AUT-005` | SHOULD | 6-digit code verification endpoint with rate-limiting. |
| **BE-304** | Profile & Preferences Mutations | `ONB-002..005`, `ONB-006` | MUST | Server Actions for updating titles, skills, logistics, dealbreakers. |
| **BE-305** | Feed Actions Backend | `FED-002` | MUST | Server Actions for Save, Dismiss, and Mark Applied (idempotent). |
| **BE-306** | Feed Query & Filtering Engine | `FED-003` | MUST | High-performance PostgREST query on `v_ranked_jobs` with full-text search. |
| **BE-307** | Application Tracker Backend | `TRK-001`, `TRK-002` | MUST | `move_application()` SQL function, application creation, snapshotting, events log. |
| **BE-308** | Saved Searches Engine | `SEA-001` | MUST | Saved search CRUD, filter validation, and preview count query. |
| **BE-309** | Daily Digest Email Pipeline | `SEA-002`, `SEA-003` | MUST | Cron worker selecting top matches, Resend client, timezone scheduling. |
| **BE-310** | High-Match Alert Worker | `SEA-004` | SHOULD | Threshold-triggered immediate email worker with 1/hour rate-limit. |
| **BE-311** | Stripe Billing & Webhook Engine | `BIL-001..003` | SHOULD | Checkout session creation, raw body webhook signature verification, entitlement sync. |
| **BE-312** | Admin Ops Queries | `ADM-002`, `ADM-003`, `ADM-004` | MUST | Ops data fetchers for run logs, queue status, source pausing, task retry. |
| **BE-313** | Account Data Export & Deletion | `ADM-005` | SHOULD | Streamed JSON export and cascading user account purge. |

---

## 5. Phase 2 — Front-End Functional Track (`FE`)

Built using plain semantic HTML, unstyled Radix UI primitives, or basic grid scaffolding. All screens, interactions, and state must work before any design tokens or custom aesthetics are added.

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **FE-101** | Auth Screens & Routing | `AUT-001`, `AUT-002` | MUST | `/login` form, magic link submit, Google button, `/auth/callback` redirector. |
| **FE-102** | Onboarding Multi-Step Wizard Flow | `ONB-001..005` | MUST | 4-step wizard container, step persistence, chip picker, form validation. |
| **FE-103** | Onboarding Real Progress Interstitial | `ONB-005` | MUST | Live polling screen showing genuine background ingestion progress. |
| **FE-104** | App Shell & Navigation Wireframe | `(app)/layout` | MUST | Basic sidebar + topbar layout, active navigation states, mobile menu toggle. |
| **FE-105** | Ranked Job Feed & List View | `FED-001` | MUST | Server Component feed list rendering job cards, empty states, pagination. |
| **FE-106** | Feed Filter Bar & Search Input | `FED-003` | MUST | URL-synced search input, dropdown filter selectors, active filter pills. |
| **FE-107** | Job Card Interactive Actions | `FED-002` | MUST | Save, Dismiss, Apply action handlers with optimistic updates and rollbacks. |
| **FE-108** | Job Detail Page & Content Rendering | `JOB-001` | MUST | `/jobs/[id]` layout, sanitised HTML description, external links. |
| **FE-109** | Score Breakdown Disclosure | `JOB-002` | MUST | Accessible expandable widget displaying points per category. |
| **FE-110** | Mark-as-Applied Dialog Form | `JOB-003` | MUST | Modal collecting applied date, notes, resume version, next action date. |
| **FE-111** | Application Tracker Kanban Board | `TRK-003` | MUST | Multi-column drag-and-drop / keyboard-accessible stage columns. |
| **FE-112** | Application Detail Drawer & Timeline | `TRK-004` | MUST | Slide-over drawer with stage history events and editable notes. |
| **FE-113** | Tracker Metric Stats Cards | `TRK-005` | MUST | Numerical summary cards (Total, Response Rate, Active Interviews). |
| **FE-114** | Follow-Up "Needs Attention" Panel | `TRK-006` | SHOULD | Overdue and upcoming action items widget. |
| **FE-115** | Saved Searches UI & Modal | `SEA-001` | MUST | Create, view, and delete saved searches with result count badges. |
| **FE-116** | User Settings & Profile Editor | `ONB-006`, `ONB-007` | MUST | Edit profile, skills, logistics, dealbreakers, and notification prefs. |
| **FE-117** | Inline Upgrade & Paywall Prompts | `BIL-004` | SHOULD | Non-blocking inline limit notices with Stripe checkout redirect. |
| **FE-118** | Admin Dashboard Interface | `ADM-001..003` | MUST | Tables for sources, scrape runs, queue monitoring, and retry buttons. |

---

## 6. Phase 3 — Design System & Visual Polish (`DS` — DONE LAST)

This is the final phase. Visual design, brand aesthetics, typography, micro-interactions, responsive refinements, and accessibility compliance are implemented across the entire working application.

| ID | Title | Origin Ticket | Priority | Focus |
|---|---|---|---|---|
| **DS-001** | Token Architecture & Theme Setup | `ENG-002` | MUST | Activate `src/styles/tokens.css` across Tailwind 4, warm paper background (`#F6F4EF`), ink text (`#14161A`). |
| **DS-002** | Editorial Typography Integration | `ENG-002`, `QUA-002` | MUST | Load Instrument Serif, Inter Tight, and JetBrains Mono with zero layout shift; set optical line-heights and tabular numbers. |
| **DS-003** | Core Component System Visuals | `ENG-002` | MUST | High-craft styling for buttons (primary electric blue `#2440F5`, secondary, ghost), inputs, selects, dialogs, toasts. |
| **DS-004** | Job Card & ScoreMeter Visual Styling | `ENG-002`, `FED-001` | MUST | Distinctive card styling, source badges, hover lifts, acid lime (`#C6F24E`) for scores ≥85, tabular score badges. |
| **DS-005** | Feed & Detail Visual Polish | `FED-001`, `JOB-001` | MUST | Editorial layout, clean typography hierarchy, read-more gradient fades, formatted salary tags, company logo fallbacks. |
| **DS-006** | Kanban Tracker Aesthetic Treatment | `TRK-003` | MUST | Column tints, stage pill badges, clean card grab states, smooth drop transitions, empty column states. |
| **DS-007** | Custom Empty States & Illustrations | `QUA-006` | SHOULD | Editorial typography empty states with subtle line illustrations (never bare "No data"). |
| **DS-008** | Loading Skeleton Shapes & Shimmers | `ENG-002`, `QUA-006` | MUST | Shape-matched skeletons mimicking actual job cards and kanban columns (no spinner-only views). |
| **DS-009** | Micro-Interactions & Motion Budget | `04 §4.4` | MUST | Card dismiss animations (fade + slide out), tab underlines, drawer entrance transitions, `prefers-reduced-motion` compliance. |
| **DS-010** | Responsive Polish (Mobile to Ultrawide) | `QUA-004` | MUST | Bottom navigation rail for mobile, bottom-sheet dialogs, touch targets ≥44px, seamless desktop multi-column rails. |
| **DS-011** | WCAG 2.1 AA Accessibility & Contrast Pass | `QUA-003` | MUST | Verified 4.5:1 contrast ratios, non-color-only score indicators, keyboard focus rings (`2px brand outline`), screen reader audit. |
| **DS-012** | Performance & Lighthouse 90+ Tuning | `QUA-002` | MUST | Image optimisation, CSS bundle tree-shaking, SSR streaming verification, sub-2.0s LCP guarantee. |

---

## 7. Master Traceability Matrix

Every single ticket from [05 Feature Ticket List](./05-feature-ticket-list.md) maps into this front-end / back-end / design structure:

| Original 05 Ticket | Phase | Track Ticket(s) | Description / Notes |
|---|---|---|---|
| **ENG-001** | Phase 0 | `FND-001` | Scaffold & tooling |
| **ENG-002** | Phase 3 | `DS-001`, `DS-002`, `DS-003`, `DS-004`, `DS-008` | Component library & design tokens (done last) |
| **ENG-003** | Phase 0 | `FND-002` | Database schema & migrations |
| **ENG-004** | Phase 0 | `FND-003` | Row-Level Security policies |
| **ENG-005** | Phase 0 | `FND-004` | Logging, errors, Sentry |
| **ENG-006** | Phase 0 | `FND-005` | CI pipeline & secret scanner |
| **AUT-001** | Split | `BE-301`, `FE-101` | Magic link auth: BE API + FE form |
| **AUT-002** | Split | `BE-301`, `FE-101` | Google OAuth: BE handler + FE button |
| **AUT-003** | Phase 1 | `BE-302` | Session management & route guards |
| **AUT-004** | Split | `BE-302`, `FE-118` | Admin bootstrap & role gates |
| **AUT-005** | Split | `BE-303`, `FE-101` | OTP fallback: BE handler + FE input |
| **ONB-001** | Phase 2 | `FE-102` | Onboarding wizard shell |
| **ONB-002** | Split | `BE-304`, `FE-102` | Step 1: Titles & seniority (BE mutation + FE step) |
| **ONB-003** | Split | `BE-304`, `FE-102` | Step 2: Skills picker (BE mutation + FE step) |
| **ONB-004** | Split | `BE-304`, `FE-102` | Step 3: Logistics (BE mutation + FE step) |
| **ONB-005** | Split | `BE-304`, `FE-102`, `FE-103` | Step 4: Dealbreakers & interstitial flow |
| **ONB-006** | Split | `BE-304`, `FE-116` | Profile editing & rescore trigger |
| **ONB-007** | Split | `BE-304`, `FE-116` | Notification preferences |
| **ING-001** | Phase 1 | `BE-101` | Connector interface & registry |
| **ING-002** | Phase 1 | `BE-102` | Greenhouse, Lever, Ashby connectors |
| **ING-003** | Phase 1 | `BE-103` | Remotive, Arbeitnow, USAJOBS connectors |
| **ING-004** | Phase 1 | `BE-104` | Adzuna aggregator connector |
| **ING-005** | Phase 1 | `BE-105` | Firecrawl scraper & search connector |
| **ING-006** | Phase 1 | `BE-106` | Normalisation & skill extraction |
| **ING-007** | Phase 1 | `BE-107` | Exact & fuzzy deduplication |
| **ING-008** | Phase 1 | `BE-108` | Durable task queue & worker pool |
| **ING-009** | Phase 1 | `BE-109` | Cron ingress & scheduling |
| **ING-010** | Phase 1 | `BE-110` | Freshness decay & expiry |
| **ING-011** | Phase 1 | `BE-111` | Scrape run logging & metrics |
| **ING-012** | Split | `BE-112`, `FE-105` | Manual "run now" action & trigger |
| **SCR-001** | Phase 1 | `BE-201` | Hard gates (knockout filters) |
| **SCR-002** | Phase 1 | `BE-202` | Deterministic rule-based scoring |
| **SCR-003** | Phase 1 | `BE-203` | OpenAI pgvector embedding |
| **SCR-004** | Phase 1 | `BE-204` | Score composition & `v_ranked_jobs` |
| **SCR-005** | Phase 1 | `BE-205` | Batch profile rescoring worker |
| **SCR-006** | Phase 1 | `BE-206` | LLM fit rationale |
| **SCR-007** | Phase 1 | `BE-207` | Score weight feature flags |
| **FED-001** | Split | `FE-105`, `DS-004`, `DS-005` | Feed: FE functional list → DS styling |
| **FED-002** | Split | `BE-305`, `FE-107` | Feed actions: BE mutations + FE buttons |
| **FED-003** | Split | `BE-306`, `FE-106` | Filters & search: BE query + FE controls |
| **FED-004** | Phase 2 | `FE-105` | "New since last visit" toggle & filter |
| **FED-005** | Split | `BE-107`, `FE-107` | Duplicate cluster handling |
| **FED-006** | Phase 2 | `FE-105` | Keyboard navigation (`j`/`k`/`s`/`x`/`a`) |
| **JOB-001** | Split | `FE-108`, `DS-005` | Job detail: FE layout → DS styling |
| **JOB-002** | Split | `FE-109`, `DS-004` | Score breakdown disclosure |
| **JOB-003** | Split | `BE-307`, `FE-110` | Mark applied: BE mutation + FE modal |
| **JOB-004** | Phase 2 | `FE-108` | Related sightings list |
| **TRK-001** | Phase 1 | `BE-307` | Application record creation & snapshots |
| **TRK-002** | Phase 1 | `BE-307` | Stage pipeline validation & history events |
| **TRK-003** | Split | `FE-111`, `DS-006` | Kanban board: FE drag-and-drop → DS styling |
| **TRK-004** | Phase 2 | `FE-112` | Application drawer detail |
| **TRK-005** | Split | `BE-307`, `FE-113` | Tracker stats: BE calculation + FE cards |
| **TRK-006** | Split | `BE-307`, `FE-114` | Follow-up reminders panel |
| **TRK-007** | Phase 1 | `BE-307` | CSV application import |
| **SEA-001** | Split | `BE-308`, `FE-115` | Saved searches CRUD |
| **SEA-002** | Phase 1 | `BE-309` | Daily digest email worker & React Email |
| **SEA-003** | Phase 1 | `BE-309` | Timezone scheduling worker |
| **SEA-004** | Phase 1 | `BE-310` | High-match instant alert |
| **SEA-005** | Phase 1 | `BE-309` | Slack digest poster |
| **BIL-001** | Phase 1 | `BE-311` | Plan definitions & usage counters |
| **BIL-002** | Split | `BE-311`, `FE-117` | Stripe checkout session creation |
| **BIL-003** | Phase 1 | `BE-311` | Stripe webhook signature & entitlement sync |
| **BIL-004** | Phase 2 | `FE-117` | Inline paywall notices |
| **BIL-005** | Phase 1 | `BE-311` | Dunning & grace period worker |
| **ADM-001** | Phase 2 | `FE-118` | Admin shell navigation & route guards |
| **ADM-002** | Split | `BE-312`, `FE-118` | Source health & run log viewer |
| **ADM-003** | Split | `BE-312`, `FE-118` | Queue monitor & task retry |
| **ADM-004** | Split | `BE-312`, `FE-118` | User account lookup |
| **ADM-005** | Split | `BE-313`, `FE-116` | Account export & delete flow |
| **QUA-001** | Cross | Phase 1 + 2 | Playwright E2E automation suite |
| **QUA-002** | Phase 3 | `DS-012` | Performance & Lighthouse 90+ tuning |
| **QUA-003** | Phase 3 | `DS-011` | Full WCAG 2.1 AA accessibility audit |
| **QUA-004** | Phase 3 | `DS-010` | Responsive cross-device layout pass |
| **QUA-005** | Cross | Launch | Pre-launch checklist & security sign-off |
| **QUA-006** | Phase 3 | `DS-007`, `DS-008` | Empty & loading state polish |
| **BKG-001..012** | Backlog | — | Phase 2 / Backlog items |

---

## 8. Execution Playbook

How to run the three phases without the plan rotting. Generic advice (small commits, write tests) is omitted — only the rules specific to an engine-first / design-last split are here.

### 8.1 Freeze the seam before Phase 1 starts

The back-end finishes before the front-end exists, so the contract *is* the product.

- **Zod is the source of truth; TypeScript is derived.** Define each schema once in `src/types/api.ts` and export `z.infer<typeof X>`. Never hand-write a parallel interface — two definitions drift.
- **Contract-first by ticket, not by phase.** A BE ticket that changes an API shape updates the type file **in the same commit**. A FE ticket opened against a stale type is a blocked ticket.
- **Nothing bypasses the seam.** Components never call PostgREST directly — only `lib/db/queries/` and Server Actions. One direct call inside a component and the boundary is gone.

### 8.2 Phase gates are tests, not opinions

Each phase ends with an objective, automatable gate. No "looks done."

| Gate | Passes when |
|---|---|
| **P0 → P1** | `supabase db reset` from empty succeeds · RLS policy tests green · CI green with zero features |
| **P1 → P2** | All BE tests green with **no live API calls** · `lib/scoring` + `lib/ingest` ≥85% · scorer proven deterministic (same input → same score) |
| **P2 → P3** | Playwright E2E green against **unstyled** UI: onboarding → feed → apply → stage move |
| **P3 → Ship** | axe zero violations · AA contrast · Lighthouse ≥90 · `prefers-reduced-motion` honoured |

The **P2 gate is the one people skip.** If the flow doesn't work in plain HTML, styling it won't fix it — you'd just be debugging logic through CSS.

### 8.3 Split accessibility across phases

The most common failure of "design last" is lumping all a11y into the design phase.

| Phase owns | Covers |
|---|---|
| **Phase 2 — structure** | Semantic elements · real `<button>` not `<div onClick>` · label/control association · heading order · focus order · live regions · `aria-expanded` |
| **Phase 3 — presentation** | Contrast ratios · focus-ring visibility · non-colour-only signalling · touch-target size |

If structure slips to Phase 3, the design pass becomes a rewrite. Hence `DS-011` is a contrast and screen-reader *audit*, not markup work.

### 8.4 "Unstyled" must not become "unstructured"

Use **Radix primitives unstyled from Day 1 of Phase 2.** Behaviour (focus trap, keyboard nav, drag-and-drop) is Phase 2; visuals are Phase 3.

- `Dialog`, `Dropdown`, `Tabs` → Radix with **no CSS** in P2.
- `Button` → a thin wrapper around a native `<button>`.

Hand-rolling a modal out of `<div>`s in P2 means Phase 3 rewrites it instead of restyling it.

### 8.5 Test the back-end without the world

- **Fixtures, never live APIs, in CI** — recorded JSON per connector in `tests/integration/fixtures/sources/`. Live calls burn quota, go flaky, and block unrelated PRs when a source rate-limits.
- **Testcontainers Postgres** for RLS and queue tests — `FOR UPDATE SKIP LOCKED` concurrency can't be validated on SQLite or a mock.
- **Inject the clock.** Freshness decay, digest timezones and retry backoff become deterministic with a fake clock instead of a `sleep`.
- **Prove idempotency explicitly:** run each queue handler twice, assert one row. This is what makes the retry/backoff design actually safe.

### 8.6 Rules for AI-assisted execution

The tickets in [05](./05-feature-ticket-list.md) were written prompt-sized on purpose. Two rules make that work:

1. **Give the agent the ticket *and* its doc sections** — e.g. *"implement `BE-107`; schema in 02 §6.2, RLS in 03 §4.2."* Tickets alone invite invention.
2. **Require evidence before "done":** run `pnpm typecheck && pnpm test` and paste the output before claiming completion. A green checkmark from a model with no output behind it is worthless.

Plus the anti-invention rule from the README: **if the agent needs something the docs don't specify — a table, an env var, a colour, an endpoint — it updates the doc first, then builds.** That keeps docs 01–06 the source of truth instead of a description of what the code happened to become.

### 8.7 Three anti-patterns to block explicitly

| Anti-pattern | Why it hurts |
|---|---|
| A "temporary" hex value or inline style in Phase 2 | It becomes de-facto design and contradicts `tokens.css`. Turn on the CI grep at the **start of P2**, not P3. |
| Schema changes after P1 without a migration + doc 02 update | The traceability matrix in §7 rots silently otherwise. |
| Scope creep into design during P1 | "Just quickly style this admin table" costs more than it saves and produces a third visual system. |

---

## 9. Immediate Next Step: Phase 0 & Phase 1 Execution

Now that the boundary and sequencing are locked in:
1. Complete **Phase 0 Foundation** (`FND-001` through `FND-005`).
2. Implement **Phase 1 Back-End** starting with the Database Migrations (`FND-002`) and Ingestion Connectors (`BE-101`..`BE-105`).
3. Validate the entire backend with automated tests before writing any front-end UI.
