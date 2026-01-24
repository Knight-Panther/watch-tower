# Infrastructure Status

Check the health of all infrastructure components (Docker, PostgreSQL, Redis, API).

## Steps

1. Check Docker containers:
   ```bash
   docker compose ps
   ```

2. Test PostgreSQL connectivity:
   ```bash
   docker compose exec postgres pg_isready -U watchtower
   ```

3. Test Redis connectivity:
   ```bash
   docker compose exec redis redis-cli ping
   ```

4. Test API health endpoint:
   ```bash
   curl -s http://localhost:3001/health
   ```

5. Report the status of each component (up/down) and any issues found.

## Notes
- If postgres is unhealthy, check logs: `docker compose logs postgres`
- If Redis is down, BullMQ queues will fail silently
- The API depends on both PostgreSQL and Redis being available
