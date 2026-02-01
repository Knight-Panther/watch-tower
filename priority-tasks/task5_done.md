# Task 5: Articles Panel + Distribution Pipeline (Telegram)

## ✅ IMPLEMENTATION STATUS (Completed Feb 2026)

### What Was Actually Implemented

| Component | Status | Files |
|-----------|--------|-------|
| **Articles API** | ✅ Done | `packages/api/src/routes/articles.ts` |
| **Articles Frontend** | ✅ Done | `packages/frontend/src/pages/Articles.tsx` |
| **Social Package** | ✅ Done | `packages/social/src/` (Telegram provider) |
| **Distribution Worker** | ✅ Done | `packages/worker/src/processors/distribution.ts` |
| **LLM→Distribution Queue** | ✅ Done | Modified `packages/worker/src/processors/llm-brain.ts` |
| **Worker Wiring** | ✅ Done | Modified `packages/worker/src/index.ts` |
| **Env Variables** | ✅ Done | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

### What Was Deferred (Future Tasks)

| Feature | Reason | Notes |
|---------|--------|-------|
| **Image Generation (DALL-E)** | Cost ($0.04/image) | `articleImages` table exists, ready to implement |
| **Digest Scheduler** | Not MVP | `postBatches` table exists, `JOB_DISTRIBUTION_BUILD` defined |
| **Facebook/LinkedIn** | Scope | Social package designed for multi-platform |
| **Rate Limiting** | Complexity | Redis sliding window pattern recommended |
| **`postDeliveries` Tracking** | Schema issue | Needs `articleId` column for single-article posts |

### Security Enhancements Added (Not in Original Plan)

| Fix | File | Description |
|-----|------|-------------|
| **Request Timeout** | `telegram.ts` | 30s timeout with AbortController |
| **Bot Token Masking** | `telegram.ts` | Redacts tokens from error logs |
| **Atomic Claim** | `distribution.ts` | `UPDATE...RETURNING` prevents duplicate posts |
| **Idempotency Check** | `distribution.ts` | Checks if already posted before retrying |
| **URL Validation** | `telegram.ts` | Blocks non-http URLs, escapes quotes |
| **HTML Escaping** | `telegram.ts` | Added `"` → `&quot;` escaping |
| **Intermediate Stage** | `distribution.ts` | `posting` stage prevents race conditions |

### Actual Pipeline Flow (Implemented)

```
Score 5 → auto-approve → queue JOB_DISTRIBUTION_IMMEDIATE
       → atomic claim (approved → posting)
       → Telegram post (30s timeout)
       → update to 'posted' (or 'posting_failed')

Score 3-4 → stays at 'scored' → manual review in dashboard
         → approve via API → update to 'approved'
         → (future: queue for digest)

Score 1-2 → auto-reject → 'rejected' stage
```

### Environment Variables Added

```env
TELEGRAM_BOT_TOKEN=   # From @BotFather
TELEGRAM_CHAT_ID=     # Channel/chat ID to post to
```

### API Endpoints Implemented

```
GET  /articles              - Paginated list with filters
GET  /articles/:id          - Single article detail
PATCH /articles/:id         - Update summary/status
POST /articles/:id/approve  - Approve with optional summary edit
POST /articles/:id/reject   - Reject article
GET  /articles/filters/options - Filter dropdown options
POST /articles/batch/approve   - Batch approve
POST /articles/batch/reject    - Batch reject
```

---

## Original Plan (Below)

## Overview

Build the articles management panel with filtering/sorting and implement the hybrid distribution workflow for Telegram.

### Decisions Made

| Decision | Choice |
|----------|--------|
| Distribution model | Hybrid (immediate + digests) |
| Image generation | Score 5 only |
| Approval flow | Edit summary before scheduling |
| Platform | Telegram first |

### Distribution Logic

```
Score 5 → Auto-approve → Generate image → Immediate post
Score 4 → Manual review → Edit summary → Approve → Next digest batch
Score 3 → Manual review → Edit summary → Approve → Digest queue (lower priority)
Score 1-2 → Auto-reject (never posted)
```

---

## Part A: Articles Panel API

### Step A1: Articles List Endpoint

**File**: `packages/api/src/routes/articles.ts`

Create paginated, filterable, sortable endpoint:

```typescript
import { FastifyInstance } from "fastify";
import { and, eq, gte, lte, inArray, ilike, desc, asc, sql, count } from "drizzle-orm";
import { articles, rssSources, sectors } from "@watch-tower/db";
import type { Database } from "@watch-tower/db";

type ArticlesDeps = { db: Database };

export const registerArticlesRoutes = (app: FastifyInstance, { db }: ArticlesDeps) => {
  // GET /articles - Paginated list with filters
  app.get("/articles", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          page: { type: "integer", default: 1 },
          limit: { type: "integer", default: 50, maximum: 100 },
          // Filters
          sectorId: { type: "string" },           // comma-separated UUIDs
          sourceId: { type: "string" },           // comma-separated UUIDs
          status: { type: "string" },             // comma-separated statuses
          minScore: { type: "integer", minimum: 1, maximum: 5 },
          maxScore: { type: "integer", minimum: 1, maximum: 5 },
          dateFrom: { type: "string", format: "date" },
          dateTo: { type: "string", format: "date" },
          search: { type: "string" },             // search in title/llmSummary
          // Sorting
          sortBy: {
            type: "string",
            enum: ["publishedAt", "importanceScore", "createdAt"],
            default: "publishedAt"
          },
          sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
      },
    },
  }, async (request) => {
    const {
      page = 1,
      limit = 50,
      sectorId,
      sourceId,
      status,
      minScore,
      maxScore,
      dateFrom,
      dateTo,
      search,
      sortBy = "publishedAt",
      sortDir = "desc",
    } = request.query as Record<string, any>;

    const offset = (page - 1) * limit;

    // Build WHERE conditions
    const conditions = [];

    if (sectorId) {
      const ids = sectorId.split(",");
      conditions.push(inArray(articles.sectorId, ids));
    }

    if (sourceId) {
      const ids = sourceId.split(",");
      conditions.push(inArray(articles.sourceId, ids));
    }

    if (status) {
      const statuses = status.split(",");
      conditions.push(inArray(articles.pipelineStage, statuses));
    }

    if (minScore !== undefined) {
      conditions.push(gte(articles.importanceScore, minScore));
    }

    if (maxScore !== undefined) {
      conditions.push(lte(articles.importanceScore, maxScore));
    }

    if (dateFrom) {
      conditions.push(gte(articles.publishedAt, new Date(dateFrom)));
    }

    if (dateTo) {
      conditions.push(lte(articles.publishedAt, new Date(dateTo)));
    }

    if (search) {
      conditions.push(
        sql`(${articles.title} ILIKE ${`%${search}%`} OR ${articles.llmSummary} ILIKE ${`%${search}%`})`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Sort mapping (use actual schema column names)
    const sortColumns: Record<string, any> = {
      publishedAt: articles.publishedAt,
      importanceScore: articles.importanceScore,
      createdAt: articles.createdAt,
    };
    const sortColumn = sortColumns[sortBy] || articles.publishedAt;
    const orderBy = sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

    // Execute queries in parallel
    const [rows, totalResult] = await Promise.all([
      db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          llmSummary: articles.llmSummary,
          importanceScore: articles.importanceScore,
          pipelineStage: articles.pipelineStage,
          publishedAt: articles.publishedAt,
          createdAt: articles.createdAt,
          // Joined fields
          sourceId: articles.sourceId,
          sourceName: rssSources.name,
          sourceUrl: rssSources.url,  // schema uses 'url' not 'feedUrl'
          sectorId: articles.sectorId,
          sectorName: sectors.name,
        })
        .from(articles)
        .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(whereClause)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),

      db
        .select({ count: count() })
        .from(articles)
        .where(whereClause),
    ]);

    const total = totalResult[0]?.count ?? 0;

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  // GET /articles/:id - Single article detail
  app.get("/articles/:id", async (request) => {
    const { id } = request.params as { id: string };

    const [article] = await db
      .select({
        id: articles.id,
        title: articles.title,
        url: articles.url,
        contentSnippet: articles.contentSnippet,
        llmSummary: articles.llmSummary,
        importanceScore: articles.importanceScore,
        pipelineStage: articles.pipelineStage,
        publishedAt: articles.publishedAt,
        createdAt: articles.createdAt,
        scoredAt: articles.scoredAt,
        approvedAt: articles.approvedAt,
        sourceName: rssSources.name,
        sourceUrl: rssSources.url,
        sectorName: sectors.name,
      })
      .from(articles)
      .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
      .leftJoin(sectors, eq(articles.sectorId, sectors.id))
      .where(eq(articles.id, id));

    if (!article) {
      throw { statusCode: 404, message: "Article not found" };
    }

    return article;
  });

  // PATCH /articles/:id - Update article (for editing summary before posting)
  app.patch("/articles/:id", {
    schema: {
      body: {
        type: "object",
        properties: {
          llmSummary: { type: "string" },
          pipelineStage: {
            type: "string",
            enum: ["approved", "rejected", "posted"]
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { llmSummary?: string; pipelineStage?: string };

    const updates: Record<string, any> = {};
    if (body.llmSummary !== undefined) updates.llmSummary = body.llmSummary;
    if (body.pipelineStage !== undefined) {
      updates.pipelineStage = body.pipelineStage;
      if (body.pipelineStage === "approved") {
        updates.approvedAt = new Date();
      }
    }

    const [updated] = await db
      .update(articles)
      .set(updates)
      .where(eq(articles.id, id))
      .returning();

    return updated;
  });

  // GET /articles/filters/options - Get available filter options
  app.get("/articles/filters/options", async () => {
    const [sectorsList, sourcesList, statusCounts] = await Promise.all([
      db.select({ id: sectors.id, name: sectors.name }).from(sectors),
      db.select({ id: rssSources.id, name: rssSources.name }).from(rssSources),
      db
        .select({
          status: articles.pipelineStage,
          count: count(),
        })
        .from(articles)
        .groupBy(articles.pipelineStage),
    ]);

    return {
      sectors: sectorsList,
      sources: sourcesList,
      statuses: statusCounts,
    };
  });
};
```

Register in `packages/api/src/index.ts`:
```typescript
import { registerArticlesRoutes } from "./routes/articles.js";

// After other route registrations
registerArticlesRoutes(app, { db });
```

---

## Part B: Database Schema (Minimal Additions)

### Existing Tables We'll USE (No Changes Needed)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `socialAccounts` | Platform credentials & config | `platform`, `credentials` (jsonb for bot tokens), `rateLimitPerHour`, `sectorIds` |
| `postBatches` | Group articles for digest posts | `sectorId`, `articleIds[]`, `contentText`, `status` |
| `postDeliveries` | Track per-platform delivery | `batchId`, `socialAccountId`, `status`, `platformPostId` |
| `scoringRules` | Auto-approve/reject thresholds | `autoApproveThreshold` (default 5), `autoRejectThreshold` (default 2) |

### Existing Column Names (Use These in API)

| Schema Column | NOT This |
|---------------|----------|
| `importanceScore` | ~~score~~ |
| `llmSummary` | ~~summary~~ |

### Step B1: Add ONLY `articleImages` Table

**File**: `packages/db/src/schema.ts`

Add ONE new table for image generation tracking:

```typescript
// ─── Article Images (for score-5 posts) ─────────────────────────────────────

export const articleImages = pgTable("article_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),

  // Generation details
  provider: text("provider").notNull(), // 'dalle', 'stable', 'ideogram'
  model: text("model"),
  prompt: text("prompt").notNull(),

  // Result
  imageUrl: text("image_url"),
  status: text("status").notNull().default("pending"), // 'pending', 'generating', 'ready', 'failed'
  errorMessage: text("error_message"),

  // Cost tracking (microdollars)
  costMicrodollars: integer("cost_microdollars"),

  // Timing
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### Step B2: Add `imageId` to `postBatches` (Optional)

If we want to attach generated images to batches:

```typescript
// In postBatches table, add:
imageId: uuid("image_id").references(() => articleImages.id, { onDelete: "set null" }),
```

**Run**: `npm run db:generate && npm run db:migrate`

---

## Part C: Image Generation Package

### Step C1: Create Image Generation Package

**File**: `packages/images/package.json`

```json
{
  "name": "@watch-tower/images",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "openai": "^4.52.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5"
  }
}
```

**File**: `packages/images/src/types.ts`

```typescript
export type ImageGenerationRequest = {
  articleId: string;
  summary: string;
  sector: string;
  title: string;
};

export type ImageGenerationResult = {
  articleId: string;
  imageUrl: string;
  provider: string;
  model: string;
  prompt: string;
  costMicrodollars: number;
};

export type ImageProvider = {
  name: string;
  model: string;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
};
```

**File**: `packages/images/src/providers/dalle.ts`

```typescript
import OpenAI from "openai";
import type { ImageProvider, ImageGenerationRequest, ImageGenerationResult } from "../types.js";

// DALL-E 3 pricing: $0.040 per image (1024x1024)
const DALLE_COST_MICRODOLLARS = 40_000;

export const createDalleProvider = (apiKey: string): ImageProvider => {
  const client = new OpenAI({ apiKey });

  return {
    name: "dalle",
    model: "dall-e-3",

    async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const prompt = buildImagePrompt(request);

      const response = await client.images.generate({
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024", // Will crop to 4:5 on frontend or use 1024x1792 for portrait
        quality: "standard",
      });

      const imageUrl = response.data[0]?.url;
      if (!imageUrl) {
        throw new Error("No image URL in DALL-E response");
      }

      return {
        articleId: request.articleId,
        imageUrl,
        provider: "dalle",
        model: "dall-e-3",
        prompt,
        costMicrodollars: DALLE_COST_MICRODOLLARS,
      };
    },
  };
};

const buildImagePrompt = (request: ImageGenerationRequest): string => {
  // Build sector-aware prompt
  const sectorStyles: Record<string, string> = {
    crypto: "futuristic digital art with blockchain and cryptocurrency visual elements, neon accents",
    biotech: "clean scientific visualization with DNA helixes and molecular structures, medical blue tones",
    stocks: "professional financial imagery with charts and market symbols, corporate blue and green",
    ai: "abstract neural network visualization with connected nodes and data streams, purple and blue gradient",
    default: "modern abstract business visualization, clean gradient background",
  };

  const style = sectorStyles[request.sector.toLowerCase()] || sectorStyles.default;

  return `Professional news thumbnail image, 4:5 aspect ratio.
Theme: ${style}.
Topic: ${request.summary.slice(0, 200)}.
Style requirements: No text or words in the image, clean minimalist design, visually striking, suitable for social media news post.`;
};
```

**File**: `packages/images/src/index.ts`

```typescript
export * from "./types.js";
export { createDalleProvider } from "./providers/dalle.js";
```

Add to workspace in root `package.json`:
```json
"workspaces": [
  "packages/db",
  "packages/shared",
  "packages/llm",
  "packages/embeddings",
  "packages/social",
  "packages/images",
  "packages/worker",
  "packages/api",
  "packages/frontend"
]
```

---

## Part D: Telegram Posting

### Step D1: Telegram Bot Setup

**File**: `packages/social/src/providers/telegram.ts`

```typescript
export type TelegramConfig = {
  botToken: string;
  defaultChatId: string;
};

export type TelegramPostRequest = {
  chatId?: string;
  text: string;
  imageUrl?: string;
  parseMode?: "HTML" | "Markdown";
};

export type TelegramPostResult = {
  messageId: number;
  chatId: string;
};

export const createTelegramProvider = (config: TelegramConfig) => {
  const baseUrl = `https://api.telegram.org/bot${config.botToken}`;

  return {
    name: "telegram" as const,

    async post(request: TelegramPostRequest): Promise<TelegramPostResult> {
      const chatId = request.chatId || config.defaultChatId;

      if (request.imageUrl) {
        // Send photo with caption
        const response = await fetch(`${baseUrl}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            photo: request.imageUrl,
            caption: request.text,
            parse_mode: request.parseMode || "HTML",
          }),
        });

        const data = await response.json();
        if (!data.ok) {
          throw new Error(`Telegram API error: ${data.description}`);
        }

        return {
          messageId: data.result.message_id,
          chatId: String(chatId),
        };
      } else {
        // Send text message
        const response = await fetch(`${baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: request.text,
            parse_mode: request.parseMode || "HTML",
          }),
        });

        const data = await response.json();
        if (!data.ok) {
          throw new Error(`Telegram API error: ${data.description}`);
        }

        return {
          messageId: data.result.message_id,
          chatId: String(chatId),
        };
      }
    },

    formatSinglePost(article: { title: string; summary: string; url: string; sector: string }): string {
      return `<b>🔴 BREAKING: ${article.sector.toUpperCase()}</b>

<b>${article.title}</b>

${article.summary}

<a href="${article.url}">Read more →</a>`;
    },

    formatDigestPost(articles: { title: string; summary: string; url: string }[], sector: string): string {
      const items = articles
        .map((a, i) => `${i + 1}. <a href="${a.url}">${a.title}</a>\n   ${a.summary.slice(0, 100)}...`)
        .join("\n\n");

      return `<b>📰 ${sector.toUpperCase()} DIGEST</b>

${items}`;
    },
  };
};
```

---

## Part E: Distribution Worker

### Step E1: Distribution Processor

**File**: `packages/worker/src/processors/distribution.ts`

```typescript
import { Job } from "bullmq";
import { eq, and, lte, inArray } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { articles, scheduledPosts, articleImages, sectors } from "@watch-tower/db";
import { createTelegramProvider } from "@watch-tower/social";
import { createDalleProvider } from "@watch-tower/images";
import type { Logger } from "pino";

type DistributionDeps = {
  db: Database;
  logger: Logger;
  telegramBotToken: string;
  telegramChatId: string;
  openaiApiKey: string;
};

export const createDistributionProcessor = (deps: DistributionDeps) => {
  const { db, logger } = deps;
  const telegram = createTelegramProvider({
    botToken: deps.telegramBotToken,
    defaultChatId: deps.telegramChatId,
  });
  const imageGenerator = createDalleProvider(deps.openaiApiKey);

  return {
    // Process score-5 articles for immediate posting
    async processImmediatePost(job: Job<{ articleId: string }>) {
      const { articleId } = job.data;
      logger.info({ articleId }, "Processing immediate post for score-5 article");

      // Fetch article with sector
      const [article] = await db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          summary: articles.summary,
          score: articles.score,
          sectorName: sectors.name,
        })
        .from(articles)
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(eq(articles.id, articleId));

      if (!article || article.score !== 5) {
        logger.warn({ articleId }, "Article not found or not score 5");
        return;
      }

      // Generate image
      logger.info({ articleId }, "Generating image for article");
      const imageResult = await imageGenerator.generate({
        articleId,
        summary: article.summary || article.title,
        sector: article.sectorName || "news",
        title: article.title,
      });

      // Store image record
      await db.insert(articleImages).values({
        articleId,
        provider: imageResult.provider,
        model: imageResult.model,
        prompt: imageResult.prompt,
        imageUrl: imageResult.imageUrl,
        status: "ready",
        costMicrodollars: imageResult.costMicrodollars,
        generationCompletedAt: new Date(),
      });

      // Post to Telegram
      const text = telegram.formatSinglePost({
        title: article.title,
        summary: article.summary || "",
        url: article.url,
        sector: article.sectorName || "News",
      });

      const result = await telegram.post({
        text,
        imageUrl: imageResult.imageUrl,
      });

      // Update article status
      await db
        .update(articles)
        .set({ pipelineStage: "posted", updatedAt: new Date() })
        .where(eq(articles.id, articleId));

      logger.info({ articleId, messageId: result.messageId }, "Article posted to Telegram");

      return { messageId: result.messageId };
    },

    // Process scheduled digest posts
    async processDigestPost(job: Job<{ scheduleId: string }>) {
      const { scheduleId } = job.data;
      logger.info({ scheduleId }, "Processing digest post");

      // Find pending posts for this schedule
      const pendingPosts = await db
        .select()
        .from(scheduledPosts)
        .where(
          and(
            eq(scheduledPosts.scheduleId, scheduleId),
            eq(scheduledPosts.status, "pending"),
            lte(scheduledPosts.scheduledFor, new Date())
          )
        )
        .orderBy(scheduledPosts.priority)
        .limit(5);

      if (pendingPosts.length === 0) {
        logger.info({ scheduleId }, "No pending posts for digest");
        return;
      }

      // Fetch articles for digest
      const articleIds = pendingPosts
        .map(p => p.articleId)
        .filter((id): id is string => id !== null);

      const digestArticles = await db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          summary: articles.summary,
          sectorName: sectors.name,
        })
        .from(articles)
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(inArray(articles.id, articleIds));

      if (digestArticles.length === 0) {
        return;
      }

      // Format and post digest
      const sector = digestArticles[0].sectorName || "News";
      const text = telegram.formatDigestPost(
        digestArticles.map(a => ({
          title: a.title,
          summary: a.summary || "",
          url: a.url,
        })),
        sector
      );

      const result = await telegram.post({ text });

      // Update all posts and articles
      await db
        .update(scheduledPosts)
        .set({ status: "posted", postedAt: new Date(), platformPostId: String(result.messageId) })
        .where(inArray(scheduledPosts.id, pendingPosts.map(p => p.id)));

      await db
        .update(articles)
        .set({ pipelineStage: "posted", updatedAt: new Date() })
        .where(inArray(articles.id, articleIds));

      logger.info({ scheduleId, count: digestArticles.length, messageId: result.messageId }, "Digest posted");

      return { messageId: result.messageId, count: digestArticles.length };
    },
  };
};
```

### Step E2: Auto-Approval Trigger in LLM Brain

**File**: `packages/worker/src/processors/llm-brain.ts`

After scoring, add automatic handling based on score:

```typescript
// After updating article with score, add this logic:

if (result.score === 5) {
  // Auto-approve and queue for immediate posting
  await db
    .update(articles)
    .set({ pipelineStage: "approved" })
    .where(eq(articles.id, result.articleId));

  // Queue immediate post job
  await distributionQueue.add("immediate-post", { articleId: result.articleId });
  logger.info({ articleId: result.articleId, score: 5 }, "Score-5 article queued for immediate posting");

} else if (result.score <= 2) {
  // Auto-reject
  await db
    .update(articles)
    .set({ pipelineStage: "rejected" })
    .where(eq(articles.id, result.articleId));
  logger.info({ articleId: result.articleId, score: result.score }, "Low-score article auto-rejected");
}
// Score 3-4 stays at "scored" for manual review
```

---

## Part F: Frontend - Articles Panel

### Step F1: Articles List Component

**File**: `packages/frontend/src/pages/Articles.tsx`

```typescript
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

type Article = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  pipelineStage: string;
  publishedAt: string;
  sourceName: string;
  sourceUrl: string;
  sectorName: string;
};

type Filters = {
  page: number;
  limit: number;
  sectorId?: string;
  sourceId?: string;
  status?: string;
  minScore?: number;
  maxScore?: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

export const ArticlesPage = () => {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    page: 1,
    limit: 50,
    sortBy: "publishedAt",
    sortDir: "desc",
  });
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);

  // Fetch filter options
  const { data: filterOptions } = useQuery({
    queryKey: ["articles", "filters"],
    queryFn: () => api.get("/articles/filters/options").json(),
  });

  // Fetch articles
  const { data, isLoading } = useQuery({
    queryKey: ["articles", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined) params.set(key, String(value));
      });
      return api.get(`/articles?${params}`).json();
    },
  });

  // Update article mutation
  const updateArticle = useMutation({
    mutationFn: ({ id, ...updates }: { id: string; summary?: string; pipelineStage?: string }) =>
      api.patch(`/articles/${id}`, { json: updates }).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["articles"] });
      setEditingArticle(null);
    },
  });

  const handleSort = (column: string) => {
    setFilters(f => ({
      ...f,
      sortBy: column,
      sortDir: f.sortBy === column && f.sortDir === "desc" ? "asc" : "desc",
    }));
  };

  const handleApprove = (article: Article) => {
    setEditingArticle(article);
  };

  const handleSaveAndApprove = (llmSummary: string) => {
    if (!editingArticle) return;
    updateArticle.mutate({
      id: editingArticle.id,
      llmSummary,
      pipelineStage: "approved",
    });
  };

  const handleReject = (articleId: string) => {
    updateArticle.mutate({ id: articleId, pipelineStage: "rejected" });
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Articles</h1>

      {/* Filters Row */}
      <div className="flex gap-4 mb-6 flex-wrap">
        <select
          className="border rounded px-3 py-2"
          value={filters.sectorId || ""}
          onChange={e => setFilters(f => ({ ...f, sectorId: e.target.value || undefined, page: 1 }))}
        >
          <option value="">All Sectors</option>
          {filterOptions?.sectors?.map((s: { id: string; name: string }) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <select
          className="border rounded px-3 py-2"
          value={filters.status || ""}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value || undefined, page: 1 }))}
        >
          <option value="">All Statuses</option>
          <option value="ingested">Ingested</option>
          <option value="embedded">Embedded</option>
          <option value="scored">Scored (Pending Review)</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="posted">Posted</option>
        </select>

        <select
          className="border rounded px-3 py-2"
          value={filters.minScore || ""}
          onChange={e => setFilters(f => ({ ...f, minScore: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
        >
          <option value="">Min Score</option>
          {[1, 2, 3, 4, 5].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          className="border rounded px-3 py-2"
          value={filters.maxScore || ""}
          onChange={e => setFilters(f => ({ ...f, maxScore: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
        >
          <option value="">Max Score</option>
          {[1, 2, 3, 4, 5].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Articles Table */}
      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2 text-left cursor-pointer" onClick={() => handleSort("publishedAt")}>
                  Date {filters.sortBy === "publishedAt" && (filters.sortDir === "desc" ? "↓" : "↑")}
                </th>
                <th className="border p-2 text-left">Source</th>
                <th className="border p-2 text-left">Sector</th>
                <th className="border p-2 text-left">Title / Summary</th>
                <th className="border p-2 text-left">Status</th>
                <th className="border p-2 text-left cursor-pointer" onClick={() => handleSort("importanceScore")}>
                  Score {filters.sortBy === "importanceScore" && (filters.sortDir === "desc" ? "↓" : "↑")}
                </th>
                <th className="border p-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.data?.map((article: Article) => (
                <tr key={article.id} className="hover:bg-gray-50">
                  <td className="border p-2 text-sm">
                    {new Date(article.publishedAt).toLocaleDateString()}
                  </td>
                  <td className="border p-2 text-sm">
                    <div className="font-medium">{article.sourceName}</div>
                    <div className="text-xs text-gray-500 truncate max-w-[150px]">{article.sourceUrl}</div>
                  </td>
                  <td className="border p-2">
                    <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">
                      {article.sectorName}
                    </span>
                  </td>
                  <td className="border p-2">
                    <a href={article.url} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline">
                      {article.title}
                    </a>
                    {article.summary && (
                      <p className="text-sm text-gray-600 mt-1 line-clamp-2">{article.summary}</p>
                    )}
                  </td>
                  <td className="border p-2">
                    <StatusBadge status={article.pipelineStage} />
                  </td>
                  <td className="border p-2 text-center">
                    {article.score !== null ? (
                      <ScoreBadge score={article.score} />
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="border p-2">
                    {article.pipelineStage === "scored" && article.score && article.score >= 3 && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApprove(article)}
                          className="px-2 py-1 bg-green-500 text-white rounded text-xs hover:bg-green-600"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleReject(article.id)}
                          className="px-2 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex justify-between items-center mt-4">
            <div className="text-sm text-gray-600">
              Showing {((filters.page - 1) * filters.limit) + 1} - {Math.min(filters.page * filters.limit, data?.pagination?.total || 0)} of {data?.pagination?.total || 0}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}
                disabled={filters.page === 1}
                className="px-3 py-1 border rounded disabled:opacity-50"
              >
                Previous
              </button>
              <span className="px-3 py-1">
                Page {filters.page} of {data?.pagination?.totalPages || 1}
              </span>
              <button
                onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}
                disabled={filters.page >= (data?.pagination?.totalPages || 1)}
                className="px-3 py-1 border rounded disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {/* Edit Summary Modal */}
      {editingArticle && (
        <EditSummaryModal
          article={editingArticle}
          onSave={handleSaveAndApprove}
          onCancel={() => setEditingArticle(null)}
        />
      )}
    </div>
  );
};

const StatusBadge = ({ status }: { status: string }) => {
  const colors: Record<string, string> = {
    ingested: "bg-gray-100 text-gray-800",
    embedded: "bg-yellow-100 text-yellow-800",
    scored: "bg-blue-100 text-blue-800",
    approved: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
    posted: "bg-purple-100 text-purple-800",
    duplicate: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`px-2 py-1 rounded text-xs ${colors[status] || "bg-gray-100"}`}>
      {status}
    </span>
  );
};

const ScoreBadge = ({ score }: { score: number }) => {
  const colors: Record<number, string> = {
    5: "bg-green-500 text-white",
    4: "bg-green-300 text-green-900",
    3: "bg-yellow-300 text-yellow-900",
    2: "bg-orange-300 text-orange-900",
    1: "bg-red-300 text-red-900",
  };
  return (
    <span className={`px-2 py-1 rounded font-bold ${colors[score] || "bg-gray-100"}`}>
      {score}
    </span>
  );
};

const EditSummaryModal = ({
  article,
  onSave,
  onCancel,
}: {
  article: Article;
  onSave: (summary: string) => void;
  onCancel: () => void;
}) => {
  const [summary, setSummary] = useState(article.summary || "");

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6">
        <h2 className="text-xl font-bold mb-4">Edit Summary Before Approval</h2>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
          <p className="text-gray-900">{article.title}</p>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Summary</label>
          <textarea
            value={summary}
            onChange={e => setSummary(e.target.value)}
            rows={4}
            className="w-full border rounded p-2"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 border rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(summary)}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
          >
            Save & Approve
          </button>
        </div>
      </div>
    </div>
  );
};

export default ArticlesPage;
```

---

## Part G: Environment Variables

Add to `.env`:

```env
# Telegram Bot
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# Image Generation (uses existing OPENAI_API_KEY for DALL-E)
IMAGE_PROVIDER=dalle
```

---

## Testing Checklist

### Database
- [ ] `post_schedules` table created
- [ ] `article_images` table created
- [ ] `scheduled_posts` table created

### API
- [ ] `GET /articles` returns paginated, filtered results
- [ ] `GET /articles/:id` returns single article
- [ ] `PATCH /articles/:id` updates summary and status
- [ ] `GET /articles/filters/options` returns filter options

### Distribution
- [ ] Score 5 articles auto-approved and queued for immediate post
- [ ] Score 1-2 articles auto-rejected
- [ ] Score 3-4 articles stay at "scored" for manual review
- [ ] Image generated for score 5 articles
- [ ] Telegram post sent with image

### Frontend
- [ ] Articles table displays all columns
- [ ] Filters work (sector, status, score range)
- [ ] Sorting works (date, score)
- [ ] Pagination works
- [ ] Approve button opens edit modal
- [ ] Save & Approve updates article and schedules post

---

## Sequence Diagram

```
Score 5 Flow:
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌──────────┐
│LLM Brain│────▶│Auto-    │────▶│Generate │────▶│Post to   │
│scores 5 │     │Approve  │     │Image    │     │Telegram  │
└─────────┘     └─────────┘     └─────────┘     └──────────┘

Score 3-4 Flow:
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
│LLM Brain│────▶│Manual   │────▶│Edit     │────▶│Add to    │────▶│Digest    │
│scores 4 │     │Review   │     │Summary  │     │Schedule  │     │Posted    │
└─────────┘     └─────────┘     └─────────┘     └──────────┘     └──────────┘
```

---

## Future (Task 6+)

- [ ] Digest scheduler (cron-based batch posting)
- [ ] Facebook integration
- [ ] LinkedIn integration
- [ ] Rate limiting per platform
- [ ] Post preview before sending
- [ ] Analytics dashboard (engagement tracking)
