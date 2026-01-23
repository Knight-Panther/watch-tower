-- Minimal schema for RSS ingestion (dev/prototype)

create table if not exists sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  default_max_age_days smallint not null default 5 check (default_max_age_days between 1 and 15),
  created_at timestamptz not null default now()
);

create table if not exists rss_sources (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  name text,
  active boolean not null default true,
  sector_id uuid references sectors(id),
  max_age_days smallint check (max_age_days between 1 and 15),
  ingest_interval_minutes smallint check (ingest_interval_minutes between 1 and 4320),
  created_at timestamptz not null default now(),
  last_fetched_at timestamptz
);

create table if not exists feed_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references rss_sources(id),
  url text not null unique,
  title text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  raw jsonb
);

create index if not exists idx_feed_items_source_published
  on feed_items(source_id, published_at desc);
