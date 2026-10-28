-- 0016_application_job_fk_set_null.sql — make `job_snapshot` mean what X-16 says it means.
--
-- ## The conflict
--
-- `mark-applied.ts` documents X-16:
--
--   `job_snapshot` captures title/company/salary/source so the tracker keeps rendering the role
--   after the source deletes it or the job expires.
--
-- That was not achievable while the foreign key cascaded. `applications` (0001) declared:
--
--   job_id uuid not null references jobs(id) on delete cascade
--
-- so hard-deleting a job deleted the **application row itself**. The snapshot had nothing left to
-- render in. Found while writing `tests/e2e/tracker.spec.ts`: the obvious test — delete the job,
-- expect the card to survive from its snapshot — failed against a board that was behaving exactly
-- as the schema specified.
--
-- This never showed up in normal operation because production never hard-deletes a job. Freshness
-- moves `jobs.status` to `expired` (`lib/ingest/freshness.ts`, the `cleanup` task kind), and the
-- row survives. Only an explicit `DELETE` reached the cascade — which is precisely why the conflict
-- sat in the schema unnoticed while the documentation promised the opposite behaviour.
--
-- ## The change
--
-- `on delete cascade` -> `on delete set null`, and `job_id` becomes nullable. The nullability is not
-- optional: PostgreSQL rejects `ON DELETE SET NULL` on a `NOT NULL` column, and dropping the
-- constraint while keeping `not null` would leave the delete failing.
--
-- No row is modified. Every existing application keeps its `job_id`; the change only relaxes what
-- the database is allowed to do later.
--
-- ## What this does and does not change
--
-- `job_snapshot` is already `jsonb not null`, so a snapshot-only row always carries the fields the
-- board renders. `queryApplications` embeds `jobs(...)` and falls back to the snapshot when the
-- embed is null, which is the branch this migration makes reachable.
--
-- `unique (user_id, job_id)` still prevents two applications for the same *live* job. It stops
-- constraining rows whose `job_id` is NULL, because PostgreSQL treats NULLs as distinct in a unique
-- index. That is acceptable rather than incidental: once the job is gone there is no second
-- "same job" to collide with, and the row is a historical record of an application, not a claim on
-- a live job.
--
-- `v_ranked_jobs`'s `applied` flag is `exists (select 1 from applications a where a.job_id = j.id
-- and a.user_id = auth.uid())`. For a snapshot-only row that comparison is NULL, which is not true,
-- so it is excluded — which is the desired semantics. It must not mark some *other* live job as
-- applied just because a user once applied to a deleted one.
--
-- `idx_applications_job_id` is unaffected and still serves the non-null lookups in
-- `job-detail.ts`, `sightings.ts` and the three feed actions, all of which filter by a job id the
-- caller already holds.

alter table public.applications
  alter column job_id drop not null;

alter table public.applications
  drop constraint if exists applications_job_id_fkey;

alter table public.applications
  add constraint applications_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete set null;

comment on column public.applications.job_id is
  'The job this application is for. Nullable: on delete set null, so deleting a job leaves the application standing and job_snapshot carries the display fields. NOT NULL would make on delete set null impossible and would silently re-cascade the application away, defeating X-16.';

comment on column public.applications.job_snapshot is
  'Display fields captured at apply time (title/company/salary/source). This is the fallback the tracker renders when job_id is null because the job has been deleted.';