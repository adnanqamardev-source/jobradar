# 05 — Feature Ticket List

**Product:** JobRadar · **Version:** 1.0 — MVP
**Source:** [01 PRD](./01-prd.md) · **Constraints:** [02 Architecture](./02-technical-architecture.md), [03 Security](./03-security-and-access.md), [04 Frontend Spec](./04-frontend-specification.md)
**Last updated:** 2026-10-03

**How to use this doc:** each ticket is written so it can be pasted directly into an AI coding tool as a single prompt. One ticket = one unit of work that an agent can complete and that you can verify without reading the rest of the codebase.

**Priority:** `MUST` = required for MVP launch · `SHOULD` = within 6 weeks of launch · `NICE` = backlog
**Tags:** `[SEC]` security · `[DATA]` data/pipeline · `[UI]` interface · `[OPS]` operations

### Reading a ticket

| Field | Meaning |
|---|---|
| **ID** | Stable reference. Never reuse. |
| **Depends on** | Must be merged and verified first. Work only in dependency order. |
| **Done when** | Acceptance criteria. Every box must be checked before the ticket closes. Nothing is "done" at 90%. |
| **Reference** | The spec section that defines the details — read it before writing code. |

### Build order (epics)

```
E0 Foundation ─▶ E1 Auth ─▶ E2 Onboarding ─▶ E3 Ingestion ─▶ E4 Scoring ─▶ E5 Feed
                                          └──────────────▶ E6 Job Detail & Actions ─▶ E7 Tracker
                                          └──────────────▶ E8 Searches & Digest
        E9 Billing & Gating (after E2)   E10 Ops (parallel from E3)   E11 Polish (last)
```

---
## SHOULD / NICE backlog (not in MVP build order)

| ID | Ticket | Priority |
|---|---|---|
| BKG-001 | Résumé version upload, default selection, attachment to applications (PRD A6) | SHOULD |
| BKG-002 | Company profiles + ATS detection for direct GH/Lever/Ashby pulls (PRD B8) | SHOULD |
| BKG-003 | User-defined source scope & company watchlists (PRD B8) | SHOULD |
| BKG-004 | `gates`… **Learning feedback loop** from save/dismiss/apply adjusting weights (PRD C6) | NICE |
| BKG-005 | Data-quality confidence flag surfaced in the UI (PRD C7) | SHOULD |
| BKG-006 | Source circuit-breaker auto-disable with admin notification (PRD B10) | NICE |
| BKG-007 | Browser bookmarklet for manual posting capture (PRD §8) | NICE |
| BKG-008 | `job_events`-driven personalisation of implicit preference weights | NICE |
| BKG-009 | Feature-flag driven scoring weights (ENG/SCR-007) | NICE |
| BKG-010 | AI résumé tailoring / cover-letter generation — **Phase 2** | NICE |
| BKG-011 | Auto-apply / form filling — **Phase 3, explicitly out of MVP** (PRD §6) | NICE |
| BKG-012 | Native mobile apps, team/coach seats, calendar sync, multi-language — **out of scope** (PRD §6) | NICE |

---
## Ticket index

| Epic | Tickets | Count |
|---|---|---|
| E0 Foundation | ENG-001…006 | 6 |
| E1 Auth | AUT-001…005 | 5 |
| E2 Onboarding | ONB-001…007 | 7 |
| E3 Ingestion | ING-001…012 | 12 |
| E4 Scoring | SCR-001…007 | 7 |
| E5 Feed | FED-001…006 | 6 |
| E6 Job Detail | JOB-001…004 | 4 |
| E7 Tracker | TRK-001…007 | 7 |
| E8 Digests | SEA-001…005 | 5 |
| E9 Billing | BIL-001…005 | 5 |
| E10 Admin | ADM-001…005 | 5 |
| E11 Polish | QUA-001…006 | 6 |
| Backlog | BKG-001…012 | 12 |
| **Buildable (E0–E11)** | | **75** |
| Backlog | BKG-001…012 | 12 |
| **Total** | | **87** |

**Priority split**

| Priority | Buildable | Backlog | Total |
|---|---|---|---|
| **MUST** | 53 | 0 | **53** |
| **SHOULD** | 17 | 4 | **21** |
| **NICE** | 5 | 8 | **13** |

**MVP = every ticket marked MUST** — 53 tickets, executed in the epic order at the top of this document. `SHOULD` tickets target the first 6 weeks after launch; `NICE` and all of `BKG-*` stay in the backlog.
