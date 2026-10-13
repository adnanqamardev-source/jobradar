/**
 * /jobs/[id] — one job in full (FE-108, JOB-001, JOB-002, JOB-004).
 *
 * ## Why the id is validated before any query
 *
 * `notFound()` for a malformed uuid **before** touching the database. PostgREST answers an
 * unparseable uuid with `22P02 invalid_input_syntax`, so validating first is what makes a
 * hand-edited URL produce the same 404 as a real miss rather than a 500 — and JOB-001 requires
 * those two to be byte-identical. `queryJobDetail` also returns `null` on any `jobs` read
 * error, so a second line of defence sits behind the first.
 *
 * There is deliberately **no branch distinguishing "not yours" from "does not exist"**. `jobs`
 * is shared corpus (every authenticated user may read every row), so both cases arrive here as
 * "no row", and adding a separate message would be precisely the information leak the
 * criterion forbids.
 *
 * ## Structure only
 *
 * Phase 2 rule (docs/06 §8.4): semantic elements, real labels, heading order, no utility
 * classes. This page's heading order is h1 (title) → h2 (About / Score / Sources), and the
 * posting's own `h3`/`h4` sit inside the description — the sanitiser's allowlist cannot
 * introduce a second h1, so a scraped page cannot break the outline.
 *
 * ## What is deliberately absent
 *
 * The action row. FE-107's `JobCardActions` is scoped to a feed card (it carries the saved and
 * dismissed state the feed already knows), and wiring it here needs the detail page to own that
 * state — which is FE-107's own follow-up, not part of JOB-001's done-when list.
 */

import { notFound, redirect } from "next/navigation";

import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/require-user";
import { createUserClient } from "@/lib/db/user-client";
import { queryJobDetail } from "@/lib/db/queries/job-detail";
import { parseJobDescription } from "@/lib/sanitize/job-description";
import { formatDate, formatSalary } from "@/lib/utils/format";
import { JobDescription } from "@/components/job/description";
import { OriginalSource } from "@/components/job/original-source";
import { ScoreBreakdown } from "@/components/job/score-breakdown";

/** `job_events.event` has a check constraint; an arbitrary UUID is the only shape accepted here. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    // Same contract as /dashboard: an unauthenticated hit goes to /login with a return path,
    // and anything else is a real failure.
    if (AppError.isAppError(error) && error.code === "unauthenticated") {
      redirect(`/login?next=${encodeURIComponent("/jobs")}`);
    }
    throw error;
  }

  const { id } = await params;
  // Before the query, not after: see the header.
  if (!UUID_PATTERN.test(id)) notFound();

  const supabase = await createUserClient(user.accessToken);
  const detail = await queryJobDetail(supabase, id);
  if (detail === null) notFound();

  const { job, score, application, sightings } = detail;
  const salary = formatSalary(job);
  const nodes = parseJobDescription(job.description_html ?? job.description_text);
  const meta = [
    job.location_raw,
    job.employment_type,
    job.seniority,
    job.city,
    job.country_code,
  ].filter((value) => value != null && value !== "");

  return (
    <article aria-labelledby="job-title">
      <header>
        <h1 id="job-title">{job.title}</h1>
        <p>
          {job.company_name}
          {job.company_domain != null && ` — ${job.company_domain}`}
        </p>
        {meta.length > 0 && <p>{meta.join(" | ")}</p>}
        {salary != null && <p>{salary}</p>}
        {/*
          `last_seen_at` is named explicitly in JOB-001's first done-when: it is what tells a
          reader this posting is still being seen, as opposed to a stale copy from weeks ago.
        */}
        <p>
          Posted {formatDate(job.posted_at)} · last seen {formatDate(job.last_seen_at)}
          {job.status !== "active" && ` · ${job.status}`}
        </p>
        {job.sighting_count > 1 && (
          <p>
            Seen on {job.sighting_count} sources
          </p>
        )}
        {job.skills != null && job.skills.length > 0 && (
          <ul aria-label="Skills">
            {job.skills.map((skill) => (
              <li key={skill}>{skill}</li>
            ))}
          </ul>
        )}
      </header>

      {/*
        Rendered once, and it owns both the "View original" link and the sighting list,
        because JOB-004 makes them stateful together. Two copies would mean two independent
        selections disagreeing about which posting is current.
      */}
      <OriginalSource
        primaryUrl={job.source_url}
        applyUrl={job.apply_url}
        sightings={sightings}
      />

      {application && (
        <section aria-labelledby="application-heading">
          <h2 id="application-heading">Your application</h2>
          <p>
            Stage: {application.stage} · applied {formatDate(application.applied_at)}
          </p>
          {application.next_action_at && (
            <p>Next action: {formatDate(application.next_action_at)}</p>
          )}
          {application.notes && <p>{application.notes}</p>}
        </section>
      )}

      <section aria-labelledby="about-heading">
        <h2 id="about-heading">About this role</h2>
        <JobDescription nodes={nodes} />
      </section>

      {/*
        A job the caller has never been scored against is normal — it was ingested after their
        last rescore — so the breakdown is absent rather than rendered as a zero. A zero would
        claim the job is a terrible match, which is a different and false statement.
      */}
      {score ? (
        <ScoreBreakdown
          finalScore={score.final_score}
          ruleScore={score.rule_score}
          semanticScore={score.semantic_score}
          breakdown={score.breakdown}
          gateReasons={score.gate_result?.passed === false ? score.gate_result.reasons : null}
          explanation={score.explanation}
        />
      ) : (
        <section aria-labelledby="unscored-heading">
          <h2 id="unscored-heading">Match score</h2>
          <p>This job has not been scored against your profile yet.</p>
        </section>
      )}
    </article>
  );
}
