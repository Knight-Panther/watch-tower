# Task 11: Platform Health Monitoring

## Overview

Add health monitoring for social platforms (Telegram, Facebook, LinkedIn) with:
- Token validity checks
- Token expiry tracking (Facebook from API, LinkedIn auto-calculated with rotation detection)
- Platform API rate limit visibility (informational, separate from our Redis posting limits)
- Status dashboard in existing Platform Settings page
- Emergency brake: skip posting to unhealthy platforms

## Architecture Decisions

| Decision | Choice |
|----------|--------|
| LinkedIn expiry tracking | Auto-calculate 60 days from first successful health check |
| LinkedIn token rotation | Detect via `tokenHash` (SHA256) - reset timer on change |
| Health check frequency | Startup (via immediate job) + every 6 hours recurring |
| Storage | New `platform_health` table (camelCase Drizzle → snake_case DB) |
| Platform rate limit data | Informational only - Redis handles posting enforcement |
| UI location | Extend existing `/platform-settings` page |
| Emergency brake | Distribution/maintenance workers check `healthy` before posting |
| API path convention | `/platforms/health` (no `/api` prefix, matches existing routes) |

---

## Phase 1: Database Schema

### 1.1 Add Drizzle schema (generates migration)

**File:** `packages/db/src/schema.ts`

> **IMPORTANT**: Use camelCase property names mapped to snake_case columns (matches existing pattern).

```typescript
// ─── Platform Health ─────────────────────────────────────────────────────────

export const platformHealth = pgTable("platform_health", {
  platform: text("platform").primaryKey(), // 'telegram' | 'facebook' | 'linkedin'
  healthy: boolean("healthy").notNull().default(false),
  error: text("error"),

  // Token tracking
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  tokenFirstSeenAt: timestamp("token_first_seen_at", { withTimezone: true }),
  tokenHash: text("token_hash"), // SHA256 of token - detect rotation

  // Platform API rate limits (informational - captured from health check)
  rateLimitRemaining: integer("rate_limit_remaining"),
  rateLimitMax: integer("rate_limit_max"),
  rateLimitPercent: integer("rate_limit_percent"), // Facebook: 0-100
  rateLimitResetsAt: timestamp("rate_limit_resets_at", { withTimezone: true }),

  // Timestamps
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }).notNull(),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### 1.2 Export from db package

**File:** `packages/db/src/index.ts`

```typescript
export { platformHealth } from "./schema.js";
```

### 1.3 Generate and run migration

```bash
npm run db:generate   # Creates migration in packages/db/drizzle/
npm run db:migrate    # Applies migration
```

---

## Phase 2: Provider Health Checks

### 2.1 Add HealthCheckResult type and update interface

**File:** `packages/social/src/types.ts`

```typescript
import type { PostTemplateConfig } from "@watch-tower/shared";

// ... existing types ...

export interface HealthCheckResult {
  platform: string;
  healthy: boolean;
  error?: string;

  // Token expiry (Facebook only - from API)
  tokenExpiresAt?: Date;

  // Platform rate limits (captured from response headers)
  rateLimit?: {
    remaining?: number;      // LinkedIn: X-RateLimit-Remaining
    limit?: number;          // LinkedIn: X-RateLimit-Limit
    percent?: number;        // Facebook: X-App-Usage call_count
    resetsAt?: Date;         // LinkedIn: X-RateLimit-Reset
  };

  checkedAt: Date;
}

export interface SocialProvider {
  readonly name: string;  // Keep readonly (existing pattern)
  post(request: PostRequest): Promise<PostResult>;
  healthCheck(): Promise<HealthCheckResult>;  // NEW

  // Template-aware formatting (preferred)
  formatPost(article: ArticleForPost, template: PostTemplateConfig): string;

  // Legacy methods (delegate to formatPost with platform defaults)
  formatSinglePost(article: ArticleForPost): string;
  formatDigestPost(articles: ArticleForPost[], sector: string): string;
}
```

### 2.2 Export HealthCheckResult

**File:** `packages/social/src/index.ts`

```typescript
export type { HealthCheckResult } from "./types.js";
```

### 2.3 Implement Telegram healthCheck()

**File:** `packages/social/src/providers/telegram.ts`

Add inside `createTelegramProvider` return object:

```typescript
async healthCheck(): Promise<HealthCheckResult> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/getMe`,
      { method: "GET" },
      timeoutMs
    );

    const data = await response.json();

    if (!data.ok) {
      return {
        platform: "telegram",
        healthy: false,
        error: sanitizeError(data.description || "Unknown error"),
        checkedAt: new Date(),
      };
    }

    return {
      platform: "telegram",
      healthy: true,
      checkedAt: new Date(),
      // Telegram: no rate limit headers, tokens don't expire
    };
  } catch (err) {
    return {
      platform: "telegram",
      healthy: false,
      error: err instanceof Error ? sanitizeError(err.message) : "Unknown error",
      checkedAt: new Date(),
    };
  }
},
```

### 2.4 Implement Facebook healthCheck()

**File:** `packages/social/src/providers/facebook.ts`

Add inside `createFacebookProvider` return object:

```typescript
async healthCheck(): Promise<HealthCheckResult> {
  try {
    // Use debug_token to check token validity and get expiry
    const debugUrl = `${GRAPH_API_BASE}/debug_token?input_token=${accessToken}&access_token=${accessToken}`;

    const response = await fetchWithTimeout(debugUrl, { method: "GET" }, timeoutMs);
    const result = await response.json();

    if (result.error || !result.data?.is_valid) {
      return {
        platform: "facebook",
        healthy: false,
        error: sanitizeError(result.error?.message || "Token invalid"),
        checkedAt: new Date(),
      };
    }

    // Parse rate limit headers
    const appUsage = response.headers.get("X-App-Usage");
    let rateLimit: HealthCheckResult["rateLimit"];
    if (appUsage) {
      try {
        const usage = JSON.parse(appUsage);
        rateLimit = {
          percent: Math.max(usage.call_count || 0, usage.total_cputime || 0, usage.total_time || 0),
        };
      } catch {
        // Ignore parse errors
      }
    }

    // Get token expiry from debug_token response
    // Handle expires_at = 0 as "never expires" (long-lived page tokens)
    const expiresAt = result.data.expires_at && result.data.expires_at > 0
      ? new Date(result.data.expires_at * 1000)
      : undefined;

    return {
      platform: "facebook",
      healthy: true,
      tokenExpiresAt: expiresAt,
      rateLimit,
      checkedAt: new Date(),
    };
  } catch (err) {
    return {
      platform: "facebook",
      healthy: false,
      error: err instanceof Error ? sanitizeError(err.message) : "Unknown error",
      checkedAt: new Date(),
    };
  }
},
```

### 2.5 Implement LinkedIn healthCheck()

**File:** `packages/social/src/providers/linkedin.ts`

Add inside `createLinkedInProvider` return object:

```typescript
async healthCheck(): Promise<HealthCheckResult> {
  try {
    const response = await fetchWithTimeout(
      `${LINKEDIN_API_BASE}/me`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
      timeoutMs
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        platform: "linkedin",
        healthy: false,
        error: sanitizeError((errorData as { message?: string }).message || `HTTP ${response.status}`),
        checkedAt: new Date(),
      };
    }

    // Parse rate limit headers (may not always be present)
    const limitHeader = response.headers.get("X-RateLimit-Limit");
    const remainingHeader = response.headers.get("X-RateLimit-Remaining");
    const resetHeader = response.headers.get("X-RateLimit-Reset");

    const rateLimit: HealthCheckResult["rateLimit"] = {};
    if (limitHeader) rateLimit.limit = parseInt(limitHeader, 10);
    if (remainingHeader) rateLimit.remaining = parseInt(remainingHeader, 10);
    if (resetHeader) rateLimit.resetsAt = new Date(parseInt(resetHeader, 10) * 1000);

    return {
      platform: "linkedin",
      healthy: true,
      rateLimit: Object.keys(rateLimit).length > 0 ? rateLimit : undefined,
      checkedAt: new Date(),
      // Note: tokenExpiresAt calculated in upsertPlatformHealth from tokenFirstSeenAt + 60 days
    };
  } catch (err) {
    return {
      platform: "linkedin",
      healthy: false,
      error: err instanceof Error ? sanitizeError(err.message) : "Unknown error",
      checkedAt: new Date(),
    };
  }
},
```

---

## Phase 3: Worker Integration

### 3.1 Add job constant

**File:** `packages/shared/src/index.ts`

```typescript
export const JOB_PLATFORM_HEALTH_CHECK = "platform-health-check";
```

### 3.2 Create health check utility

**File:** `packages/worker/src/utils/platform-health.ts`

```typescript
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { platformHealth } from "@watch-tower/db";
import type { HealthCheckResult } from "@watch-tower/social";

const LINKEDIN_TOKEN_LIFETIME_DAYS = 60;

/**
 * Compute SHA256 hash of access token for rotation detection
 */
export const hashToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};

/**
 * Upsert platform health record.
 * Handles LinkedIn token rotation via hash comparison.
 */
export const upsertPlatformHealth = async (
  db: Database,
  result: HealthCheckResult,
  currentTokenHash?: string // Pass hash if available (LinkedIn)
): Promise<void> => {
  const existing = await db.query.platformHealth.findFirst({
    where: eq(platformHealth.platform, result.platform),
  });

  let tokenExpiresAt = result.tokenExpiresAt;
  let tokenFirstSeenAt = existing?.tokenFirstSeenAt ?? null;
  let tokenHash = currentTokenHash ?? existing?.tokenHash ?? null;

  // LinkedIn: calculate expiry from firstSeenAt, detect token rotation
  if (result.platform === "linkedin" && result.healthy) {
    const tokenChanged = currentTokenHash && existing?.tokenHash && currentTokenHash !== existing.tokenHash;

    if (!tokenFirstSeenAt || tokenChanged) {
      // First time seeing this token OR token was rotated - reset timer
      tokenFirstSeenAt = new Date();
      tokenHash = currentTokenHash ?? null;
    }

    // Calculate 60 days from first seen
    tokenExpiresAt = new Date(
      tokenFirstSeenAt.getTime() + LINKEDIN_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000
    );
  }

  const data = {
    platform: result.platform,
    healthy: result.healthy,
    error: result.error ?? null,
    tokenExpiresAt: tokenExpiresAt ?? null,
    tokenFirstSeenAt: tokenFirstSeenAt,
    tokenHash: tokenHash,
    rateLimitRemaining: result.rateLimit?.remaining ?? null,
    rateLimitMax: result.rateLimit?.limit ?? null,
    rateLimitPercent: result.rateLimit?.percent ?? null,
    rateLimitResetsAt: result.rateLimit?.resetsAt ?? null,
    lastCheckAt: result.checkedAt,
    updatedAt: new Date(),
  };

  await db
    .insert(platformHealth)
    .values({ ...data, createdAt: new Date() })
    .onConflictDoUpdate({
      target: platformHealth.platform,
      set: data,
    });
};

/**
 * Update lastPostAt timestamp after successful post.
 * Also marks platform as healthy (successful post = working).
 */
export const updateLastPostAt = async (db: Database, platform: string): Promise<void> => {
  await db
    .update(platformHealth)
    .set({
      lastPostAt: new Date(),
      healthy: true, // Successful post proves platform works
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(platformHealth.platform, platform));
};

/**
 * Check if platform is healthy before posting.
 * Returns true if healthy or no health record exists.
 */
export const isPlatformHealthy = async (db: Database, platform: string): Promise<boolean> => {
  const health = await db.query.platformHealth.findFirst({
    where: eq(platformHealth.platform, platform),
  });

  // No record = assume healthy (first run)
  if (!health) return true;

  return health.healthy;
};
```

### 3.3 Add health check to job registry

**File:** `packages/worker/src/job-registry.ts`

Add to the `jobs` array inside `ensureRepeatableJobs`:

```typescript
import {
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  JOB_SEMANTIC_BATCH,
  JOB_LLM_SCORE_BATCH,
  JOB_PLATFORM_HEALTH_CHECK,  // ADD
  logger,
} from "@watch-tower/shared";

// Inside ensureRepeatableJobs, add to jobs array:
{
  queue: maintenanceQueue,
  name: JOB_PLATFORM_HEALTH_CHECK,
  jobId: JOB_PLATFORM_HEALTH_CHECK,
  every: 6 * 60 * 60 * 1000, // 6 hours
},
```

### 3.4 Add health check handler to maintenance worker

**File:** `packages/worker/src/processors/maintenance.ts`

Add imports at top:

```typescript
import { JOB_PLATFORM_HEALTH_CHECK } from "@watch-tower/shared";
import { upsertPlatformHealth, hashToken } from "../utils/platform-health.js";
```

Add to `MaintenanceDeps` type:

```typescript
type MaintenanceDeps = {
  // ... existing fields ...
  // Token hashes for rotation detection (computed at startup)
  linkedinTokenHash?: string;
};
```

Add new job handler inside the worker processor (use `if`, not `switch`):

```typescript
if (job.name === JOB_PLATFORM_HEALTH_CHECK) {
  logger.debug("[maintenance] running platform health checks");

  for (const [name, provider] of Object.entries(providers)) {
    if (!provider) continue;

    try {
      const result = await provider.healthCheck();
      // Pass token hash for LinkedIn rotation detection
      const tokenHash = name === "linkedin" ? linkedinTokenHash : undefined;
      await upsertPlatformHealth(db, result, tokenHash);

      if (result.healthy) {
        logger.info({ platform: name }, "[health-check] passed");
      } else {
        logger.warn({ platform: name, error: result.error }, "[health-check] failed");
      }
    } catch (err) {
      logger.error({ platform: name, error: err }, "[health-check] error");
    }
  }
  return;
}
```

Update `createMaintenanceWorker` to accept and compute token hash:

```typescript
export const createMaintenanceWorker = ({
  // ... existing deps ...
  linkedinConfig,
}: MaintenanceDeps) => {
  // Compute LinkedIn token hash once at startup
  const linkedinTokenHash = linkedinConfig?.accessToken
    ? hashToken(linkedinConfig.accessToken)
    : undefined;

  // ... rest of function ...
```

### 3.5 Register health check job at startup

**File:** `packages/worker/src/index.ts`

Add import:

```typescript
import { JOB_PLATFORM_HEALTH_CHECK } from "@watch-tower/shared";
```

After existing job registrations, add:

```typescript
// Health check every 6 hours
await maintenanceQueue.add(
  JOB_PLATFORM_HEALTH_CHECK,
  {},
  { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: JOB_PLATFORM_HEALTH_CHECK }
);

// Run health check immediately on startup
await maintenanceQueue.add(
  JOB_PLATFORM_HEALTH_CHECK,
  {},
  { jobId: "health-check-startup" }
);
logger.info("[worker] platform health check enabled (every 6h)");
```

### 3.6 Update lastPostAt in both post paths

**File:** `packages/worker/src/processors/distribution.ts`

Add import:

```typescript
import { updateLastPostAt, isPlatformHealthy } from "../utils/platform-health.js";
```

Add health check before posting (inside the platform loop):

```typescript
// Check platform health before posting (emergency brake)
const isHealthy = await isPlatformHealthy(db, name);
if (!isHealthy) {
  logger.warn({ articleId, platform: name }, "[distribution] platform unhealthy, skipping");
  results.push({
    platform: name,
    success: false,
    error: "Platform marked unhealthy - skipping",
  });
  continue;
}
```

After successful post (where `postResult.success` is true):

```typescript
if (postResult.success) {
  anySuccess = true;
  await updateLastPostAt(db, name);  // ADD THIS
  // ... existing event publish code ...
}
```

**File:** `packages/worker/src/processors/maintenance.ts`

Add import (if not already):

```typescript
import { updateLastPostAt, isPlatformHealthy } from "../utils/platform-health.js";
```

In `processScheduledPosts`, add health check before posting:

```typescript
// Check platform health before posting (emergency brake)
const isHealthy = await isPlatformHealthy(db, delivery.platform);
if (!isHealthy) {
  logger.warn(
    { deliveryId: delivery.id, platform: delivery.platform },
    "[post-scheduler] platform unhealthy, rescheduling"
  );
  // Reschedule for 1 hour later
  const retryAt = new Date(Date.now() + 60 * 60 * 1000);
  await db
    .update(postDeliveries)
    .set({
      status: "scheduled",
      scheduledAt: retryAt,
      errorMessage: "Platform unhealthy, retrying in 1 hour",
    })
    .where(eq(postDeliveries.id, delivery.id));
  continue;
}
```

After successful post:

```typescript
if (postResult.success) {
  // Success: update delivery and article
  await updateLastPostAt(db, delivery.platform);  // ADD THIS
  // ... existing update code ...
}
```

---

## Phase 4: API Endpoints

### 4.1 Create platforms routes file

**File:** `packages/api/src/routes/platforms.ts`

```typescript
import type { FastifyInstance } from "fastify";
import { platformHealth } from "@watch-tower/db";
import { JOB_PLATFORM_HEALTH_CHECK } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export const registerPlatformsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  const { db, maintenanceQueue, requireApiKey } = deps;

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /platforms/health - Get health status for all platforms
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/platforms/health", { preHandler: requireApiKey }, async (_req, reply) => {
    const rows = await db.select().from(platformHealth);

    const platforms = rows.map((row) => {
      // Calculate status
      let status: "active" | "expiring" | "expired" | "error" = "active";
      let daysRemaining: number | undefined;

      if (!row.healthy) {
        status = "error";
      } else if (row.tokenExpiresAt) {
        const now = new Date();
        const msRemaining = row.tokenExpiresAt.getTime() - now.getTime();
        daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));

        if (daysRemaining <= 0) {
          status = "expired";
        } else if (daysRemaining <= 7) {
          status = "expiring";
        } else if (daysRemaining <= 14) {
          status = "expiring";
        }
      }

      return {
        platform: row.platform,
        healthy: row.healthy,
        status,
        error: row.error,
        expiresAt: row.tokenExpiresAt?.toISOString() ?? null,
        daysRemaining,
        lastCheck: row.lastCheckAt.toISOString(),
        lastPost: row.lastPostAt?.toISOString() ?? null,
        rateLimit: {
          remaining: row.rateLimitRemaining,
          limit: row.rateLimitMax,
          percent: row.rateLimitPercent,
          resetsAt: row.rateLimitResetsAt?.toISOString() ?? null,
        },
      };
    });

    return reply.send({ platforms });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /platforms/health/refresh - Trigger immediate health check
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/platforms/health/refresh", { preHandler: requireApiKey }, async (_req, reply) => {
    await maintenanceQueue.add(
      JOB_PLATFORM_HEALTH_CHECK,
      {},
      { priority: 1, jobId: `health-refresh-${Date.now()}` }
    );

    return reply.send({ message: "Health check queued" });
  });
};
```

### 4.2 Register routes in server.ts

**File:** `packages/api/src/server.ts`

Add import:

```typescript
import { registerPlatformsRoutes } from "./routes/platforms.js";
```

Add registration (after other routes):

```typescript
registerPlatformsRoutes(app, deps);
```

---

## Phase 5: Frontend UI

### 5.1 Add API client functions

**File:** `packages/frontend/src/api.ts`

```typescript
// ─── Platform Health ──────────────────────────────────────────────────────────

export type PlatformHealth = {
  platform: string;
  healthy: boolean;
  status: "active" | "expiring" | "expired" | "error";
  error: string | null;
  expiresAt: string | null;
  daysRemaining?: number;
  lastCheck: string;
  lastPost: string | null;
  rateLimit: {
    remaining: number | null;
    limit: number | null;
    percent: number | null;
    resetsAt: string | null;
  };
};

export const getPlatformHealth = async (): Promise<PlatformHealth[]> => {
  const res = await fetch(`${API_URL}/platforms/health`, {
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) throw new Error("Failed to fetch platform health");
  const data = await res.json();
  return data.platforms;
};

export const refreshPlatformHealth = async (): Promise<void> => {
  const res = await fetch(`${API_URL}/platforms/health/refresh`, {
    method: "POST",
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) throw new Error("Failed to trigger health check");
};
```

### 5.2 Add formatRelativeTime helper

**File:** `packages/frontend/src/pages/PlatformSettings.tsx`

Add helper function (or import from shared utils):

```typescript
const formatRelativeTime = (isoString: string): string => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};
```

### 5.3 Update PlatformSettings page

**File:** `packages/frontend/src/pages/PlatformSettings.tsx`

Add imports:

```typescript
import { getPlatformHealth, refreshPlatformHealth, type PlatformHealth } from "../api";
```

Add state and effects:

```typescript
// Platform Health state
const [platformHealth, setPlatformHealth] = useState<PlatformHealth[]>([]);
const [isHealthLoading, setIsHealthLoading] = useState(true);
const [isRefreshing, setIsRefreshing] = useState(false);

// Load health on mount
useEffect(() => {
  const loadHealth = async () => {
    try {
      const health = await getPlatformHealth();
      setPlatformHealth(health);
    } catch {
      // Silent fail - health section optional
    } finally {
      setIsHealthLoading(false);
    }
  };
  loadHealth();
}, []);

// Refresh handler
const handleRefreshHealth = async () => {
  setIsRefreshing(true);
  try {
    await refreshPlatformHealth();
    toast.info("Health check queued - refreshing in 5s...");
    setTimeout(async () => {
      try {
        const health = await getPlatformHealth();
        setPlatformHealth(health);
      } catch {
        // Ignore
      }
      setIsRefreshing(false);
    }, 5000);
  } catch {
    toast.error("Failed to refresh health");
    setIsRefreshing(false);
  }
};
```

### 5.4 Add Connection Status section (at top of page)

```tsx
{/* Connection Status Section */}
<section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
  <div className="flex items-center justify-between">
    <div>
      <h2 className="text-lg font-semibold">Connection Status</h2>
      <p className="mt-1 text-sm text-slate-400">
        Token validity and platform API health
      </p>
    </div>
    <button
      onClick={handleRefreshHealth}
      disabled={isRefreshing}
      className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-slate-500 disabled:opacity-50"
    >
      {isRefreshing ? "Checking..." : "Refresh"}
    </button>
  </div>

  <div className="mt-6 space-y-3">
    {isHealthLoading && (
      <p className="text-sm text-slate-500">Loading health status...</p>
    )}
    {!isHealthLoading && platformHealth.length === 0 && (
      <p className="text-sm text-slate-500">No platforms configured</p>
    )}
    {platformHealth.map((health) => (
      <PlatformHealthCard key={health.platform} health={health} />
    ))}
  </div>
</section>
```

### 5.5 PlatformHealthCard component

```tsx
const PLATFORM_ICONS: Record<string, string> = {
  telegram: "📱",
  facebook: "📘",
  linkedin: "💼",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500",
  expiring: "bg-amber-500",
  expired: "bg-red-500",
  error: "bg-red-500",
};

function PlatformHealthCard({ health }: { health: PlatformHealth }) {
  const icon = PLATFORM_ICONS[health.platform] ?? "📱";
  const statusColor = STATUS_COLORS[health.status] ?? "bg-slate-500";
  const lastCheckRelative = formatRelativeTime(health.lastCheck);

  const getStatusText = () => {
    if (health.status === "error") return health.error ?? "Error";
    if (health.status === "expired") return "Token expired - renew required";
    if (health.status === "expiring" && health.daysRemaining !== undefined) {
      return `Expires in ${health.daysRemaining} days`;
    }
    return "Connected";
  };

  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
        <span className="text-xl">{icon}</span>
        <div>
          <p className="font-medium text-slate-200 capitalize">{health.platform}</p>
          <p className="text-xs text-slate-500">{getStatusText()}</p>
        </div>
      </div>

      <div className="text-right">
        <p className="text-xs text-slate-500">Checked {lastCheckRelative}</p>
        {health.rateLimit.remaining !== null && health.rateLimit.limit !== null && (
          <p className="text-xs text-slate-400">
            API: {health.rateLimit.remaining}/{health.rateLimit.limit} remaining
          </p>
        )}
        {health.rateLimit.percent !== null && (
          <p className="text-xs text-slate-400">
            API usage: {health.rateLimit.percent}%
          </p>
        )}
      </div>
    </div>
  );
}
```

---

## Phase 6: Testing & Verification

### 6.1 Manual testing checklist

- [ ] Database migration creates `platform_health` table
- [ ] Worker startup triggers immediate health check
- [ ] Health check runs every 6 hours (verify in Redis/BullMQ)
- [ ] `/platforms/health` returns correct data (all platforms)
- [ ] `/platforms/health/refresh` triggers immediate check
- [ ] UI shows Connection Status section with color-coded badges
- [ ] Refresh button works and updates after 5s
- [ ] Facebook token expiry shows from API (or null for long-lived)
- [ ] LinkedIn token expiry calculated from first_seen_at + 60 days
- [ ] LinkedIn token rotation resets the 60-day timer
- [ ] Platform rate limits displayed (Facebook %, LinkedIn remaining)
- [ ] `lastPostAt` updates in BOTH distribution and maintenance paths
- [ ] Emergency brake: unhealthy platforms are skipped during posting

### 6.2 Edge cases to verify

- [ ] Platform not configured → not shown in health list
- [ ] Invalid token → shows error status with message
- [ ] Network timeout → shows error with timeout message
- [ ] Token close to expiry (7 days) → shows yellow/orange warning
- [ ] Token expired → shows red status
- [ ] First LinkedIn health check → stores `tokenFirstSeenAt` and `tokenHash`
- [ ] LinkedIn token changed in .env → timer resets on next health check
- [ ] Facebook `expires_at = 0` → treated as "never expires"
- [ ] Successful post after health failure → marks platform healthy again
- [ ] No health record exists → posting proceeds (assumes healthy)

---

## File Changes Summary

| Package | Files Changed/Added |
|---------|---------------------|
| `packages/db` | `schema.ts` (add platformHealth table) |
| `packages/social` | `types.ts`, `index.ts`, `telegram.ts`, `facebook.ts`, `linkedin.ts` |
| `packages/shared` | `index.ts` (add JOB_PLATFORM_HEALTH_CHECK) |
| `packages/worker` | `job-registry.ts`, `index.ts`, `maintenance.ts`, `distribution.ts`, new `utils/platform-health.ts` |
| `packages/api` | `server.ts`, new `routes/platforms.ts` |
| `packages/frontend` | `api.ts`, `PlatformSettings.tsx` |

---

## Implementation Order

1. **Database** - Add Drizzle schema, generate and run migration
2. **Shared** - Add `JOB_PLATFORM_HEALTH_CHECK` constant
3. **Social package** - Add `HealthCheckResult` type, `healthCheck()` to all providers
4. **Worker utilities** - Create `utils/platform-health.ts`
5. **Worker job registry** - Add health check to `ensureRepeatableJobs`
6. **Worker maintenance** - Add health check job handler
7. **Worker index** - Register recurring job + startup check
8. **Worker distribution/maintenance** - Add `updateLastPostAt` + emergency brake
9. **API** - Create `routes/platforms.ts`, register in server.ts
10. **Frontend** - Add API functions, update PlatformSettings page
11. **Testing** - Verify all functionality

---

## Status

- [ ] Phase 1: Database Schema
- [ ] Phase 2: Provider Health Checks
- [ ] Phase 3: Worker Integration
- [ ] Phase 4: API Endpoints
- [ ] Phase 5: Frontend UI
- [ ] Phase 6: Testing & Verification
