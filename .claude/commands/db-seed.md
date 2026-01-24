# Seed Database

Populate the database with development seed data (sectors and sample RSS sources).

## Steps

1. Ensure PostgreSQL is running and schema is applied:
   ```bash
   docker compose exec postgres pg_isready -U watchtower
   ```

2. Run the seed SQL file:
   ```bash
   docker compose exec -T postgres psql -U watchtower -d watchtower < packages/db/seed.sql
   ```

3. Verify seed data was inserted:
   ```bash
   docker compose exec postgres psql -U watchtower -d watchtower -c "SELECT name, slug FROM sectors;"
   docker compose exec postgres psql -U watchtower -d watchtower -c "SELECT name, url, active FROM rss_sources;"
   ```

## Notes
- The seed file is at `packages/db/seed.sql`
- Running seed multiple times may fail on unique constraints (sectors.slug, rss_sources.url)
- To re-seed cleanly, run `/db-reset` first, then `/db-seed`
- Default seed includes: Technology, Finance, Science sectors with BBC, The Verge, Wired sources
