# Reset Database

Drop and recreate the database schema using Drizzle. This is destructive — all data will be lost.

## Steps

1. Confirm infrastructure is running:
   ```bash
   docker compose ps
   ```

2. Drop the existing database and recreate:
   ```bash
   docker compose exec postgres psql -U watchtower -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;"
   ```

3. Push the schema fresh:
   ```bash
   npm run db:push
   ```

4. Verify tables exist:
   ```bash
   docker compose exec postgres psql -U watchtower -c "\dt"
   ```

## Notes
- This destroys ALL data in the database
- The `vector` extension is required for pgvector (semantic dedup)
- After reset, you may want to re-seed sectors/sources via the API or seed script
