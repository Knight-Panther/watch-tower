# Task 10: Rate Limiting & Provider Hardening

## Overview

Implement rate limiting for social platform posting and harden Facebook/LinkedIn providers with proper timeouts. The `social_accounts.rate_limit_per_hour` column exists but isn't enforced.

## Official Platform Rate Limits

| Platform | Official Limit | Recommended Default |
|----------|---------------|---------------------|
| Telegram | ~30 msg/sec to different chats | 20/hr (very generous) |
| Facebook | ~25 posts/24hr per page | 1/hr (conservative) |
| LinkedIn | 100 posts/day per org | 4/hr (safe) |

---

## Phase 1: Redis Sliding Window Rate Limiter

### 1.1 Create Rate Limiter Utility

**File:** `packages/worker/src/utils/rate-limiter.ts`

```typescript
import type { Redis } from "ioredis";

export type RateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterMs?: number;
};

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Tracks timestamps of recent posts and checks against limit.
 */
export const createRateLimiter = (redis: Redis) => {
  return {
    /**
     * Check if posting is allowed and record the attempt if so.
     * @param platform - Platform name (telegram, facebook, linkedin)
     * @param limitPerHour - Max posts allowed per hour
     * @returns Whether posting is allowed and current usage
     */
    async checkAndRecord(platform: string, limitPerHour: number): Promise<RateLimitResult> {
      const key = `rate_limit:${platform}`;
      const now = Date.now();
      const windowStart = now - 60 * 60 * 1000; // 1 hour ago

      // Remove old entries outside the window
      await redis.zremrangebyscore(key, 0, windowStart);

      // Count current entries in window
      const current = await redis.zcard(key);

      if (current >= limitPerHour) {
        // Get oldest entry to calculate retry time
        const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
        const oldestTime = oldest.length >= 2 ? parseInt(oldest[1]) : now;
        const retryAfterMs = oldestTime + 60 * 60 * 1000 - now;

        return {
          allowed: false,
          current,
          limit: limitPerHour,
          retryAfterMs: Math.max(0, retryAfterMs),
        };
      }

      // Record this attempt
      await redis.zadd(key, now, `${now}`);
      // Set expiry on the key (cleanup)
      await redis.expire(key, 3600);

      return {
        allowed: true,
        current: current + 1,
        limit: limitPerHour,
      };
    },

    /**
     * Get current usage without recording.
     */
    async getUsage(platform: string): Promise<{ current: number }> {
      const key = `rate_limit:${platform}`;
      const now = Date.now();
      const windowStart = now - 60 * 60 * 1000;

      await redis.zremrangebyscore(key, 0, windowStart);
      const current = await redis.zcard(key);

      return { current };
    },
  };
};

export type RateLimiter = ReturnType<typeof createRateLimiter>;
```

### 1.2 Implementation Checklist

- [ ] Create `packages/worker/src/utils/rate-limiter.ts`
- [ ] Export from `packages/worker/src/utils/index.ts` (create if needed)
- [ ] Add unit tests for sliding window logic

---

## Phase 2: Integrate Rate Limiter into Workers

### 2.1 Update Worker Index

**File:** `packages/worker/src/index.ts`

Pass Redis instance to distribution and maintenance workers for rate limiting.

```typescript
// After creating redis connection
import { createRateLimiter } from "./utils/rate-limiter.js";

const rateLimiter = createRateLimiter(redis);

// Pass to distribution worker
const distributionWorker = createDistributionWorker({
  connection,
  db,
  telegramConfig,
  facebookConfig,
  linkedinConfig,
  eventPublisher,
  rateLimiter, // NEW
});

// Pass to maintenance worker
const maintenanceWorker = createMaintenanceWorker({
  connection,
  db,
  ingestQueue,
  distributionQueue,
  telegramConfig,
  facebookConfig,
  linkedinConfig,
  maintenanceQueue,
  semanticDedupQueue,
  llmQueue,
  rateLimiter, // NEW
});
```

### 2.2 Update Distribution Worker

**File:** `packages/worker/src/processors/distribution.ts`

```typescript
// Add to deps type
type DistributionDeps = {
  // ... existing
  rateLimiter: RateLimiter;
};

// In the worker, before posting to each platform:
async function postToPlatform(
  platform: string,
  provider: SocialProvider,
  article: ArticleForDistribution,
  template: PostTemplateConfig,
  rateLimiter: RateLimiter,
  db: Database,
) {
  // 1. Get rate limit from social_accounts
  const limitResult = await db.execute(sql`
    SELECT rate_limit_per_hour as "limit"
    FROM social_accounts
    WHERE platform = ${platform} AND is_active = true
    LIMIT 1
  `);
  const limit = (limitResult.rows[0] as { limit: number } | undefined)?.limit ?? 4;

  // 2. Check rate limit
  const rateCheck = await rateLimiter.checkAndRecord(platform, limit);
  if (!rateCheck.allowed) {
    logger.warn(
      { platform, current: rateCheck.current, limit: rateCheck.limit },
      "[distribution] rate limit reached, skipping"
    );
    return {
      platform,
      success: false,
      error: `Rate limit reached (${rateCheck.current}/${rateCheck.limit}/hr)`,
      rateLimited: true,
      retryAfterMs: rateCheck.retryAfterMs,
    };
  }

  // 3. Proceed with posting
  const text = provider.formatPost({ ... }, template);
  const result = await provider.post({ text });

  return { platform, ...result, rateLimited: false };
}
```

### 2.3 Update Maintenance Worker

**File:** `packages/worker/src/processors/maintenance.ts`

Same pattern as distribution worker - check rate limit before posting scheduled posts.

### 2.4 Handle Rate-Limited Jobs

When a post is rate-limited:
- For immediate posts: Log warning, mark as rate_limited in results
- For scheduled posts: Re-queue with delay using `retryAfterMs`

```typescript
// In maintenance worker, if rate limited:
if (result.rateLimited && result.retryAfterMs) {
  // Update delivery to retry later
  await db
    .update(postDeliveries)
    .set({
      scheduledAt: new Date(Date.now() + result.retryAfterMs),
      errorMessage: `Rate limited, retrying in ${Math.ceil(result.retryAfterMs / 60000)} minutes`,
    })
    .where(eq(postDeliveries.id, delivery.id));
}
```

### 2.5 Implementation Checklist

- [ ] Add `rateLimiter` to DistributionDeps type
- [ ] Add `rateLimiter` to MaintenanceDeps type
- [ ] Create rate limiter in worker/index.ts
- [ ] Pass rate limiter to both workers
- [ ] Check rate limit before posting in distribution.ts
- [ ] Check rate limit before posting in maintenance.ts
- [ ] Handle rate-limited scheduled posts (re-queue with delay)

---

## Phase 3: API Endpoint for Usage Stats

### 3.1 Add Usage Endpoint

**File:** `packages/api/src/routes/social-accounts.ts`

```typescript
// GET /social-accounts/usage - Get rate limit usage for all platforms
app.get("/social-accounts/usage", { preHandler: deps.requireApiKey }, async () => {
  // Get all active platforms with their limits
  const accounts = await deps.db
    .select({
      platform: socialAccounts.platform,
      limit: socialAccounts.rateLimitPerHour,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.isActive, true));

  // Get current usage from Redis for each platform
  const usage = await Promise.all(
    accounts.map(async (acc) => {
      const key = `rate_limit:${acc.platform}`;
      const now = Date.now();
      const windowStart = now - 60 * 60 * 1000;

      // Clean old entries and count
      await deps.redis.zremrangebyscore(key, 0, windowStart);
      const current = await deps.redis.zcard(key);

      return {
        platform: acc.platform,
        current,
        limit: acc.limit,
        percentage: Math.round((current / acc.limit) * 100),
        status: current >= acc.limit ? "blocked" : current >= acc.limit * 0.8 ? "warning" : "ok",
      };
    })
  );

  return { usage };
});
```

### 3.2 Pass Redis to API

**File:** `packages/api/src/server.ts`

```typescript
// Add Redis to ApiDeps
export type ApiDeps = {
  db: Database;
  requireApiKey: preHandlerHookHandler;
  redis: Redis; // NEW
};
```

### 3.3 Implementation Checklist

- [ ] Add Redis to ApiDeps type in server.ts
- [ ] Pass Redis instance when creating API server
- [ ] Add `GET /social-accounts/usage` endpoint
- [ ] Return current/limit/percentage/status for each platform

---

## Phase 4: UI Usage Indicator

### 4.1 Add API Function

**File:** `packages/frontend/src/api.ts`

```typescript
export type PlatformUsage = {
  platform: string;
  current: number;
  limit: number;
  percentage: number;
  status: "ok" | "warning" | "blocked";
};

export const getSocialAccountsUsage = async (): Promise<{ usage: PlatformUsage[] }> => {
  const res = await fetch(`${API_URL}/social-accounts/usage`, {
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) {
    throw new Error("Failed to load usage stats");
  }
  return res.json();
};
```

### 4.2 Update ScoringRules.tsx

**File:** `packages/frontend/src/pages/ScoringRules.tsx`

Add usage indicator next to each platform toggle:

```tsx
// Add state
const [platformUsage, setPlatformUsage] = useState<Record<string, PlatformUsage>>({});

// Load usage on mount and periodically
useEffect(() => {
  const loadUsage = async () => {
    try {
      const { usage } = await getSocialAccountsUsage();
      const byPlatform = Object.fromEntries(usage.map(u => [u.platform, u]));
      setPlatformUsage(byPlatform);
    } catch {
      // Silent fail
    }
  };
  loadUsage();
  const interval = setInterval(loadUsage, 30000); // Refresh every 30s
  return () => clearInterval(interval);
}, []);

// Usage indicator component
const UsageIndicator = ({ platform }: { platform: string }) => {
  const usage = platformUsage[platform];
  if (!usage) return null;

  const colorClass = {
    ok: "text-emerald-400",
    warning: "text-amber-400",
    blocked: "text-red-400",
  }[usage.status];

  return (
    <span className={`text-xs ${colorClass}`}>
      {usage.current}/{usage.limit}/hr
      {usage.status === "blocked" && " (limit reached)"}
    </span>
  );
};

// Add to each platform toggle section:
<div className="flex items-center justify-between ...">
  <div className="flex items-center gap-3">
    <span className="text-lg">📨</span>
    <div>
      <p className="text-sm font-medium text-slate-200">Telegram</p>
      <p className="text-xs text-slate-500">Post to connected Telegram channel</p>
      <UsageIndicator platform="telegram" /> {/* NEW */}
    </div>
  </div>
  {/* toggle button */}
</div>
```

### 4.3 Implementation Checklist

- [ ] Add `getSocialAccountsUsage` to api.ts
- [ ] Add `PlatformUsage` type to api.ts
- [ ] Add usage state to ScoringRules.tsx
- [ ] Create UsageIndicator component
- [ ] Add indicator to each platform toggle
- [ ] Auto-refresh usage every 30 seconds
- [ ] Style based on status (ok=green, warning=amber, blocked=red)

---

## Phase 5: Provider Timeouts

### 5.1 Add Timeout to Facebook Provider

**File:** `packages/social/src/providers/facebook.ts`

```typescript
// Add at top of file
const DEFAULT_TIMEOUT_MS = 30_000;

// Add timeout helper (copy from telegram.ts)
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

// Update config type
export type FacebookConfig = {
  pageId: string;
  accessToken: string;
  timeoutMs?: number; // NEW
};

// In createFacebookProvider:
const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

// Replace fetch() with fetchWithTimeout():
const response = await fetchWithTimeout(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body),
}, timeoutMs);

// Handle AbortError in catch block
catch (err) {
  let error: string;
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      error = `Request timeout after ${timeoutMs}ms`;
    } else {
      error = err.message;
    }
  } else {
    error = "Unknown error";
  }
  // ...
}
```

### 5.2 Add Timeout to LinkedIn Provider

**File:** `packages/social/src/providers/linkedin.ts`

Same pattern as Facebook - add `fetchWithTimeout` and handle AbortError.

### 5.3 Implementation Checklist

- [ ] Add `fetchWithTimeout` helper to facebook.ts
- [ ] Add `timeoutMs` to FacebookConfig
- [ ] Use fetchWithTimeout in Facebook post()
- [ ] Handle AbortError in Facebook catch block
- [ ] Add `fetchWithTimeout` helper to linkedin.ts
- [ ] Add `timeoutMs` to LinkedInConfig
- [ ] Use fetchWithTimeout in LinkedIn post()
- [ ] Handle AbortError in LinkedIn catch block

---

## Phase 6: Update Seed Defaults

### 6.1 Update seed.sql

**File:** `packages/db/seed.sql`

```sql
-- Update rate limits to match official platform limits
INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour)
SELECT 'telegram', 'Primary Telegram Channel', '{}'::jsonb, true, 20  -- Very generous
WHERE NOT EXISTS (SELECT 1 FROM social_accounts WHERE platform = 'telegram');

INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour)
SELECT 'facebook', 'Company Facebook Page', '{}'::jsonb, true, 1  -- Conservative (25/day)
WHERE NOT EXISTS (SELECT 1 FROM social_accounts WHERE platform = 'facebook');

INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour)
SELECT 'linkedin', 'Company LinkedIn Page', '{}'::jsonb, true, 4  -- Safe (100/day)
WHERE NOT EXISTS (SELECT 1 FROM social_accounts WHERE platform = 'linkedin');
```

### 6.2 SQL to Update Existing Data

```sql
-- Run manually to update existing records
UPDATE social_accounts SET rate_limit_per_hour = 20 WHERE platform = 'telegram';
UPDATE social_accounts SET rate_limit_per_hour = 1 WHERE platform = 'facebook';
UPDATE social_accounts SET rate_limit_per_hour = 4 WHERE platform = 'linkedin';
```

### 6.3 Implementation Checklist

- [ ] Update seed.sql with realistic defaults
- [ ] Document SQL for updating existing data

---

## Phase 7: LinkedIn API Review (Optional)

### 7.1 Check ugcPosts Deprecation

LinkedIn deprecated `ugcPosts` in favor of the Posts API. Check if we need to migrate.

**Current:** `POST /v2/ugcPosts`
**New:** `POST /rest/posts` (Community Management API)

Research:
- [ ] Check LinkedIn API changelog for ugcPosts status
- [ ] Test if ugcPosts still works for organization posting
- [ ] If deprecated, migrate to Posts API

### 7.2 Migration (if needed)

```typescript
// New LinkedIn Posts API format
const postBody = {
  author: `urn:li:organization:${organizationId}`,
  commentary: textWithoutUrl,
  visibility: "PUBLIC",
  distribution: {
    feedDistribution: "MAIN_FEED",
  },
  content: urlMatch ? {
    article: {
      source: urlMatch[0],
      title: article.title,
    }
  } : undefined,
  lifecycleState: "PUBLISHED",
};

const response = await fetch("https://api.linkedin.com/rest/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": "202401",
    "X-Restli-Protocol-Version": "2.0.0",
  },
  body: JSON.stringify(postBody),
});
```

---

## Files Summary

| Action | Package | File |
|--------|---------|------|
| Create | worker | `src/utils/rate-limiter.ts` |
| Modify | worker | `src/index.ts` (pass rateLimiter) |
| Modify | worker | `src/processors/distribution.ts` (check rate limit) |
| Modify | worker | `src/processors/maintenance.ts` (check rate limit) |
| Modify | api | `src/server.ts` (add Redis to deps) |
| Modify | api | `src/routes/social-accounts.ts` (add usage endpoint) |
| Modify | frontend | `src/api.ts` (add usage API) |
| Modify | frontend | `src/pages/ScoringRules.tsx` (add usage indicator) |
| Modify | social | `src/providers/facebook.ts` (add timeout) |
| Modify | social | `src/providers/linkedin.ts` (add timeout) |
| Modify | db | `seed.sql` (update defaults) |

## Testing Checklist

- [ ] Rate limiter blocks when limit reached
- [ ] Rate limiter allows after window expires
- [ ] Distribution worker respects rate limits
- [ ] Maintenance worker respects rate limits
- [ ] Scheduled posts re-queue when rate limited
- [ ] API returns correct usage stats
- [ ] UI shows usage indicator
- [ ] UI updates usage periodically
- [ ] Facebook timeout works (test with slow network)
- [ ] LinkedIn timeout works
- [ ] Telegram still works (regression test)

## Context From Previous Chat

### Critical Bug Fixed
- Config key mismatch was fixed: now consistently uses `auto_post_${platform}` everywhere
- Files updated: `distribution.ts`, `seed.sql`
- User needs to run SQL to rename existing keys:
  ```sql
  UPDATE app_config SET key = 'auto_post_telegram' WHERE key = 'telegram_auto_post_enabled';
  UPDATE app_config SET key = 'auto_post_facebook' WHERE key = 'facebook_auto_post_enabled';
  UPDATE app_config SET key = 'auto_post_linkedin' WHERE key = 'linkedin_auto_post_enabled';
  ```

### Post Templates
- Saved to `social_accounts.post_template` (JSONB)
- API: `PUT /social-accounts/:id/template`

### Different Post Formats Per Platform
- Telegram: HTML with `<b>`, `<a>` tags
- Facebook: Plain text, relies on link preview
- LinkedIn: Plain text with article card
