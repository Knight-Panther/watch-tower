# Task 6: Scheduled Posting System

## Overview

Implement a scheduled posting system where users can:
1. Approve + Schedule articles in a single modal (date/time/platform)
2. View/manage upcoming posts on a dedicated Scheduled page
3. Worker automatically posts at scheduled times
4. Toggle auto-posting for score 5 articles via `app_config`

## Architecture Decisions

- **Repurpose `post_deliveries`** — add `scheduled_at` column, use for all posting
- **Delete `post_batches`** — no batch/digest posting, individual articles only
- **Keep `approved` pipeline stage** — `post_deliveries.status` controls posting timing
- **Combined modal** — Approve + Schedule in one step
- **Maintenance worker handles scheduling** — polls every 30s for due posts
- **Global auto-post toggle** — `app_config.auto_post_score5` (true/false)

---

## Phase 1: Database Schema Changes

### 1.1 Modify `post_deliveries` table

Add columns to existing table:

```sql
-- Add scheduling columns to post_deliveries
ALTER TABLE post_deliveries ADD COLUMN article_id UUID REFERENCES articles(id) ON DELETE CASCADE;
ALTER TABLE post_deliveries ADD COLUMN scheduled_at TIMESTAMPTZ;

-- Update status options: 'scheduled' | 'posting' | 'posted' | 'failed' | 'cancelled'
-- (status column already exists)

-- Create index for scheduler polling
CREATE INDEX idx_post_deliveries_due ON post_deliveries(scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX idx_post_deliveries_article ON post_deliveries(article_id);
```

### 1.2 Delete `post_batches` table

```sql
-- Remove batch posting infrastructure
DROP TABLE IF EXISTS post_batches CASCADE;
```

### 1.3 Add auto-post config

```sql
INSERT INTO app_config (key, value) VALUES ('auto_post_score5', 'true')
ON CONFLICT (key) DO NOTHING;
```

### 1.4 Files to modify

- [ ] `packages/db/src/schema.ts` - update `postDeliveries`, remove `postBatches`
- [ ] `packages/db/src/index.ts` - remove `postBatches` export
- [ ] Generate migration: `npm run db:generate`
- [ ] Run migration: `npm run db:migrate`
- [ ] Update seed script if needed

---

## Phase 2: API Endpoints

### 2.1 Update `packages/api/src/routes/articles.ts`

| Method | Endpoint | Body | Purpose |
|--------|----------|------|---------|
| `POST` | `/articles/:id/schedule` | `{ platform, scheduledAt }` | Approve + create scheduled delivery |
| `DELETE` | `/articles/:id/schedule` | `{ platform }` | Cancel scheduled delivery |

**Schedule endpoint logic:**
```typescript
// POST /articles/:id/schedule
1. Validate article exists and pipeline_stage = 'scored'
2. Update article: pipeline_stage = 'approved', approved_at = NOW()
3. Insert into post_deliveries: article_id, platform, scheduled_at, status = 'scheduled'
4. Return success with delivery ID
```

### 2.2 New file `packages/api/src/routes/scheduled.ts`

| Method | Endpoint | Query Params | Purpose |
|--------|----------|--------------|---------|
| `GET` | `/scheduled` | `?from&to&platform&status&sector` | List scheduled deliveries |
| `PATCH` | `/scheduled/:id` | `{ scheduledAt }` | Reschedule |
| `DELETE` | `/scheduled/:id` | — | Cancel (set status = 'cancelled') |

### 2.3 Files to create/modify

- [ ] `packages/api/src/routes/articles.ts` - add schedule endpoint
- [ ] `packages/api/src/routes/scheduled.ts` - new file
- [ ] `packages/api/src/server.ts` - register scheduled routes

---

## Phase 3: Worker - Post Scheduler

### 3.1 Add to maintenance processor

Extend `packages/worker/src/processors/maintenance.ts`:

```typescript
const processScheduledPosts = async (db: Database, telegramConfig: TelegramConfig) => {
  // 1. Claim due posts (atomic)
  const duePosts = await db.execute(sql`
    UPDATE post_deliveries
    SET status = 'posting'
    WHERE id IN (
      SELECT id FROM post_deliveries
      WHERE scheduled_at <= NOW()
      AND status = 'scheduled'
      ORDER BY scheduled_at
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, article_id, platform
  `);

  // 2. For each claimed post
  for (const delivery of duePosts) {
    try {
      // Fetch article data
      const article = await db.query.articles.findFirst({
        where: eq(articles.id, delivery.articleId)
      });

      // Post via platform provider
      const telegram = createTelegramProvider(telegramConfig);
      const result = await telegram.postSingle(article);

      // Update delivery + article
      await db.update(postDeliveries)
        .set({ status: 'posted', sentAt: new Date(), platformPostId: result.postId })
        .where(eq(postDeliveries.id, delivery.id));

      await db.update(articles)
        .set({ pipelineStage: 'posted' })
        .where(eq(articles.id, delivery.articleId));

    } catch (error) {
      await db.update(postDeliveries)
        .set({ status: 'failed', errorMessage: error.message })
        .where(eq(postDeliveries.id, delivery.id));
    }
  }
};
```

### 3.2 Integrate with maintenance schedule job

Add `processScheduledPosts()` call to `JOB_MAINTENANCE_SCHEDULE` handler (runs every 30s).

### 3.3 Files to modify

- [ ] `packages/worker/src/processors/maintenance.ts` - add `processScheduledPosts`
- [ ] `packages/worker/src/processors/distribution.ts` - update for individual posts
- [ ] `packages/shared/src/queues.ts` - cleanup unused constants

---

## Phase 4: Frontend - Combined Approve/Schedule Modal

### 4.1 Replace approve button with schedule modal

Current flow: `[Approve]` → immediate approval
New flow: `[Approve]` → opens modal → approve + schedule

### 4.2 Schedule Modal Component

```
┌─────────────────────────────────────────┐
│         Approve & Schedule              │
├─────────────────────────────────────────┤
│  Date:  [Feb 1, 2026        ▼]          │
│  Time:  [09:00              ▼]          │
│                                         │
│  Platform:                              │
│  [✓] Telegram                           │
│  [ ] Facebook (coming soon)             │
│  [ ] LinkedIn (coming soon)             │
│                                         │
│         [Cancel]  [Approve & Schedule]  │
└─────────────────────────────────────────┘
```

### 4.3 Files to modify

- [ ] `packages/frontend/src/pages/Articles.tsx` - update approve button
- [ ] `packages/frontend/src/components/ScheduleModal.tsx` - new component
- [ ] `packages/frontend/src/api.ts` - add schedule API functions

---

## Phase 5: Frontend - Scheduled Posts Page

### 5.1 New page showing upcoming posts

| Source | Sector | Post Preview | Date | Time | Platform | Status | Actions |
|--------|--------|--------------|------|------|----------|--------|---------|
| TechCrunch | Tech | "AI startup raises..." | Feb 1 | 09:00 | Telegram | Scheduled | [Reschedule] [Cancel] |

### 5.2 Features

- Sort by date/time (default: soonest first)
- Filter by: sector, platform, date range, status
- Click row → navigate to article in `/articles`
- Reschedule modal (date/time picker)
- Cancel button (sets status = 'cancelled')

### 5.3 Files to create/modify

- [ ] `packages/frontend/src/pages/Scheduled.tsx` - new page
- [ ] `packages/frontend/src/App.tsx` - add route
- [ ] `packages/frontend/src/components/Layout.tsx` - add nav link

---

## Phase 6: Score 5 Auto-Post Toggle

### 6.1 Add toggle to Settings/Config

- Read `app_config.auto_post_score5` on frontend
- Toggle switch in settings or dashboard header
- When enabled: score 5 → auto-approve + immediate post (no scheduling)
- When disabled: score 5 → auto-approve only, no posting

### 6.2 Update LLM Brain processor

```typescript
// In llm-brain.ts, after auto-approval
if (autoApproveEnabled && score >= autoApproveThreshold) {
  // Check if auto-post is enabled
  const autoPost = await getAppConfig(db, 'auto_post_score5');

  if (autoPost === 'true') {
    // Queue immediate distribution
    await distributionQueue.add(JOB_DISTRIBUTION_IMMEDIATE, { articleId });
  }
  // If false, just approve without posting
}
```

### 6.3 Files to modify

- [ ] `packages/worker/src/processors/llm-brain.ts` - check auto_post_score5
- [ ] `packages/frontend/src/pages/Settings.tsx` or header - add toggle
- [ ] `packages/api/src/routes/config.ts` - ensure PATCH endpoint works

---

## Phase 7: Cleanup Dead Code

### 7.1 Remove unused tables/code

- [ ] Delete `post_batches` from schema
- [ ] Remove `JOB_DISTRIBUTION_BUILD` constant (never handled)
- [ ] Remove `JOB_DISTRIBUTION_POST` if not needed
- [ ] Update `formatDigestPost` → ensure `formatSinglePost` is used
- [ ] Remove batch-related code from distribution.ts

### 7.2 Files to cleanup

- [ ] `packages/db/src/schema.ts` - remove postBatches
- [ ] `packages/shared/src/queues.ts` - remove unused job constants
- [ ] `packages/worker/src/processors/distribution.ts` - simplify to single-post only

---

## Phase 8: Testing & Verification

### 8.1 Manual testing checklist

- [ ] Approve article with schedule → appears in Scheduled page
- [ ] Wait for scheduled time → Telegram receives post
- [ ] Article status changes to "posted"
- [ ] Reschedule a post → verify time updates
- [ ] Cancel a post → status = 'cancelled', no post sent
- [ ] Toggle auto_post_score5 off → score 5 approves but doesn't post
- [ ] Toggle auto_post_score5 on → score 5 posts immediately

### 8.2 Edge cases

- [ ] Schedule in the past → should post immediately
- [ ] Duplicate scheduling same article/platform → UNIQUE constraint or update existing
- [ ] Worker crash during posting → status stays "posting", needs recovery (add to maintenance zombie reset)
- [ ] Platform API failure → status = "failed", error_message populated
- [ ] Article rejected after scheduled → cancel any pending deliveries (CASCADE or trigger)

---

## Implementation Order

1. **Schema changes** (Phase 1) - foundation
2. **Cleanup dead code** (Phase 7) - cleaner codebase
3. **API endpoints** (Phase 2) - backend ready
4. **Worker scheduler** (Phase 3) - automation works
5. **Frontend modal** (Phase 4) - main workflow
6. **Scheduled page** (Phase 5) - visibility
7. **Auto-post toggle** (Phase 6) - fine-tuning
8. **Testing** (Phase 8) - verify everything

---

## Dependencies

- Telegram provider working ✓
- Articles page exists ✓
- Distribution worker exists ✓ (needs simplification)
- Maintenance worker runs every 30s ✓

## Key Differences from Original Plan

| Original | Updated |
|----------|---------|
| New `scheduled_posts` table | Repurpose `post_deliveries` |
| Keep `post_batches` | Delete `post_batches` |
| Separate approve/schedule | Combined modal |
| New `post-scheduler.ts` worker | Extend maintenance worker |
| Batch/digest posting | Individual article posting only |
| Per-sector auto-post | Global `app_config` toggle |
