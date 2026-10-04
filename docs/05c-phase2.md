# 05c — Phase 2 Front-End Functional Tickets

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [05 Feature Ticket List](./05-feature-ticket-list.md)
**Last reviewed:** 2026-10-04

---

## E5 — Discovery & Feed

### FED-001 — Ranked job feed
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** SCR-004, ENG-002

Dashboard rendering the ranked feed as a Server Component using `v_ranked_jobs` ([04 §5.4](./04-frontend-specification.md)), with the job card from [04 §3.3](./04-frontend-specification.md).

**Done when:**
- [ ] Sorted by `final_score` desc, score-band grouping with newest-first inside each band
- [ ] Server-rendered — no client-side fetch waterfall; LCP p95 < 2.0s
- [ ] Cards show company, score badge, title, meta row, skill chips, `ScoreMeter`, action row
- [ ] Empty state uses `display-l` copy and a real next step (never "No data")
- [ ] Gated/zero-score jobs do not appear
- [ ] Shape-matched skeletons render while loading (no spinner-only page)

---

### FED-002 — Feed actions: save / dismiss / mark applied
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** FED-001

Server Actions for the three actions, with optimistic UI and rollback ([03 §5.3](./03-security-and-access.md)).

**Done when:**
- [ ] Each action is a Server Action with Zod validation + `requireUser`
- [ ] Optimistic update with rollback and a toast on failure
- [ ] Dismissed jobs never resurface (and are excluded from scoring surfaced sets)
- [ ] Double-click "Mark applied" creates exactly one application (idempotent)
- [ ] All three fire the corresponding analytics events with `job_id` and `score`

---

### FED-003 — Filters, sort & search
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** FED-001

Filter by score band, work mode, location, salary, seniority, employment type, source, posted-since; sort by score / date / salary; keyword search via full-text index.

**Done when:**
- [ ] Filters are server-driven (URL-searchParams so state is shareable and back/forward works)
- [ ] Keyword search uses `websearch_to_tsquery` with escaped input (no string-concat SQL — [03 §6.2 S-01](./03-security-and-access.md))
- [ ] Filter state reflected in the URL and restorable on reload
- [ ] Query p95 < 120ms on a seeded corpus of 50k jobs
- [ ] Selected filters render as removable chips per [04 §3.6](./04-frontend-specification.md)

---

### FED-004 — "New since last visit" view
**[UI]** · **Priority:** SHOULD · **Depends on:** FED-001

Diff against `profiles.last_seen_feed_at` (D7).

**Done when:**
- [ ] Returning users see a "N new since yesterday" pill using the count-pill style
- [ ] Toggling the view shows only unseen jobs; viewing updates `last_seen_feed_at`
- [ ] Count is accurate after pagination and filter changes

---

### FED-005 — Duplicate cluster handling
**[UI] [DATA]** · **Priority:** SHOULD · **Depends on:** ING-007, FED-002

Show a "Seen on N sources" chip; dismissing the cluster dismisses all occurrences (D5).

**Done when:**
- [ ] `sighting_count > 1` renders the chip and lists sources in the detail view
- [ ] "Hide all of these" dismisses the whole cluster in one action
- [ ] Partial-source failures never hide a job that is still active elsewhere

---

### FED-006 — Keyboard navigation
**[UI]** · **Priority:** NICE · **Depends on:** FED-001

`j`/`k` move, `s` save, `x` dismiss, `o` open, `a` apply (D6).

**Done when:**
- [ ] All five shortcuts work with a visible focus indicator on the active card
- [ ] Shortcuts don't fire while typing in inputs
- [ ] A discoverable cheat-sheet exists (e.g. `?`) and the actions work without the keyboard too
- [ ] Screen-reader announcement on action

---

## E6 — Job Detail & Actions

### JOB-001 — Job detail page
**[UI]** · **Priority:** MUST · **Depends on:** FED-001

`/jobs/[id]` with description, source badge, canonical link, salary, dates, company block, and score breakdown ([01 PRD Flow 2](./01-prd.md)).

**Done when:**
- [ ] All fields from [04 §3.3](./04-frontend-specification.md) render, including `last_seen_at`
- [ ] "View original" opens `source_url` with `rel="noopener noreferrer"`
- [ ] Description HTML is sanitised to the allowlist in [03 §6.2 S-02](./03-security-and-access.md)
- [ ] Long descriptions collapse with `Read more`
- [ ] 404 for another user's unseen/nonexistent ID, byte-identical to a real miss

---

### JOB-002 — Score breakdown disclosure
**[UI]** · **Priority:** MUST · **Depends on:** JOB-001, SCR-004

Expandable breakdown rendering `job_scores.breakdown` exactly as specified in [04 §3.4](./04-frontend-specification.md) (C3).

**Done when:**
- [ ] Each component shows name, points, and mini bar; sums visibly to `final_score`
- [ ] Semantic blend line shown separately
- [ ] Gated jobs explain *why* they were filtered out in plain English
- [ ] Fires `score_breakdown_opened` on open
- [ ] Fully keyboard operable with correct `aria-expanded`

---

### JOB-003 — Mark-as-applied modal
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** FED-002, TRK-001

Apply modal: applied date, résumé version, notes, follow-up date → creates the application (PRD Flow 2 step 12).

**Done when:**
- [ ] Defaults to today; accepts future follow-up date
- [ ] Résumé picker lists `resume_versions` (empty state if none, non-blocking)
- [ ] Submit creates an application in `applied` stage + a `application_events` row
- [ ] Idempotent on `(user_id, job_id)` — double submit creates one record
- [ ] Success toast + feed card moves to applied state

---

### JOB-004 — Related & duplicate sightings
**[UI]** · **Priority:** NICE · **Depends on:** JOB-001, FED-005

Show alternate sightings of the same role with their source links.

**Done when:**
- [ ] Lists each sighting's source and URL
- [ ] Original/best-preserved description is used for the main body
- [ ] Selecting an alternate updates which URL "View original" uses

---

## E7 — Application Tracker

### TRK-001 — Application record creation
**[DATA]** · **Priority:** MUST · **Depends on:** ENG-003

`applications` insert path with `job_snapshot`, `applied_at`, `resume_version_id`, `notes`, `next_action_at`, plus an initial `application_events` row (use the `move_application()` semantics from [02 §5.9](./02-technical-architecture.md)).

**Done when:**
- [ ] Unique `(user_id, job_id)` enforced — duplicates rejected at the DB level
- [ ] `job_snapshot` captures title/company/salary so history survives source deletion ([03 §5.2 X-16](./03-security-and-access.md))
- [ ] Initial `application_events` row has `from_stage = null`
- [ ] `manual` and `csv_import` sources supported in the schema from day one

---

### TRK-002 — Stage pipeline & history
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** TRK-001

Stage transitions `discovered → saved → applied → screening → interview → offer / rejected / withdrawn` via drag or button, each writing an event.

**Done when:**
- [ ] Invalid transitions are rejected server-side by `move_application()`
- [ ] Every move writes an `application_events` row (append-only — no UPDATE policy)
- [ ] Timeline on the detail drawer shows each transition with timestamps
- [ ] Drag-and-drop has an equal keyboard path (arrow keys + Enter)
- [ ] Analytics event fires with `from`/`to`

---

### TRK-003 — Kanban board view
**[UI]** · **Priority:** MUST · **Depends on:** TRK-002

Columns per stage with counts, drag targets, and WIP badges ([01 PRD Flow 3](./01-prd.md)).

**Done when:**
- [ ] One column per stage with live counts and `stage-badge` styling
- [ ] Drag between columns triggers the stage move with optimistic update + rollback
- [ ] Mobile: columns become stacked stage lists ([04 §4.3](./04-frontend-specification.md))
- [ ] Empty columns show a muted placeholder, not a blank gap
- [ ] Fully keyboard operable; `aria` announcements on move

---

### TRK-004 — Application drawer detail
**[UI]** · **Priority:** MUST · **Depends on:** TRK-002

Drawer with timeline, notes, follow-up date, résumé link, and original posting link.

**Done when:**
- [ ] Shows stage history in reverse-chronological order
- [ ] Notes and `next_action_at` editable inline with autosave + error toast
- [ ] Deep-links to the job detail; handles a deleted job via `job_snapshot`
- [ ] Focus trapped in drawer; `Escape` closes and returns focus to the card

---

### TRK-005 — Tracker stats dashboard
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** TRK-002

Counts by stage, applications this week, response rate, average days-in-stage (PRD E4).

**Done when:**
- [ ] All four metrics render as stat cards per [04 §3.3](./04-frontend-specification.md)
- [ ] Response rate = applications reaching `screening`+ ÷ total applied (documented formula)
- [ ] Zero-data states are explicit ("No applications yet"), not `0%` implying failure
- [ ] Numbers use `mono` with `tabular-nums`

---

### TRK-006 — Follow-up reminders
**[UI]** · **Priority:** SHOULD · **Depends on:** TRK-004

"Needs attention" panel surfacing `next_action_at <= today` ([03 §6.1 X-15](./03-security-and-access.md)).

**Done when:**
- [ ] Due and overdue items appear with distinct overdue styling
- [ ] Past dates are allowed and shown as overdue
- [ ] Completing a follow-up clears it and logs an event
- [ ] Panel appears on the dashboard and the tracker

---

### TRK-007 — CSV import
**[DATA]** · **Priority:** NICE · **Depends on:** TRK-001

Import an existing spreadsheet (company, title, url, stage, date) (PRD E6).

**Done when:**
- [ ] Maps columns, previews 10 rows, reports invalid rows before commit
- [ ] Imported rows get `source='csv_import'` and `job_snapshot`
- [ ] Malformed file → `validation_failed` with row-level errors, partial import never silently applied
- [ ] 5 MB / 1000-row cap

---

## E8 — Searches, Digests & Alerts

### SEA-001 — Saved searches CRUD
**[UI] [DATA] [SEC]** · **Priority:** MUST · **Depends on:** FED-003

Named search with `query` + `filters` JSONB, plus live preview count (PRD F2).

**Done when:**
- [ ] Create/read/update/delete scoped to the owner (RLS verified)
- [ ] Preview shows result count + top 5 with scores before saving
- [ ] Quota enforced: max 3 (free) / 25 (pro), server-side
- [ ] `filters` validated by Zod on write — no arbitrary JSON accepted
- [ ] `notify` toggle controls digest inclusion

---

### SEA-002 — Daily digest email
**[UI] [DATA]** · **Priority:** MUST · **Depends on:** ENG-003, SCR-004, ONB-007

Digest selection + React Email template + Resend send per [02 §6.5](./02-technical-architecture.md) / [04 §5.5](./04-frontend-specification.md) (PRD F1).

**Done when:**
- [ ] Selects top 10 by score since `last_digest_at`, excluding dismissed/applied
- [ ] **Zero results → `status='skipped'`, no email sent**
- [ ] Each item: score, one-line rationale, deep link with `digest_id`/`job_id` params
- [ ] Send is idempotent on `(user_id, scheduled_for)` — double cron never double-sends
- [ ] Failure retries once then marks `failed` and surfaces to admin
- [ ] One-click unsubscribe works **without a session**
- [ ] Renders correctly in Gmail, Apple Mail, Outlook (checked, not assumed)

---

### SEA-003 — Digest scheduling by timezone
**[OPS]** · **Priority:** SHOULD · **Depends on:** SEA-002, ONB-007

`pg_cron` + `send_digest` tasks partitioned by IANA timezone ([02 §6.5](./02-technical-architecture.md)).

**Done when:**
- [ ] Each user receives at their configured local time
- [ ] DST transitions verified with a test ([03 §6.1 X-17](./03-security-and-access.md))
- [ ] `digests.scheduled_for` is the idempotency key
- [ ] Missing timezone falls back safely (no duplicate or skipped sends)

---

### SEA-004 — High-match instant alert
**[DATA]** · **Priority:** SHOULD · **Depends on:** SEA-002

Email when a job scores above the user's threshold (default 90), rate-limited to one per hour (PRD F4).

**Done when:**
- [ ] Threshold configurable in notification settings
- [ ] Max one alert per hour; multiple matches batch into one email
- [ ] Pro-only; free users see the inline prompt instead
- [ ] Alert emails never duplicate an item already in that day's digest

---

### SEA-005 — Slack digest
**[DATA]** · **Priority:** NICE · **Depends on:** SEA-002

Post the digest to `SLACK_WEBHOOK_URL` (PRD F5).

**Done when:**
- [ ] Message blocks render title, score, and link per job
- [ ] Webhook absent → feature hidden, not an error
- [ ] Skipped when nothing new (same rule as email)

---
