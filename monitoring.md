# Monitoring Panel Implementation Guide

## Goal
Provide a simple, reliable monitoring panel that answers:
- Are scheduled fetches running on time?
- Are sources successfully ingesting new items?
- Which sources or sectors are stale or erroring?
- What is the current queue backlog?

The monitoring data must reflect the *actual ingestion path* in this codebase:
- `maintenance:schedule` creates repeatable feed jobs.
- `feed:process` performs RSS parsing and inserts into `feed_items`.
- `ingest:poll` is manual and does not represent ongoing schedule health.

## Strategy
Use **persistent telemetry for every feed fetch run**, stored in Supabase, with a **project-side TTL cleanup** driven by the existing maintenance job. This preserves short-term history for troubleshooting and enables a simple stats API without heavy queue inspection on the client.

Why:
- Current tables do not record per-fetch success/failure.
- `last_fetched_at` is only updated by manual ingest, so it is not a reliable indicator.
- Storing per-run telemetry enables "stale" detection, error tracking, and throughput metrics.

Note:
- Expected intervals are **source-only** (no sector/global fallbacks).

## Data Model Additions
Create a new table to capture each fetch run.

Suggested table: `feed_fetch_runs`
Fields:
- `id` uuid primary key default `gen_random_uuid()`
- `source_id` uuid references `rss_sources(id)`
- `status` text not null check (`success`, `error`)
- `started_at` timestamptz not null
- `finished_at` timestamptz
- `duration_ms` integer
- `item_count` integer
- `error_message` text
- `created_at` timestamptz not null default now()

Indexes:
- `source_id, created_at desc`
- `created_at` (to support TTL cleanup)

Config:
- Add `feed_fetch_runs_ttl_hours` to `app_config` with a default (e.g., 336).
- Allow override via `.env` if desired, or rely on `app_config` only.

## Backend Implementation Steps

### 1) Telemetry write in `feed` worker
File: `packages/worker/src/processors/feed.ts`
- At job start, record `started_at`.
- On success, insert a `feed_fetch_runs` row with:
  - `status = "success"`
  - `started_at`, `finished_at`, `duration_ms`
  - `item_count = items inserted`
- On parse failure, insert a `feed_fetch_runs` row with:
  - `status = "error"`
  - `error_message`
  - `started_at`, `finished_at`, `duration_ms`
- Consider writing `item_count = 0` for empty parses.

Rationale:
This is the only place that reflects real ingestion, so it must own telemetry.

### 2) TTL cleanup in maintenance job
File: `packages/worker/src/processors/maintenance.ts`
- Add a new config fetch for `feed_fetch_runs_ttl_hours`.
- In `maintenance:cleanup`, delete rows older than `ttl_hours`.

Example behavior:
- `ttl_days = 14` keeps two weeks of runs.
- Cleanup runs daily.

### 3) API endpoints for monitoring
Create `packages/api/src/routes/stats.ts` and register in `server.ts`.

Endpoints:
1) `GET /stats/overview`
   - total sources, active sources
   - items inserted in last 24h (from `feed_items`)
   - stale sources count (computed from last success run vs source interval)
   - queue counts (BullMQ: `waiting`, `active`, `delayed`, `failed`)

2) `GET /stats/sources`
   - per-source telemetry:
     - latest run status, time, item_count, duration, error_message
     - expected interval (source-only)
     - `is_stale` computed server-side

3) `GET /stats/sectors`
   - per-sector rollup:
     - active sources
     - items 24h
     - stale sources
     - last error count (optional)

Implementation detail:
- Use a SQL view or RPC for "latest run per source" to avoid N+1 queries.
- Minimal path: query `feed_fetch_runs` and reduce in API code (acceptable for small data).

### 4) (Optional) Persist "scheduler heartbeat"
File: `packages/worker/src/processors/maintenance.ts`
- On each `maintenance:schedule`, update `app_config` key `last_schedule_run_at`.
- Use this to show "scheduler alive" in the UI.

## Frontend Implementation Steps

### 1) Add a Monitoring page
File: `packages/frontend/src/pages/Monitoring.tsx`
Sections:
- Top summary cards
  - Active sources
  - Items last 24h
  - Stale sources
  - Queue backlog
- Source health table
  - Source name/url, sector, expected interval (source-only)
  - Last run status + time
  - Items last 24h
  - Error message (if any)
- Sector summary
  - Active sources per sector
  - Items 24h
  - Stale sources

### 2) Add route + navigation
Files:
- `packages/frontend/src/App.tsx` route `/monitoring`
- `packages/frontend/src/components/Layout.tsx` nav link

### 3) API client additions
File: `packages/frontend/src/api.ts`
- Add `getStatsOverview`, `getStatsSources`, `getStatsSectors`
- Use `useEffect` polling every 30-60 seconds (optional)

### 4) Stale detection UI
Simple rule to start:
- stale if `now > last_success_at + (expected_interval_minutes * 2)`
- show badge: OK / Stale / Error

## Practical Defaults
- `feed_fetch_runs_ttl_hours`: 336
- Stale threshold: 2x expected interval
- Polling: 60 seconds

## Migration Checklist
- Add `feed_fetch_runs` table + indexes
- Add `feed_fetch_runs_ttl_days` to `app_config`
- Update worker feed processor to insert telemetry
- Update maintenance cleanup to TTL `feed_fetch_runs`
- Add stats routes
- Add monitoring UI

## Validation
- Trigger a manual ingest and verify a success run is inserted.
- Force a bad RSS URL and verify error telemetry is stored.
- Confirm stale badge appears for sources with no recent successful runs.
- Confirm cleanup removes old rows after TTL.
