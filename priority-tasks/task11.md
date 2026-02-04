# Task 11: Platform Health Monitoring

## Overview

Add health monitoring for social platforms (Telegram, Facebook, LinkedIn) with:
- Token validity checks
- Token expiry tracking (Facebook from API, LinkedIn auto-calculated)
- Platform API rate limit visibility
- Status dashboard in existing Platform Settings page

## Architecture Decisions

| Decision | Choice |
|----------|--------|
| LinkedIn expiry tracking | Auto-calculate 60 days from first successful health check |
| Health check frequency | Worker startup + every 6 hours via maintenance job |
| Storage | New `platform_health` database table |
| Platform rate limit data | Capture on healthCheck(), store in DB, show in UI |
| UI location | Extend existing `/platform-settings` page |
| Emergency brake | Not implemented (rely on app-side limits) |

---

## Phase 1: Database Schema

### 1.1 Create migration for `platform_health` table

**File:** `packages/db/drizzle/XXXX_platform_health.sql`

```sql
CREATE TABLE platform_health (
  platform VARCHAR(20) PRIMARY KEY,        -- 'telegram' | 'facebook' | 'linkedin'
  healthy BOOLEAN NOT NULL DEFAULT false,
  error TEXT,

  -- Token expiry tracking
  token_expires_at TIMESTAMPTZ,            -- Facebook: from API, LinkedIn: calculated
  token_first_seen_at TIMESTAMPTZ,         -- For LinkedIn 60-day calculation

  -- Platform API rate limit data (captured on health check)
  rate_limit_remaining INTEGER,            -- LinkedIn: absolute count remaining
  rate_limit_max INTEGER,                  -- LinkedIn: daily limit
  rate_limit_percent INTEGER,              -- Facebook: usage percentage (0-100)
  rate_limit_resets_at TIMESTAMPTZ,        -- LinkedIn: when limit resets

  -- Timestamps
  last_check_at TIMESTAMPTZ NOT NULL,
  last_post_at TIMESTAMPTZ,                -- Updated when post succeeds

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 1.2 Add Drizzle schema

**File:** `packages/db/src/schema.ts`

Add `platformHealth` table definition with proper types.

---

## Phase 2: Provider Health Checks

### 2.1 Update SocialProvider interface

**File:** `packages/social/src/types.ts`

```typescript
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
  name: string;
  post(request: PostRequest): Promise<PostResult>;
  healthCheck(): Promise<HealthCheckResult>;  // NEW
  formatPost(article: ArticleForPost, template: PostTemplateConfig): string;
  formatSinglePost(article: ArticleForPost): string;
  formatDigestPost(articles: ArticleForPost[], sector: string): string;
}
```

### 2.2 Implement Telegram healthCheck()

**File:** `packages/social/src/providers/telegram.ts`

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
      // No rate limit data available for Telegram
      // No token expiry (Telegram tokens don't expire)
    };
  } catch (err) {
    return {
      platform: "telegram",
      healthy: false,
      error: err instanceof Error ? sanitizeError(err.message) : "Unknown error",
      checkedAt: new Date(),
    };
  }
}
```

### 2.3 Implement Facebook healthCheck()

**File:** `packages/social/src/providers/facebook.ts`

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
      } catch {}
    }

    // Get token expiry from debug_token response
    const expiresAt = result.data.expires_at
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
}
```

### 2.4 Implement LinkedIn healthCheck()

**File:** `packages/social/src/providers/linkedin.ts`

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
        error: sanitizeError(errorData.message || `HTTP ${response.status}`),
        checkedAt: new Date(),
      };
    }

    // Parse rate limit headers
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
      // Note: tokenExpiresAt will be calculated from token_first_seen_at + 60 days
    };
  } catch (err) {
    return {
      platform: "linkedin",
      healthy: false,
      error: err instanceof Error ? sanitizeError(err.message) : "Unknown error",
      checkedAt: new Date(),
    };
  }
}
```

---

## Phase 3: Worker Integration

### 3.1 Add health check on worker startup

**File:** `packages/worker/src/index.ts`

After creating providers, before starting workers:

```typescript
// Run health checks for all configured platforms on startup
const runStartupHealthChecks = async () => {
  const providers = [
    telegramConfig ? createTelegramProvider(telegramConfig) : null,
    facebookConfig ? createFacebookProvider(facebookConfig) : null,
    linkedinConfig ? createLinkedInProvider(linkedinConfig) : null,
  ].filter(Boolean);

  for (const provider of providers) {
    try {
      const result = await provider.healthCheck();
      await upsertPlatformHealth(db, result);

      if (result.healthy) {
        logger.info(`[${provider.name}] ✓ Health check passed`);
      } else {
        logger.warn(`[${provider.name}] ✗ Health check failed: ${result.error}`);
      }
    } catch (err) {
      logger.error(`[${provider.name}] Health check error`, err);
    }
  }
};

await runStartupHealthChecks();
```

### 3.2 Add periodic health check job

**File:** `packages/shared/src/index.ts`

Add new job constant:

```typescript
export const JOB_PLATFORM_HEALTH_CHECK = "platform-health-check";
```

### 3.3 Implement health check in maintenance worker

**File:** `packages/worker/src/processors/maintenance.ts`

Add handler for `JOB_PLATFORM_HEALTH_CHECK`:

```typescript
case JOB_PLATFORM_HEALTH_CHECK: {
  logger.debug("[maintenance] running platform health checks");
  await runPlatformHealthChecks(db, providers);
  return;
}
```

### 3.4 Register recurring health check job

**File:** `packages/worker/src/index.ts`

```typescript
// Health check every 6 hours
await maintenanceQueue.add(
  JOB_PLATFORM_HEALTH_CHECK,
  {},
  { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: JOB_PLATFORM_HEALTH_CHECK }
);
```

### 3.5 Create health check utility function

**File:** `packages/worker/src/utils/platform-health.ts`

```typescript
import type { Database } from "@watch-tower/db";
import type { SocialProvider, HealthCheckResult } from "@watch-tower/social";
import { platformHealth } from "@watch-tower/db";
import { eq } from "drizzle-orm";

const LINKEDIN_TOKEN_LIFETIME_DAYS = 60;

export const upsertPlatformHealth = async (
  db: Database,
  result: HealthCheckResult
) => {
  const existing = await db.query.platformHealth.findFirst({
    where: eq(platformHealth.platform, result.platform),
  });

  // For LinkedIn: calculate expiry from first_seen_at
  let tokenExpiresAt = result.tokenExpiresAt;
  let tokenFirstSeenAt = existing?.token_first_seen_at;

  if (result.platform === "linkedin" && result.healthy) {
    if (!tokenFirstSeenAt) {
      // First time seeing this token - record now
      tokenFirstSeenAt = new Date();
    }
    // Calculate 60 days from first seen
    tokenExpiresAt = new Date(tokenFirstSeenAt.getTime() + LINKEDIN_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
  }

  const data = {
    platform: result.platform,
    healthy: result.healthy,
    error: result.error || null,
    token_expires_at: tokenExpiresAt || null,
    token_first_seen_at: tokenFirstSeenAt || null,
    rate_limit_remaining: result.rateLimit?.remaining || null,
    rate_limit_max: result.rateLimit?.limit || null,
    rate_limit_percent: result.rateLimit?.percent || null,
    rate_limit_resets_at: result.rateLimit?.resetsAt || null,
    last_check_at: result.checkedAt,
    updated_at: new Date(),
  };

  await db.insert(platformHealth)
    .values({ ...data, created_at: new Date() })
    .onConflictDoUpdate({
      target: platformHealth.platform,
      set: data,
    });
};

export const updateLastPostAt = async (db: Database, platform: string) => {
  await db.update(platformHealth)
    .set({ last_post_at: new Date(), updated_at: new Date() })
    .where(eq(platformHealth.platform, platform));
};
```

### 3.6 Update distribution worker to track last_post_at

**File:** `packages/worker/src/processors/distribution.ts`

After successful post:

```typescript
if (result.success) {
  await updateLastPostAt(db, platform);
}
```

---

## Phase 4: API Endpoint

### 4.1 Add GET /api/platforms/health endpoint

**File:** `packages/api/src/routes/platforms.ts`

```typescript
import { platformHealth } from "@watch-tower/db";

// GET /api/platforms/health
app.get("/api/platforms/health", async (request, reply) => {
  const rows = await db.select().from(platformHealth);

  const platforms = rows.map((row) => {
    // Calculate status
    let status: "active" | "expiring" | "expired" | "error" = "active";
    let daysRemaining: number | undefined;

    if (!row.healthy) {
      status = "error";
    } else if (row.token_expires_at) {
      const now = new Date();
      const msRemaining = row.token_expires_at.getTime() - now.getTime();
      daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));

      if (daysRemaining <= 0) {
        status = "expired";
      } else if (daysRemaining <= 7) {
        status = "expiring";  // Orange/Red warning
      } else if (daysRemaining <= 14) {
        status = "expiring";  // Yellow warning
      }
    }

    return {
      platform: row.platform,
      healthy: row.healthy,
      status,
      error: row.error,
      expiresAt: row.token_expires_at?.toISOString() || null,
      daysRemaining,
      lastCheck: row.last_check_at.toISOString(),
      lastPost: row.last_post_at?.toISOString() || null,
      rateLimit: {
        remaining: row.rate_limit_remaining,
        limit: row.rate_limit_max,
        percent: row.rate_limit_percent,
        resetsAt: row.rate_limit_resets_at?.toISOString() || null,
      },
    };
  });

  return reply.send({ platforms });
});
```

### 4.2 Add POST /api/platforms/health/refresh endpoint

**File:** `packages/api/src/routes/platforms.ts`

```typescript
// POST /api/platforms/health/refresh
// Triggers immediate health check for all platforms
app.post("/api/platforms/health/refresh", async (request, reply) => {
  // Add job to maintenance queue with high priority
  await maintenanceQueue.add(
    JOB_PLATFORM_HEALTH_CHECK,
    {},
    { priority: 1, jobId: `health-refresh-${Date.now()}` }
  );

  return reply.send({ message: "Health check queued" });
});
```

---

## Phase 5: Frontend UI

### 5.1 Add API client functions

**File:** `packages/frontend/src/api.ts`

```typescript
export type PlatformHealth = {
  platform: string;
  healthy: boolean;
  status: "active" | "expiring" | "expired" | "error";
  error?: string;
  expiresAt?: string;
  daysRemaining?: number;
  lastCheck: string;
  lastPost?: string;
  rateLimit: {
    remaining?: number;
    limit?: number;
    percent?: number;
    resetsAt?: string;
  };
};

export const getPlatformHealth = async (): Promise<PlatformHealth[]> => {
  const res = await fetch(`${API_URL}/api/platforms/health`, {
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) throw new Error("Failed to fetch platform health");
  const data = await res.json();
  return data.platforms;
};

export const refreshPlatformHealth = async (): Promise<void> => {
  const res = await fetch(`${API_URL}/api/platforms/health/refresh`, {
    method: "POST",
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) throw new Error("Failed to trigger health check");
};
```

### 5.2 Update PlatformSettings page

**File:** `packages/frontend/src/pages/PlatformSettings.tsx`

Add new "Connection Status" section at the top:

```tsx
// New state
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
    // Wait for job to complete then refresh
    setTimeout(async () => {
      const health = await getPlatformHealth();
      setPlatformHealth(health);
      setIsRefreshing(false);
    }, 5000);
  } catch {
    toast.error("Failed to refresh health");
    setIsRefreshing(false);
  }
};
```

### 5.3 Connection Status section UI

```tsx
{/* Connection Status Section - NEW */}
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
      {isRefreshing ? "Checking..." : "↻ Refresh"}
    </button>
  </div>

  <div className="mt-6 space-y-3">
    {platformHealth.map((health) => (
      <PlatformHealthCard key={health.platform} health={health} />
    ))}
    {platformHealth.length === 0 && !isHealthLoading && (
      <p className="text-sm text-slate-500">No platforms configured</p>
    )}
  </div>
</section>
```

### 5.4 PlatformHealthCard component

```tsx
const STATUS_COLORS = {
  active: "bg-emerald-500",
  expiring: "bg-amber-500",
  expired: "bg-red-500",
  error: "bg-red-500",
};

const STATUS_TEXT = {
  active: "Connected",
  expiring: "Token expiring soon",
  expired: "Token expired",
  error: "Error",
};

function PlatformHealthCard({ health }: { health: PlatformHealth }) {
  const icon = PLATFORM_ICONS[health.platform] || "📱";
  const statusColor = STATUS_COLORS[health.status];

  // Format last check as relative time
  const lastCheckRelative = formatRelativeTime(health.lastCheck);

  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
        <span className="text-xl">{icon}</span>
        <div>
          <p className="font-medium text-slate-200 capitalize">{health.platform}</p>
          <p className="text-xs text-slate-500">
            {health.status === "error" && health.error}
            {health.status === "expiring" && health.daysRemaining !== undefined &&
              `Expires in ${health.daysRemaining} days`}
            {health.status === "expired" && "Token expired - renew required"}
            {health.status === "active" && STATUS_TEXT.active}
          </p>
        </div>
      </div>

      <div className="text-right">
        <p className="text-xs text-slate-500">Checked {lastCheckRelative}</p>
        {health.rateLimit.remaining !== undefined && (
          <p className="text-xs text-slate-400">
            API: {health.rateLimit.remaining}/{health.rateLimit.limit} remaining
          </p>
        )}
        {health.rateLimit.percent !== undefined && (
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

- [ ] Worker startup runs health checks and logs results
- [ ] Health check job runs every 6 hours
- [ ] `/api/platforms/health` returns correct data
- [ ] UI shows Connection Status section with color-coded badges
- [ ] Refresh button triggers new health check
- [ ] Facebook token expiry shows from API
- [ ] LinkedIn token expiry calculated from first_seen_at + 60 days
- [ ] Platform rate limits displayed (Facebook %, LinkedIn remaining)
- [ ] last_post_at updates when posting succeeds

### 6.2 Edge cases to verify

- [ ] Platform not configured → not shown in health list
- [ ] Invalid token → shows error status with message
- [ ] Network timeout → shows error with timeout message
- [ ] Token close to expiry (7 days) → shows yellow/orange warning
- [ ] Token expired → shows red status
- [ ] First LinkedIn health check → stores token_first_seen_at

---

## File Changes Summary

| Package | Files Changed/Added |
|---------|---------------------|
| `packages/db` | `schema.ts`, new migration file |
| `packages/social` | `types.ts`, `telegram.ts`, `facebook.ts`, `linkedin.ts` |
| `packages/shared` | `index.ts` (new constant) |
| `packages/worker` | `index.ts`, `maintenance.ts`, new `platform-health.ts` util |
| `packages/api` | `routes/platforms.ts` (new or extended) |
| `packages/frontend` | `api.ts`, `PlatformSettings.tsx` |

---

## Implementation Order

1. **Database** - Create migration and Drizzle schema
2. **Social package** - Add `healthCheck()` to all providers
3. **Worker utilities** - Add `upsertPlatformHealth()` helper
4. **Worker startup** - Run health checks on boot
5. **Maintenance job** - Add periodic health check
6. **API endpoint** - Add `/api/platforms/health`
7. **Frontend** - Add Connection Status section to Platform Settings
8. **Testing** - Verify all functionality

---

## Status

- [ ] Phase 1: Database Schema
- [ ] Phase 2: Provider Health Checks
- [ ] Phase 3: Worker Integration
- [ ] Phase 4: API Endpoint
- [ ] Phase 5: Frontend UI
- [ ] Phase 6: Testing & Verification
