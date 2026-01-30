# Task 2: Stage 2 — Semantic Dedup Pipeline

**Created:** 2026-01-25
**Status:** PENDING
**Rename to:** `task2_done.md` when all items are implemented

---

## Overview

Implement the semantic deduplication stage of the pipeline. This stage:
1. Generates embeddings for ingested articles using OpenAI's text-embedding-3-small
2. Compares new articles against recent articles using pgvector similarity search
3. Marks semantic duplicates and links them to the original article
4. Advances non-duplicate articles to the next pipeline stage

**Pipeline position:**
```
[1] INGEST ──→ [2] SEMANTIC DEDUP ──→ [3] LLM BRAIN ──→ [4] DISTRIBUTE
              ^^^^^^^^^^^^^^^^
              THIS TASK
```

**Cost optimization:** This stage filters duplicates BEFORE expensive LLM scoring, reducing overall costs.

---

## Prerequisites

- [ ] OpenAI API key with access to embeddings API
- [ ] pgvector extension available in PostgreSQL (Docker image or manual install)

---

## 1. Enable pgvector Extension

**File:** `packages/db/src/migrations/0001_add_pgvector.sql` (or via Drizzle)

### Steps:
1. Create migration to enable pgvector extension
2. Add `embedding` vector column to articles table
3. Add `embedding_model` column to track which model generated the embedding (future-proofing)
4. Add HNSW index for fast similarity search (optional initially)

### Migration SQL:
```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column (1536 dimensions for text-embedding-3-small)
ALTER TABLE articles ADD COLUMN embedding vector(1536);

-- Track which model generated the embedding (for future model changes)
ALTER TABLE articles ADD COLUMN embedding_model text;

-- Index for similarity search (can defer until dataset grows)
-- CREATE INDEX idx_articles_embedding ON articles
--   USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### Drizzle schema update:
```typescript
// packages/db/src/schema.ts
import { vector } from "drizzle-orm/pg-core"; // or custom type

// In articles table definition, add:
embedding: vector("embedding", { dimensions: 1536 }),
embeddingModel: text("embedding_model"),  // Track model for future compatibility
```

**Note:** Drizzle doesn't have native vector support yet. Options:
- Use raw SQL migration + custom column type
- Use `customType` helper from drizzle-orm

### Custom vector type (if needed):
```typescript
// packages/db/src/types/vector.ts
import { customType } from "drizzle-orm/pg-core";

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value.replace(/^\[/, "[").replace(/\]$/, "]"));
  },
});
```

---

## 2. Update Docker Compose for pgvector

**File:** `docker-compose.yml`

### Steps:
1. Change PostgreSQL image to pgvector-enabled version

### Target:
```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16  # Instead of postgres:16
    # ... rest unchanged
```

---

## 3. Create Embeddings Package

**Directory:** `packages/embeddings/`

### Package structure:
```
packages/embeddings/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           # Public exports
    ├── provider.ts        # Provider interface + factory
    ├── openai.ts          # OpenAI implementation
    └── similarity.ts      # pgvector query helpers
```

### 3.1 Package configuration

**File:** `packages/embeddings/package.json`
```json
{
  "name": "@watch-tower/embeddings",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "openai": "^4.70.0",
    "@watch-tower/db": "*",
    "@watch-tower/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

**File:** `packages/embeddings/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### 3.2 Provider interface

**File:** `packages/embeddings/src/provider.ts`
```typescript
import { OpenAIEmbeddingProvider } from "./openai.js";

export interface EmbeddingProvider {
  /** Model identifier for tracking */
  readonly model: string;

  /** Vector dimensions produced by this model */
  readonly dimensions: number;

  /** Generate embeddings for multiple texts (batch) */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Generate embedding for single text */
  embed(text: string): Promise<number[]>;
}

export type EmbeddingProviderConfig = {
  provider: "openai";
  apiKey: string;
  model?: string; // default: text-embedding-3-small
};

export const createEmbeddingProvider = (config: EmbeddingProviderConfig): EmbeddingProvider => {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(config.apiKey, config.model);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
};
```

> **Note:** We use static import instead of `require()` since this is an ESM package (`"type": "module"`). Dynamic imports would work too but aren't necessary here.

### 3.3 OpenAI implementation

**File:** `packages/embeddings/src/openai.ts`
```typescript
import OpenAI from "openai";
import type { EmbeddingProvider } from "./provider.js";

const DEFAULT_MODEL = "text-embedding-3-small";
const DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

// Conservative batch size to avoid token limit errors
// OpenAI limit is ~8191 tokens per input, but total request has limits too
const MAX_BATCH_SIZE = 100;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  readonly model: string;
  readonly dimensions: number;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = DIMENSIONS[model] ?? 1536;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Process in chunks to avoid API limits (token-based, not just count)
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: chunk,
      });

      // Sort by index to ensure order matches input
      const sorted = response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      results.push(...sorted);
    }

    return results;
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }
}
```

### 3.4 Similarity search helpers

**File:** `packages/embeddings/src/similarity.ts`
```typescript
import { sql } from "drizzle-orm";
import type { Database } from "@watch-tower/db";

export type SimilarArticle = {
  id: string;
  title: string;
  similarity: number;
  createdAt: Date;
};

/**
 * Find articles similar to the given embedding vector.
 * Uses cosine distance (1 - cosine_similarity).
 * Lower distance = more similar.
 *
 * IMPORTANT: Orders by distance first, then by created_at ASC to ensure
 * older articles are preferred as the "canonical" original. This prevents
 * newer articles from becoming the duplicate target.
 *
 * Also excludes articles that are themselves duplicates to prevent chains
 * (A→B→C). We only link to non-duplicate articles.
 */
export const findSimilarArticles = async (
  db: Database,
  embedding: number[],
  options: {
    threshold?: number;      // Max cosine distance (default 0.15 = ~85% similarity)
    limit?: number;          // Max results (default 5)
    excludeIds?: string[];   // Article IDs to exclude (e.g., self)
    maxAgeDays?: number;     // Only compare against recent articles (default 30)
    currentArticleCreatedAt?: Date; // Only match against older articles
  } = {},
): Promise<SimilarArticle[]> => {
  const {
    threshold = 0.15,
    limit = 5,
    excludeIds = [],
    maxAgeDays = 30,
    currentArticleCreatedAt,
  } = options;

  const vectorStr = `[${embedding.join(",")}]`;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  // Raw SQL for pgvector cosine distance operator
  const result = await db.execute(sql`
    SELECT
      id,
      title,
      created_at as "createdAt",
      1 - (embedding <=> ${vectorStr}::vector) as similarity
    FROM articles
    WHERE
      embedding IS NOT NULL
      AND pipeline_stage NOT IN ('duplicate', 'rejected', 'ingested')
      AND is_semantic_duplicate = false
      AND created_at > ${cutoffDate}
      ${currentArticleCreatedAt ? sql`AND created_at < ${currentArticleCreatedAt}` : sql``}
      ${excludeIds.length > 0 ? sql`AND id NOT IN (${sql.join(excludeIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql``}
      AND (embedding <=> ${vectorStr}::vector) < ${threshold}
    ORDER BY embedding <=> ${vectorStr}::vector, created_at ASC
    LIMIT ${limit}
  `);

  return result.rows as SimilarArticle[];
};
```

> **Key design decisions:**
> - `ORDER BY distance, created_at ASC` ensures older articles are preferred as canonical
> - `is_semantic_duplicate = false` prevents duplicate-of chains (A→B→C)
> - `currentArticleCreatedAt` filter ensures we only match against older articles

### 3.5 Public exports

**File:** `packages/embeddings/src/index.ts`
```typescript
export { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingProviderConfig } from "./provider.js";
export { findSimilarArticles, updateArticleEmbeddings, type SimilarArticle } from "./similarity.js";
```

---

## 4. Add Environment Variables

**Files:** `.env`, `.env.example`, `packages/shared/src/schemas/env.ts`

### 4.1 Environment files

```env
# Embeddings (OpenAI)
OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
SIMILARITY_THRESHOLD=0.85
```

### 4.2 Zod schema update

**File:** `packages/shared/src/schemas/env.ts`
```typescript
// Add to existing schema:
// Note: Use transform to treat empty string as undefined (for rollback: OPENAI_API_KEY="")
OPENAI_API_KEY: z.string().optional().transform((val) => val === "" ? undefined : val),
EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
```

> **Rollback safety:** The transform allows `OPENAI_API_KEY=""` to disable embeddings without validation errors.

---

## 5. Create Semantic Dedup Processor

**File:** `packages/worker/src/processors/semantic-dedup.ts`

### Key design decisions:
1. **Claim pattern**: Use `pipeline_stage = 'embedding'` as intermediate state to prevent stuck rows
2. **FOR UPDATE SKIP LOCKED**: Prevents multiple workers from processing same articles
3. **Atomic transactions**: Embedding + stage update in single transaction
4. **Empty input handling**: Skip articles with insufficient text content
5. **Store embedding_model**: Track which model generated each embedding

### Implementation:
```typescript
import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  QUEUE_SEMANTIC_DEDUP,
  JOB_SEMANTIC_BATCH,
  JOB_LLM_SCORE_BATCH,
  logger,
} from "@watch-tower/shared";
import { type Database } from "@watch-tower/db";
import {
  type EmbeddingProvider,
  findSimilarArticles,
} from "@watch-tower/embeddings";
import type { Queue } from "bullmq";

type SemanticDedupDeps = {
  connection: { host: string; port: number };
  db: Database;
  embeddingProvider: EmbeddingProvider;
  llmQueue: Queue;
  similarityThreshold: number;
  batchSize?: number;
};

const BATCH_SIZE = 50;
const MIN_TEXT_LENGTH = 10; // Minimum characters to generate meaningful embedding

type ClaimedArticle = {
  id: string;
  title: string;
  contentSnippet: string | null;
  createdAt: Date;
};

export const createSemanticDedupWorker = ({
  connection,
  db,
  embeddingProvider,
  llmQueue,
  similarityThreshold,
  batchSize = BATCH_SIZE,
}: SemanticDedupDeps) =>
  new Worker(
    QUEUE_SEMANTIC_DEDUP,
    async (job) => {
      if (job.name !== JOB_SEMANTIC_BATCH) return;

      // 1. CLAIM articles atomically using FOR UPDATE SKIP LOCKED
      // This prevents multiple workers from processing the same articles
      // and uses 'embedding' as intermediate stage to prevent stuck rows
      const claimResult = await db.execute(sql`
        UPDATE articles
        SET pipeline_stage = 'embedding'
        WHERE id IN (
          SELECT id FROM articles
          WHERE pipeline_stage = 'ingested'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        RETURNING id, title, content_snippet as "contentSnippet", created_at as "createdAt"
      `);

      const claimedArticles = claimResult.rows as ClaimedArticle[];

      if (claimedArticles.length === 0) {
        logger.debug("[semantic-dedup] no pending articles");
        return;
      }

      logger.info(`[semantic-dedup] claimed ${claimedArticles.length} articles`);

      // 2. Filter out empty/short content that would produce poor embeddings
      const validArticles: ClaimedArticle[] = [];
      const skippedIds: string[] = [];

      for (const article of claimedArticles) {
        const text = `${article.title}\n${article.contentSnippet ?? ""}`.trim();
        if (text.length >= MIN_TEXT_LENGTH) {
          validArticles.push(article);
        } else {
          skippedIds.push(article.id);
          logger.warn(`[semantic-dedup] skipping ${article.id}: insufficient text (${text.length} chars)`);
        }
      }

      // Mark skipped articles as embedded (pass through) to avoid blocking pipeline
      if (skippedIds.length > 0) {
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'embedded'
          WHERE id = ANY(${skippedIds}::uuid[])
        `);
      }

      if (validArticles.length === 0) {
        return;
      }

      // 3. Generate embeddings for batch
      const texts = validArticles.map(
        (a) => `${a.title}\n${a.contentSnippet ?? ""}`.trim(),
      );

      let embeddings: number[][];
      try {
        embeddings = await embeddingProvider.embedBatch(texts);
      } catch (err) {
        // On failure, reset articles back to 'ingested' so they can be retried
        const failedIds = validArticles.map((a) => a.id);
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'ingested'
          WHERE id = ANY(${failedIds}::uuid[])
        `);
        logger.error("[semantic-dedup] embedding generation failed, reset articles", err);
        throw err; // Will retry via BullMQ
      }

      // 4. For each article: save embedding + check for duplicates (atomic per article)
      const nonDuplicateIds: string[] = [];
      const embeddingModel = embeddingProvider.model;

      for (let i = 0; i < validArticles.length; i++) {
        const article = validArticles[i];
        const embedding = embeddings[i];
        const vectorStr = `[${embedding.join(",")}]`;

        // Check for similar articles (only older, non-duplicate articles)
        const similar = await findSimilarArticles(db, embedding, {
          threshold: 1 - similarityThreshold,
          limit: 1,
          excludeIds: [article.id],
          maxAgeDays: 30,
          currentArticleCreatedAt: article.createdAt,
        });

        if (similar.length > 0) {
          // ATOMIC: Save embedding + mark as duplicate in one update
          const original = similar[0];
          await db.execute(sql`
            UPDATE articles
            SET
              embedding = ${vectorStr}::vector,
              embedding_model = ${embeddingModel},
              pipeline_stage = 'duplicate',
              is_semantic_duplicate = true,
              duplicate_of_id = ${original.id}::uuid,
              similarity_score = ${original.similarity}
            WHERE id = ${article.id}::uuid
          `);

          logger.debug(
            `[semantic-dedup] ${article.id} is duplicate of ${original.id} (${(original.similarity * 100).toFixed(1)}%)`,
          );
        } else {
          // ATOMIC: Save embedding + advance to next stage
          await db.execute(sql`
            UPDATE articles
            SET
              embedding = ${vectorStr}::vector,
              embedding_model = ${embeddingModel},
              pipeline_stage = 'embedded'
            WHERE id = ${article.id}::uuid
          `);

          nonDuplicateIds.push(article.id);
        }
      }

      logger.info(
        `[semantic-dedup] ${nonDuplicateIds.length}/${validArticles.length} unique articles`,
      );

      // 5. Queue non-duplicates for LLM scoring
      if (nonDuplicateIds.length > 0) {
        const LLM_BATCH_SIZE = 10;
        for (let i = 0; i < nonDuplicateIds.length; i += LLM_BATCH_SIZE) {
          const batch = nonDuplicateIds.slice(i, i + LLM_BATCH_SIZE);
          await llmQueue.add(JOB_LLM_SCORE_BATCH, { articleIds: batch });
        }
      }
    },
    { connection, concurrency: 2 },
  );
```

> **Stuck row prevention:**
> - Articles move `ingested` → `embedding` → `embedded`/`duplicate`
> - If worker crashes after claim but before completion, articles stay at `embedding`
> - Add a cleanup job to reset stale `embedding` articles (>5 min old) back to `ingested`

---

## 6. Wire Up the Worker

**File:** `packages/worker/src/index.ts`

### Changes needed:
1. Import the new processor
2. Create embedding provider
3. Create semantic dedup queue + worker
4. Add queue chaining from ingest → semantic dedup
5. Add to shutdown handler

### Code additions:
```typescript
// Imports
import { Queue } from "bullmq";
import { QUEUE_SEMANTIC_DEDUP, QUEUE_LLM_BRAIN, JOB_SEMANTIC_BATCH } from "@watch-tower/shared";
import { createEmbeddingProvider } from "@watch-tower/embeddings";
import { createSemanticDedupWorker } from "./processors/semantic-dedup.js";

// After DB init, before ingest queue:

// Embedding provider (skip if no API key)
const embeddingProvider = env.OPENAI_API_KEY
  ? createEmbeddingProvider({
      provider: "openai",
      apiKey: env.OPENAI_API_KEY,
      model: env.EMBEDDING_MODEL,
    })
  : null;

// Semantic dedup queue
const semanticDedupQueue = new Queue(QUEUE_SEMANTIC_DEDUP, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// LLM queue (placeholder for Stage 3)
const llmQueue = new Queue(QUEUE_LLM_BRAIN, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Semantic dedup worker (only if embeddings enabled)
const semanticDedupWorker = embeddingProvider
  ? createSemanticDedupWorker({
      connection,
      db,
      embeddingProvider,
      llmQueue,
      similarityThreshold: env.SIMILARITY_THRESHOLD,
    })
  : null;

// Add recurring job to process pending articles
if (semanticDedupWorker) {
  await semanticDedupQueue.add(
    JOB_SEMANTIC_BATCH,
    {},
    { repeat: { every: 60 * 1000 }, jobId: JOB_SEMANTIC_BATCH }, // Every minute
  );

  semanticDedupWorker.on("failed", (job, err) => {
    logger.error(`[semantic-dedup] job ${job?.id ?? "unknown"} failed`, err.message);
  });
}

// In shutdown handler, add:
await semanticDedupWorker?.close();
await semanticDedupQueue.close();
await llmQueue.close();
```

### Stale article cleanup (add to maintenance processor)

```typescript
// In packages/worker/src/processors/maintenance.ts
// Add a job to reset stale 'embedding' stage articles (crashed workers)

const STALE_EMBEDDING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// In cleanup job handler:
const staleThreshold = new Date(Date.now() - STALE_EMBEDDING_THRESHOLD_MS);
const resetResult = await db.execute(sql`
  UPDATE articles
  SET pipeline_stage = 'ingested'
  WHERE pipeline_stage = 'embedding'
    AND updated_at < ${staleThreshold}
  RETURNING id
`);

if (resetResult.rows.length > 0) {
  logger.warn(`[maintenance] reset ${resetResult.rows.length} stale embedding articles`);
}
```

> **Note:** This requires an `updated_at` column on articles, or use `created_at` with a longer threshold.

---

## 7. Queue Chaining: Ingest → Semantic Dedup

**Option A: Recurring batch job (recommended)**
Already implemented above — semantic dedup runs every minute and picks up `ingested` articles.

**Option B: Direct chaining**
Modify ingest processor to queue semantic dedup after inserting articles:

```typescript
// In packages/worker/src/processors/feed.ts, after successful insert:
if (itemAdded > 0 && semanticDedupQueue) {
  await semanticDedupQueue.add(JOB_SEMANTIC_BATCH, {});
}
```

**Recommendation:** Start with Option A (polling) for simplicity. Option B adds coupling but reduces latency.

---

## 8. Update Turbo Pipeline

**File:** `turbo.json`

Ensure embeddings package builds before worker:
```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"]
    }
  }
}
```

The `^build` pattern means each package builds its dependencies first. No changes needed if already configured this way.

---

## 9. Testing Checklist

### Manual testing:
- [ ] `npm run infra:up` starts pgvector-enabled PostgreSQL
- [ ] `npm run db:push` creates embedding + embedding_model columns successfully
- [ ] Worker starts without errors when `OPENAI_API_KEY` is set
- [ ] Worker starts gracefully when `OPENAI_API_KEY` is NOT set (semantic dedup disabled)
- [ ] Worker starts gracefully when `OPENAI_API_KEY=""` (empty string = disabled)
- [ ] Ingested articles get embeddings after semantic dedup runs
- [ ] `embedding_model` is populated with the model name
- [ ] Duplicate articles are marked with `pipeline_stage = 'duplicate'`
- [ ] Unique articles advance to `pipeline_stage = 'embedded'`
- [ ] `similarity_score` and `duplicate_of_id` are populated for duplicates
- [ ] Older articles are always the canonical (not marked as duplicates of newer)
- [ ] No duplicate-of chains exist (duplicates only point to non-duplicates)
- [ ] Articles with empty/short content pass through without embedding
- [ ] Concurrent workers don't process the same articles (test with 2 workers)
- [ ] Stale `embedding` articles are reset by maintenance job
- [ ] Logs show deduplication progress

### SQL verification queries:
```sql
-- Check embedding + embedding_model columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'articles' AND column_name IN ('embedding', 'embedding_model');

-- Check pipeline stage distribution
SELECT pipeline_stage, COUNT(*)
FROM articles
GROUP BY pipeline_stage;

-- Check duplicate detection
SELECT a.title, a.similarity_score, a.embedding_model, b.title as duplicate_of
FROM articles a
JOIN articles b ON a.duplicate_of_id = b.id
WHERE a.is_semantic_duplicate = true
LIMIT 10;

-- Verify no duplicate chains (duplicates should point to non-duplicates)
SELECT a.id, a.title, b.is_semantic_duplicate as original_is_also_duplicate
FROM articles a
JOIN articles b ON a.duplicate_of_id = b.id
WHERE a.is_semantic_duplicate = true AND b.is_semantic_duplicate = true;
-- Should return 0 rows

-- Verify older articles are canonical
SELECT a.id, a.created_at as dup_created, b.created_at as original_created
FROM articles a
JOIN articles b ON a.duplicate_of_id = b.id
WHERE a.is_semantic_duplicate = true AND a.created_at < b.created_at;
-- Should return 0 rows (duplicates should always be newer than originals)
```

---

## Implementation Order

1. **Environment variables** — Add OPENAI_API_KEY etc. to env schema first (avoids undefined errors)
2. **Docker Compose update** — Switch to pgvector image
3. **pgvector migration** — Add extension + embedding + embedding_model columns
4. **Drizzle schema update** — Add embedding column type
5. **embeddings package** — Provider + similarity helpers
6. **Semantic dedup processor** — Core logic with claim pattern
7. **Worker wiring** — Integrate new processor + add stale cleanup
8. **Testing** — Verify end-to-end flow

---

## Cost Estimation

**OpenAI text-embedding-3-small pricing:** ~$0.02 per 1M tokens

| Articles/day | Avg tokens/article | Daily cost |
|--------------|-------------------|------------|
| 100 | 500 | $0.001 |
| 1,000 | 500 | $0.01 |
| 10,000 | 500 | $0.10 |

**Conclusion:** Embedding costs are negligible compared to LLM scoring.

---

## Rollback Plan

If issues occur:
1. Set `OPENAI_API_KEY=""` to disable semantic dedup (env schema handles empty string → undefined)
2. Worker will skip semantic dedup worker creation, articles stay at `ingested` stage
3. Reset any stuck `embedding` stage articles:
   ```sql
   UPDATE articles SET pipeline_stage = 'ingested' WHERE pipeline_stage = 'embedding';
   ```
4. Future: implement bypass to skip directly to LLM stage

---

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| OpenAI rate limiting | BullMQ exponential backoff + conservative batch sizes |
| Stuck rows (worker crash) | Claim pattern + maintenance cleanup job |
| Duplicate work (concurrent workers) | FOR UPDATE SKIP LOCKED |
| Mixed embeddings after model change | `embedding_model` column tracks source model |
| Long-tail duplicates (>30 days) | Configurable `maxAgeDays`, document limitation |
| Empty content clustering | MIN_TEXT_LENGTH filter + pass-through |
| Duplicate-of chains | Only match non-duplicate articles |

---

## Future Enhancements (Out of Scope)

- [ ] Local embeddings (BGE-small, sentence-transformers) for zero API cost
- [ ] HNSW index when dataset exceeds 100k articles
- [ ] Configurable similarity threshold per sector
- [ ] Backfill job for existing articles without embeddings
- [ ] Embedding cache to avoid re-embedding unchanged content
- [ ] Re-embedding job when model changes (based on `embedding_model` mismatch)
- [ ] N+1 query optimization: batch similarity search using temp table
