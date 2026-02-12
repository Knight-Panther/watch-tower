# Task 16: Translation Pipeline Hardening + Autopost Flood Protection

The translation (Georgian/English) and autoposting pipelines have critical gaps in error handling, retry logic, and flood protection. A code audit revealed that failed translations have no immediate retry, rate-limited social posts are silently **lost** (not rescheduled), and the first-ingest scenario can bombard platforms with dozens of posts in seconds.

**Root cause:** The translation pipeline was built for the happy path, and the distribution worker's immediate-post path lacks the retry/reschedule logic that the scheduled-post path already has.

---

## Table of Contents

1. [Findings & Current State](#1-findings--current-state)
2. [Priority 1: Fix Rate-Limited Immediate Distribution (Posts Lost)](#2-priority-1-fix-rate-limited-immediate-distribution-posts-lost)
3. [Priority 1: Add Staggering for Auto-Approved Batches](#3-priority-1-add-staggering-for-auto-approved-batches)
4. [Priority 2: Translation In-Worker Retry for Transient Errors](#4-priority-2-translation-in-worker-retry-for-transient-errors)
5. [Priority 2: Add translation_attempts Column + Max Retry Cap](#5-priority-2-add-translation_attempts-column--max-retry-cap)
6. [Priority 2: Save Translation Error to DB](#6-priority-2-save-translation-error-to-db)
7. [Priority 3: Auto-Retry posting_failed Articles](#7-priority-3-auto-retry-posting_failed-articles)
8. [Priority 3: Global Posting Flood Protection](#8-priority-3-global-posting-flood-protection)
9. [Priority 3: Reduce Failed Translation Retry Delay](#9-priority-3-reduce-failed-translation-retry-delay)
10. [Change Map](#10-change-map)
11. [Testing Checklist](#11-testing-checklist)

---

## 1. Findings & Current State

### Translation Pipeline Flow

```
LLM Brain scores article (every 10s, batch 10)
  │
  ├─ score >= threshold → pipeline_stage = 'approved'
  ├─ score <= reject    → pipeline_stage = 'rejected'
  └─ score 3-4          → pipeline_stage = 'scored' (manual review)
  │
  ▼ (every 15s, batch 10)
Translation worker claims WHERE translation_status IS NULL
  │
  ├─ translation_status = 'translating' (atomic claim)
  │
  ├─ SUCCESS → translation_status = 'translated'
  │            title_ka + llm_summary_ka saved
  │            If approved → queue distribution
  │
  └─ FAILURE → translation_status = 'failed'
               Error only logged (not in DB)
               Retry after 1 HOUR (maintenance zombie cleanup)
```

**Key files:**
| File | Purpose |
|------|---------|
| `packages/worker/src/processors/translation.ts` | Translation worker (claim, translate, queue distribution) |
| `packages/translation/src/gemini.ts` | Gemini translation provider |
| `packages/translation/src/openai.ts` | OpenAI translation provider |
| `packages/worker/src/processors/maintenance.ts:199-230` | Zombie translation cleanup (stuck + failed reset) |

### Translation Issues Found

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| T1 | Failed translations retry only after **1 hour** (maintenance zombie cleanup) | HIGH | `maintenance.ts:217-229` |
| T2 | No retry counter — permanently failing articles retry **forever**, wasting API credits | HIGH | `translation.ts` (no `translation_attempts` column) |
| T3 | Error message not saved to DB — frontend shows "Translation failed" with no reason | MEDIUM | `translation.ts:173-178` (only `logger.warn`) |
| T4 | No in-worker retry for transient errors (429, 500, network timeout) — immediately marks `failed` | HIGH | `translation.ts:160-178` |
| T5 | New `GoogleGenerativeAI` client created per call (minor perf) | LOW | `gemini.ts:19` |

### Autoposting Pipeline Flow

```
English mode:
  LLM Brain → approved → immediately queues JOB_DISTRIBUTION_IMMEDIATE
  Distribution worker (concurrency: 1) → post to each enabled platform

Georgian mode:
  LLM Brain → approved → DEFERS to translation worker
  Translation worker → translates → queues JOB_DISTRIBUTION_IMMEDIATE
  Distribution worker → checks title_ka exists → posts
```

**Key files:**
| File | Purpose |
|------|---------|
| `packages/worker/src/processors/llm-brain.ts:396-430` | Auto-approve → queue distribution |
| `packages/worker/src/processors/distribution.ts` | Immediate distribution worker |
| `packages/worker/src/processors/maintenance.ts:382-615` | Scheduled post processing |
| `packages/worker/src/utils/rate-limiter.ts` | Redis sliding window rate limiter |

### Autoposting Issues Found

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| D1 | **CRITICAL**: Rate-limited platforms are SKIPPED in immediate distribution — posts are **lost forever** | CRITICAL | `distribution.ts:241-253` |
| D2 | If Telegram succeeds but Facebook rate-limited → article marked `posted` → Facebook never gets it | CRITICAL | `distribution.ts:311-316` |
| D3 | No `post_delivery` record created for rate-limited skips — no audit trail | HIGH | `distribution.ts:280` (only reached after `provider.post()`) |
| D4 | No staggering — 15 auto-approved articles blast to Telegram in ~30 seconds | HIGH | `llm-brain.ts:414` (no `delay` option on job) |
| D5 | `posting_failed` is a dead end — articles never retried | MEDIUM | `distribution.ts:322-325`, no maintenance recovery |
| D6 | No global flood protection (e.g., `max_auto_posts_per_hour`) | MEDIUM | No config exists |

### The First-Ingest Flood — Worked Example

```
Minute 0:00 — Ingest fires, 60 articles inserted as 'ingested'
Minute 1:00 — Semantic dedup batch: 50 embedded, 10 remain
Minute 1:15 — LLM brain batch 1: 10 scored → 3 auto-approved, queued for distribution
Minute 1:25 — LLM brain batch 2: 10 scored → 2 auto-approved, queued
Minute 1:35 — LLM brain batch 3: 10 scored → 4 auto-approved, queued
...
Minute 2:00 — Dedup finishes remaining 10
Minute 2:30 — All 60 scored. Total auto-approved: ~15

Distribution queue now has 15 jobs, concurrency 1, no delay:

Telegram (20/hr limit):
  ✅ Posts 1-15 all succeed — 15 posts in ~2 minutes
  → Followers see a wall of 15 posts. Looks like spam/bot.

Facebook (1/hr limit):
  ✅ Post 1 succeeds
  ❌ Posts 2-15: rate limited → SKIPPED → LOST FOREVER

LinkedIn (4/hr limit):
  ✅ Posts 1-4 succeed
  ❌ Posts 5-15: rate limited → SKIPPED → LOST FOREVER
```

### Contrast: Scheduled Posts Handle This Correctly

The maintenance worker's `processScheduledPosts()` at `maintenance.ts:463-485` already implements proper rate-limit handling:

```typescript
// Rate-limited → reschedule with future scheduledAt
const retryAt = new Date(Date.now() + (rateCheck.retryAfterMs ?? 60000));
await db.update(postDeliveries).set({
  status: "scheduled",
  scheduledAt: retryAt,
  errorMessage: `Rate limited, retrying in ${Math.ceil(...)} minutes`,
}).where(eq(postDeliveries.id, delivery.id));
```

The immediate distribution path at `distribution.ts:241-253` does NOT do this — it just `continue`s past the platform.

---

## 2. Priority 1: Fix Rate-Limited Immediate Distribution (Posts Lost)

**Problem:** When the immediate distribution worker hits a rate limit for a platform, it skips it entirely. No `post_delivery` record is created, no reschedule happens, and if any other platform succeeds, the article is marked `posted` — the rate-limited platform never gets the article.

**Solution:** When a platform is rate-limited during immediate distribution, create a `post_delivery` row with `status: 'scheduled'` and a future `scheduledAt`. The existing maintenance worker (`processScheduledPosts`) already processes scheduled deliveries every 30 seconds — it will pick these up automatically.

### Step D1.1: Create post_delivery for rate-limited platforms

**File:** `packages/worker/src/processors/distribution.ts`

**Location:** Lines 241-253 (the rate limit `continue` block)

**Current code:**
```typescript
if (!rateCheck.allowed) {
  logger.warn(
    { articleId, platform: name, current: rateCheck.current, limit: rateCheck.limit },
    "[distribution] rate limit reached, skipping",
  );
  results.push({
    platform: name,
    success: false,
    error: `Rate limit reached (${rateCheck.current}/${rateCheck.limit}/hr)`,
    rateLimited: true,
    retryAfterMs: rateCheck.retryAfterMs,
  });
  continue;
}
```

**Change:** After pushing to `results`, insert a `post_delivery` with scheduled retry:

```typescript
if (!rateCheck.allowed) {
  const retryAfterMs = rateCheck.retryAfterMs ?? 60_000;
  const retryAt = new Date(Date.now() + retryAfterMs);

  logger.warn(
    { articleId, platform: name, current: rateCheck.current, limit: rateCheck.limit, retryAt },
    "[distribution] rate limit reached, scheduling retry via post_deliveries",
  );

  // Create a scheduled delivery so maintenance worker picks it up later
  await db.insert(postDeliveries).values({
    articleId,
    platform: name,
    scheduledAt: retryAt,
    status: "scheduled",
    errorMessage: `Rate limited (${rateCheck.current}/${rateCheck.limit}/hr), auto-scheduled retry`,
  });

  results.push({
    platform: name,
    success: false,
    error: `Rate limited — scheduled retry at ${retryAt.toISOString()}`,
    rateLimited: true,
    retryAfterMs,
  });
  continue;
}
```

### Step D1.2: Don't mark article as `posted` if some platforms are pending

**File:** `packages/worker/src/processors/distribution.ts`

**Location:** Lines 310-327 (article stage update after posting loop)

**Current code:**
```typescript
if (anySuccess) {
  await db.execute(sql`
    UPDATE articles SET pipeline_stage = 'posted', ...
    WHERE id = ${articleId}::uuid
  `);
} else if (results.length > 0) {
  await db.execute(sql`
    UPDATE articles SET pipeline_stage = 'posting_failed'
    WHERE id = ${articleId}::uuid
  `);
}
```

**Change:** Track whether any platform was deferred to scheduled delivery. If all immediate posts succeeded AND no platform was rate-limited → `posted`. If at least one succeeded but others were deferred → still `posted` (the scheduled delivery handles the rest independently). If zero succeeded and some were rate-limited (not hard-failed) → keep as `approved` so it's not a dead end.

```typescript
const anyRateLimited = results.some((r) => r.rateLimited);

if (anySuccess) {
  // At least one platform succeeded — mark posted
  // Rate-limited platforms have scheduled deliveries that will be processed independently
  await db.execute(sql`
    UPDATE articles
    SET pipeline_stage = 'posted', approved_at = COALESCE(approved_at, NOW())
    WHERE id = ${articleId}::uuid
  `);
} else if (anyRateLimited && !results.some((r) => !r.rateLimited && !r.success)) {
  // ALL failures were rate limits (no hard failures) — keep approved
  // Scheduled deliveries exist, maintenance worker will post later
  await db.execute(sql`
    UPDATE articles SET pipeline_stage = 'approved'
    WHERE id = ${articleId}::uuid
  `);
  logger.info({ articleId }, "[distribution] all platforms rate-limited, kept as approved");
} else if (results.length > 0) {
  // Hard failures on all platforms
  await db.execute(sql`
    UPDATE articles SET pipeline_stage = 'posting_failed'
    WHERE id = ${articleId}::uuid
  `);
}
```

### Step D1.3: Also handle unhealthy platform skip the same way

**File:** `packages/worker/src/processors/distribution.ts`

**Location:** Lines 227-235 (unhealthy platform skip)

Same pattern: when a platform is unhealthy, create a scheduled `post_delivery` for retry in 1 hour (matching the maintenance worker's behavior for unhealthy platforms).

```typescript
if (!isHealthy) {
  const retryAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  logger.warn({ articleId, platform: name }, "[distribution] platform unhealthy, scheduling retry");

  await db.insert(postDeliveries).values({
    articleId,
    platform: name,
    scheduledAt: retryAt,
    status: "scheduled",
    errorMessage: "Platform unhealthy, auto-scheduled retry in 1 hour",
  });

  results.push({
    platform: name,
    success: false,
    error: "Platform unhealthy — scheduled retry in 1 hour",
  });
  continue;
}
```

---

## 3. Priority 1: Add Staggering for Auto-Approved Batches

**Problem:** When LLM Brain scores a batch of 10 articles and 5 are auto-approved, all 5 `JOB_DISTRIBUTION_IMMEDIATE` jobs are queued with no delay. Even with concurrency 1, posts fire as fast as the API allows. Telegram followers see 15 posts in 2 minutes — looks like bot spam.

**Solution:** Add incremental BullMQ `delay` to each distribution job. Instead of all jobs being immediately available, they're staggered 30-60 seconds apart.

### Step D2.1: Add stagger delay in LLM Brain's distribution queueing

**File:** `packages/worker/src/processors/llm-brain.ts`

**Location:** Lines 398-429 (inside the `for (const result of successes)` loop that queues distribution)

Add a counter for how many distribution jobs are queued in this batch, and apply an incremental delay:

```typescript
// Track auto-post stagger delay across the batch
let autoPostIndex = 0;
const STAGGER_DELAY_MS = 45_000; // 45 seconds between posts

// ... inside the loop:
if (telegramEnabled) {
  const delay = autoPostIndex * STAGGER_DELAY_MS;
  await distributionQueue.add(
    JOB_DISTRIBUTION_IMMEDIATE,
    { articleId: result.articleId },
    {
      jobId: `immediate-${result.articleId}`,
      delay,
    },
  );
  autoPostIndex++;
  logger.info(
    { articleId: result.articleId, score: result.score, delayMs: delay },
    "[llm-brain] queued for immediate distribution (staggered)",
  );
}
```

### Step D2.2: Same stagger in Translation worker's distribution queueing

**File:** `packages/worker/src/processors/translation.ts`

**Location:** Lines 230-239 (inside the `for (const article of claimed)` loop, after successful translation of approved articles)

Same pattern — track a counter across the batch:

```typescript
// Track auto-post stagger across batch
let autoPostIndex = 0;
const STAGGER_DELAY_MS = 45_000;

// ... inside the success block for approved articles:
if (autoPostEnabled) {
  const delay = autoPostIndex * STAGGER_DELAY_MS;
  await distributionQueue.add(
    JOB_DISTRIBUTION_IMMEDIATE,
    { articleId: article.id },
    {
      jobId: `dist-ka-${article.id}`,
      delay,
    },
  );
  autoPostIndex++;
}
```

### Step D2.3: Add STAGGER_DELAY_MS to shared config

**File:** `packages/shared/src/index.ts` (or a new constants section)

Export the stagger constant so both workers use the same value:

```typescript
export const AUTO_POST_STAGGER_MS = 45_000; // 45s between auto-posts
```

This can later be made configurable via `app_config` if needed.

---

## 4. Priority 2: Translation In-Worker Retry for Transient Errors

**Problem:** When Gemini/OpenAI returns a transient error (HTTP 429 rate limit, 500 internal server error, network timeout), the translation worker immediately marks the article as `failed`. It won't be retried for 1 hour (maintenance zombie cleanup). For a 429 that would resolve in 10 seconds, this is extremely wasteful.

**Solution:** Add a simple retry loop (2 retries with exponential backoff) inside the translation worker before marking as `failed`.

### Step T1.1: Add retry wrapper in translation worker

**File:** `packages/worker/src/processors/translation.ts`

**Location:** Lines 160-178 (the `for (const article of claimed)` loop)

Replace the single `translate()` call with a retry loop:

```typescript
const MAX_TRANSLATION_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 5_000; // 5s, 10s

for (const article of claimed) {
  const translate = config.provider === "openai" ? translateWithOpenAI : translateWithGemini;

  let result: TranslationResult | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= MAX_TRANSLATION_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_BASE_DELAY_MS * attempt;
      logger.info(
        { articleId: article.id, attempt, delayMs },
        "[translation] retrying after transient error",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const attemptResult = await translate(
      apiKey,
      config.model,
      article.title,
      article.llmSummary,
      config.instructions || undefined,
    );

    if (!attemptResult.error || (attemptResult.titleKa && attemptResult.summaryKa)) {
      result = attemptResult;
      break; // Success
    }

    lastError = attemptResult.error ?? "Unknown error";

    // Only retry on transient-looking errors
    const isTransient =
      lastError.includes("429") ||
      lastError.includes("500") ||
      lastError.includes("503") ||
      lastError.includes("timeout") ||
      lastError.includes("ECONNRESET") ||
      lastError.includes("rate") ||
      lastError.includes("overloaded");

    if (!isTransient) {
      result = attemptResult;
      break; // Permanent error, don't retry
    }
  }

  // result is guaranteed non-null here (at least the last attempt populates it)
  if (result!.error || !result!.titleKa || !result!.summaryKa) {
    // Mark as failed (with error message — see Step T3)
    // ... existing failure handling
  } else {
    // ... existing success handling
  }
}
```

### Step T1.2: Add isTransient check to translation providers

**File:** `packages/translation/src/types.ts`

Add an optional `isTransient` flag to `TranslationResult`:

```typescript
export type TranslationResult = {
  titleKa: string | null;
  summaryKa: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  latencyMs: number;
  error?: string;
  isTransient?: boolean; // True for 429, 500, network errors
};
```

**Files:** `packages/translation/src/gemini.ts` and `packages/translation/src/openai.ts`

In the `catch` block, detect transient errors and set the flag:

```typescript
catch (err) {
  const errorMsg = err instanceof Error ? err.message : "Unknown error";
  const isTransient =
    errorMsg.includes("429") ||
    errorMsg.includes("500") ||
    errorMsg.includes("503") ||
    errorMsg.includes("timeout") ||
    errorMsg.includes("ECONNRESET") ||
    errorMsg.includes("overloaded");

  return {
    titleKa: null,
    summaryKa: null,
    error: errorMsg,
    isTransient,
    latencyMs: Date.now() - startTime,
  };
}
```

This makes the retry logic in the worker cleaner — just check `result.isTransient` instead of string matching.

---

## 5. Priority 2: Add `translation_attempts` Column + Max Retry Cap

**Problem:** There is no `translation_attempts` counter. A permanently failing article (e.g., contains characters that crash the LLM, extremely long title) will be retried every hour forever — burning API credits each time.

**Solution:** Add a `translation_attempts` column to the `articles` table. Increment on each attempt. After reaching max (e.g., 5), set `translation_status = 'exhausted'` — a permanent terminal state that maintenance never resets.

### Step T2.1: Add column to articles schema

**File:** `packages/db/src/schema.ts` (articles table definition)

Add to the articles table:

```typescript
translationAttempts: integer("translation_attempts").default(0).notNull(),
```

### Step T2.2: Generate and run migration

```bash
npm run db:generate   # Generates migration for new column
npm run db:migrate    # Applies it
```

### Step T2.3: Increment attempts in translation worker claim query

**File:** `packages/worker/src/processors/translation.ts`

**Location:** Lines 116-137 (the atomic claim UPDATE)

Change the claim query to:
1. Exclude articles with `translation_attempts >= 5`
2. Increment `translation_attempts` on claim

```sql
UPDATE articles
SET
  translation_status = 'translating',
  translation_attempts = translation_attempts + 1
WHERE id IN (
  SELECT id FROM articles
  WHERE importance_score = ANY(...)
    AND translation_status IS NULL
    AND llm_summary IS NOT NULL
    AND title_ka IS NULL
    AND scored_at IS NOT NULL
    AND created_at > ${enabledSince}
    AND translation_attempts < 5        -- NEW: cap retries
  ORDER BY created_at ASC
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING
  id, title, llm_summary, importance_score, pipeline_stage,
  translation_attempts as "translationAttempts"   -- NEW: return for logging
```

### Step T2.4: Set terminal state on max attempts

**File:** `packages/worker/src/processors/translation.ts`

In the failure handling block, check if this was the last allowed attempt:

```typescript
if (result.error || !result.titleKa || !result.summaryKa) {
  const maxAttempts = 5;
  const isExhausted = article.translationAttempts >= maxAttempts;

  await db.execute(sql`
    UPDATE articles
    SET
      translation_status = ${isExhausted ? "exhausted" : "failed"},
      translation_error = ${result.error ?? "Unknown error"}
    WHERE id = ${article.id}::uuid
  `);

  if (isExhausted) {
    logger.error(
      { articleId: article.id, attempts: article.translationAttempts },
      "[translation] max attempts reached, marking exhausted (permanent)",
    );
  }
}
```

### Step T2.5: Maintenance must NOT reset 'exhausted' translations

**File:** `packages/worker/src/processors/maintenance.ts`

**Location:** Lines 217-229 (the failed translation reset)

The existing query already only resets `translation_status = 'failed'` — so `exhausted` is safe. But add a comment for clarity:

```typescript
// Reset 'failed' → NULL after configured delay (allows retry)
// NOTE: 'exhausted' translations are NOT reset — they hit max attempts
```

### Step T2.6: Update frontend to show exhausted state

**File:** Frontend component that displays translation status

Show "Translation exhausted (5 attempts)" instead of "Translation failed" when `translation_status === 'exhausted'`. This tells the user the article needs manual intervention.

---

## 6. Priority 2: Save Translation Error to DB

**Problem:** When translation fails, the error message is only logged. The frontend shows "Translation failed" but can't show WHY (API rate limit? JSON parse error? Network timeout?). Operators can't diagnose without reading server logs.

**Solution:** Add a `translation_error` column and save the error message on failure.

### Step T3.1: Add column to articles schema

**File:** `packages/db/src/schema.ts` (articles table definition)

```typescript
translationError: text("translation_error"),
```

### Step T3.2: Generate and run migration

Combine with the `translation_attempts` migration from Step T2.2 if done together:

```bash
npm run db:generate
npm run db:migrate
```

### Step T3.3: Save error in translation worker failure path

**File:** `packages/worker/src/processors/translation.ts`

**Location:** Lines 173-178 (the failure UPDATE)

```typescript
await db.execute(sql`
  UPDATE articles
  SET
    translation_status = ${isExhausted ? "exhausted" : "failed"},
    translation_error = ${result.error ?? "Unknown error"}
  WHERE id = ${article.id}::uuid
`);
```

### Step T3.4: Clear error on successful translation

**File:** `packages/worker/src/processors/translation.ts`

**Location:** Lines 182-191 (the success UPDATE)

Add `translation_error = NULL` to the success update to clear any previous error:

```typescript
UPDATE articles
SET
  title_ka = ...,
  llm_summary_ka = ...,
  translation_model = ...,
  translation_status = 'translated',
  translation_error = NULL,         -- Clear previous error
  translated_at = NOW()
WHERE id = ${article.id}::uuid
```

### Step T3.5: Expose error in API response

**File:** `packages/api/src/routes/articles.ts` (or wherever the article list query is)

Include `translation_error` in the SELECT so the frontend can display it.

### Step T3.6: Show error in frontend

**File:** Frontend articles list/panel component

When `translation_status === 'failed'` or `'exhausted'`, show the `translation_error` value as a tooltip or sub-text:

```
"Translation failed" → "Translation failed: 429 Too Many Requests"
"Translation exhausted" → "Translation exhausted (5 attempts): JSON parse error"
```

---

## 7. Priority 3: Auto-Retry `posting_failed` Articles

**Problem:** When all platforms fail for an immediate distribution job, the article is set to `pipeline_stage = 'posting_failed'`. This is a permanent dead end — no maintenance job ever picks it up. The article is lost.

**Solution:** Add a maintenance routine that resets `posting_failed` articles back to `approved` after 30 minutes, up to a max retry count.

### Step D3.1: Add `posting_attempts` column to articles

**File:** `packages/db/src/schema.ts`

```typescript
postingAttempts: integer("posting_attempts").default(0).notNull(),
```

Generate + run migration.

### Step D3.2: Increment posting attempts in distribution worker

**File:** `packages/worker/src/processors/distribution.ts`

When setting `posting_failed`:

```typescript
await db.execute(sql`
  UPDATE articles
  SET
    pipeline_stage = 'posting_failed',
    posting_attempts = posting_attempts + 1
  WHERE id = ${articleId}::uuid
`);
```

### Step D3.3: Add maintenance routine to reset posting_failed

**File:** `packages/worker/src/processors/maintenance.ts`

Add a new function (similar to `resetZombieArticles`):

```typescript
/**
 * Retry articles stuck in 'posting_failed' state.
 * Resets to 'approved' after 30 minutes, up to 3 attempts.
 * After 3 attempts, leaves as 'posting_failed' (permanent — needs manual intervention).
 */
const retryPostingFailed = async (db: Database, distributionQueue?: Queue) => {
  if (!distributionQueue) return 0;

  const retryThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 min
  const maxAttempts = 3;

  const result = await db.execute(sql`
    UPDATE articles
    SET pipeline_stage = 'approved'
    WHERE pipeline_stage = 'posting_failed'
      AND approved_at < ${retryThreshold}
      AND posting_attempts < ${maxAttempts}
    RETURNING id
  `);

  const retried = result.rows as { id: string }[];
  if (retried.length === 0) return 0;

  // Re-queue for distribution
  for (const article of retried) {
    try {
      await distributionQueue.add(
        JOB_DISTRIBUTION_IMMEDIATE,
        { articleId: article.id },
        { jobId: `retry-failed-${article.id}-${Date.now()}` },
      );
    } catch (err) {
      logger.error(`[maintenance] failed to re-queue posting_failed article ${article.id}`, err);
    }
  }

  logger.warn(`[maintenance] retried ${retried.length} posting_failed articles`);
  return retried.length;
};
```

### Step D3.4: Wire into maintenance scheduler tick

**File:** `packages/worker/src/processors/maintenance.ts`

**Location:** Inside `JOB_MAINTENANCE_SCHEDULE` handler (line 724-741), after `rescueOrphanedApprovedArticles`:

```typescript
await retryPostingFailed(db, distributionQueue);
```

---

## 8. Priority 3: Global Posting Flood Protection

**Problem:** There's no global cap on how many articles can be auto-posted per hour. Per-platform rate limits exist but Telegram allows 20/hr — enough to annoy followers with a wall of posts. The per-platform limit protects the API, not the user experience.

**Solution:** Add a `max_auto_posts_per_hour` app_config setting. When the limit is reached, newly auto-approved articles get their distribution deferred (staggered into the future).

### Step D4.1: Add config key to seed

**File:** `packages/db/seed.sql` (raw SQL seed file, uses `ON CONFLICT DO NOTHING`)

Add to the existing `INSERT INTO app_config` block:

```sql
('max_auto_posts_per_hour', '8', NOW()),
```

Note: `app_config.value` is `jsonb`. Bare number `'8'` is valid JSON (matches existing pattern like `'60'` for `feed_items_ttl_days`).

Default 8 per hour across all platforms combined.

### Step D4.2: Check global limit before queueing in LLM Brain

**File:** `packages/worker/src/processors/llm-brain.ts`

Before queuing `JOB_DISTRIBUTION_IMMEDIATE`, check how many articles have been auto-posted in the last hour:

```typescript
// Global flood protection: check total posts in the last hour
const recentPostCount = await db.execute(sql`
  SELECT COUNT(*) as count FROM post_deliveries
  WHERE status = 'posted'
    AND sent_at > NOW() - INTERVAL '1 hour'
`);
const postsThisHour = Number((recentPostCount.rows[0] as { count: string }).count);

const maxPerHour = await getConfigNumber(db, "max_auto_posts_per_hour", 8);
if (postsThisHour >= maxPerHour) {
  // Defer: create scheduled delivery instead of immediate
  const deferMinutes = Math.ceil((postsThisHour - maxPerHour + 1) * (60 / maxPerHour));
  logger.info(
    { articleId: result.articleId, postsThisHour, maxPerHour, deferMinutes },
    "[llm-brain] global flood limit reached, deferring distribution",
  );
  // Article stays 'approved', maintenance scheduler will pick it up later
  continue;
}
```

### Step D4.3: Add to Site Rules UI (optional)

**File:** Frontend Site Rules page

Add a "Max Auto-Posts per Hour" input field under Feed Limits or a new "Posting Controls" section. Saves to `app_config` via existing config API.

---

## 9. Priority 3: Reduce Failed Translation Retry Delay

**Problem:** Failed translations wait 1 hour before the maintenance zombie cleanup resets them to `NULL` for retry. For transient errors (API blip, brief rate limit), this is far too long.

**Solution:** Reduce the first retry delay to 10 minutes (from 60), and add configurable escalation.

### Step T4.1: Change failed translation reset threshold

**File:** `packages/worker/src/processors/maintenance.ts`

**Location:** Lines 217-229

Change from 60 minutes to 10 minutes:

```typescript
// Reset 'failed' → NULL after 10 minutes (allows retry)
// The translation_attempts counter prevents infinite retries
const failedThreshold = new Date(Date.now() - 10 * 60 * 1000); // was 60 min
```

This is now safe because the `translation_attempts` cap (Priority 2, Step T2) prevents infinite retry loops. Before this change was risky; with the cap, 10-minute retry is safe.

### Step T4.2: Make configurable via app_config (optional)

**File:** `packages/worker/src/processors/maintenance.ts`

Read from `app_config` with fallback:

```typescript
const translationRetryMinutes = await getConfigNumber(db, "translation_retry_minutes", 10);
const failedThreshold = new Date(Date.now() - translationRetryMinutes * 60 * 1000);
```

---

## 10. Change Map

| File | Changes |
|------|---------|
| **packages/db/src/schema.ts** | Add `translation_attempts`, `translation_error`, `posting_attempts` columns |
| **packages/worker/src/processors/distribution.ts** | D1.1: Rate-limited → create scheduled delivery; D1.2: Fix article stage logic; D1.3: Unhealthy → schedule retry; D3.2: Increment posting_attempts |
| **packages/worker/src/processors/llm-brain.ts** | D2.1: Stagger delay on distribution jobs; D4.2: Global flood check |
| **packages/worker/src/processors/translation.ts** | T1.1: In-worker retry loop; T2.3-T2.4: Attempt counting + exhausted state; T3.3-T3.4: Save/clear translation_error |
| **packages/worker/src/processors/maintenance.ts** | D3.3-D3.4: Retry posting_failed; T4.1: Reduce retry delay; T2.5: Comment about exhausted |
| **packages/translation/src/types.ts** | T1.2: Add `isTransient` flag |
| **packages/translation/src/gemini.ts** | T1.2: Detect transient errors |
| **packages/translation/src/openai.ts** | T1.2: Detect transient errors |
| **packages/shared/src/index.ts** | D2.3: Export `AUTO_POST_STAGGER_MS` constant |
| **packages/api/src/routes/articles.ts** | T3.5: Include `translation_error` in response |
| **packages/frontend/src/** | T2.6 + T3.6: Show exhausted state + error details |
| **packages/db/seed.sql** | D4.1: Add `max_auto_posts_per_hour` to app_config seed |
| **Migration** | New migration for 3 columns: `translation_attempts`, `translation_error`, `posting_attempts` |

---

## 11. Testing Checklist

### Translation Pipeline

- [ ] **T-01**: Trigger a translation with a known-good article → `translation_status = 'translated'`, `title_ka` + `llm_summary_ka` populated
- [ ] **T-02**: Simulate Gemini 429 (temporarily use wrong API key or exhaust quota) → in-worker retry kicks in (check logs for "retrying after transient error")
- [ ] **T-03**: Permanently bad article (if possible) → after 5 attempts, `translation_status = 'exhausted'`, no more retries
- [ ] **T-04**: Failed translation shows error in frontend (tooltip/sub-text with actual error message)
- [ ] **T-05**: `translation_attempts` increments correctly: 0 → 1 on first claim, 2 on second, etc.
- [ ] **T-06**: Retry delay: failed article retries after ~10 minutes (not 1 hour)

### Autoposting — Rate Limit Handling

- [ ] **D-01**: Set Facebook rate limit to 1/hr, auto-approve 3 articles → first posts, other 2 get `post_deliveries` with `status: 'scheduled'` and future `scheduledAt`
- [ ] **D-02**: After scheduled time passes, maintenance worker picks up and posts the deferred Facebook deliveries
- [ ] **D-03**: Article marked `posted` after first platform succeeds; deferred platforms handled via deliveries

### Autoposting — Staggering

- [ ] **D-04**: Auto-approve 5 articles in one LLM brain batch → distribution jobs have incremental delays (0s, 45s, 90s, 135s, 180s)
- [ ] **D-05**: Telegram channel doesn't receive a burst — posts arrive ~45s apart
- [ ] **D-06**: Same stagger behavior in Georgian mode (translation → distribution path)

### Autoposting — Flood Protection

- [ ] **D-07**: Set `max_auto_posts_per_hour = 3`, auto-approve 5 → first 3 post, remaining 2 deferred
- [ ] **D-08**: `posting_failed` article retries after 30 minutes (check maintenance logs)
- [ ] **D-09**: `posting_failed` article with `posting_attempts >= 3` stays failed permanently

### Edge Cases

- [ ] **E-01**: First ingest with 60+ articles → verify staggering + rate limiting work together (no platform bombarded)
- [ ] **E-02**: Georgian mode: translation fails → article stays `approved` → retries → eventually translates → posts
- [ ] **E-03**: Emergency stop mid-batch: enable emergency stop while distribution jobs are queued → remaining jobs skip
- [ ] **E-04**: Worker restart: no zombie articles stuck in `translating` after 10 min
- [ ] **E-05**: All platforms unhealthy: article gets scheduled deliveries for later, not `posting_failed`
