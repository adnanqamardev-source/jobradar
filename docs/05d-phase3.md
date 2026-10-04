# 05d — Phase 3 Design Tickets

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [05 Feature Ticket List](./05-feature-ticket-list.md)
**Last reviewed:** 2026-10-04

---

## E9 — Billing & Gating

### BIL-001 — Plan definitions & usage metering
**[DATA] [SEC]** · **Priority:** SHOULD · **Depends on:** ONB-005

`lib/billing/plans.ts` as the single source of truth for limits from [03 §3.2](./03-security-and-access.md), plus `usage_events` counters (G1, G2).

**Done when:**
- [ ] Every limit in the [03 §3.2](./03-security-and-access.md) matrix exists in one typed constant
- [ ] Counters incremented per billing period with an idempotent helper
- [ ] A `requirePlan()`/`requireQuota()` guard returns `quota_exceeded` with the exact inline copy
- [ ] Quota enforced **both** in the Server Action and by a DB-level check where applicable
- [ ] Usage widget shows current vs limit with the meter style from [04 §3.6](./04-frontend-specification.md)

---

### BIL-002 — Stripe checkout & customer portal
**[UI] [DATA]** · **Priority:** SHOULD · **Depends on:** BIL-001

Checkout session creation and portal session creation per [04 §5.6](./04-frontend-specification.md) (G3).

**Done when:**
- [ ] `client_reference_id` ties the session to the user; `success_url` returns to the **originally attempted action**
- [ ] Portal supports plan change and cancel
- [ ] Keys read from env only; publishable key is the only client-visible one
- [ ] Price ID from `STRIPE_PRICE_ID_PRO`, never hardcoded

---

### BIL-003 — Stripe webhooks & entitlement sync
**[DATA] [SEC]** · **Priority:** SHOULD · **Depends on:** BIL-002

`/api/webhooks/stripe` handling the four events from [04 §5.6](./04-frontend-specification.md), signature-verified, service-role writes (G3).

**Done when:**
- [ ] Signature verified against the **raw** body with `STRIPE_WEBHOOK_SECRET`
- [ ] `checkout.session.completed` → `plan='pro'`; `subscription.deleted` → `plan='free'`
- [ ] `payment_failed` → `past_due` **without** downgrading entitlements
- [ ] Replayed `event.id` is a no-op
- [ ] `profiles.plan` cannot be changed by any client path (test from ENG-004 holds)
- [ ] Reconciliation job self-heals a missed webhook within an hour

---

### BIL-004 — Inline paywall prompts
**[UI] [SEC]** · **Priority:** SHOULD · **Depends on:** BIL-001

G4: inline, non-blocking limit notices explaining what Pro unlocks — **never a modal** (PRD Flow 6).

**Done when:**
- [ ] Limit notice renders inline at the point of the blocked action
- [ ] Copy states current usage, the limit, and what Pro adds
- [ ] No page block, no forced redirect, no countdown/urgency patterns
- [ ] Fires `paywall_viewed` with the `limit` property
- [ ] After upgrade, the originally attempted action completes automatically

---

### BIL-005 — Dunning & grace handling
**[DATA]** · **Priority:** SHOULD · **Depends on:** BIL-003

`past_due` banner, 7-day grace, dunning emails at day 1/3/7 ([03 §5.2](./03-security-and-access.md)).

**Done when:**
- [ ] `past_due` shows an update-card banner with a portal link
- [ ] Grace period holds `pro` entitlements for 7 days, then `free`
- [ ] Dunning emails sent on schedule and stop on recovery
- [ ] No user-visible error if Stripe is unreachable — banner degrades gracefully

---

## E10 — Operations & Admin

### ADM-001 — Admin shell & role gate
**[UI] [SEC]** · **Priority:** MUST · **Depends on:** AUT-004

`/admin` layout with server-side `requireAdmin()`, nav (Sources, Runs, Queue, Users), and per-action re-checks.

**Done when:**
- [ ] Non-admin redirect to `/dashboard` with the neutral message
- [ ] Every admin Server Action re-verifies `is_admin()` server-side
- [ ] All mutations write `audit_logs`
- [ ] Admin route not linked in the user-facing sidebar

---

### ADM-002 — Source health & run log
**[OPS] [UI]** · **Priority:** MUST · **Depends on:** ING-011, ADM-001

Source tiles (green/amber/red by `consecutive_failures`) and a last-50-runs table with filters (PRD H2).

**Done when:**
- [ ] Tile shows status, `last_success_at`, `next_run_at`, and failure count
- [ ] Run table: status, duration, counts, `api_calls`, expandable error
- [ ] Amber at 3 failures, red/paused at 5
- [ ] Data read with the service key server-side; no `scrape_runs` client access
- [ ] List refreshes without a full page reload

---

### ADM-003 — Queue monitor & retry
**[OPS]** · **Priority:** MUST · **Depends on:** ING-008, ADM-001

Queue depth by status/kind, failed-task list with manual retry (PRD H2).

**Done when:**
- [ ] Depth chart: pending / running / failed / oldest pending age
- [ ] Failed tasks list `attempts`, `last_error`, and kind
- [ ] Retry re-enqueues with attempts reset and writes an audit row
- [ ] Alert fires when `consecutive_failures >= 3` or pending depth exceeds threshold

---

### ADM-004 — User lookup (no content access)
**[SEC] [UI]** · **Priority:** SHOULD · **Depends on:** ADM-001

Find an account by email showing plan, status, and counts — **not** profile or application content ([03 §3.2](./03-security-and-access.md)).

**Done when:**
- [ ] Search returns account metadata only: plan, created_at, counts of applications/scores
- [ ] Viewing any profile *content* requires an explicit audited action
- [ ] Every lookup writes `audit_logs` (`action='admin.lookup_user'`)
- [ ] Test confirms admin cannot fetch another user's `applications` via RLS

---

### ADM-005 — Account export & deletion
**[SEC] [DATA]** · **Priority:** SHOULD · **Depends on:** ENG-004

User-triggered JSON export and full account deletion (PRD H4, [03 §6.1 X-21](./03-security-and-access.md)).

**Done when:**
- [ ] Export produces valid JSON containing profile, scores, applications, events, digests
- [ ] Export excludes secrets and other users' data; streamed, not buffered in memory
- [ ] Deletion cascades all user rows **and** Storage objects; shared `jobs` retained
- [ ] Confirmation copy lists exactly what is removed
- [ ] Post-deletion, the refresh token is invalid and the account cannot be re-authenticated

---

## E11 — Polish, Quality & Launch

### QUA-001 — End-to-end test suite
**[OPS]** · **Priority:** MUST · **Depends on:** TRK-003

Playwright covering: onboarding → feed → apply → stage move → stats; paywall → checkout; admin retry; error paths.

**Done when:**
- [ ] Happy path from signup to a moved application passes headless
- [ ] Abandoned-onboarding resume path covered
- [ ] Rate-limit and quota paths assert the exact copy from [03 §5.1](./03-security-and-access.md)
- [ ] 404-not-yours and 500-with-requestId assertions pass
- [ ] Suite runs in CI and is green three consecutive runs (no flakes)

---

### QUA-002 — Performance pass
**[OPS] [UI]** · **Priority:** MUST · **Depends on:** FED-001, JOB-001

Hit the budgets in [02 §8](./02-technical-architecture.md).

**Done when:**
- [ ] Feed LCP p95 < 2.0s; job detail SSR < 400ms; feed query p95 < 120ms on 50k jobs
- [ ] No client-side fetch waterfall on the feed (Server Component verified)
- [ ] Images/fonts self-hosted with `next/font`, zero layout shift
- [ ] Lighthouse performance ≥ 90 on `/dashboard` and `/jobs/[id]`

---

### QUA-003 — Accessibility audit
**[UI] [SEC]** · **Priority:** MUST · **Depends on:** FED-001, TRK-003

Full WCAG 2.1 AA pass ([04 §4.6](./04-frontend-specification.md)).

**Done when:**
- [ ] `vitest-axe` green on the component gallery and all five main routes
- [ ] Score conveyed by text + value, never colour alone ([03 §6.1 X-23](./03-security-and-access.md))
- [ ] Kanban fully keyboard-operable with announcements
- [ ] Visible focus everywhere; `Skip to content` link; correct heading order
- [ ] `prefers-reduced-motion` disables all but opacity transitions
- [ ] Screen-reader spot-check (VoiceOver or NVDA) on onboarding, feed, tracker

---

### QUA-004 — Responsive pass
**[UI]** · **Priority:** MUST · **Depends on:** FED-001, TRK-003

Breakpoint behaviour from [04 §4.3](./04-frontend-specification.md).

**Done when:**
- [ ] 360px: no horizontal scroll on any route; bottom tab bar active
- [ ] 640–1023px: icon rail + 2-column card grid
- [ ] ≥1024px: full sidebar; ≥1280px right rail with `Needs attention`
- [ ] Modals become bottom sheets on mobile with safe-area padding
- [ ] Touch targets ≥44×44px

---

### QUA-005 — Launch readiness & legal
**[OPS] [SEC]** · **Priority:** MUST · **Depends on:** all MUST tickets

Complete the pre-launch checklist in [03 §7](./03-security-and-access.md) plus legal and support assets.

**Done when:**
- [ ] Every box in [03 §7](./03-security-and-access.md) is checked
- [ ] Privacy policy + terms published (covering scraping sources, résumé storage, deletion)
- [ ] Source inventory reviewed for ToS compliance — **no LinkedIn/Indeed direct scraping** (PRD R2)
- [ ] `ADMIN_EMAILS` set; admin can reach the console
- [ ] Monitoring dashboards live: source health, queue depth, error rate, cost/MAU
- [ ] Rollback procedure documented and tested on a preview deploy
- [ ] PostHog funnel events verified end-to-end against the PRD §7 metric tree

---

### QUA-006 — A11y & copy review of empty/error states
**[UI]** · **Priority:** SHOULD · **Depends on:** ENG-005

Every empty, loading, and error state matches [04 §3.7](./04-frontend-specification.md) and the copy map in [03 §5.1](./03-security-and-access.md).

**Done when:**
- [ ] No route ever renders "No data" or a bare spinner
- [ ] Every error shows curated copy + a next action; no raw messages anywhere
- [ ] Loading skeletons are shape-matched to final content
- [ ] Zero-data states offer a real action (add skills, run a search, view a sample)

---
