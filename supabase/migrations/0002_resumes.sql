-- 0002_resumes.sql — Resume storage and extraction tracking (BE-314)
-- Depends on: 0001_init.sql
-- Run via: supabase db reset (or supabase db push for incremental)

-- ===================================================================
-- resumes table
-- ===================================================================
-- Stores metadata and extraction results for user-uploaded resumes.
-- The actual file is stored in Supabase Storage (private `resumes` bucket);
-- this row tracks the file path, parsing status, and extracted data.

create table if not exists resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  file_path text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes integer not null check (size_bytes > 0),
  parsed_json jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  confidence numeric(3,2) check (confidence >= 0 and confidence <= 1),
  extracted_at timestamptz,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes
create index if not exists idx_resumes_user_id on resumes (user_id);
create index if not exists idx_resumes_status on resumes (status);
create index if not exists idx_resumes_created_at on resumes (created_at desc);

-- ===================================================================
-- RLS policies for resumes
-- ===================================================================
-- Users can only access their own resumes. No public access.

alter table resumes enable row level security;
alter table resumes force row level security;

-- Users can read their own resumes
create policy "resumes_select_own" on resumes
  for select using (user_id = (select auth.uid()));

-- Users can insert their own resumes
create policy "resumes_insert_own" on resumes
  for insert with check (user_id = (select auth.uid()));

-- Users can update their own resumes (e.g. after parsing completes)
create policy "resumes_update_own" on resumes
  for update using (user_id = (select auth.uid()));

-- Users can delete their own resumes
create policy "resumes_delete_own" on resumes
  for delete using (user_id = (select auth.uid()));

-- ===================================================================
-- Storage bucket for resumes (private)
-- ===================================================================
-- Note: Bucket creation via SQL is not supported in all Supabase versions.
-- Create the bucket via the Supabase dashboard or CLI:
--   supabase storage buckets create resumes --public=false
-- Then apply the storage policies below.

-- Storage policies (apply after bucket creation)
-- Users can upload to their own folder
create policy "resumes_storage_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Users can read their own files
create policy "resumes_storage_select_own" on storage.objects
  for select using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Users can update their own files
create policy "resumes_storage_update_own" on storage.objects
  for update using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Users can delete their own files
create policy "resumes_storage_delete_own" on storage.objects
  for delete using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ===================================================================
-- updated_at trigger
-- ===================================================================
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger resumes_updated_at
  before update on resumes
  for each row
  execute function update_updated_at_column();
