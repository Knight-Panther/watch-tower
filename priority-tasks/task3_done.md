# Task 3: Stage 3 — LLM Brain Pipeline

**Created:** 2026-01-30
**Completed:** 2026-01-31
**Status:** DONE

---

## Overview

Implement the LLM scoring and summarization stage of the pipeline. This stage:
1. Scores articles for importance (1-5 scale) using LLM
2. Generates concise summaries for high-scoring articles
3. Auto-approves/rejects based on configurable thresholds
4. Advances articles through the pipeline stages
5. **Multi-provider support** (Claude, OpenAI, DeepSeek) with automatic fallback

**Pipeline position:**
```
[1] INGEST ──→ [2] SEMANTIC DEDUP ──→ [3] LLM BRAIN ──→ [4] DISTRIBUTE
                                      ^^^^^^^^^^^^^^
                                      THIS TASK
```

**Cost optimization:** This is the most expensive stage. Previous stages filter aggressively to minimize LLM calls.

---

## Critical Design Decisions

> These decisions were validated by Codex (GPT-5.2) and Gemini (3 Pro) code review.

### Queue Model: Recurring Scanner (Option A)

The LLM brain processor uses a **recurring scanner pattern** (same as semantic-dedup):
- Polls DB for `embedded` articles every 60 seconds
- Ignores job payload `articleIds` — DB `pipeline_stage` is source of truth
- More resilient: if jobs are lost, articles still get processed

**Implication:** Remove `articleIds` from semantic-dedup's LLM queue enqueue (just trigger with empty payload).

### Partial Batch Failure Handling

Use `Promise.allSettled` to handle individual article failures:
- Successful scores are committed immediately
- Failed articles get `pipeline_stage = 'scoring_failed'` (not reset to `embedded`)
- Prevents one bad article from poisoning the entire batch forever

### Transaction + Bulk UPDATE

- Wrap batch operations in a transaction for atomicity
- Use bulk UPDATE with VALUES clause instead of N+1 queries

---

## Implementation Phases

| Phase | Description | Checkpoint |
|-------|-------------|------------|
| 1 | LLM package foundation | Package builds, exports types |
| 2 | Claude provider + validation | Can call Claude API with zod validation |
| 3 | Basic scoring processor | Articles get scores with partial failure handling |
| 4 | Summary generation | Articles get summaries |
| 5 | Auto-approve/reject logic | Threshold-based decisions |
| 6 | Per-sector scoring rules | Custom prompts per sector |
| 7 | OpenAI fallback provider | Provider selection works |

---

## Phase 1: LLM Package Foundation

**Goal:** Create package structure with types, interfaces, and validation schemas.

### 1.1 Create package directory structure

```
packages/llm/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           # Public exports
    ├── types.ts           # Shared types
    ├── schemas.ts         # Zod validation schemas
    ├── provider.ts        # Provider interface + factory
    └── prompts.ts         # Prompt templates
```

### 1.2 Package configuration

**File:** `packages/llm/package.json`
```json
{
  "name": "@watch-tower/llm",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "openai": "^4.70.0",
    "zod": "^3.23.0",
    "@watch-tower/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

**File:** `packages/llm/tsconfig.json`
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

### 1.3 Core types

**File:** `packages/llm/src/types.ts`
```typescript
export type ScoringRequest = {
  articleId: string;
  title: string;
  contentSnippet: string | null;
  sectorName?: string;
  promptTemplate?: string; // Custom prompt, or use default
};

export type ScoringResult = {
  articleId: string;
  score: number;           // 1-5
  summary: string | null;  // Generated summary (Phase 4)
  reasoning?: string;      // Optional: why this score (for debugging)
  error?: string;          // Error message if scoring failed
};

export type LLMProviderConfig = {
  provider: "claude" | "openai";
  apiKey: string;
  model?: string;
};
```

### 1.4 Zod validation schemas

**File:** `packages/llm/src/schemas.ts`
```typescript
import { z } from "zod";

/**
 * Schema for validating LLM scoring response.
 * Handles edge cases: string scores, out-of-range values, missing fields.
 */
export const ScoringResponseSchema = z.object({
  score: z.coerce.number().min(1).max(5).transform((v) => Math.round(v)),
  summary: z.string().max(500).optional().nullable(),
  reasoning: z.string().max(500).optional(),
});

export type ScoringResponse = z.infer<typeof ScoringResponseSchema>;

/**
 * Parse and validate LLM response text.
 * Strips markdown code fences and handles common LLM quirks.
 */
export const parseScoringResponse = (
  text: string,
): { success: true; data: ScoringResponse } | { success: false; error: string } => {
  try {
    // Strip markdown code fences if present
    let cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Extract JSON object from text (handles preambles like "Here is the JSON:")
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: "No JSON object found in response" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = ScoringResponseSchema.safeParse(parsed);

    if (!validated.success) {
      return { success: false, error: validated.error.message };
    }

    return { success: true, data: validated.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown parse error" };
  }
};
```

### 1.5 Provider interface

**File:** `packages/llm/src/provider.ts`
```typescript
import type { ScoringRequest, ScoringResult, LLMProviderConfig } from "./types.js";

export interface LLMProvider {
  /** Provider name for tracking */
  readonly name: string;

  /** Model identifier for tracking */
  readonly model: string;

  /** Score a single article */
  score(request: ScoringRequest): Promise<ScoringResult>;
}

// Factory function - will be implemented in Phase 2
export const createLLMProvider = (config: LLMProviderConfig): LLMProvider => {
  throw new Error(`LLM provider "${config.provider}" not yet implemented`);
};
```

### 1.6 Public exports

**File:** `packages/llm/src/index.ts`
```typescript
export type { ScoringRequest, ScoringResult, LLMProviderConfig } from "./types.js";
export type { LLMProvider } from "./provider.js";
export { createLLMProvider } from "./provider.js";
export { ScoringResponseSchema, parseScoringResponse } from "./schemas.js";
```

### 1.7 Add to workspace and worker dependency

**File:** `package.json` (root) — verify `packages/llm` is included in workspaces

**File:** `packages/worker/package.json` — add dependency:
```json
{
  "dependencies": {
    "@watch-tower/llm": "*"
  }
}
```

### Phase 1 Checkpoint

- [ ] `npm install` succeeds (workspace recognized)
- [ ] `npm run build -w @watch-tower/llm` succeeds
- [ ] Types and schemas are exported correctly
- [ ] Worker package has `@watch-tower/llm` dependency

---

## Phase 2: Claude Provider Implementation

**Goal:** Working Claude API integration with robust validation and input truncation.

### 2.1 Add environment variables

**File:** `packages/shared/src/schemas/env.ts`
```typescript
// Add to existing schema:
ANTHROPIC_API_KEY: z.string().optional().transform((val) => val === "" ? undefined : val),
LLM_PROVIDER: z.enum(["claude", "openai"]).default("claude"),
LLM_MODEL: z.string().optional(), // Override default model (see defaults below)
```

**File:** `.env.example` — add:
```env
# LLM Providers
ANTHROPIC_API_KEY=sk-ant-...
LLM_PROVIDER=claude

# Optional: Override default model
# Claude default: claude-sonnet-4-20250514
# OpenAI default: gpt-4o-mini
# LLM_MODEL=claude-sonnet-4-20250514
```

### 2.2 Default scoring prompt

**File:** `packages/llm/src/prompts.ts`
```typescript
/**
 * Input content is truncated to this length before sending to LLM.
 * Prevents context window overflow and controls costs.
 * ~10k chars ≈ ~2.5k tokens, leaving room for prompt + output.
 */
export const MAX_CONTENT_LENGTH = 10000;

/**
 * Default scoring prompt template.
 * Uses explicit JSON example (not <1-5>) to improve parse reliability.
 */
export const DEFAULT_SCORING_PROMPT = `You are a news importance scorer for a media monitoring system.

Rate the following article on a scale of 1-5 based on its importance and newsworthiness.

Scoring criteria:
1 = Not newsworthy (press releases, minor updates, promotional content)
2 = Low importance (routine news, minor developments)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments, breaking news)
5 = Critical importance (major breaking news, market-moving events)

Consider:
- Novelty and uniqueness of the information
- Potential impact on the sector/industry
- Timeliness and urgency
- Credibility indicators

Article Title: {title}
Article Content: {content}
Sector: {sector}

Respond with ONLY a valid JSON object, no markdown, no explanation:
{"score": 3, "reasoning": "Brief explanation here"}`;

/**
 * Prompt template for Phase 4+ (includes summary).
 */
export const SCORING_WITH_SUMMARY_PROMPT = `You are a news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (press releases, minor updates, promotional content)
2 = Low importance (routine news, minor developments)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments, breaking news)
5 = Critical importance (major breaking news, market-moving events)

Consider: novelty, potential impact, timeliness, credibility.

Article Title: {title}
Article Content: {content}
Sector: {sector}

Respond with ONLY a valid JSON object, no markdown, no explanation:
{"score": 3, "summary": "One or two sentence summary here.", "reasoning": "Brief explanation"}`;

/**
 * Format prompt template with article data.
 * Truncates content to MAX_CONTENT_LENGTH.
 */
export const formatScoringPrompt = (
  template: string,
  article: { title: string; content: string; sector: string },
): string => {
  const truncatedContent =
    article.content.length > MAX_CONTENT_LENGTH
      ? article.content.slice(0, MAX_CONTENT_LENGTH) + "... [truncated]"
      : article.content;

  return template
    .replace("{title}", article.title)
    .replace("{content}", truncatedContent || "No content available")
    .replace("{sector}", article.sector || "General");
};
```

### 2.3 Claude provider implementation

**File:** `packages/llm/src/claude.ts`
```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "./provider.js";
import type { ScoringRequest, ScoringResult } from "./types.js";
import { DEFAULT_SCORING_PROMPT, formatScoringPrompt } from "./prompts.js";
import { parseScoringResponse } from "./schemas.js";
import { logger } from "@watch-tower/shared";

/**
 * Default Claude model.
 * NOTE: Model IDs change over time. Override via LLM_MODEL env var.
 */
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Fallback score when parsing fails.
 * Score 3 = "needs manual review" — safe default.
 */
const FALLBACK_SCORE = 3;

export class ClaudeLLMProvider implements LLMProvider {
  private client: Anthropic;
  readonly name = "claude";
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async score(request: ScoringRequest): Promise<ScoringResult> {
    const prompt = formatScoringPrompt(
      request.promptTemplate ?? DEFAULT_SCORING_PROMPT,
      {
        title: request.title,
        content: request.contentSnippet ?? "",
        sector: request.sectorName ?? "General",
      },
    );

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });

      // Extract text from response
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      // Parse and validate with zod
      const parsed = parseScoringResponse(text);

      if (!parsed.success) {
        logger.warn(
          `[claude] Parse failed for ${request.articleId}: ${parsed.error}. Raw: ${text.slice(0, 200)}`,
        );
        // Return fallback score instead of throwing — keeps pipeline flowing
        return {
          articleId: request.articleId,
          score: FALLBACK_SCORE,
          summary: null,
          reasoning: `Parse error: ${parsed.error}`,
          error: parsed.error,
        };
      }

      return {
        articleId: request.articleId,
        score: parsed.data.score,
        summary: parsed.data.summary ?? null,
        reasoning: parsed.data.reasoning,
      };
    } catch (err) {
      logger.error(`[claude] API error for ${request.articleId}`, err);
      // Re-throw API errors (rate limits, network issues) for retry
      throw err;
    }
  }
}
```

### 2.4 Update provider factory

**File:** `packages/llm/src/provider.ts` — update:
```typescript
import type { ScoringRequest, ScoringResult, LLMProviderConfig } from "./types.js";
import { ClaudeLLMProvider } from "./claude.js";

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  score(request: ScoringRequest): Promise<ScoringResult>;
}

export const createLLMProvider = (config: LLMProviderConfig): LLMProvider => {
  switch (config.provider) {
    case "claude":
      return new ClaudeLLMProvider(config.apiKey, config.model);
    case "openai":
      throw new Error("OpenAI provider not yet implemented (Phase 7)");
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
};
```

### 2.5 Update exports

**File:** `packages/llm/src/index.ts`
```typescript
export type { ScoringRequest, ScoringResult, LLMProviderConfig } from "./types.js";
export type { LLMProvider } from "./provider.js";
export { createLLMProvider } from "./provider.js";
export { ScoringResponseSchema, parseScoringResponse } from "./schemas.js";
export {
  DEFAULT_SCORING_PROMPT,
  SCORING_WITH_SUMMARY_PROMPT,
  formatScoringPrompt,
  MAX_CONTENT_LENGTH,
} from "./prompts.js";
```

### Phase 2 Checkpoint

- [ ] `ANTHROPIC_API_KEY` in `.env` works
- [ ] Package builds successfully
- [ ] Manual test: Score a hardcoded article title
- [ ] Malformed LLM response returns fallback score 3 (not error)
- [ ] API errors (rate limit) are thrown for retry

---

## Phase 3: Scoring Processor with Partial Failure Handling

**Goal:** Worker processor with transaction safety, bulk updates, and partial failure handling.

### 3.1 Update semantic-dedup to use empty payload

**File:** `packages/worker/src/processors/semantic-dedup.ts` — update LLM queue enqueue:

```typescript
// BEFORE (sends articleIds):
// await llmQueue.add(JOB_LLM_SCORE_BATCH, { articleIds: batch });

// AFTER (empty payload — LLM brain scans DB):
if (nonDuplicateIds.length > 0) {
  // Just trigger the scanner — it will find embedded articles
  await llmQueue.add(JOB_LLM_SCORE_BATCH, {});
}
```

### 3.2 Create LLM brain processor

**File:** `packages/worker/src/processors/llm-brain.ts`
```typescript
import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  QUEUE_LLM_BRAIN,
  JOB_LLM_SCORE_BATCH,
  logger,
  EventPublisher,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import type { LLMProvider, ScoringRequest, ScoringResult } from "@watch-tower/llm";
import type { Redis } from "ioredis";

type LLMBrainDeps = {
  connection: { host: string; port: number };
  db: Database;
  redis: Redis;
  llmProvider: LLMProvider;
  batchSize?: number;
};

const DEFAULT_BATCH_SIZE = 10;

type ClaimedArticle = {
  id: string;
  title: string;
  contentSnippet: string | null;
  sectorId: string | null;
  sectorName: string | null;
};

export const createLLMBrainWorker = ({
  connection,
  db,
  redis,
  llmProvider,
  batchSize = DEFAULT_BATCH_SIZE,
}: LLMBrainDeps) => {
  const eventPublisher = new EventPublisher(redis);

  return new Worker(
    QUEUE_LLM_BRAIN,
    async (job) => {
      if (job.name !== JOB_LLM_SCORE_BATCH) return;

      // 1. CLAIM articles atomically using FOR UPDATE SKIP LOCKED
      // Scanner pattern: ignores job.data, scans for 'embedded' articles
      const claimResult = await db.execute(sql`
        UPDATE articles
        SET pipeline_stage = 'scoring'
        WHERE id IN (
          SELECT id FROM articles
          WHERE pipeline_stage = 'embedded'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        RETURNING
          id,
          title,
          content_snippet as "contentSnippet",
          sector_id as "sectorId"
      `);

      const claimedArticles = claimResult.rows as ClaimedArticle[];

      if (claimedArticles.length === 0) {
        logger.debug("[llm-brain] no pending articles");
        return;
      }

      // Fetch sector names in one query (avoid N+1)
      const sectorIds = [...new Set(claimedArticles.map((a) => a.sectorId).filter(Boolean))];
      const sectorMap = new Map<string, string>();

      if (sectorIds.length > 0) {
        const sectorsResult = await db.execute(sql`
          SELECT id, name FROM sectors WHERE id = ANY(${sectorIds}::uuid[])
        `);
        for (const row of sectorsResult.rows as { id: string; name: string }[]) {
          sectorMap.set(row.id, row.name);
        }
      }

      // Enrich articles with sector names
      const articles: ClaimedArticle[] = claimedArticles.map((a) => ({
        ...a,
        sectorName: a.sectorId ? sectorMap.get(a.sectorId) ?? null : null,
      }));

      logger.info(`[llm-brain] claimed ${articles.length} articles for scoring`);

      // 2. Score each article with Promise.allSettled for partial failure handling
      const requests: ScoringRequest[] = articles.map((a) => ({
        articleId: a.id,
        title: a.title,
        contentSnippet: a.contentSnippet,
        sectorName: a.sectorName ?? undefined,
      }));

      const settledResults = await Promise.allSettled(
        requests.map((req) => llmProvider.score(req)),
      );

      // 3. Separate successes and failures
      const successes: ScoringResult[] = [];
      const failures: { articleId: string; error: string }[] = [];

      for (let i = 0; i < settledResults.length; i++) {
        const result = settledResults[i];
        const articleId = requests[i].articleId;

        if (result.status === "fulfilled") {
          successes.push(result.value);
        } else {
          failures.push({
            articleId,
            error: result.reason instanceof Error ? result.reason.message : "Unknown error",
          });
        }
      }

      // 4. Bulk update successes in a transaction
      const scoringModel = llmProvider.model;
      const now = new Date();

      if (successes.length > 0) {
        // Build VALUES for bulk update
        const values = successes
          .map(
            (r) =>
              `('${r.articleId}'::uuid, ${r.score}, ${r.summary ? `'${r.summary.replace(/'/g, "''")}'` : "NULL"}, '${scoringModel}', '${now.toISOString()}'::timestamptz, 'scored')`,
          )
          .join(", ");

        await db.execute(sql`
          UPDATE articles AS a
          SET
            importance_score = v.score,
            llm_summary = v.summary,
            scoring_model = v.model,
            scored_at = v.scored_at,
            pipeline_stage = v.stage
          FROM (VALUES ${sql.raw(values)}) AS v(id, score, summary, model, scored_at, stage)
          WHERE a.id = v.id
        `);

        // Publish events for real-time dashboard
        for (const result of successes) {
          await eventPublisher.publish({
            type: "article:scored",
            articleId: result.articleId,
            score: result.score,
          });
        }
      }

      // 5. Mark failures with 'scoring_failed' stage (don't reset to embedded — prevents infinite loop)
      if (failures.length > 0) {
        const failedIds = failures.map((f) => f.articleId);
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'scoring_failed'
          WHERE id = ANY(${failedIds}::uuid[])
        `);

        for (const failure of failures) {
          logger.error(`[llm-brain] scoring failed for ${failure.articleId}: ${failure.error}`);
        }
      }

      logger.info(
        `[llm-brain] batch complete: ${successes.length} scored, ${failures.length} failed`,
      );
    },
    { connection, concurrency: 1 }, // Low concurrency to respect rate limits
  );
};
```

### 3.3 Wire up in worker entry

**File:** `packages/worker/src/index.ts` — add:
```typescript
import { createLLMProvider } from "@watch-tower/llm";
import { createLLMBrainWorker } from "./processors/llm-brain.js";

// After embedding provider setup...

// LLM provider (skip if no API key)
const llmApiKey =
  env.LLM_PROVIDER === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;

const llmProvider = llmApiKey
  ? createLLMProvider({
      provider: env.LLM_PROVIDER,
      apiKey: llmApiKey,
      model: env.LLM_MODEL,
    })
  : null;

if (!llmProvider) {
  logger.warn(`[worker] LLM provider disabled: no API key for ${env.LLM_PROVIDER}`);
}

// LLM brain worker (only if provider enabled)
const llmBrainWorker = llmProvider
  ? createLLMBrainWorker({
      connection,
      db,
      redis,
      llmProvider,
    })
  : null;

// Add recurring job to process pending articles (scanner pattern)
if (llmBrainWorker) {
  await llmQueue.add(
    JOB_LLM_SCORE_BATCH,
    {},
    { repeat: { every: 60 * 1000 }, jobId: "llm-score-recurring" },
  );

  llmBrainWorker.on("failed", (job, err) => {
    logger.error(`[llm-brain] job ${job?.id ?? "unknown"} failed`, err.message);
  });
}

// IMPORTANT: If LLM is disabled, semantic-dedup still enqueues jobs.
// This is expected — jobs accumulate until LLM is re-enabled.
// To drain: enable LLM, or manually delete jobs from queue.

// In shutdown handler:
await llmBrainWorker?.close();
```

### 3.4 Add stale scoring cleanup to maintenance

**File:** `packages/worker/src/processors/maintenance.ts` — add:
```typescript
// Reset stale 'scoring' stage articles (crashed workers)
// Uses 10 min threshold since LLM calls are slower than embeddings
const STALE_SCORING_THRESHOLD_MS = 10 * 60 * 1000;

const staleScoringThreshold = new Date(Date.now() - STALE_SCORING_THRESHOLD_MS);
const resetScoringResult = await db.execute(sql`
  UPDATE articles
  SET pipeline_stage = 'embedded'
  WHERE pipeline_stage = 'scoring'
    AND scored_at IS NULL
    AND created_at < ${staleScoringThreshold}
  RETURNING id
`);

if (resetScoringResult.rows.length > 0) {
  logger.warn(`[maintenance] reset ${resetScoringResult.rows.length} stale scoring articles`);
}

// Note: 'scoring_failed' articles are NOT auto-reset.
// They require manual investigation or a separate retry job.
```

### 3.5 Add article:scored event type (if not exists)

**File:** `packages/shared/src/events.ts` — verify or add:
```typescript
export type ArticleScoredEvent = {
  type: "article:scored";
  articleId: string;
  score: number;
};

// Add to PipelineEvent union type
```

### Phase 3 Checkpoint

- [ ] Worker starts without errors when `ANTHROPIC_API_KEY` is set
- [ ] Worker starts gracefully when API key is NOT set (LLM disabled)
- [ ] `embedded` articles get scored and move to `scored` stage
- [ ] `importance_score` and `scoring_model` are populated
- [ ] Partial failures: successful articles saved, failed ones → `scoring_failed`
- [ ] Events published for real-time dashboard
- [ ] Bulk UPDATE used (not N+1)
- [ ] Stale `scoring` articles are reset by maintenance
- [ ] Logs show scoring progress

**SQL verification:**
```sql
-- Check pipeline stage distribution
SELECT pipeline_stage, COUNT(*), AVG(importance_score) as avg_score
FROM articles
GROUP BY pipeline_stage;

-- Check scored articles
SELECT title, importance_score, scoring_model, scored_at
FROM articles
WHERE pipeline_stage = 'scored'
ORDER BY scored_at DESC
LIMIT 10;

-- Check failed articles (should investigate these)
SELECT id, title, created_at
FROM articles
WHERE pipeline_stage = 'scoring_failed';
```

---

## Phase 4: Summary Generation

**Goal:** Generate concise summaries for articles during scoring.

### 4.1 Update default prompt

In `packages/llm/src/prompts.ts`, the `SCORING_WITH_SUMMARY_PROMPT` is already defined.

**File:** `packages/llm/src/claude.ts` — update to use summary prompt:
```typescript
import { SCORING_WITH_SUMMARY_PROMPT, formatScoringPrompt } from "./prompts.js";

// In score() method:
const prompt = formatScoringPrompt(
  request.promptTemplate ?? SCORING_WITH_SUMMARY_PROMPT, // Changed from DEFAULT_SCORING_PROMPT
  {
    title: request.title,
    content: request.contentSnippet ?? "",
    sector: request.sectorName ?? "General",
  },
);
```

### 4.2 Update bulk update to include summary

The bulk UPDATE in Phase 3 already includes `llm_summary`. No changes needed.

### Phase 4 Checkpoint

- [ ] Scored articles have `llm_summary` populated
- [ ] Summaries are concise (1-2 sentences, max 200 chars)
- [ ] Score + summary generated in single LLM call (cost efficient)

**SQL verification:**
```sql
SELECT title, importance_score, llm_summary, LENGTH(llm_summary) as summary_len
FROM articles
WHERE llm_summary IS NOT NULL
ORDER BY scored_at DESC
LIMIT 10;
```

---

## Phase 5: Auto-Approve/Reject Logic

**Goal:** Automatically approve/reject articles based on score thresholds.

### 5.1 Add threshold constants

**File:** `packages/shared/src/schemas/env.ts` — add:
```typescript
LLM_AUTO_APPROVE_THRESHOLD: z.coerce.number().min(1).max(5).default(5),
LLM_AUTO_REJECT_THRESHOLD: z.coerce.number().min(1).max(5).default(2),
```

### 5.2 Update processor deps and logic

**File:** `packages/worker/src/processors/llm-brain.ts` — update:

```typescript
type LLMBrainDeps = {
  connection: { host: string; port: number };
  db: Database;
  redis: Redis;
  llmProvider: LLMProvider;
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  batchSize?: number;
};

// In the bulk update section, determine stage per article:
if (successes.length > 0) {
  const values = successes
    .map((r) => {
      let stage: string;
      let approvedAt: string | null = null;

      if (r.score >= deps.autoApproveThreshold) {
        stage = "approved";
        approvedAt = `'${now.toISOString()}'::timestamptz`;
      } else if (r.score <= deps.autoRejectThreshold) {
        stage = "rejected";
      } else {
        stage = "scored"; // Manual review needed
      }

      return `('${r.articleId}'::uuid, ${r.score}, ${r.summary ? `'${r.summary.replace(/'/g, "''")}'` : "NULL"}, '${scoringModel}', '${now.toISOString()}'::timestamptz, ${approvedAt ?? "NULL"}, '${stage}')`;
    })
    .join(", ");

  await db.execute(sql`
    UPDATE articles AS a
    SET
      importance_score = v.score,
      llm_summary = v.summary,
      scoring_model = v.model,
      scored_at = v.scored_at,
      approved_at = v.approved_at,
      pipeline_stage = v.stage
    FROM (VALUES ${sql.raw(values)}) AS v(id, score, summary, model, scored_at, approved_at, stage)
    WHERE a.id = v.id
  `);
}

// Log stats
const approved = successes.filter((r) => r.score >= deps.autoApproveThreshold).length;
const rejected = successes.filter((r) => r.score <= deps.autoRejectThreshold).length;
const review = successes.length - approved - rejected;

logger.info(
  `[llm-brain] batch: ${approved} approved, ${rejected} rejected, ${review} for review, ${failures.length} failed`,
);
```

### 5.3 Update worker wiring

**File:** `packages/worker/src/index.ts` — update:
```typescript
const llmBrainWorker = llmProvider
  ? createLLMBrainWorker({
      connection,
      db,
      redis,
      llmProvider,
      autoApproveThreshold: env.LLM_AUTO_APPROVE_THRESHOLD,
      autoRejectThreshold: env.LLM_AUTO_REJECT_THRESHOLD,
    })
  : null;
```

### Phase 5 Checkpoint

- [ ] Score 5 articles → `approved` stage
- [ ] Score 1-2 articles → `rejected` stage
- [ ] Score 3-4 articles → `scored` stage (manual review)
- [ ] `approved_at` is set for auto-approved articles
- [ ] Logs show approval/rejection stats

**SQL verification:**
```sql
-- Check auto-approval distribution
SELECT
  pipeline_stage,
  COUNT(*),
  AVG(importance_score) as avg_score
FROM articles
WHERE scored_at IS NOT NULL
GROUP BY pipeline_stage;

-- Check approved articles
SELECT title, importance_score, llm_summary, approved_at
FROM articles
WHERE pipeline_stage = 'approved'
ORDER BY approved_at DESC
LIMIT 10;
```

---

## Phase 6: Per-Sector Scoring Rules

**Goal:** Use custom prompt templates and thresholds from `scoring_rules` table.

### 6.1 Fetch and apply scoring rules in processor

**File:** `packages/worker/src/processors/llm-brain.ts` — update:

```typescript
// After fetching sector names, also fetch scoring rules:
type SectorRule = {
  promptTemplate: string;
  autoApprove: number;
  autoReject: number;
};
const sectorRules = new Map<string, SectorRule>();

if (sectorIds.length > 0) {
  const rulesResult = await db.execute(sql`
    SELECT
      sector_id as "sectorId",
      prompt_template as "promptTemplate",
      auto_approve_threshold as "autoApprove",
      auto_reject_threshold as "autoReject"
    FROM scoring_rules
    WHERE sector_id = ANY(${sectorIds}::uuid[])
  `);

  for (const row of rulesResult.rows as any[]) {
    sectorRules.set(row.sectorId, {
      promptTemplate: row.promptTemplate,
      autoApprove: row.autoApprove,
      autoReject: row.autoReject,
    });
  }
}

// Build scoring requests with sector-specific prompts
const requests: ScoringRequest[] = articles.map((a) => {
  const rules = a.sectorId ? sectorRules.get(a.sectorId) : undefined;
  return {
    articleId: a.id,
    title: a.title,
    contentSnippet: a.contentSnippet,
    sectorName: a.sectorName ?? undefined,
    promptTemplate: rules?.promptTemplate, // Use custom or default
  };
});

// In approval logic, use sector-specific thresholds:
const getThresholds = (articleId: string) => {
  const article = articles.find((a) => a.id === articleId)!;
  const rules = article.sectorId ? sectorRules.get(article.sectorId) : undefined;
  return {
    approve: rules?.autoApprove ?? deps.autoApproveThreshold,
    reject: rules?.autoReject ?? deps.autoRejectThreshold,
  };
};
```

### 6.2 Seed default scoring rules

**File:** `packages/db/seed.sql` — add scoring rules:

```sql
-- Seed default scoring rules for each sector
-- Run after sectors are created

INSERT INTO scoring_rules (sector_id, prompt_template, auto_approve_threshold, auto_reject_threshold)
SELECT
  s.id,
  CASE s.slug
    WHEN 'biotech' THEN 'You are a biotech news analyst. Focus on FDA approvals, clinical trial results, drug discoveries, and healthcare innovation.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (press releases, minor updates)
2 = Low importance (routine news)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments, FDA decisions)
5 = Critical importance (major approvals, breakthrough results)

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'

    WHEN 'crypto' THEN 'You are a crypto/blockchain news analyst. Focus on regulatory changes, major protocol updates, security incidents, and institutional adoption.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (minor token launches, shilling)
2 = Low importance (routine updates)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant protocol changes, regulatory moves)
5 = Critical importance (major hacks, landmark regulations, institutional news)

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'

    ELSE 'You are a news analyst specializing in ' || s.slug || ' news.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (press releases, minor updates)
2 = Low importance (routine news)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments)
5 = Critical importance (major breaking news)

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'
  END,
  5, -- auto_approve_threshold
  2  -- auto_reject_threshold
FROM sectors s
ON CONFLICT (sector_id) DO NOTHING;
```

### Phase 6 Checkpoint

- [ ] `scoring_rules` table has entries for each sector
- [ ] Articles use sector-specific prompts when available
- [ ] Sector-specific thresholds override defaults
- [ ] Generic articles (no sector) use default prompt

**SQL verification:**
```sql
-- Check scoring rules
SELECT s.name, sr.auto_approve_threshold, sr.auto_reject_threshold
FROM scoring_rules sr
JOIN sectors s ON sr.sector_id = s.id;

-- Verify sector-specific scoring
SELECT
  s.name as sector,
  COUNT(*) as total,
  AVG(a.importance_score) as avg_score
FROM articles a
JOIN sectors s ON a.sector_id = s.id
WHERE a.scored_at IS NOT NULL
GROUP BY s.name;
```

---

## Phase 7: OpenAI Fallback Provider

**Goal:** Add OpenAI as alternative provider.

### 7.1 OpenAI provider implementation

**File:** `packages/llm/src/openai.ts`
```typescript
import OpenAI from "openai";
import type { LLMProvider } from "./provider.js";
import type { ScoringRequest, ScoringResult } from "./types.js";
import { SCORING_WITH_SUMMARY_PROMPT, formatScoringPrompt } from "./prompts.js";
import { parseScoringResponse } from "./schemas.js";
import { logger } from "@watch-tower/shared";

/**
 * Default OpenAI model.
 * gpt-4o-mini is cost-efficient with good quality.
 */
const DEFAULT_MODEL = "gpt-4o-mini";
const FALLBACK_SCORE = 3;

export class OpenAILLMProvider implements LLMProvider {
  private client: OpenAI;
  readonly name = "openai";
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async score(request: ScoringRequest): Promise<ScoringResult> {
    const prompt = formatScoringPrompt(
      request.promptTemplate ?? SCORING_WITH_SUMMARY_PROMPT,
      {
        title: request.title,
        content: request.contentSnippet ?? "",
        sector: request.sectorName ?? "General",
      },
    );

    try {
      // Try with JSON mode first (not all models support it)
      const supportsJsonMode = this.model.includes("gpt-4") || this.model.includes("gpt-3.5-turbo");

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
        ...(supportsJsonMode && { response_format: { type: "json_object" } }),
      });

      const text = response.choices[0]?.message?.content ?? "";
      const parsed = parseScoringResponse(text);

      if (!parsed.success) {
        logger.warn(
          `[openai] Parse failed for ${request.articleId}: ${parsed.error}. Raw: ${text.slice(0, 200)}`,
        );
        return {
          articleId: request.articleId,
          score: FALLBACK_SCORE,
          summary: null,
          reasoning: `Parse error: ${parsed.error}`,
          error: parsed.error,
        };
      }

      return {
        articleId: request.articleId,
        score: parsed.data.score,
        summary: parsed.data.summary ?? null,
        reasoning: parsed.data.reasoning,
      };
    } catch (err) {
      logger.error(`[openai] API error for ${request.articleId}`, err);
      throw err;
    }
  }
}
```

### 7.2 Update provider factory

**File:** `packages/llm/src/provider.ts` — update:
```typescript
import { ClaudeLLMProvider } from "./claude.js";
import { OpenAILLMProvider } from "./openai.js";

export const createLLMProvider = (config: LLMProviderConfig): LLMProvider => {
  switch (config.provider) {
    case "claude":
      return new ClaudeLLMProvider(config.apiKey, config.model);
    case "openai":
      return new OpenAILLMProvider(config.apiKey, config.model);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
};
```

### Phase 7 Checkpoint

- [ ] `LLM_PROVIDER=openai` uses OpenAI
- [ ] `LLM_PROVIDER=claude` uses Claude (default)
- [ ] Both providers produce valid scores and summaries
- [ ] `scoring_model` correctly reflects which provider was used
- [ ] Parse errors return fallback score (not crash)

---

## Final Testing Checklist

### End-to-end flow:
- [ ] Articles flow: `ingested` → `embedded` → `scored` → `approved`/`rejected`
- [ ] No stuck articles in `scoring` stage
- [ ] `scoring_failed` articles are logged (investigate manually)
- [ ] LLM costs are reasonable (check provider dashboard)

### Error handling:
- [ ] Worker recovers from API rate limits (BullMQ retry)
- [ ] Parse errors return fallback score (pipeline continues)
- [ ] Partial batch failures: successes saved, failures marked
- [ ] Stale articles are cleaned up

### Performance:
- [ ] Batch of 10 articles scored in reasonable time
- [ ] Bulk UPDATE used (not N+1)
- [ ] Sector rules fetched in single query

### Configuration:
- [ ] Per-sector prompts work
- [ ] Per-sector thresholds work
- [ ] Environment variable overrides work
- [ ] Model can be overridden via `LLM_MODEL`

---

## Cost Estimation

| Provider | Model | Cost per 1K articles |
|----------|-------|---------------------|
| Claude | claude-sonnet-4-20250514 | ~$0.30 |
| OpenAI | gpt-4o-mini | ~$0.15 |

**Assumptions:** ~500 tokens input (after truncation), ~100 tokens output per article.

**Cost optimization tips:**
- Use gpt-4o-mini for cost efficiency
- Anthropic prompt caching can reduce input costs by ~90% (requires config)
- Aggressive pre-filtering in earlier stages reduces LLM calls

---

## Rollback Plan

If issues occur:
1. Set `ANTHROPIC_API_KEY=""` and `OPENAI_API_KEY=""` to disable LLM
2. Articles will stay at `embedded` stage (semantic dedup still works)
3. Jobs will accumulate in LLM queue (expected behavior)
4. Reset stuck articles:
   ```sql
   UPDATE articles SET pipeline_stage = 'embedded' WHERE pipeline_stage = 'scoring';
   ```
5. Investigate failed articles:
   ```sql
   SELECT * FROM articles WHERE pipeline_stage = 'scoring_failed';
   ```

---

## Re-scoring Semantics

**Important:** If you re-run scoring (prompt changes, model changes):
- Previously `approved` articles may be downgraded
- `approved_at` will be overwritten or cleared
- Consider adding `re_scored_at` column if audit trail needed

**Recommendation:** For re-scoring, create a separate job that:
1. Resets `pipeline_stage` to `embedded`
2. Clears `importance_score`, `llm_summary`, `scoring_model`
3. Lets normal pipeline re-process

---

## Phase 8: Multi-Provider Support with Fallback (ADDED)

**Goal:** Support multiple LLM providers with automatic fallback on failures.

### 8.1 Implemented Features

| Feature | Description |
|---------|-------------|
| **DeepSeek provider** | Cost-effective alternative ($0.14/1M input) |
| **Per-provider model config** | `LLM_CLAUDE_MODEL`, `LLM_OPENAI_MODEL`, `LLM_DEEPSEEK_MODEL` |
| **Fallback on failure** | Parse errors, API errors, auth errors trigger fallback |
| **Auth error warnings** | Specific log when 401/403 triggers fallback |
| **Missing key warnings** | Log when fallback configured but key missing |
| **Provider-aware logging** | `[deepseek]` instead of `[openai]` for DeepSeek calls |

### 8.2 New Environment Variables

```env
# Provider selection
LLM_PROVIDER=deepseek              # claude | openai | deepseek

# Per-provider models (optional)
LLM_CLAUDE_MODEL=claude-sonnet-4-20250514
LLM_OPENAI_MODEL=gpt-4o-mini
LLM_DEEPSEEK_MODEL=deepseek-chat

# Fallback (optional)
LLM_FALLBACK_PROVIDER=claude
LLM_FALLBACK_MODEL=claude-sonnet-4-20250514

# API keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
```

### 8.3 Fallback Triggers

| Error Type | Triggers Fallback |
|------------|-------------------|
| Parse error (malformed JSON) | Yes |
| Auth error (401/403) | Yes + Warning |
| Network errors (ECONNRESET, etc.) | Yes |
| Rate limit (429) | Yes |
| Server errors (5xx) | Yes |

### 8.4 New Files

| File | Purpose |
|------|---------|
| `packages/llm/src/deepseek.ts` | DeepSeek provider (OpenAI-compatible) |
| `packages/llm/src/fallback.ts` | `LLMProviderWithFallback` wrapper |
| `packages/llm/README.md` | Configuration guide for developers |

### Phase 8 Checkpoint

- [x] DeepSeek provider works
- [x] Per-provider model selection works
- [x] Fallback triggers on parse errors
- [x] Fallback triggers on API errors
- [x] Auth errors log specific warning
- [x] Missing fallback key logs warning
- [x] Provider-aware logging (uses `this.name`)

---

## Future Enhancements (Out of Scope)

- [ ] Anthropic prompt caching configuration
- [ ] Batch scoring in single LLM call (multi-article prompt)
- [ ] `pipeline_stage_changed_at` column for better zombie detection
- [ ] Caching: skip re-scoring unchanged articles
- [ ] A/B testing different prompts
- [ ] Confidence scores from LLM
- [ ] Human feedback loop to improve prompts
- [ ] Cost tracking per sector
- [ ] `rejected_at` column for rejection audit trail
- [ ] Dashboard integration for remaining API credits
- [ ] Per-sector model preference from `scoring_rules.model_preference`
