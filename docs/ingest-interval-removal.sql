-- Remove global and sector ingest intervals; keep only per-source interval.

delete from app_config where key = 'ingest_interval_minutes';

alter table sectors
  drop column if exists ingest_interval_minutes;

-- Ensure every source has a per-source interval before enforcing NOT NULL.
-- Update the value below to your preferred default if needed.
update rss_sources
  set ingest_interval_minutes = 15
  where ingest_interval_minutes is null;

alter table rss_sources
  alter column ingest_interval_minutes set not null;
