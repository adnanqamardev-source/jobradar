# 01 â€” Product Requirements Document (PRD)

**Last reviewed:** 2026-10-04


**Product:** JobRadar *(working name)*
**Version:** 1.0 â€” MVP
**Status:** Approved for build
**Last updated:** 2026-10-03
**Companion docs:** [02 Technical Architecture](./02-technical-architecture.md) Â· [03 Security & Access](./03-security-and-access.md) Â· [04 Frontend Specification](./04-frontend-specification.md) Â· [05 Feature Tickets](./05-feature-ticket-list.md)

---

## 1. Problem Statement

**Last reviewed:** 2026-10-04


### What's broken today

**Last reviewed:** 2026-10-04


Looking for a job has become a second job â€” and it's mostly busywork.

A serious job seeker has to open 8â€“12 different places every morning: LinkedIn, Indeed, Google Jobs, Wellfound, a dozen company career pages, plus niche boards for their industry. Each one has a different layout, a different filter UI, and a different definition of "remote." Postings are duplicated across all of them, so the same role shows up five times. Good roles are posted and filled within 48 hours, so missing one day means missing the job.

Then comes the second half of the problem, which is worse. Once you've found 30 roles you might care about, you have to decide which ones are actually worth your time. That means reading each description carefully, checking the seniority level against your experience, checking whether the salary is disclosed at all (usually not), checking whether "hybrid" means two days a week or four, and checking whether the company is on some list you made in your head. Doing this properly takes 4â€“6 minutes per posting. Doing it for 30 postings takes an afternoon.

And there's no feedback loop. After you apply, the posting disappears into what everyone calls "the black hole." You have no idea how many applications are still live, which stage each one is in, how long it's been since you heard back, or what your actual response rate is. People track this in a spreadsheet that they update faithfully for nine days and then abandon.

### Who faces it

**Last reviewed:** 2026-10-04


- **Active seekers** applying to 10â€“25 roles a week, spending 6â€“12 hours a week on search and tracking work that is entirely mechanical.
- **Passive explorers** who are employed and can only look in evening bursts, so by the time they look, the good roles are two days cold.
- **Career changers** who can't use title-based search at all, because the roles they want are named differently at every company.

### Why it matters

**Last reviewed:** 2026-10-04


The mechanics of job search are not the hard part â€” evaluating fit and following up are. Every hour spent refreshing boards, copy-pasting descriptions into a spreadsheet, and manually checking salary bands is an hour not spent preparing, networking, or interviewing. The search market also structurally favours people with free time and familiarity with tools, which quietly makes outcomes worse for the people who need the job most.

**JobRadar exists to move the mechanical half of job search into a background process**, so the seeker's attention goes to the half that actually requires a human.

### The core bet

**Last reviewed:** 2026-10-04


Most of job search is *retrieval and ranking*, not judgment. If we can (a) pull postings from many sources automatically, (b) deduplicate them, and (c) rank them against a structured profile, then the user only ever looks at a short, already-filtered list â€” and the tracker closes the loop on what they applied to.

---

## 2. Target Users

**Last reviewed:** 2026-10-04


### Primary persona â€” "Maya," the active seeker

**Last reviewed:** 2026-10-04


| | |
|---|---|
| **Age** | 27â€“38 |
| **Situation** | Employed but looking, or recently laid off. Searching 4â€“10 hours a week alongside a full-time job or job-search routine. |
| **Role type** | Product, engineering, design, marketing, data, ops â€” knowledge work with clear titles and skills. |
| **Tech comfort** | High. Comfortable with tabs, spreadsheets, browser extensions, and subscriptions. Does not write code. Has used Zapier/Notion templates. |
| **What they want** | A short daily list of roles that are genuinely relevant, ranked, with enough detail to decide in 30 seconds. Confidence that nothing is being missed. |
| **What frustrates them** | Re-checking the same ten sites. Duplicates. "Competitive salary" with no number. Applications that vanish. Job boards that show 200 results where 6 are real matches. Cold postings still circulating weeks later. |
| **Current workaround** | A spreadsheet with columns for company/title/stage/date, updated for about a week, then abandoned. Google Alerts that produce noise. |
| **Success to them** | "I open one page each morning and I know exactly what to do next." |

### Secondary persona â€” "TomÃ¡s," the passive explorer

**Last reviewed:** 2026-10-04


- **Age** 30â€“45, happily employed, mildly curious.
- **Tech comfort** Moderate â€” will set something up once if it's obviously worth it and never touch it again.
- **Want:** A weekly digest of only the 5â€“10 roles that would genuinely tempt him. No notifications, no app to check.
- **Frustration:** Anything that demands daily attention or spams him.
- **Implication for the product:** The system must deliver value with *zero* daily engagement. Scheduling and digests are not nice-to-haves; they're what makes this persona exist at all.

### Tertiary persona â€” "Priya," the career changer

**Last reviewed:** 2026-10-04


- **Age** 24â€“32, moving between functions (teacher â†’ analyst, designer â†’ PM).
- **Tech comfort** Moderate-high.
- **Want:** To find roles that don't share her current title. Keyword and skill-based discovery rather than title-based.
- **Frustration:** Title-based search is useless to her; she needs skills, seniority, and adjacency.
- **Implication:** Scoring must weigh **skills and seniority over title**, and saved searches must support skill lists, not just titles.

### What we assume about all three

**Last reviewed:** 2026-10-04


1. They will not tolerate a setup longer than **3 minutes**.
2. They will not read a manual. The first screen must explain itself.
3. They will judge the product on the **quality of the first 10 results**, not on feature count.
4. They will not pay before they have seen the product work.

---

## 3. Product Vision

**Last reviewed:** 2026-10-04


> **JobRadar is the background process for your job search: it watches every source you care about, throws away the duplicates and the dead roles, ranks what's left against who you actually are, and keeps score of everything you've applied to â€” so the only thing left for you to do is decide.**

### North-star behaviour (12 months out)

**Last reviewed:** 2026-10-04


A user opens JobRadar once a day, for under five minutes, and leaves knowing: *these three are worth applying to today, and here's where my other 14 applications stand.* They never manually browse a job board again.

### Design principles that follow from the vision

**Last reviewed:** 2026-10-04


1. **Rank over list.** Volume is the enemy. A ranked list of 20 beats a sorted list of 2,000.
2. **Show the reasoning.** Every score is expandable to *why*. A number without a reason erodes trust within a week.
3. **Background by default, on demand when needed.** Scrapes run on a schedule; the user can force a run but never has to.
4. **One source of truth for status.** The posting and the application live in the same record. No second spreadsheet.
5. **Stale data is worse than no data.** Expired roles are demoted and marked, never presented as fresh.

---

## 4. Core Features

**Last reviewed:** 2026-10-04


Priority legend: **M** = Must-have for MVP launch Â· **S** = Should-have (launch within 6 weeks of MVP) Â· **N** = Nice-to-have (backlog)

### Epic A â€” Profile & Preferences

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| A1 | **Account creation** | Sign up with email magic link or Google OAuth. No passwords to manage. | **M** |
| A2 | **Profile onboarding wizard** | 4-step guided setup (~3 min): role & seniority â†’ skills â†’ location/work-mode/compensation â†’ dealbreakers. Progress saved between steps. | **M** |
| A3 | **Skills & seniority model** | User picks from a canonical skill list (with free-text add), rates proficiency, and sets target seniority. Drives scoring. | **M** |
| A4 | **Hard filters (dealbreakers)** | Blocked companies, excluded keywords, minimum salary floor, remote/hybrid/on-site, visa requirement, location radius. Jobs failing these are never surfaced. | **M** |
| A5 | **Profile editing** | Re-edit any onboarding field post-setup; rescoring is triggered on save. | **M** |
| A6 | **RÃ©sumÃ© version storage** | Upload and store multiple rÃ©sumÃ© versions, set a default, attach one to an application. | **S** |
| A7 | **Notification preferences** | Per-channel, per-cadence controls for digests and alerts. | **S** |

### Epic B â€” Ingestion & Sources

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| B1 | **Job API connectors** | Pull postings from structured, ToS-friendly public job APIs (Greenhouse, Lever, Ashby, Remotive, Arbeitnow, USAJOBS, Adzuna). Each connector maps fields to the canonical job schema. | **M** |
| B2 | **Firecrawl generic scraper** | For career pages and boards that are JS-rendered or have no API: `firecrawl_scrape` with JSON-schema extraction, `firecrawl_search` for discovery, `firecrawl_map` for careers-page discovery. | **M** |
| B3 | **Scheduled automated runs** | Cron-driven ingestion per source on a configurable cadence (default: every 6 hours for APIs, daily for Firecrawl-heavy sources to control cost). | **M** |
| B4 | **Normalisation** | Map every source's fields into one canonical job shape: title, company, location, work mode, salary, seniority, employment type, skills, description text. | **M** |
| B5 | **Deduplication** | Exact-match canonical hash (title + company domain + location) plus fuzzy trigram matching across sources. One job record survives; sightings are counted. | **M** |
| B6 | **Freshness & expiry** | `first_seen_at` / `last_seen_at` tracking; roles not seen for N days are marked `stale`, not seen for 2N are `expired` and demoted. | **M** |
| B7 | **Scrape run observability** | Per-run record: source, status, duration, items found / new / duplicate / failed, error text. Visible in an admin view. | **M** |
| B8 | **User-defined source scope** | User chooses which sources and which companies are watched for their account (company watchlist pulls directly from that company's ATS feed). | **S** |
| B9 | **Manual "run now"** | Force an immediate ingestion run for a source or a saved search, rate-limited per plan. | **S** |
| B10 | **Source health auto-disable** | A connector that fails 5 consecutive runs is paused and surfaced in admin rather than burning quota. | **N** |

### Epic C â€” Matching & Scoring

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| C1 | **Rule-based fit score (0â€“100)** | Weighted deterministic score: skills overlap, seniority match, compensation match, location/work-mode match, recency, company preference. Any hard-filter hit gates the score to 0. | **M** |
| C2 | **Semantic match score** | Embed the job description and the profile into pgvector; cosine similarity contributes to the final score. Catches skill adjacency and title drift (e.g. "Growth Marketer" â†” "Performance Marketing"). | **M** |
| C3 | **Score breakdown** | Every score stores a JSON breakdown of each component's contribution, rendered as a labelled bar in the UI. "Why 78?" must be answerable on screen. | **M** |
| C4 | **Batch rescoring** | When a profile changes, affected jobs are requeued for scoring rather than rescored synchronously. | **M** |
| C5 | **LLM fit rationale** | 2â€“3 sentence plain-English explanation of fit and gaps ("Strong on React/TypeScript; gap is the 5+ year Java requirement"). | **S** |
| C6 | **Feedback loop** | Save/dismiss/apply actions are recorded and used to adjust the user's implicit preference weights over time. | **N** |
| C7 | **Confidence & data-quality flag** | Jobs with missing salary or unparseable descriptions get a lower confidence flag rather than a misleadingly precise score. | **S** |

### Epic D â€” Discovery & Feed

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| D1 | **Ranked job feed** | Default dashboard: cards sorted by final score, newest-scanned first within score bands. | **M** |
| D2 | **Job detail view** | Full posting: description, canonical source link, source badge, salary, posted date, last-seen date, score breakdown, related same-job sightings. | **M** |
| D3 | **Filters & sort** | Filter by score band, work mode, location, salary, seniority, employment type, source, posted-since; sort by score / date / salary. | **M** |
| D4 | **Save / dismiss / mark applied** | One-click actions from card and detail view. Dismissed jobs never resurface; applied jobs jump into the tracker. | **M** |
| D5 | **Hide a duplicate cluster** | Collapse and dismiss all occurrences of a job at once. | **S** |
| D6 | **Keyboard navigation** | `j`/`k` move, `s` save, `x` dismiss, `o` open, `a` apply. Power users live here. | **N** |
| D7 | **"Only new since last visit" view** | Diff against the user's last-seen timestamp so returning users see exactly what changed. | **S** |

### Epic E â€” Application Tracker

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| E1 | **Application record** | Created on "mark applied": links the job + profile snapshot at time of application, stage, applied date, notes, rÃ©sumÃ© version. | **M** |
| E2 | **Stage pipeline** | `discovered â†’ saved â†’ applied â†’ screening â†’ interview â†’ offer â†’ rejected / withdrawn`. Drag or button to move. | **M** |
| E3 | **Stage history** | Every stage change is timestamped into an event log shown on the application's timeline. | **M** |
| E4 | **Dashboard stats** | Counts by stage, applications this week, response rate, days-in-stage averages. | **M** |
| E5 | **Follow-up reminders** | Set a `next_action_at` date; due items appear in a "Needs attention" panel. | **S** |
| E6 | **Bulk import from CSV** | Import an existing spreadsheet (company, title, url, stage, date). | **N** |

### Epic F â€” Alerts & Digests

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| F1 | **Daily digest email** | Top N (default 10) matches since last digest, each with score, one-line rationale, and a deep link. Skipped when there's nothing new. | **M** |
| F2 | **Saved searches** | Named query + filters the user can re-run and subscribe to. | **M** |
| F3 | **Digest scheduling & preferences** | Per-user send time, weekday selection, max items, mute. | **S** |
| F4 | **High-match alert** | Instant email when a job scores above the user's alert threshold (default 90). Rate-limited to one per hour. | **S** |
| F5 | **Slack digest** | Post the digest to a Slack webhook instead of / alongside email. | **N** |

### Epic G â€” Monetisation & Gating

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| G1 | **Plan definitions** | Free vs Pro limits (sources watched, jobs scored/month, saved searches, digest frequency, LLM rationale). | **S** |
| G2 | **Usage metering** | Per-user counters per billing period for the gated actions. | **S** |
| G3 | **Stripe checkout & subscription** | Checkout session, webhook-driven entitlement updates, customer portal for cancel/change. | **S** |
| G4 | **Upgrade prompts** | Inline, non-blocking limit notices that explain what unlocking does. | **S** |

### Epic H â€” Operations & Quality

**Last reviewed:** 2026-10-04


| # | Feature | Description | Priority |

**Last reviewed:** 2026-10-04

|---|---|---|---|
| H1 | **Task queue** | Durable queue for scrape / score / digest work with retry and backoff, so a slow API never blocks the app. | **M** |
| H2 | **Admin console** | Source health, recent run log, queue depth, failure list, user lookup (no content access by default). | **M** |
| H3 | **Structured logging & error tracking** | Correlated request/run IDs, Sentry for exceptions, product analytics for funnels. | **M** |
| H4 | **Data deletion / export** | User-triggered account export (JSON) and account deletion that cascades correctly. | **S** |
| H5 | **A/B-safe config** | Feature flags for scoring weights so weights can be tuned without deploys. | **N** |

---

## 5. App Flow

**Last reviewed:** 2026-10-04


### Flow 0 â€” Landing â†’ signup (cold start)

**Last reviewed:** 2026-10-04


1. User lands on the marketing home page: headline, 30-second explainer, "See a live sample feed" (public read-only demo feed), primary CTA **Start free**.
2. Clicks **Start free** â†’ sign-up sheet.
3. Chooses **Continue with Google** or **Enter email**.
   - Google â†’ provider consent â†’ session created â†’ straight to onboarding.
   - Email â†’ magic link sent â†’ "Check your inbox" screen â†’ clicks link â†’ session created â†’ onboarding.
4. *Edge:* returning user with an existing session skips sign-up and lands on their dashboard.

### Flow 1 â€” Onboarding wizard (target: under 3 minutes)

**Last reviewed:** 2026-10-04


Landing screen shows **"Let's find out what a good job looks like for you"** with a 4-step progress rail.

- **Step 1 â€” Role & seniority.** Target titles (multi-select, free text allowed), seniority level, years of experience.
  *Buttons:* `Continue` (disabled until â‰¥1 title), `Skip for now` (uses defaults, flags profile as incomplete).
- **Step 2 â€” Skills.** Searchable chip picker over the canonical skill list + free-text add. Per-skill proficiency (Familiar / Proficient / Expert).
  *Buttons:* `Continue` (disabled until â‰¥3 skills), `Back`.
- **Step 3 â€” Logistics.** Country/region â†’ remote preference (Remote / Hybrid / On-site / Any) â†’ hybrid days acceptable â†’ minimum compensation + currency + period â†’ visa sponsorship required (Yes/No/No preference).
  *Buttons:* `Continue`, `Back`.
- **Step 4 â€” Dealbreakers.** Blocked companies (typeahead), excluded keywords, "anything else we should never show you."
  *Buttons:* `Finish & build my feed`, `Back`.

**On Finish:**
5. Profile saved. `onboarding_completed = true`.
6. A **first ingestion run** is enqueued immediately for the default source set.
7. **Interstitial:** "Building your feedâ€¦" with a live progress line (sources scanned / jobs found / jobs scored). Polls every 1.5s. This screen is doing real work â€” it must not be a fake loader.
8. Redirect to **Dashboard**.

*Edge:* user abandons at any step â†’ progress saved; next login resumes at the unfinished step with a banner.

### Flow 2 â€” Daily use (the core loop)

**Last reviewed:** 2026-10-04


9. User opens the app â†’ **Dashboard** shows: greeting, "12 new since yesterday", top-ranked job cards, and a **Needs attention** panel (follow-ups due, digest pending).
10. Scans card titles + score badges. Clicks a card â†’ **Job Detail**.
11. Job Detail shows: score + expandable breakdown, LLM rationale *(Pro)*, full description, salary, source badge + "View original", posted / last-seen dates, company block.
12. Decides:
    - **Not relevant** â†’ `Dismiss` â†’ returns to feed, card animates out, never resurfaces.
    - **Interested** â†’ `Save` â†’ card moves to *Saved* stage; user returns to feed.
    - **Applying** â†’ `Mark applied` â†’ **Apply modal**: applied date, rÃ©sumÃ© version (optional), notes, follow-up date â†’ `Confirm` â†’ application record created in *Applied* stage â†’ toast + confetti-free confirmation.
13. Repeats for the next 2â€“5 cards. Whole session target: **under 5 minutes.**
14. Leaves. Digest handles the rest.

### Flow 3 â€” Tracker review

**Last reviewed:** 2026-10-04


15. User clicks **Applications** in the sidebar.
16. Sees **Kanban** (or list) by stage: counts per column, WIP badges.
17. Drags `Acme Corp` from *Applied* â†’ *Interview*. Stage history entry written automatically.
18. Clicks an application â†’ drawer with timeline (applied â†’ screening â†’ interview), notes, follow-up date, original posting.
19. **Needs attention** surfaces anything with `next_action_at` â‰¤ today.

### Flow 4 â€” Tuning the feed

**Last reviewed:** 2026-10-04


20. User clicks **Saved searches** â†’ `New search`.
21. Enters query + filters (location, salary floor, seniority, sources) â†’ preview shows count + top 5 with scores.
22. `Save` â†’ named search stored, subscription toggle on.
23. From any job card, "Don't show me this" style exclusions (company / keyword) write back into **Dealbreakers** â€” tuning happens *in context*, not only in settings.

### Flow 5 â€” Digest delivery (happens without the user)

**Last reviewed:** 2026-10-04


24. Cron at the user's configured send time â†’ fetches jobs scored since last digest, above threshold, excluding dismissed/applied.
25. Top N (default 10) rendered from an email template â†’ sent via Resend.
26. User clicks a job in the email â†’ deep link into Job Detail with a `utm`/source tag.
27. Nothing new â†’ no email is sent. *Silence is a feature.*

### Flow 6 â€” Limit reached â†’ upgrade

**Last reviewed:** 2026-10-04


28. Free user hits a gated action (e.g. 11th saved search, LLM rationale on a job).
29. **Inline** notice explains the limit and what Pro unlocks â€” never a modal ambush, never a blocked page.
30. Clicks **See Pro** â†’ pricing â†’ `Start Pro` â†’ Stripe Checkout â†’ success â†’ webhook updates entitlement â†’ returns to the originally attempted action, now completed.

### Flow 7 â€” Admin / ops

**Last reviewed:** 2026-10-04


31. Admin signs in â†’ `/admin` (role-gated at the layout level).
32. Views: source health tiles, last 50 scrape runs, queue depth, failures with retry button, user lookup.
33. Retries a failed run â†’ enqueued â†’ status updates live.

---

## 6. MVP Definition

**Last reviewed:** 2026-10-04


**MVP = everything marked `M` above.** In concrete terms:

**In the MVP**
- Magic-link + Google auth, complete onboarding, editable profile
- 7+ API connectors + Firecrawl generic scraper, scheduled runs, normalisation, dedup, freshness
- Rule + semantic scoring with a visible breakdown, batch rescoring
- Ranked feed, filters, job detail, save/dismiss/apply
- Application tracker with stages, history, and stats
- Saved searches + daily digest email
- Durable task queue, admin console, logging/error tracking
- Free-plan limits defined and enforced (even if plans aren't billed yet)

**Deliberately NOT building in version one**

| Not building | Why | When instead |
|---|---|---|
| **Auto-apply / form filling** | Highest value, highest brittleness and risk. Employer sites change weekly; failures damage trust and brand. | Phase 3, after the discovery loop is proven |
| **AI rÃ©sumÃ© & cover-letter generation** | Real quality bar, needs human review loops; also a content-policy minefield. | Phase 2 |
| **Employer side / job board marketplace** | A two-sided product. Doubles the surface area for zero benefit to the seeker. | Only if a clear wedge appears |
| **RÃ©sumÃ© builder / parsing** | Adjacent problem, well-solved elsewhere. We only store PDFs. | Never (integrate instead) |
| **Native mobile apps** | Responsive web covers the daily check-in. Native is a big cost for a habit we haven't proven. | After retention is proven |
| **Team / coach seats, shared trackers** | Collaboration is a different product. | Phase 3 |
| **Browser extension** | Great for capture, but manual capture is a workaround for a scraping gap we should close properly. | Phase 2 (bookmarklet first) |
| **Calendar / interview scheduling** | Nice, not load-bearing. | Phase 3 |
| **Multi-language job parsing & UI** | English-first; schema keeps the door open. | Where demand shows up |
| **Public SEO job pages** | SEO play needs content and legal review of republished listings. | Deliberately deferred |
| **Support live chat / onboarding calls** | Doesn't scale pre-PMF. Email + docs. | â€” |

---

## 7. Success Metrics

**Last reviewed:** 2026-10-04


### North-star metric

**Last reviewed:** 2026-10-04


> **Weekly Meaningful Actions per Active User (WMA)**
> A "meaningful action" = a job saved, applied to, dismissed, or a stage advanced.
> **Target: â‰¥ 7/week by week 8 post-launch.**

Rationale: it's the only number that rises when the product is genuinely shortening the user's week. Signups and page views don't.

### Metric tree

**Last reviewed:** 2026-10-04


**â‘  Activation (does setup produce value?)**

| Metric | Definition | Target |
|---|---|---|
| Onboarding completion | % of signups finishing all 4 steps | â‰¥ 65% |
| Time to first relevant job | Signup â†’ first job scored â‰¥ 70 | < 5 min |
| Activation rate | % with profile complete **and** â‰¥10 scored jobs within 24h | â‰¥ 55% |
| First-session depth | Jobs reviewed in session 1 | â‰¥ 8 |

**â‘¡ Engagement (is the loop being used?)**

| Metric | Definition | Target |
|---|---|---|
| WAU / MAU | Weekly active Ã· monthly active | â‰¥ 45% |
| WMA per active user | See north star | â‰¥ 7 |
| Session length (returning) | Median | 3â€“7 min *(longer â‰  better)* |
| Feed â†’ detail CTR | Detail opens Ã· feed impressions | â‰¥ 35% |
| Detail â†’ save/apply/dismiss | Actions Ã· detail opens | â‰¥ 60% |
| Untouched matches | Jobs surfaced, never opened, in 7 days | < 30% |

**â‘¢ Quality (is the ranking any good?)**

| Metric | Definition | Target |
|---|---|---|
| Save rate by score band | Save rate for 85+ vs below 50 | â‰¥ **5Ã—** lift *(validates the scoring)* |
| Dismiss-without-open rate | Dismissed without opening detail | < 15% |
| Duplicate complaint rate | Users hiding duplicate clusters Ã· WAU | < 2% |
| Freshness | % of surfaced jobs seen in last 7 days | â‰¥ 95% |
| Source success rate | Successful scrape runs Ã· total | â‰¥ 97% |
| Scoring coverage | % of active jobs with a score | â‰¥ 98% |

**â‘£ Retention (does it become infrastructure?)**

| Metric | Definition | Target |
|---|---|---|
| D7 retention | Return within 7 days of signup | â‰¥ 40% |
| D30 retention | Active in week 4 | â‰¥ 25% |
| Digest open rate | Opens Ã· sends | â‰¥ 40% |
| Digest-driven session rate | Sessions starting from a digest link | â‰¥ 25% |
| Silent-week churn | No WMA in 14 days | < 10% of MAU |

**â‘¤ Outcome (did they get the job?)**

| Metric | Definition | Target |
|---|---|---|
| Applications per user / week | Tracked applications created | 3â€“8 *(too high suggests spam)* |
| Response rate | Applications reaching `screening` or beyond | â‰¥ 15% |
| Time-to-first-interview | Signup â†’ first `interview` stage | < 21 days |
| Self-reported outcome | Quarterly "did this help?" pulse | â‰¥ 70% positive |

**â‘¥ Business (does it sustain?)**

| Metric | Definition | Target |
|---|---|---|
| Free â†’ Pro conversion | Paid Ã· active free at day 30 | â‰¥ 4% |
| MRR | â€” | Track, no target pre-PMF |
| Gross margin on Pro | Revenue Ã· (Firecrawl + LLM + egress cost) | â‰¥ 70% |
| Cost per active user / month | Infra + API spend Ã· MAU | < $1.50 free tier |
| CAC payback (if paid acquisition) | â€” | > 6 months = pause channels |

**â‘¦ Reliability & trust**

| Metric | Definition | Target |
|---|---|---|
| p95 dashboard load | LCP on the feed | < 2.0s |
| Ingestion lag | Posting published â†’ available to rank | < 6h |
| Error rate (5xx) | Server errors Ã· requests | < 0.5% |
| Unsubscribe rate (digest) | Unsubs Ã· sends | < 0.5% / month |

### How we'll know it's failing

**Last reviewed:** 2026-10-04


**Leading indicators of trouble** â€” any two together triggers a review:
- Onboarding completion < 40% â†’ setup is too long or the value isn't clear up front.
- Save rate does **not** differ across score bands â†’ scoring is decorative; fix before adding features.
- D7 < 25% â†’ either results are poor or the habit isn't being established.
- Untouched matches > 50% â†’ the feed is too long; cut volume before adding sources.
- Digest open rate < 25% â†’ subject lines/content are noise; users are learning to ignore us.

### Measurement plan

**Last reviewed:** 2026-10-04


- **Product analytics:** PostHog â€” pageviews, `signup_completed`, `onboarding_step_completed`, `job_viewed`, `job_saved`, `job_dismissed`, `application_created`, `application_stage_changed`, `digest_opened`, `paywall_viewed`, `subscription_started`.
- **Backend metrics:** scrape-run table + queue depth + Sentry; exposed as admin dashboard tiles.
- **Weekly review:** one page, seven numbers â€” activation rate, WMA/user, save-rate lift, D7, source success, response rate, cost/MAU.

---

## 8. Assumptions & Risks

**Last reviewed:** 2026-10-04


| # | Assumption / Risk | Mitigation |

**Last reviewed:** 2026-10-04

|---|---|---|
| R1 | Job sources may change markup or rate limits without notice. | Connector isolation per source; schema-driven Firecrawl extraction; circuit breaker pauses failing sources (H-something â†’ B10). |
| R2 | Aggregators / scraped boards may restrict reuse. | **Prefer official/public ATS APIs first**; Firecrawl only on public career pages; keep a legal review checkpoint before launch; no LinkedIn/Indeed direct scraping. |
| R3 | Scraping quality varies; bad parses create junk feed items. | Confidence flag (C7), quarantine on parse failure, admin review queue. |
| R4 | Scoring feels arbitrary â†’ users lose trust. | Visible breakdown (C3) is a **must**, not a nice-to-have. |
| R5 | API/LLM costs scale with success. | Per-plan quotas (G1/G2), Firecrawl only for sources without APIs, `:free` OpenRouter models for rationale only, batch embedding. |
| R6 | Digest fatigue â†’ churn. | Skip-if-empty, user cadence controls, mute, hard unsubscribe in one click. |
| R7 | Users won't trust us with their rÃ©sumÃ©. | RÃ©sumÃ© storage is `S`, never required for activation; clear deletion (H4). |

---

## 9. Open Questions

**Last reviewed:** 2026-10-04


1. Do we launch with **Stripe billing live**, or with plans defined but unmetered (growth-mode launch)?
2. Company watchlist: fetch a company's ATS feed on-demand (per-user) or globally shared across all users? *(Architecture assumes globally shared with per-user subscription.)*
3. Should the demo/feed preview on the marketing page be a **static curated set** or a live read-only feed?
4. Score threshold for high-match alerts: fixed at 90, or user-configurable from day one?

---

*End of PRD. Build order and per-ticket acceptance criteria live in [05 Feature Ticket List](./05-feature-ticket-list.md).*

