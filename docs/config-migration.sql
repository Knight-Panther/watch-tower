-- App configuration table

create table if not exists app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_config (key, value)
values ('feed_items_ttl_days', '60')
on conflict (key) do nothing;

insert into app_config (key, value)
values ('feed_fetch_runs_ttl_hours', '336')
on conflict (key) do nothing;
