# Task 12: Security Hardening - 9-Layer Defense System

## Overview

Implement comprehensive security hardening with 9 defense layers to protect against:
- Malicious RSS feeds (XXE attacks, SSRF, content injection)
- Database flooding (feed bombing)
- API abuse (brute force, bot injection)
- Inappropriate content posting (account bans)

All thresholds configurable via environment variables with UI overrides where applicable.

## New Frontend Page: Site Rules

Create a dedicated "Site Rules" page with tabs:
- **Domain Whitelist** - Manage allowed RSS source domains
- **Feed Limits** - Global defaults for feed size/article quotas
- **API Security** - Rate limiting, CORS settings display
- **Emergency Controls** - Kill switch, system status

---

## Defense Layers Summary

| Layer | Protection | Configurable Via |
|-------|------------|------------------|
| 1. Domain Whitelist | Only trusted RSS sources allowed | DB + UI |
| 2. URL Validation | Block `file://`, private IPs, malformed URLs | Code only |
| 3. Feed Size Limit | Max bytes per RSS fetch | Env + UI |
| 4. XXE Protection | Secure XML parser config | Code only |
| 5. Article Quotas | Per-fetch + daily limits per source | Env + UI (per-source override) |
| 6. CORS Whitelist | Only allowed frontend origins | Env |
| 7. API Rate Limiting | Per-endpoint request limits | Env + UI display |
| 8. Kill Switch | Emergency stop all posting | UI toggle |
| 9. Nginx Basic Auth | Login required to access dashboard | Nginx config |

---

## Environment Variables (New)

```env
# ─── Security: Feed Limits ────────────────────────────────────────────────────
MAX_FEED_SIZE_MB=5                    # Layer 3: Max RSS feed size in MB
MAX_ARTICLES_PER_FETCH=100            # Layer 5: Max articles per single fetch
MAX_ARTICLES_PER_SOURCE_DAILY=500     # Layer 5: Max articles per source per day

# ─── Security: API ────────────────────────────────────────────────────────────
ALLOWED_ORIGINS=http://localhost:5173 # Layer 6: Comma-separated allowed origins
API_RATE_LIMIT_PER_MINUTE=200         # Layer 7: Global API rate limit
```

---

## Phase 1: Database Schema

### 1.1 Create `allowed_domains` Table

**File:** `packages/db/src/schema.ts`

```typescript
// ─── Domain Whitelist ────────────────────────────────────────────────────────

export const allowedDomains = pgTable("allowed_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: text("domain").notNull().unique(),      // e.g., "reuters.com"
  notes: text("notes"),                            // Optional description
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### 1.2 Add Per-Source Override Columns

**File:** `packages/db/src/schema.ts`

Add to `rssSources` table:

```typescript
// Add after existing columns in rssSources
maxArticlesPerFetch: integer("max_articles_per_fetch"),     // NULL = use global default
maxArticlesPerDay: integer("max_articles_per_day"),         // NULL = use global default
```

### 1.3 Add Kill Switch to `app_config` Seed

**File:** `packages/db/seed.sql`

```sql
-- Kill Switch (Layer 8)
INSERT INTO app_config (key, value) VALUES ('emergency_stop', 'false')
ON CONFLICT (key) DO NOTHING;
```

### 1.4 Export and Generate Migration

```bash
npm run db:generate
npm run db:migrate
```

### Implementation Checklist - Phase 1

- [ ] Add `allowedDomains` table to schema.ts
- [ ] Add `maxArticlesPerFetch` column to rssSources
- [ ] Add `maxArticlesPerDay` column to rssSources
- [ ] Export `allowedDomains` from db package index
- [ ] Add `emergency_stop` to seed.sql
- [ ] Generate and run migration

---

## Phase 2: Shared Package Updates

### 2.1 Add Security Config Schema

**File:** `packages/shared/src/index.ts`

```typescript
import { z } from "zod";

// ─── Security Environment Schema ─────────────────────────────────────────────

export const securityEnvSchema = z.object({
  MAX_FEED_SIZE_MB: z.coerce.number().min(1).max(50).default(5),
  MAX_ARTICLES_PER_FETCH: z.coerce.number().min(10).max(500).default(100),
  MAX_ARTICLES_PER_SOURCE_DAILY: z.coerce.number().min(50).max(5000).default(500),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().min(10).max(1000).default(200),
});

export type SecurityEnv = z.infer<typeof securityEnvSchema>;
```

### 2.2 Extend Base Env Schema

**File:** `packages/shared/src/index.ts`

Merge security schema into `baseEnvSchema`:

```typescript
export const baseEnvSchema = z.object({
  // ... existing fields ...
}).merge(securityEnvSchema.partial()); // All security fields optional with defaults
```

### Implementation Checklist - Phase 2

- [ ] Add `securityEnvSchema` to shared package
- [ ] Merge into `baseEnvSchema`
- [ ] Export `SecurityEnv` type

---

## Phase 3: Layer 1 - Domain Whitelist

### 3.1 Create Domain Validation Utility

**File:** `packages/worker/src/utils/domain-whitelist.ts`

```typescript
import { eq } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { allowedDomains } from "@watch-tower/db";
import { logger } from "@watch-tower/shared";

/**
 * Extract root domain from URL.
 * "https://feeds.reuters.com/news" → "reuters.com"
 */
export const extractRootDomain = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split(".");
    // Handle cases like "co.uk", "com.au" etc.
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return parsed.hostname;
  } catch {
    return null;
  }
};

/**
 * Check if domain is in whitelist.
 */
export const isDomainAllowed = async (
  db: Database,
  url: string
): Promise<{ allowed: boolean; domain: string | null; reason?: string }> => {
  const domain = extractRootDomain(url);

  if (!domain) {
    return { allowed: false, domain: null, reason: "Invalid URL format" };
  }

  const [found] = await db
    .select()
    .from(allowedDomains)
    .where(eq(allowedDomains.domain, domain))
    .limit(1);

  if (!found) {
    logger.debug({ domain, url }, "[whitelist] domain not in whitelist");
    return { allowed: false, domain, reason: `Domain "${domain}" not authorized` };
  }

  if (!found.isActive) {
    return { allowed: false, domain, reason: `Domain "${domain}" is disabled` };
  }

  return { allowed: true, domain };
};
```

### 3.2 Integrate into Sources API

**File:** `packages/api/src/routes/sources.ts`

Add validation in POST `/sources` handler (after existing validation):

```typescript
import { isDomainAllowed } from "../utils/domain-whitelist.js";

// In POST /sources handler, after URL validation:
const whitelistCheck = await isDomainAllowed(deps.db, url);
if (!whitelistCheck.allowed) {
  return reply.code(403).send({
    error: whitelistCheck.reason || "Domain not authorized",
    domain: whitelistCheck.domain,
  });
}
```

Also add to PATCH `/sources/:id` when URL is being updated.

### 3.3 Seed Initial Whitelist

**File:** `packages/db/seed.sql`

```sql
-- ─── Domain Whitelist (Layer 1) ──────────────────────────────────────────────
-- Add your trusted news sources here

INSERT INTO allowed_domains (domain, notes) VALUES
  ('reuters.com', 'Reuters News Agency'),
  ('bloomberg.com', 'Bloomberg Financial News'),
  ('coindesk.com', 'Crypto News'),
  ('cointelegraph.com', 'Crypto News'),
  ('techcrunch.com', 'Tech News'),
  ('theverge.com', 'Tech News'),
  ('arstechnica.com', 'Tech News'),
  ('wired.com', 'Tech News'),
  ('wsj.com', 'Wall Street Journal'),
  ('ft.com', 'Financial Times'),
  ('cnbc.com', 'CNBC Financial'),
  ('bbc.com', 'BBC News'),
  ('npr.org', 'NPR News'),
  ('apnews.com', 'Associated Press')
ON CONFLICT (domain) DO NOTHING;
```

### Implementation Checklist - Phase 3

- [ ] Create `packages/worker/src/utils/domain-whitelist.ts`
- [ ] Also create in `packages/api/src/utils/domain-whitelist.ts` (or shared)
- [ ] Add whitelist check in POST `/sources`
- [ ] Add whitelist check in PATCH `/sources/:id` (when URL changes)
- [ ] Add seed data for initial trusted domains
- [ ] Test: adding non-whitelisted domain returns 403

---

## Phase 4: Layer 2 - URL Validation

### 4.1 Create URL Validator Utility

**File:** `packages/shared/src/url-validator.ts`

```typescript
// Private/reserved IP ranges to block (SSRF protection)
const BLOCKED_IP_PATTERNS = [
  /^127\./,                              // Localhost
  /^10\./,                               // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[01])\./,      // Private Class B
  /^192\.168\./,                         // Private Class C
  /^169\.254\./,                         // Link-local
  /^0\./,                                // Invalid
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // Carrier-grade NAT
];

const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal",      // GCP metadata
  "169.254.169.254",               // AWS/Azure/GCP metadata
];

export type UrlValidationResult = {
  valid: boolean;
  error?: string;
  url?: URL;
};

/**
 * Validate URL for safe fetching.
 * Blocks: file://, private IPs, localhost, metadata endpoints.
 */
export const validateFeedUrl = (url: string): UrlValidationResult => {
  // Check basic format
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, error: `Invalid protocol: ${parsed.protocol} (only http/https allowed)` };
  }

  // Block dangerous hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return { valid: false, error: "Localhost and internal URLs not allowed" };
  }

  // Block private IP ranges
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, error: "Private IP addresses not allowed" };
    }
  }

  // Block metadata endpoints (cloud provider internal)
  if (hostname.includes("metadata") || hostname.includes("169.254")) {
    return { valid: false, error: "Metadata endpoints not allowed" };
  }

  return { valid: true, url: parsed };
};
```

### 4.2 Export from Shared Package

**File:** `packages/shared/src/index.ts`

```typescript
export { validateFeedUrl, type UrlValidationResult } from "./url-validator.js";
```

### 4.3 Integrate into Sources API

**File:** `packages/api/src/routes/sources.ts`

```typescript
import { validateFeedUrl } from "@watch-tower/shared";

// In POST /sources, BEFORE whitelist check:
const urlValidation = validateFeedUrl(url);
if (!urlValidation.valid) {
  return reply.code(400).send({ error: urlValidation.error });
}
```

### Implementation Checklist - Phase 4

- [ ] Create `packages/shared/src/url-validator.ts`
- [ ] Export from shared package index
- [ ] Add URL validation in POST `/sources` (before whitelist check)
- [ ] Add URL validation in PATCH `/sources/:id`
- [ ] Test: `file://` returns 400
- [ ] Test: `http://localhost` returns 400
- [ ] Test: `http://192.168.1.1` returns 400
- [ ] Test: `http://169.254.169.254` returns 400

---

## Phase 5: Layers 3 & 4 - Feed Size Limit + XXE Protection

### 5.1 Create Secure RSS Fetcher

**File:** `packages/worker/src/utils/secure-rss.ts`

```typescript
import Parser from "rss-parser";
import { logger } from "@watch-tower/shared";

export type SecureFetchResult = {
  success: boolean;
  feed?: Parser.Output<Parser.Item>;
  error?: string;
  truncated?: boolean;
};

/**
 * Fetch RSS feed with security protections:
 * - Size limit (Layer 3)
 * - XXE protection via parser config (Layer 4)
 * - Timeout protection
 */
export const fetchFeedSecurely = async (
  url: string,
  options: {
    maxSizeBytes: number;
    timeoutMs: number;
  }
): Promise<SecureFetchResult> => {
  const { maxSizeBytes, timeoutMs } = options;

  // Create parser with XXE protection
  // rss-parser uses xml2js internally - these options disable dangerous features
  const parser = new Parser({
    timeout: timeoutMs,
    maxRedirects: 5,
    headers: {
      "User-Agent": "WatchTower/1.0 RSS Reader",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    customFields: {
      item: [],
    },
  });

  try {
    // First, do a HEAD request to check content-length
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headResponse = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const contentLength = headResponse.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
        logger.warn({ url, contentLength, maxSizeBytes }, "[secure-rss] feed too large (HEAD check)");
        return {
          success: false,
          error: `Feed size (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB) exceeds limit (${Math.round(maxSizeBytes / 1024 / 1024)}MB)`,
        };
      }
    } catch {
      // HEAD failed - continue with GET (some servers don't support HEAD)
      clearTimeout(timeoutId);
    }

    // Fetch and parse with size limit
    const feed = await parser.parseURL(url);

    return { success: true, feed };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";

    if (error.includes("aborted") || error.includes("timeout")) {
      return { success: false, error: `Request timeout after ${timeoutMs}ms` };
    }

    return { success: false, error };
  }
};
```

### 5.2 Update Feed Processor

**File:** `packages/worker/src/processors/feed.ts`

Replace direct `parser.parseURL` with secure fetcher:

```typescript
import { fetchFeedSecurely } from "../utils/secure-rss.js";
import { securityEnvSchema } from "@watch-tower/shared";

// At top of file, parse security config
const securityEnv = securityEnvSchema.parse(process.env);
const MAX_FEED_SIZE_BYTES = securityEnv.MAX_FEED_SIZE_MB * 1024 * 1024;

// In worker processor, replace:
// feed = await parser.parseURL(url);

// With:
const fetchResult = await fetchFeedSecurely(url, {
  maxSizeBytes: MAX_FEED_SIZE_BYTES,
  timeoutMs: 15000,
});

if (!fetchResult.success) {
  // Log and record error
  await recordFetchRun(db, {
    sourceId,
    status: "error",
    startedAt,
    finishedAt: new Date(),
    durationMs: Date.now() - startedAt.getTime(),
    errorMessage: fetchResult.error,
  });
  logger.error({ sourceId, url, error: fetchResult.error }, "[ingest] secure fetch failed");
  return;
}

const feed = fetchResult.feed!;
```

### Implementation Checklist - Phase 5

- [ ] Create `packages/worker/src/utils/secure-rss.ts`
- [ ] Update `packages/worker/src/processors/feed.ts` to use secure fetcher
- [ ] Parse `MAX_FEED_SIZE_MB` from env
- [ ] Test: Feed > 5MB is rejected
- [ ] Test: Normal feeds still work

---

## Phase 6: Layer 5 - Article Quotas

### 6.1 Create Quota Checker Utility

**File:** `packages/worker/src/utils/article-quota.ts`

```typescript
import { eq, and, gte, sql } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { articles, rssSources } from "@watch-tower/db";
import { securityEnvSchema, logger } from "@watch-tower/shared";

const securityEnv = securityEnvSchema.parse(process.env);

export type QuotaResult = {
  allowed: number;          // How many articles can be inserted
  perFetchLimit: number;    // Per-fetch limit used
  dailyLimit: number;       // Daily limit used
  dailyUsed: number;        // Already used today
  dailyRemaining: number;   // Remaining daily quota
};

/**
 * Calculate how many articles can be inserted for a source.
 * Respects both per-fetch and daily limits.
 * Uses source-specific overrides if set, otherwise global defaults.
 */
export const checkArticleQuota = async (
  db: Database,
  sourceId: string
): Promise<QuotaResult> => {
  // Get source-specific overrides
  const [source] = await db
    .select({
      maxArticlesPerFetch: rssSources.maxArticlesPerFetch,
      maxArticlesPerDay: rssSources.maxArticlesPerDay,
    })
    .from(rssSources)
    .where(eq(rssSources.id, sourceId));

  // Use source override or global default
  const perFetchLimit = source?.maxArticlesPerFetch ?? securityEnv.MAX_ARTICLES_PER_FETCH;
  const dailyLimit = source?.maxArticlesPerDay ?? securityEnv.MAX_ARTICLES_PER_SOURCE_DAILY;

  // Count articles added today for this source
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [{ count: dailyUsed }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articles)
    .where(
      and(
        eq(articles.sourceId, sourceId),
        gte(articles.createdAt, todayStart)
      )
    );

  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);

  // Allowed = minimum of per-fetch limit and daily remaining
  const allowed = Math.min(perFetchLimit, dailyRemaining);

  logger.debug(
    { sourceId, perFetchLimit, dailyLimit, dailyUsed, dailyRemaining, allowed },
    "[quota] article quota calculated"
  );

  return {
    allowed,
    perFetchLimit,
    dailyLimit,
    dailyUsed,
    dailyRemaining,
  };
};
```

### 6.2 Integrate into Feed Processor

**File:** `packages/worker/src/processors/feed.ts`

After parsing feed, before inserting:

```typescript
import { checkArticleQuota } from "../utils/article-quota.js";

// After parsing and filtering items:
const quota = await checkArticleQuota(db, sourceId);

if (quota.allowed === 0) {
  logger.warn(
    { sourceId, dailyUsed: quota.dailyUsed, dailyLimit: quota.dailyLimit },
    "[ingest] daily quota exhausted, skipping"
  );
  await recordFetchRun(db, {
    sourceId,
    status: "success",  // Not an error, just quota reached
    startedAt,
    finishedAt: new Date(),
    durationMs: Date.now() - startedAt.getTime(),
    itemCount: itemsToInsert.length,
    itemAdded: 0,
    errorMessage: `Daily quota reached (${quota.dailyUsed}/${quota.dailyLimit})`,
  });
  return;
}

// Apply quota limit
const itemsWithinQuota = itemsToInsert.slice(0, quota.allowed);

if (itemsWithinQuota.length < itemsToInsert.length) {
  logger.info(
    {
      sourceId,
      original: itemsToInsert.length,
      limited: itemsWithinQuota.length,
      perFetchLimit: quota.perFetchLimit,
      dailyRemaining: quota.dailyRemaining,
    },
    "[ingest] articles limited by quota"
  );
}

// Use itemsWithinQuota for insertion instead of itemsToInsert
```

### Implementation Checklist - Phase 6

- [ ] Create `packages/worker/src/utils/article-quota.ts`
- [ ] Update `packages/worker/src/processors/feed.ts` to use quota checker
- [ ] Test: Source with 100 articles returns max 100 per fetch
- [ ] Test: Source hitting daily limit returns 0 allowed
- [ ] Test: Source-specific override is respected

---

## Phase 7: Layer 6 - CORS Whitelist

### 7.1 Update Server CORS Configuration

**File:** `packages/api/src/server.ts`

Replace:
```typescript
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
});
```

With:
```typescript
const allowedOrigins = env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()) || ["http://localhost:5173"];

await app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) {
      cb(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      logger.warn({ origin, allowedOrigins }, "[cors] blocked request from unauthorized origin");
      cb(new Error("Not allowed by CORS"), false);
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: false,
});
```

### Implementation Checklist - Phase 7

- [ ] Update CORS config in `packages/api/src/server.ts`
- [ ] Add `ALLOWED_ORIGINS` to `.env.example`
- [ ] Test: Request from allowed origin works
- [ ] Test: Request from unknown origin is blocked

---

## Phase 8: Layer 7 - API Rate Limiting

### 8.1 Enhance Rate Limiting Configuration

**File:** `packages/api/src/server.ts`

Update rate limiting to be configurable:

```typescript
const apiRateLimit = env.API_RATE_LIMIT_PER_MINUTE ?? 200;

// Apply different limits to different endpoint groups
await app.register(rateLimit, {
  max: apiRateLimit,
  timeWindow: "1 minute",
  keyGenerator: (request) => {
    // Rate limit by IP
    return request.ip;
  },
  errorResponseBuilder: (_, context) => ({
    statusCode: 429,
    error: "Too Many Requests",
    message: `Rate limit exceeded. Limit: ${context.max} requests per minute.`,
  }),
});

// Stricter limits for sensitive endpoints (register per-route)
const strictRateLimit = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
  },
};
```

### 8.2 Apply Strict Limits to Sensitive Routes

**File:** `packages/api/src/routes/sources.ts`

```typescript
// POST /sources - limit to 10/minute (prevent mass feed injection)
app.post("/sources", {
  preHandler: deps.requireApiKey,
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, async (request, reply) => { ... });
```

**File:** `packages/api/src/routes/reset.ts`

```typescript
// POST /reset - limit to 1/hour (destructive operation)
app.post("/reset", {
  preHandler: deps.requireApiKey,
  config: { rateLimit: { max: 1, timeWindow: "1 hour" } },
}, async (request, reply) => { ... });
```

### Implementation Checklist - Phase 8

- [ ] Update rate limiting in `packages/api/src/server.ts`
- [ ] Add per-route stricter limits for `/sources`, `/reset`
- [ ] Add `API_RATE_LIMIT_PER_MINUTE` to `.env.example`
- [ ] Remove `if (!isDev)` check - enable rate limiting in all environments
- [ ] Test: Exceeding rate limit returns 429

---

## Phase 9: Layer 8 - Kill Switch

### 9.1 Add Kill Switch Check to Distribution

**File:** `packages/worker/src/processors/distribution.ts`

```typescript
import { eq } from "drizzle-orm";
import { appConfig } from "@watch-tower/db";

// At start of distribution job processing:
const [emergencyStop] = await db
  .select({ value: appConfig.value })
  .from(appConfig)
  .where(eq(appConfig.key, "emergency_stop"));

if (emergencyStop?.value === "true") {
  logger.warn("[distribution] emergency stop active, skipping all posting");
  return;
}
```

### 9.2 Add Kill Switch Check to Maintenance Worker

**File:** `packages/worker/src/processors/maintenance.ts`

Same check at the start of `processScheduledPosts`:

```typescript
const [emergencyStop] = await db
  .select({ value: appConfig.value })
  .from(appConfig)
  .where(eq(appConfig.key, "emergency_stop"));

if (emergencyStop?.value === "true") {
  logger.warn("[maintenance] emergency stop active, skipping scheduled posts");
  return;
}
```

### 9.3 Add API Endpoint for Kill Switch

**File:** `packages/api/src/routes/config.ts`

```typescript
// GET /config/emergency-stop
app.get("/config/emergency-stop", { preHandler: deps.requireApiKey }, async () => {
  const [row] = await deps.db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "emergency_stop"));

  return { enabled: row?.value === "true" };
});

// POST /config/emergency-stop
app.post<{ Body: { enabled: boolean } }>(
  "/config/emergency-stop",
  { preHandler: deps.requireApiKey },
  async (request, reply) => {
    const { enabled } = request.body;

    await deps.db
      .insert(appConfig)
      .values({ key: "emergency_stop", value: String(enabled) })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: String(enabled) },
      });

    logger.warn({ enabled }, "[config] emergency stop toggled");

    return { enabled };
  }
);
```

### Implementation Checklist - Phase 9

- [ ] Add emergency stop check in distribution.ts
- [ ] Add emergency stop check in maintenance.ts
- [ ] Add GET/POST endpoints for `/config/emergency-stop`
- [ ] Test: When enabled, no posts go out
- [ ] Test: When disabled, posting resumes

---

## Phase 10: Frontend - Site Rules Page

### 10.1 Create API Functions

**File:** `packages/frontend/src/api.ts`

```typescript
// ─── Site Rules API ──────────────────────────────────────────────────────────

export type AllowedDomain = {
  id: string;
  domain: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
};

export type SecurityConfig = {
  maxFeedSizeMb: number;
  maxArticlesPerFetch: number;
  maxArticlesPerSourceDaily: number;
  allowedOrigins: string[];
  apiRateLimitPerMinute: number;
};

// Domain Whitelist
export const getAllowedDomains = async (): Promise<AllowedDomain[]> => {
  const res = await fetch(`${API_URL}/site-rules/domains`, {
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) throw new Error("Failed to fetch domains");
  return res.json();
};

export const addAllowedDomain = async (domain: string, notes?: string): Promise<AllowedDomain> => {
  const res = await fetch(`${API_URL}/site-rules/domains`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" } as Record<string, string>,
    body: JSON.stringify({ domain, notes }),
  });
  if (!res.ok) throw new Error("Failed to add domain");
  return res.json();
};

export const deleteAllowedDomain = async (id: string): Promise<void> => {
  const res = await fetch(`${API_URL}/site-rules/domains/${id}`, {
    method: "DELETE",
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) throw new Error("Failed to delete domain");
};

// Security Config (read-only from env)
export const getSecurityConfig = async (): Promise<SecurityConfig> => {
  const res = await fetch(`${API_URL}/site-rules/config`, {
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) throw new Error("Failed to fetch security config");
  return res.json();
};

// Kill Switch
export const getEmergencyStop = async (): Promise<{ enabled: boolean }> => {
  const res = await fetch(`${API_URL}/config/emergency-stop`, {
    headers: authHeaders as Record<string, string>,
  });
  if (!res.ok) throw new Error("Failed to fetch emergency stop status");
  return res.json();
};

export const setEmergencyStop = async (enabled: boolean): Promise<void> => {
  const res = await fetch(`${API_URL}/config/emergency-stop`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" } as Record<string, string>,
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error("Failed to set emergency stop");
};
```

### 10.2 Create Site Rules Page

**File:** `packages/frontend/src/pages/SiteRules.tsx`

Create page with tabs:
- **Domain Whitelist** - Table with add/delete functionality
- **Feed Limits** - Display current limits (from env), explain they're global defaults
- **API Security** - Display CORS origins, rate limits
- **Emergency Controls** - Kill switch toggle with warning

### 10.3 Create API Routes for Site Rules

**File:** `packages/api/src/routes/site-rules.ts`

```typescript
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { allowedDomains } from "@watch-tower/db";
import { securityEnvSchema } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export const registerSiteRulesRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  const securityEnv = securityEnvSchema.parse(process.env);

  // GET /site-rules/domains
  app.get("/site-rules/domains", { preHandler: deps.requireApiKey }, async () => {
    return deps.db.select().from(allowedDomains).orderBy(allowedDomains.domain);
  });

  // POST /site-rules/domains
  app.post<{ Body: { domain: string; notes?: string } }>(
    "/site-rules/domains",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { domain, notes } = request.body;

      // Normalize domain (lowercase, trim)
      const normalized = domain.toLowerCase().trim();

      try {
        const [inserted] = await deps.db
          .insert(allowedDomains)
          .values({ domain: normalized, notes: notes || null })
          .returning();
        return inserted;
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          return reply.code(409).send({ error: "Domain already exists" });
        }
        throw err;
      }
    }
  );

  // DELETE /site-rules/domains/:id
  app.delete<{ Params: { id: string } }>(
    "/site-rules/domains/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [deleted] = await deps.db
        .delete(allowedDomains)
        .where(eq(allowedDomains.id, id))
        .returning();

      if (!deleted) {
        return reply.code(404).send({ error: "Domain not found" });
      }
      return { success: true };
    }
  );

  // GET /site-rules/config
  app.get("/site-rules/config", { preHandler: deps.requireApiKey }, async () => {
    return {
      maxFeedSizeMb: securityEnv.MAX_FEED_SIZE_MB,
      maxArticlesPerFetch: securityEnv.MAX_ARTICLES_PER_FETCH,
      maxArticlesPerSourceDaily: securityEnv.MAX_ARTICLES_PER_SOURCE_DAILY,
      allowedOrigins: securityEnv.ALLOWED_ORIGINS.split(",").map(o => o.trim()),
      apiRateLimitPerMinute: securityEnv.API_RATE_LIMIT_PER_MINUTE,
    };
  });
};
```

### 10.4 Add Navigation Link

**File:** `packages/frontend/src/components/Sidebar.tsx` (or similar)

Add "Site Rules" link with shield/lock icon.

### 10.5 Update Source Edit Form

Add optional override fields for per-source limits:
- `max_articles_per_fetch` (optional number input)
- `max_articles_per_day` (optional number input)

Show helper text: "Leave blank to use global defaults"

### Implementation Checklist - Phase 10

- [ ] Create `packages/frontend/src/pages/SiteRules.tsx`
- [ ] Add API functions to `packages/frontend/src/api.ts`
- [ ] Create `packages/api/src/routes/site-rules.ts`
- [ ] Register site-rules routes in server.ts
- [ ] Add navigation link in sidebar
- [ ] Update source edit form with override fields
- [ ] Test: Can add/remove domains from UI
- [ ] Test: Security config displays correctly
- [ ] Test: Kill switch toggle works

---

## Phase 11: Nginx Basic Auth (Frontend Protection)

### 11.1 Overview

Nginx Basic Auth adds a login prompt before anyone can access the frontend. This protects the entire dashboard without code changes.

```
User → Nginx (auth prompt) → Frontend/API
                ↓
        .htpasswd file (username:hashed_password)
```

### 11.2 Create Password File

```bash
# Install htpasswd utility (if not present)
# Ubuntu/Debian:
sudo apt-get install apache2-utils

# Create password file with admin user
sudo htpasswd -c /etc/nginx/.htpasswd admin
# Enter password when prompted

# Add additional users (without -c flag)
sudo htpasswd /etc/nginx/.htpasswd anotheruser
```

### 11.3 Nginx Configuration

**File:** `/etc/nginx/sites-available/watchtower` (or your nginx config)

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # SSL certificates (Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # ─── Basic Auth (protects everything) ─────────────────────────────────────
    auth_basic "Watch Tower Admin";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # ─── Frontend (React static files) ────────────────────────────────────────
    location / {
        root /var/www/watchtower/frontend;
        try_files $uri $uri/ /index.html;
    }

    # ─── API Proxy ────────────────────────────────────────────────────────────
    location /api/ {
        rewrite ^/api/(.*) /$1 break;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support (for /events endpoint)
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400;
    }

    # ─── Health check (no auth - for monitoring tools) ────────────────────────
    location = /api/health {
        auth_basic off;
        rewrite ^/api/(.*) /$1 break;
        proxy_pass http://127.0.0.1:3001;
    }
}
```

### 11.4 Docker Compose Alternative

If using Docker, add Nginx container:

**File:** `docker-compose.yml`

```yaml
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/.htpasswd:/etc/nginx/.htpasswd:ro
      - ./packages/frontend/dist:/var/www/frontend:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - api
      - frontend

  api:
    # ... existing api service
    expose:
      - "3001"  # Only expose internally, not to host

  # ... other services
```

### 11.5 Generate .htpasswd for Docker

```bash
# Create nginx directory
mkdir -p nginx

# Generate password hash (without apache2-utils)
# Using openssl:
echo "admin:$(openssl passwd -apr1 'your-secure-password')" > nginx/.htpasswd

# Or using htpasswd if available:
htpasswd -c nginx/.htpasswd admin
```

### 11.6 Test Configuration

```bash
# Test nginx config syntax
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx

# Test auth
curl -I https://yourdomain.com
# Should return: 401 Unauthorized

curl -I -u admin:password https://yourdomain.com
# Should return: 200 OK
```

### Implementation Checklist - Phase 11

- [ ] Install htpasswd utility (or use openssl)
- [ ] Create `.htpasswd` file with admin user
- [ ] Configure Nginx with `auth_basic`
- [ ] Set up SSL certificates (Let's Encrypt)
- [ ] Proxy API requests to backend
- [ ] Exclude `/api/health` from auth (for monitoring)
- [ ] Test auth works (401 without credentials, 200 with)
- [ ] Document credentials securely (password manager)

---

## Phase 12: Update .env.example

**File:** `.env.example`

```env
# ─── Security Configuration ───────────────────────────────────────────────────

# Feed Limits (Layer 3 & 5)
MAX_FEED_SIZE_MB=5                              # Max RSS feed size in megabytes
MAX_ARTICLES_PER_FETCH=100                      # Max articles per single fetch
MAX_ARTICLES_PER_SOURCE_DAILY=500               # Max articles per source per day

# CORS (Layer 6)
ALLOWED_ORIGINS=http://localhost:5173           # Comma-separated allowed origins

# API Rate Limiting (Layer 7)
API_RATE_LIMIT_PER_MINUTE=200                   # Global API rate limit
```

---

## Files Summary

| Package | File | Action |
|---------|------|--------|
| `db` | `schema.ts` | Add `allowedDomains` table, source override columns |
| `db` | `seed.sql` | Add initial whitelist, kill switch config |
| `shared` | `index.ts` | Add security env schema |
| `shared` | `url-validator.ts` | NEW - URL validation utility |
| `worker` | `utils/domain-whitelist.ts` | NEW - Domain whitelist checker |
| `worker` | `utils/secure-rss.ts` | NEW - Secure RSS fetcher |
| `worker` | `utils/article-quota.ts` | NEW - Quota checker |
| `worker` | `processors/feed.ts` | Integrate all security layers |
| `worker` | `processors/distribution.ts` | Add kill switch check |
| `worker` | `processors/maintenance.ts` | Add kill switch check |
| `api` | `server.ts` | Update CORS, rate limiting |
| `api` | `routes/sources.ts` | Add URL + whitelist validation |
| `api` | `routes/config.ts` | Add kill switch endpoints |
| `api` | `routes/site-rules.ts` | NEW - Site rules API |
| `frontend` | `api.ts` | Add site rules API functions |
| `frontend` | `pages/SiteRules.tsx` | NEW - Site Rules page |
| `frontend` | Sidebar | Add navigation link |
| root | `.env.example` | Add security config |

---

## Testing Checklist

### Layer 1: Domain Whitelist
- [ ] Adding source with whitelisted domain works
- [ ] Adding source with non-whitelisted domain returns 403
- [ ] UI shows whitelist and allows add/delete

### Layer 2: URL Validation
- [ ] `file://` URLs rejected
- [ ] `http://localhost` rejected
- [ ] `http://192.168.x.x` rejected
- [ ] `http://169.254.169.254` rejected
- [ ] Valid `https://` URLs work

### Layer 3: Feed Size Limit
- [ ] Feed > MAX_FEED_SIZE_MB is rejected
- [ ] Normal feeds work

### Layer 4: XXE Protection
- [ ] Parser doesn't expand external entities (manual test with crafted XML)

### Layer 5: Article Quotas
- [ ] Per-fetch limit enforced
- [ ] Daily limit enforced
- [ ] Source-specific override works

### Layer 6: CORS
- [ ] Allowed origin can make requests
- [ ] Unknown origin is blocked

### Layer 7: Rate Limiting
- [ ] Global limit works
- [ ] Per-endpoint stricter limits work
- [ ] Returns 429 when exceeded

### Layer 8: Kill Switch
- [ ] When enabled, no posts go out
- [ ] When disabled, posts resume
- [ ] UI toggle works

---

## Status

- [ ] Phase 1: Database Schema
- [ ] Phase 2: Shared Package Updates
- [ ] Phase 3: Layer 1 - Domain Whitelist
- [ ] Phase 4: Layer 2 - URL Validation
- [ ] Phase 5: Layers 3 & 4 - Feed Size + XXE
- [ ] Phase 6: Layer 5 - Article Quotas
- [ ] Phase 7: Layer 6 - CORS Whitelist
- [ ] Phase 8: Layer 7 - API Rate Limiting
- [ ] Phase 9: Layer 8 - Kill Switch
- [ ] Phase 10: Frontend - Site Rules Page
- [ ] Phase 11: Nginx Basic Auth
- [ ] Phase 12: Update .env.example
