# 02b — Key Subsystems

**Product:** JobRadar · **Version:** 1.0 — MVP
**Parent:** [02 Technical Architecture](./02-technical-architecture.md) §6
**Last reviewed:** 2026-10-04

---

## 6. Key Subsystems

### 6.1 Connector interface (the plug-in point)

```ts
// src/lib/connectors/types.ts
export interface SourceConnector {
  readonly kind: SourceKind;              // matches sources.kind
  fetch(cfg: SourceConfig, ctx: RunCtx): AsyncIterable<RawJob>;
  readonly costClass: 'free' | 'metered' | 'firecrawl';
}

export interface RawJob {
  externalId: string;
  sourceUrl: string;
  applyUrl?: string;
  title: string;
  companyName: string;
  location?: string;
  salaryRaw?: string;
  postedAt?: string;      // ISO
  descriptionHtml?: string;
  descriptionText?: string;
  raw: unknown;           // untouched payload → jobs.raw
}
```

**Source priority order (PRD R2):**

| Tier | Sources | Basis |
|---|---|---|
| **1 — Official APIs** (use first) | Greenhouse Board, Lever Postings, Ashby Job Board, Remotive, Arbeitnow, USAJOBS | Public, documented, stable |
| **2 — Aggregators w/ keys** | Adzuna (salary-enriched), optional JSearch via RapidAPI | Rate-limited, quota-tracked |
| **3 — Firecrawl** | Career pages with no API; `firecrawl_search` discovery; `firecrawl_map` for sitemap discovery | Metered — reserve for Tier 1/2 gaps |

Firecrawl usage rules: always `formats: ["json"]` with an explicit extraction schema matching `RawJob`; `onlyMainContent: true`; per-source `maxAge` caching to avoid re-crawling unchanged pages; hard daily cap per plan.

**Connector contract tests** run against `tests/integration/fixtures/sources/{kind}.json` — CI never hits live APIs.

**Where this is implemented (BE-101, 2026-10-05).** `src/lib/connectors/types.ts` holds the
interface and `HTTP_DEFAULTS`; `http.ts` holds `fetchJson` — the single place a connector may touch
the network, carrying the §5.9 timeout/retry/error-mapping policy; `registry.ts` maps
`source_kind` → connector and throws naming the kind when one is missing. Three deliberate choices
the code depends on:

- `RawJob` is **not** defined in `connectors/types.ts`. The seam contract puts the schema in
  `src/types/canonical-job.ts` and derives the type from it (§8.1); the module re-exports it.
- `RunCtx` carries `fetch`, `now` and `sleep`, so a connector is testable against a fixture with a
  fake clock and no real waiting.
- `fetchJson` retries only 429 and 5xx (plus timeouts/network errors). A 4xx that is not 429 is the
  caller's fault — retrying it burns quota and hides a bad key.

### 6.2 Deduplication (two passes)

1. **Exact — `dedupe_hash`**
   `sha256(norm_title | norm_company_domain | norm_city | work_mode)` where `norm_*` lowercases, strips punctuation/legal suffixes (`Inc`, `Ltd`, `GmbH`) and collapses whitespace.
   Unique index → `insert … on conflict (dedupe_hash) do update set last_seen_at = now(), sighting_count = jobs.sighting_count + 1`.
2. **Fuzzy — trigram** (runs on newly inserted rows only)
   `similarity(title_norm, $t) > 0.85 AND company_domain = $d` → merge: keep the row with the richer `description_text`, increment `sighting_count`, record the loser's URL as an alternate sighting.

Same job from three sources = **one** feed card, with a "seen on N sources" chip (D5).

### 6.3 Scoring pipeline

```
gates (hard filters)      →  any hit?  final_score = 0, gate_result.reasons, HIDE from feed
                                    ↓ pass
rule score 0–100          →  skills 35 · seniority 15 · compensation 15
                             location/work-mode 15 · recency 10 · company pref 10
semantic score 0–100      →  cosine(job.embedding, profile.embedding)
final = 0.5·rule + 0.5·semantic     (weights from lib/scoring/weights.ts, flag-overridable)
                                    ↓
breakdown JSON            →  stored, rendered as the labelled bar in the UI (C3)
                                    ↓ (Pro, separate task)
LLM rationale 2–3 sentences →  job_scores.explanation
```

- **Gates** (`lib/scoring/gates.ts`): blocked company · excluded keyword in title/description · work-mode not in `profile.work_modes` · `salary_max < min_salary` when disclosed · seniority above `target` by >1 band.
- **Triggers:** profile save → `rescore_profile` task (requeue, never synchronous — C4); new/updated job → `score_jobs` task batched per profile.
- **Freshness:** cron flips `active → stale` at 14 days unseen, `stale → expired` at 28 (B6).

### 6.4 Queue execution model

- Vercel Cron hits `/api/cron/process` every minute with `CRON_SECRET`.
- Worker claims ≤ 25 tasks (`FOR UPDATE SKIP LOCKED`), runs each in a try/catch with a 5-minute lease.
- Failure → `attempts += 1`, `run_after = now() + 2^n seconds` (n = attempts), status back to `pending`; at `max_attempts` → `failed` + `audit_logs` entry + admin surface.
- Idempotency: every handler is safe to re-run (upserts keyed by unique constraints, digests keyed by `digests.scheduled_for`).
- Vercel function timeouts are respected by **batch size, not long-running loops** — if a batch is incomplete, the handler re-enqueues itself.

**Where these rules are implemented.** The protocol above lives in `src/lib/queue/plan.ts`
(`planClaim`, `settleTask`, `backoffFor`, `needsAuditLog`) with its constants in
`src/lib/queue/constants.ts`. Both `scripts/queue-drain.ts` and `src/app/api/cron/process/route.ts`
are **executors** of that plan — neither decides anything. `plan.ts` is pure: it takes tasks
and an injected clock, so the whole protocol is unit-testable without Postgres, and the
"run twice, assert one row" obligation above can be tested directly.

Two consequences worth stating, because both were bugs once:

- `attempts` increments on **failure**, never on claim. Incrementing at claim burns a retry
  on every success.
- The 5-minute lease is written to `locked_at`/`locked_by` **only**. `run_after` carries
  backoff scheduling alone — since the claim orders by `run_after`, storing a lease there
  would make one column carry two clocks. `n` in `2^n` is the **post-increment** value, so
  the first failure waits `2^1 = 2s`.

**Where the claim is implemented (FND-002, 2026-10-06).** `FOR UPDATE SKIP LOCKED` cannot be
expressed through `supabase-js` — its query builder composes select/update calls and has no
way to attach either clause to a read — so the only way to get the specified primitive is an
RPC. `supabase/migrations/0009_claim_task_queue.sql` creates
`public.claim_tasks(p_worker_id, p_limit, p_kind, p_lease_seconds)`, which selects candidates
`for update skip locked` ordered by `priority, run_after` and stamps `locked_at`/`locked_by`.
It is `security definer` because `task_queue` has RLS enabled **and forced**; EXECUTE is
revoked from `anon` and `authenticated` explicitly, because Supabase's default privileges
grant EXECUTE per role and a PUBLIC-only revoke is a no-op (the lesson from `0008`).

The function **performs** the claim but decides nothing. Consistent with the two rules above,
it does not increment `attempts` and does not touch `run_after` on a fresh claim; both belong
to `settleTask`/`planClaim`.

**Lease reaping lives in the same function, deliberately.** A worker killed mid-task leaves
its row `running` forever, and `planClaim` skips any row that is not `pending`, so a reaper
outside the claim transaction could not hand an orphan back in time. Each `claim_tasks` call
therefore first returns `running` rows whose lease is older than `p_lease_seconds` to
`pending` (clearing the lease and setting `run_after = now()` so the task is immediately
due). Only *expired* leases are touched — a row a live worker holds keeps its lease.

**Handler dispatch is BE-108.** Until `src/lib/queue/handlers/*` exists, a claimed task has
nothing to run. `queue-drain.ts` releases it back to `pending` with an explanatory
`last_error` rather than marking it `done`, so a drained row stays visible and retryable
instead of being falsely complete.

### 6.5 Digest

Daily `pg_cron` → `send_digest` tasks partitioned by `time_zone` → handler selects `job_scores` for that user where `final_score >= alert_threshold`, `job_id` not dismissed/applied, `scored_at > last_digest_at`, ordered by score, limit 10 → renders React Email → Resend → writes `digests` row. **Zero results → `status = 'skipped'`, no email.**

### 6.6 Normalisation (RawJob → CanonicalJob)

**Added 2026-10-04.** Described here rather than inline in the data flow (§3.1 step 5) because
two of its rules are easy to get wrong and expensive to get wrong quietly: the Indian salary
notation and the India-vs-worldwide remote distinction. `src/lib/ingest/normalize.ts`; every
function is pure and deterministic.

**Order matters, and it is the opposite of what reads naturally.**

1. **`remote_scope` before country resolution.** India-specific phrases are matched *first*,
   so `"Remote - India (Worldwide)"` resolves to `india`. A generic remote check first would
   match `worldwide` and hand an India-only role to the global bucket.
2. **Lakh/crore before the number scan.** `15L` and `15,00,000` are *scaled* figures. Running
   the generic number pattern first reads `15L` as `15` — off by 100,000× — and
   `\d{1,3}(,\d{3})*` cannot match Indian `3-2-3` grouping at all, silently truncating
   `15,00,000` to `15`. The scan therefore matches any comma-grouped run and strips separators.

| Input | Output | The trap |
|---|---|---|
| `₹15,00,000 per year` | `1500000 INR / year` | western grouping regex → `15` |
| `15L per year` | `1500000 INR / year` | number scan → `15` |
| `1.2 Cr` | `12000000 INR / year` | suffix not resolved before the scan |
| `Remote - India` | `scope india`, `country IN` | country only appears in parentheses in some sources |
| `Remote - Worldwide` | `scope global`, `country null` | "worldwide" is **not** a country |
| `Bangalore, India` | `city Bangalore`, `IN` | 2-part form, not 3 |

**`remote_scope` is not derivable from `work_mode`, and `country_code` is not a substitute.**
`work_mode = 'remote'` is true for both `india` and `global` scopes; `country_code` is null for
genuinely worldwide roles. Filtering an Indian candidate's feed needs the scope column
specifically — see [02a](./02a-schema.md) §5.2 and §5.4.

**One parser per concern, shared across call sites.** Résumé extraction reuses this module's
`parseSalary` and `parseLocation` rather than keeping its own. That is not tidiness: an earlier
draft had two salary parsers, the résumé one lacking Indian grouping, and they disagreed on
`₹15,00,000` in the same codebase. `notes.md` records the general failure — two definitions of
one thing will drift.

---
