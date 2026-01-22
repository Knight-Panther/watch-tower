-- Add sector support and per-source max age

create table if not exists sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  default_max_age_days smallint not null default 5 check (default_max_age_days between 1 and 15),
  created_at timestamptz not null default now()
);

alter table rss_sources
  add column if not exists sector_id uuid references sectors(id),
  add column if not exists max_age_days smallint check (max_age_days between 1 and 15),
  add column if not exists ingest_interval_minutes smallint check (ingest_interval_minutes between 1 and 4320);

create unique index if not exists rss_sources_url_unique on rss_sources (url);

alter table sectors
  add column if not exists ingest_interval_minutes smallint check (ingest_interval_minutes between 1 and 4320);
