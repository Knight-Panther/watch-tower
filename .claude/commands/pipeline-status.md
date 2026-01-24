# Pipeline Status

Check the current state of the article processing pipeline by querying the database.

## Steps

1. Ensure PostgreSQL is running:
   ```bash
   docker compose ps postgres
   ```

2. Query article counts by pipeline stage:
   ```bash
   docker compose exec postgres psql -U watchtower -c "SELECT pipeline_stage, count(*) FROM articles GROUP BY pipeline_stage ORDER BY count DESC;"
   ```

3. Check recent feed fetch runs (last 24h):
   ```bash
   docker compose exec postgres psql -U watchtower -c "SELECT source_id, status, item_count, item_added, duration_ms, created_at FROM feed_fetch_runs WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 20;"
   ```

4. Check BullMQ queue status via the API:
   ```bash
   curl -s -H "x-api-key: local-dev-key" http://localhost:3001/stats/overview | jq .queues
   ```

5. Report a summary: total articles per stage, recent ingest activity, queue depths.

## Notes
- Pipeline stages: ingested → embedded → scored → approved/rejected → posted (or duplicate)
- Stale sources are those that haven't been fetched in 2x their configured interval
