/**
 * job-card.tsx — one ranked job in the feed (FED-001, card anatomy docs/04 §3.3).
 *
 * ## What renders
 *
 * Company, score badge (via ScoreMeter), title (linked to the detail page),
 * meta row (location · type · seniority), salary, skill chips, source count,
 * posted date, and the action row (FE-107). Everything is semantic HTML:
 * `<article>`, `<h3>`, `<ul>` for chips — no utility classes, no div-soup.
 */

import Link from "next/link";

import type { FeedRow } from "@/lib/db/queries/feed";
import type { ResumeVersion } from "@/lib/db/queries/resume-versions";
import { formatDate, formatSalary } from "@/lib/utils/format";
import { JobCardActions } from "./job-card-actions";
import { ScoreMeter } from "./score-meter";

export function JobCard({
  job,
  resumeVersions,
}: {
  job: FeedRow;
  resumeVersions: ResumeVersion[];
}) {
  const salary = formatSalary(job);

  return (
    <article aria-labelledby={`job-${job.id}-title`}>
      <header>
        <span>{job.company_name}</span>
        {/*
          FED-005: a job seen on more than one source says so on the card. The
          full per-source list lives on the detail page (JOB-004).
        */}
        {job.sighting_count > 1 && <span>Seen on {job.sighting_count} sources</span>}
      </header>

      <h3 id={`job-${job.id}-title`}>
        <Link href={`/jobs/${job.id}`}>{job.title}</Link>
      </h3>

      <p>
        {[job.location, job.employment_type, job.seniority].filter(Boolean).join(" | ")}
      </p>

      {salary != null && <p>{salary}</p>}

      {job.skills.length > 0 && (
        <ul aria-label="Skills">
          {job.skills.map((skill) => (
            <li key={skill}>{skill}</li>
          ))}
        </ul>
      )}

      <ScoreMeter score={job.final_score} />

      <p>Posted {formatDate(job.posted_at)}</p>

      {/*
        FE-107: Save / Dismiss with optimistic update + rollback + alert
        toast, plus the FE-110 apply dialog. `sightingCount` decides whether
        Dismiss is labelled "Hide all of these" — a cluster is one `jobs` row
        (dedupe_hash is UNIQUE), so there is nothing else to hide, and saying
        so is what makes the cluster scope legible.
      */}
      <JobCardActions
        jobId={job.id}
        jobTitle={job.title}
        sightingCount={job.sighting_count}
        resumeVersions={resumeVersions}
        initialState={{ saved: job.saved, dismissed: job.dismissed }}
      />
    </article>
  );
}
