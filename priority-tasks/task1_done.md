# Task 1: Infrastructure Hardening & Reliability Audit Fixes

**Created:** 2026-01-24
**Status:** PENDING
**Rename to:** `task1_done.md` when all items are implemented

---

## Overview

This task covers all fixes identified during the project audit:
- Graceful shutdown for API server
- Startup readiness checks (Redis, DB)
- Health endpoint improvements
- app_config seed data
- Env file cleanup
- Frontend loading states
- DB client close method

---

## 1. API Server Graceful Shutdown

**File:** `packages/api/src/index.ts`
**Problem:** No signal handlers. On restart/deploy, connections leak and in-flight requests are dropped.

### Steps:
1. Add SIGTERM and SIGINT signal handlers
2. Call `app.close()` to stop accepting new requests and drain existing ones
3. Close BullMQ queue connections (ingestQueue, maintenanceQueue) if any are created in the API
4. Close the database pool
5. Add a force-exit timeout (e.g., 10 seconds) in case shutdown hangs
6. Log shutdown progress

### Target code structure:
```typescript
const shutdown = async () => {
  console.info("[api] shutting down...");
  // 1. Stop accepting new HTTP requests
  await app.close();
  // 2. Close any queue connections
  await ingestQueue?.close();
  await maintenanceQueue?.close();
  // 3. Close database pool
  await db.close(); // Needs close method exposed (see item 2)
  console.info("[api] shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Force exit after 10s if graceful shutdown hangs
setTimeout(() => {
  console.error("[api] forced exit after timeout");
  process.exit(1);
}, 10_000).unref();
```

---

## 2. Expose Database Pool Close Method

**File:** `packages/db/src/client.ts`
**Problem:** `createDb()` returns only the Drizzle instance. The underlying `pg.Pool` is not accessible for shutdown.

### Steps:
1. Change `createDb()` to return both the Drizzle instance and a `close()` function
2. Return type: `{ db: DrizzleInstance, close: () => Promise<void> }`
3. Update all consumers (API index.ts, Worker index.ts) to destructure the new return value
4. Call `close()` in shutdown handlers

### Target code:
```typescript
export const createDb = (connectionString: string) => {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
};
```

### Files to update:
- `packages/db/src/client.ts` — change factory return
- `packages/db/src/index.ts` — update exports if needed
- `packages/api/src/server.ts` — destructure `{ db, close }`
- `packages/worker/src/index.ts` — destructure `{ db, close }`, call in shutdown

---

## 3. Redis Pre-flight Health Check

**File:** `packages/worker/src/index.ts`
**Problem:** Worker creates queues without verifying Redis is reachable. If Redis is down, first job attempt crashes.

### Steps:
1. Before creating any Queue instances, create a temporary Redis connection
2. Run `redis.ping()` to verify connectivity
3. If ping fails, log error and exit with code 1
4. If ping succeeds, close temp connection and proceed with queue creation
5. Add the same check to API server if it creates queue connections

### Target code:
```typescript
import { Redis } from "ioredis";

const redis = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT });
try {
  await redis.ping();
  console.info("[worker] redis connected");
} catch (err) {
  console.error("[worker] redis unreachable, exiting", err);
  process.exit(1);
}
await redis.quit();
```

---

## 4. Database Connection Verification on Startup

**Files:** `packages/api/src/index.ts`, `packages/worker/src/index.ts`
**Problem:** DB pool is lazy — connections created on first query. If DB is down, server starts but fails on first request.

### Steps:
1. After creating the DB instance, run a simple verification query: `SELECT 1`
2. If query fails, log error and exit with code 1
3. If query succeeds, proceed with server startup
4. Add to both API and Worker startup sequences

### Target code:
```typescript
try {
  await db.execute(sql`SELECT 1`);
  console.info("[api] database connected");
} catch (err) {
  console.error("[api] database unreachable, exiting", err);
  process.exit(1);
}
```

---

## 5. Health Endpoint Enhancement

**File:** `packages/api/src/routes/health.ts`
**Problem:** Always returns `{ status: "ok" }` regardless of actual dependency health.

### Steps:
1. Check Redis connectivity (ping)
2. Check PostgreSQL connectivity (simple query)
3. Return detailed status per dependency
4. Return HTTP 503 if any dependency is unhealthy
5. Keep the check lightweight (no expensive queries)

### Target response:
```json
// Healthy (200):
{ "status": "ok", "redis": "ok", "database": "ok" }

// Unhealthy (503):
{ "status": "degraded", "redis": "ok", "database": "error" }
```

---

## 6. Seed app_config with Default Values

**File:** `packages/db/seed.sql` (or create new seed script)
**Problem:** app_config table is empty. System works via code fallbacks, but explicit defaults are better for visibility and UI display.

### Steps:
1. Insert default values into app_config table
2. Use ON CONFLICT DO NOTHING so re-running is safe
3. Values to seed:

```sql
INSERT INTO app_config (key, value, updated_at) VALUES
  ('feed_items_ttl_days', '60', NOW()),
  ('feed_fetch_runs_ttl_hours', '336', NOW())
ON CONFLICT (key) DO NOTHING;
```

4. Add this to the db:push or db:migrate workflow, or create a `npm run db:seed` script
5. Update root package.json with the seed command

---

## 7. Remove Unused LLM Environment Variables

**Files:** `.env`, `.env.example`
**Problem:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_PROVIDER` are defined but not used (Phase 4 future). They cause confusion.

### Steps:
1. Remove these lines from `.env`:
   - `OPENAI_API_KEY=sk-...`
   - `ANTHROPIC_API_KEY=sk-ant-...`
   - `LLM_PROVIDER=claude`
2. Remove same lines from `.env.example`
3. Add a comment: `# LLM vars will be added when Phase 4 (scoring/summarization) is implemented`
4. Update CLAUDE.md Environment Variables section to note these are future-only

---

## 8. Add Missing Env Vars to Zod Validation Schema

**File:** `packages/shared/src/schemas/env.ts`
**Problem:** Only validates DATABASE_URL, REDIS_HOST, REDIS_PORT, API_KEY. Missing PORT and VITE vars.

### Steps:
1. Add `PORT` to schema as optional with default 3001:
   ```typescript
   PORT: z.coerce.number().int().positive().default(3001),
   ```
2. Create a separate `frontendEnvSchema` for VITE vars (used only in frontend):
   ```typescript
   export const frontendEnvSchema = z.object({
     VITE_API_URL: z.string().url(),
     VITE_API_KEY: z.string().min(1),
   });
   ```
3. Update API server to use validated PORT instead of raw `process.env.PORT`

---

## 9. Worker Startup Error Handling

**File:** `packages/worker/src/index.ts`
**Problem:** No try-catch around initialization. If any startup step fails, error is unhandled.

### Steps:
1. Wrap entire startup in a try-catch
2. Log the error with context
3. Exit with code 1 on failure
4. Ensure cleanup of any partially-initialized resources

### Target structure:
```typescript
const main = async () => {
  try {
    // 1. Validate env
    // 2. Verify Redis
    // 3. Verify DB
    // 4. Create queues and workers
    // 5. Register signal handlers
    console.info("[worker] started successfully");
  } catch (err) {
    console.error("[worker] startup failed", err);
    process.exit(1);
  }
};

main();
```

---

## 10. Frontend Loading States Improvement

**Files:** `packages/frontend/src/pages/Database.tsx`, `packages/frontend/src/App.tsx`
**Problem:** Loading states are text-only. Database page has no loading indicator at all.

### Steps:
1. Add a simple spinner component (Tailwind `animate-spin` on an SVG)
2. Replace "Loading..." text in Home page with spinner
3. Replace "Loading monitoring data..." in Monitoring page with spinner
4. Add loading state to Database settings page (show spinner while TTL values load)
5. Disable save buttons while loading or saving

### Spinner component (reusable):
```tsx
const Spinner = () => (
  <svg className="animate-spin h-5 w-5 text-slate-400" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
  </svg>
);
```

---

## 11. Prevent Duplicate Validation Rules (Frontend/Backend)

**Problem:** Validation ranges (TTL 30-60 days, interval 1-4320 min, max age 1-15 days) are hardcoded in both frontend and backend. If backend changes, frontend becomes stale.

### Steps:
1. Add a new API endpoint: `GET /config/constraints`
2. Return all validation ranges from backend:
   ```json
   {
     "feedItemsTtl": { "min": 30, "max": 60, "unit": "days" },
     "fetchRunsTtl": { "min": 1, "max": 2160, "unit": "hours" },
     "interval": { "min": 1, "max": 4320, "unit": "minutes" },
     "maxAge": { "min": 1, "max": 15, "unit": "days" }
   }
   ```
3. Frontend fetches constraints on startup
4. Use fetched constraints in form validation instead of hardcoded values
5. Backend remains the single source of truth

---

## Implementation Order (Recommended)

1. **Item 2** — DB close method (dependency for items 1, 4)
2. **Item 3** — Redis pre-flight check
3. **Item 4** — DB connection verification
4. **Item 1** — API graceful shutdown
5. **Item 9** — Worker error handling
6. **Item 5** — Health endpoint
7. **Item 6** — Seed app_config
8. **Item 7** — Remove unused env vars
9. **Item 8** — Zod schema additions
10. **Item 10** — Frontend spinners
11. **Item 11** — Validation constraints endpoint

---

## Verification Checklist

After implementing all items, verify:

- [ ] `npm run dev` starts cleanly with Redis + Postgres running
- [ ] `npm run dev` (without Redis) exits with clear error message
- [ ] `npm run dev` (without Postgres) exits with clear error message
- [ ] `GET /health` returns 503 when Redis is down
- [ ] `GET /health` returns 503 when Postgres is down
- [ ] Ctrl+C on API process closes cleanly (no connection leaks)
- [ ] Ctrl+C on Worker process closes cleanly (existing behavior preserved)
- [ ] app_config has default TTL values after fresh `db:push + db:seed`
- [ ] Frontend shows spinners during initial load
- [ ] Database page loads TTL values before enabling inputs
- [ ] `.env` has no LLM-related variables
- [ ] `npm run build` passes with all changes
