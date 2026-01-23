-- Watch Tower: Initial Schema
-- Sectors, RSS Sources, Feed Items, Fetch Runs, App Config

-- Sectors: group sources by domain/topic
create table sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  default_max_age_days smallint not null default 5
    check (default_max_age_days between 1 and 15),
  created_at timestamptz not null default now()
);

-- RSS Sources: individual feed URLs
create table rss_sources (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  name text,
  active boolean not null default true,
  sector_id uuid references sectors(id) on delete set null,
  max_age_days smallint check (max_age_days between 1 and 15),
  ingest_interval_minutes smallint not null default 15
    check (ingest_interval_minutes between 1 and 4320),
  created_at timestamptz not null default now(),
  last_fetched_at timestamptz
);

-- Feed Items: parsed RSS entries
create table feed_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references rss_sources(id) on delete set null,
  url text not null unique,
  title text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  raw jsonb
);

create index idx_feed_items_source_published
  on feed_items(source_id, published_at desc);

-- Feed Fetch Runs: telemetry for monitoring
create table feed_fetch_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references rss_sources(id) on delete cascade,
  status text not null check (status in ('success', 'error')),
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,
  item_count integer,
  error_message text,
  created_at timestamptz not null default now()
);

create index idx_feed_fetch_runs_source_created
  on feed_fetch_runs(source_id, created_at desc);

create index idx_feed_fetch_runs_created
  on feed_fetch_runs(created_at desc);

-- App Config: key-value store for TTLs and settings
create table app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Default TTL configurations
insert into app_config (key, value) values
  ('feed_items_ttl_days', '60'),
  ('feed_fetch_runs_ttl_hours', '336');
