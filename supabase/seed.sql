-- Seed data for local development
-- Run via: supabase db reset

-- 1. Skills taxonomy (minimal starter set)
insert into skills (name, slug, aliases, category)
values
  ('TypeScript', 'typescript', array['ts'], 'language'),
  ('React', 'react', array['react.js', 'reactjs'], 'framework'),
  ('Next.js', 'nextjs', array['next', 'next.js'], 'framework'),
  ('PostgreSQL', 'postgresql', array['postgres', 'psql'], 'database'),
  ('Tailwind CSS', 'tailwindcss', array['tailwind'], 'css'),
  ('Python', 'python', array['py'], 'language'),
  ('AWS', 'aws', array['amazon web services'], 'cloud'),
  ('Docker', 'docker', array['containerization'], 'devops'),
  ('Kubernetes', 'kubernetes', array['k8s'], 'devops'),
  ('GraphQL', 'graphql', array['gql'], 'api')
on conflict (slug) do nothing;

-- 2. Default source configs (enabled = true means cron will pick them up)
insert into sources (name, kind, config, enabled, is_default, cadence_minutes)
values
  ('Greenhouse', 'api_greenhouse', '{"boards": []}', true, true, 60),
  ('Lever', 'api_lever', '{"boards": []}', true, true, 60),
  ('Ashby', 'api_ashby', '{"organizations": []}', true, true, 60),
  ('Remotive', 'api_remotive', '{}', true, true, 120),
  ('Arbeitnow', 'api_arbeitnow', '{}', true, true, 120),
  ('USAJOBS', 'api_usajobs', '{}', true, true, 180),
  ('Adzuna', 'api_adzuna', '{"countries": ["us", "gb", "ca", "au", "de"]}', true, false, 240),
  ('Firecrawl Search', 'firecrawl_search', '{"queries": ["software engineer remote", "frontend developer"]}', true, false, 360),
  ('Firecrawl Scrape', 'firecrawl_scrape', '{"urls": []}', true, false, 360)
on conflict (name) do nothing;

-- 3. Default scrape_runs will be created by the cron jobs on first run