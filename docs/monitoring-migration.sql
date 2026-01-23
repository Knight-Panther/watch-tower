-- Telemetry for feed fetch runs + TTL config for monitoring.

create table if not exists feed_fetch_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references rss_sources(id),
  status text not null check (status in ('success', 'error')),
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,
  item_count integer,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_feed_fetch_runs_source_created
  on feed_fetch_runs(source_id, created_at desc);

create index if not exists idx_feed_fetch_runs_created
  on feed_fetch_runs(created_at desc);

insert into app_config (key, value)
values ('feed_fetch_runs_ttl_hours', '336')
on conflict (key) do nothing;
