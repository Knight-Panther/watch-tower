# Task 14: Georgian Translation Layer

Add a translation layer that converts English article titles and summaries to Georgian using Gemini or OpenAI. This enables posting in Georgian across all social platforms with a single global toggle.

---

## Table of Contents

1. [Requirements Summary](#1-requirements-summary)
2. [Architecture: Decoupled Translation Status](#2-architecture-decoupled-translation-status)
3. [Schema Changes](#3-schema-changes)
4. [Implementation: Existing Code Changes (A1-A5)](#4-implementation-existing-code-changes-a1-a5)
5. [Implementation: New Code (B1-B6)](#5-implementation-new-code-b1-b6)
6. [Change Map](#6-change-map)
7. [Testing Checklist](#7-testing-checklist)

---

## 1. Requirements Summary

### Translation Layer

| Setting | Value |
|---------|-------|
| Trigger | Automatic after LLM scoring, for articles matching configured scores |
| Scores to translate | Configurable checkboxes: default [3, 4, 5] |
| Global enable/disable | `posting_language` toggle: `"en"` (off) or `"ka"` (on) |
| Input | `title` + `llm_summary` (English) |
| Output | `title_ka` + `llm_summary_ka` (Georgian) |
| Provider | Gemini (default) or OpenAI — switchable via UI, no heavy abstraction |
| Model | Configurable via app_config (default: `gemini-2.0-flash`) |
| Instructions | Global textarea for style/tone guidance |
| Backfill old articles | No — `translation_enabled_since` timestamp prevents translating pre-existing articles |

### Posting Behavior

| Setting | Value |
|---------|-------|
| Language toggle | `posting_language`: `"en"` or `"ka"` in app_config |
| Scope | All platforms, all posts (auto + scheduled) |
| When `"en"` | Uses `title` / `llm_summary` (current behavior, unchanged) |
| When `"ka"` | Uses `title_ka` / `llm_summary_ka` |
| Missing translation | Distribution rolls back to `approved`, logs warning, skips platform |

### Auto-Post Gating (Critical)

| Mode | Behavior |
|------|----------|
| `posting_language = "en"` | LLM brain queues distribution immediately for auto-approved articles (current behavior) |
| `posting_language = "ka"` | LLM brain SKIPS distribution queue. Translation worker translates, then queues distribution for `approved` articles |

**Flow diagram:**
```
English mode:
  LLM Brain → scores article → auto-approve (score 5) → queues distribution → posts in English

Georgian mode:
  LLM Brain → scores article → auto-approve (score 5) → SKIPS distribution
       ↓
  Translation Worker picks up (scored_at IS NOT NULL, translation_status IS NULL)
       ↓
  Translates → stores title_ka, llm_summary_ka, translation_status = 'translated'
       ↓
  If pipeline_stage = 'approved': queues distribution → posts in Georgian
  If pipeline_stage = 'scored': waits for manual approval (user schedules via UI)
```

### Config Keys in app_config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `posting_language` | string | `"en"` | `"en"` or `"ka"` — acts as master toggle |
| `translation_scores` | number[] | `[3, 4, 5]` | Which scores to translate |
| `translation_provider` | string | `"gemini"` | `"gemini"` or `"openai"` |
| `translation_model` | string | `"gemini-2.0-flash"` | Model identifier (provider-specific) |
| `translation_instructions` | string | _(default prompt)_ | Custom style/tone instructions |
| `translation_enabled_since` | string (ISO) | _(set when switching to "ka")_ | Backfill guard timestamp |

**Simplification:** No `translation_enabled` key (redundant with `posting_language`). No heavy abstraction — just two concrete functions with a switch.

---

## 2. Architecture: Decoupled Translation Status

### Why NOT New Pipeline Stages

The old approach proposed adding `translating` / `translated` / `translation_failed` as new `pipeline_stage` values. This would break **every existing worker** because they all hardcode specific stages:

| Worker | Hardcoded Stage | Would Break |
|--------|----------------|-------------|
| Distribution (`distribution.ts:128`) | `WHERE pipeline_stage = 'approved'` | Yes — `translated` articles never reach distribution |
| Rescue (`maintenance.ts:234`) | `WHERE pipeline_stage = 'approved'` | Yes — would skip untranslated articles, or push them prematurely |
| Zombie reset (`maintenance.ts:156-190`) | `embedding → ingested`, `scoring → embedded` | Would need new entries for each translation stage |
| Scheduled posts (`maintenance.ts:426-437`) | Fetches article by ID, expects `approved` | Would need stage awareness |
| Articles API (`articles.ts:395`) | `allowedStages = ["scored", "approved"]` | Would need `translated` added |
| Frontend (`Articles.tsx:17-25`) | Hardcoded 7 stages | Would need UI changes |

**Cascading breakage across 6+ files for a feature that should be orthogonal to the pipeline.**

### The Solution: Separate `translation_status` Column

Add a **decoupled** `translation_status` column to `articles`:

```
translation_status: NULL | 'translating' | 'translated' | 'failed'
```

**Key properties:**
- `pipeline_stage` remains untouched — all existing workers keep working as-is
- Translation worker queries by `importance_score` + `translation_status` + `scored_at`, NOT `pipeline_stage`
- Distribution checks Georgian fields at format time, not at claim time
- Zombie reset only resets `translation_status`, never touches `pipeline_stage`

**State diagram:**
```
Article scored (score 3-4):  pipeline_stage = 'scored',  translation_status = NULL
Article scored (score 5):    pipeline_stage = 'approved', translation_status = NULL
                                    ↓
Translation worker claims:   pipeline_stage = unchanged,  translation_status = 'translating'
                                    ↓
Translation success:         pipeline_stage = unchanged,  translation_status = 'translated'
Translation failure:         pipeline_stage = unchanged,  translation_status = 'failed'
```

### How Distribution Handles Georgian Mode

Distribution worker claims `approved` articles exactly as before (`distribution.ts:124-136`). At format time:

1. Read `posting_language` from app_config
2. If `"en"` → use English fields (unchanged)
3. If `"ka"` AND `title_ka IS NOT NULL` → use Georgian fields
4. If `"ka"` AND `title_ka IS NULL` → **roll back to `approved`**, skip this article (translation pending)

This is safe because:
- Distribution's atomic claim (`approved → posting`) is idempotent
- Rolling back to `approved` means the rescue function or next distribution job will retry
- Once translation completes, the article will have `title_ka` and proceed normally

---

## 3. Schema Changes

### 3.1 Articles Table — New Columns

Add to `packages/db/src/schema.ts` (inside articles table, after line 88):

```typescript
// Georgian translation fields
titleKa: text("title_ka"),
llmSummaryKa: text("llm_summary_ka"),
translationModel: text("translation_model"),
translationStatus: text("translation_status"),  // NULL | 'translating' | 'translated' | 'failed'
translatedAt: timestamp("translated_at", { withTimezone: true }),
```

### 3.2 Migration SQL

```sql
ALTER TABLE articles ADD COLUMN title_ka TEXT;
ALTER TABLE articles ADD COLUMN llm_summary_ka TEXT;
ALTER TABLE articles ADD COLUMN translation_model TEXT;
ALTER TABLE articles ADD COLUMN translation_status TEXT;
ALTER TABLE articles ADD COLUMN translated_at TIMESTAMPTZ;

-- Index for translation worker claim query
CREATE INDEX idx_articles_translation_pending
  ON articles (importance_score, translation_status)
  WHERE translation_status IS NULL AND scored_at IS NOT NULL;
```

### 3.3 App Config Seeds

Add to `packages/db/seed.sql`:

```sql
-- Translation settings
INSERT INTO app_config (key, value, updated_at) VALUES
  ('posting_language', '"en"', NOW()),
  ('translation_scores', '[3, 4, 5]', NOW()),
  ('translation_provider', '"gemini"', NOW()),
  ('translation_model', '"gemini-2.0-flash"', NOW()),
  ('translation_instructions', '"Translate the following English news content into Georgian. Maintain a professional, news-appropriate tone. Keep proper nouns (company names, person names) in their original form. Technical terms like Bitcoin, blockchain, AI may remain in English if no widely-accepted Georgian equivalent exists. The translation should be natural and fluent, not word-for-word."', NOW())
ON CONFLICT (key) DO NOTHING;
```

**Note:** Values are raw JSONB. Drizzle auto-parses on read: `'"en"'` → string `"en"`, `'[3,4,5]'` → array `[3,4,5]`.

---

## 4. Implementation: Existing Code Changes (A1-A5)

### A1: LLM Brain — Skip Immediate Distribution in Georgian Mode

**File:** `packages/worker/src/processors/llm-brain.ts`
**Location:** Lines 379-401 (inside the `article:approved` event handler)

The LLM brain currently queues distribution immediately for auto-approved articles (score >= threshold). In Georgian mode, we must skip this — the translation worker will queue distribution after translating.

**Current code (lines 383-401):**
```typescript
if (distributionQueue) {
  const telegramEnabled = await isTelegramAutoPostEnabled(db);
  if (telegramEnabled) {
    await distributionQueue.add(
      JOB_DISTRIBUTION_IMMEDIATE,
      { articleId: result.articleId },
      { jobId: `immediate-${result.articleId}` },
    );
    logger.info(
      { articleId: result.articleId, score: result.score },
      "[llm-brain] queued for immediate Telegram distribution",
    );
  }
}
```

**Change:** Wrap with posting language check:
```typescript
if (distributionQueue) {
  // Check posting language — Georgian mode defers to translation worker
  const [langRow] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "posting_language"));
  const postingLanguage = (langRow?.value as string) ?? "en";

  if (postingLanguage === "ka") {
    logger.debug(
      { articleId: result.articleId, score: result.score },
      "[llm-brain] Georgian mode — translation worker will handle distribution",
    );
  } else {
    const telegramEnabled = await isTelegramAutoPostEnabled(db);
    if (telegramEnabled) {
      await distributionQueue.add(
        JOB_DISTRIBUTION_IMMEDIATE,
        { articleId: result.articleId },
        { jobId: `immediate-${result.articleId}` },
      );
      logger.info(
        { articleId: result.articleId, score: result.score },
        "[llm-brain] queued for immediate Telegram distribution",
      );
    }
  }
}
```

### A2: Distribution Worker — Georgian Field Selection + Rollback

**File:** `packages/worker/src/processors/distribution.ts`

**Change 1: Add Georgian fields to RETURNING clause (line 124-136)**

Update the atomic claim query to also return `title_ka` and `llm_summary_ka`:

```sql
RETURNING
  id,
  title,
  url,
  llm_summary as "llmSummary",
  importance_score as "importanceScore",
  title_ka as "titleKa",
  llm_summary_ka as "llmSummaryKa",
  (SELECT name FROM sectors WHERE id = articles.sector_id) as "sectorName"
```

Update the `ArticleForDistribution` type (line 41-48):
```typescript
type ArticleForDistribution = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  sectorName: string | null;
  titleKa: string | null;       // ADD
  llmSummaryKa: string | null;  // ADD
};
```

**Change 2: Language-aware formatting (before line 227)**

After the article is claimed and before the platform loop, read posting language and resolve content:

```typescript
// Read posting language
const [langRow] = await db
  .select({ value: appConfig.value })
  .from(appConfig)
  .where(eq(appConfig.key, "posting_language"));
const postingLanguage = (langRow?.value as string) ?? "en";

// Georgian mode: check translation is available
if (postingLanguage === "ka" && (!article.titleKa || !article.llmSummaryKa)) {
  // Roll back to approved — translation worker hasn't finished yet
  await db.execute(sql`
    UPDATE articles SET pipeline_stage = 'approved' WHERE id = ${articleId}::uuid
  `);
  logger.warn(
    { articleId },
    "[distribution] Georgian mode but no translation — rolled back to approved",
  );
  return { skipped: true, reason: "awaiting_translation" };
}

// Resolve content based on language
const postTitle = postingLanguage === "ka" && article.titleKa
  ? article.titleKa : article.title;
const postSummary = postingLanguage === "ka" && article.llmSummaryKa
  ? article.llmSummaryKa : (article.llmSummary || article.title);
```

**Change 3: Use resolved content in formatPost (line 227-235)**

Replace the hardcoded English fields:
```typescript
const text = provider!.formatPost(
  {
    title: postTitle,
    summary: postSummary,
    url: article.url,
    sector: article.sectorName || "News",
  },
  template,
);
```

### A3: Maintenance Worker — Scheduled Posts Language Awareness

**File:** `packages/worker/src/processors/maintenance.ts`

**Change 1: Add Georgian fields to scheduled post article query (lines 426-437)**

```sql
SELECT
  a.id,
  a.title,
  a.url,
  a.llm_summary as "llmSummary",
  a.importance_score as "importanceScore",
  a.title_ka as "titleKa",
  a.llm_summary_ka as "llmSummaryKa",
  s.name as "sectorName"
FROM articles a
LEFT JOIN sectors s ON a.sector_id = s.id
WHERE a.id = ${delivery.articleId}::uuid
```

Update the `ArticleForPost` type (lines 266-273):
```typescript
type ArticleForPost = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  sectorName: string | null;
  titleKa: string | null;       // ADD
  llmSummaryKa: string | null;  // ADD
};
```

**Change 2: Language-aware formatting in processScheduledPosts (lines 452-461)**

Before formatPost, read language and resolve content (same pattern as distribution):

```typescript
// Read posting language
const [langRow] = await db
  .select({ value: appConfig.value })
  .from(appConfig)
  .where(eq(appConfig.key, "posting_language"));
const postingLanguage = (langRow?.value as string) ?? "en";

// Georgian mode: check translation is available
if (postingLanguage === "ka" && (!article.titleKa || !article.llmSummaryKa)) {
  logger.warn(
    { deliveryId: delivery.id, articleId: delivery.articleId },
    "[post-scheduler] Georgian mode but no translation — marking failed",
  );
  await db
    .update(postDeliveries)
    .set({ status: "failed", errorMessage: "No Georgian translation available" })
    .where(eq(postDeliveries.id, delivery.id));
  continue;
}

// Resolve content based on language
const postTitle = postingLanguage === "ka" && article.titleKa
  ? article.titleKa : article.title;
const postSummary = postingLanguage === "ka" && article.llmSummaryKa
  ? article.llmSummaryKa : (article.llmSummary || article.title);

// Format and post using resolved content
const text = provider.formatPost(
  {
    title: postTitle,
    summary: postSummary,
    url: article.url,
    sector: article.sectorName || "News",
  },
  template,
);
```

**Note:** Read `posting_language` once at the top of `processScheduledPosts()` to avoid N+1 queries.

### A4: Rescue Function — Georgian Guard

**File:** `packages/worker/src/processors/maintenance.ts`
**Location:** Lines 228-264 (`rescueOrphanedApprovedArticles`)

The rescue function finds `approved` articles older than 5 minutes and re-queues them to distribution. In Georgian mode, this would push untranslated articles into distribution repeatedly.

**Change:** Add Georgian guard to the rescue query (line 234):

```typescript
const rescueOrphanedApprovedArticles = async (db: Database, distributionQueue?: Queue) => {
  if (!distributionQueue) return 0;

  // Check posting language once
  const [langRow] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "posting_language"));
  const postingLanguage = (langRow?.value as string) ?? "en";

  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);

  // In Georgian mode, only rescue articles that have been translated
  const orphanedResult = postingLanguage === "ka"
    ? await db.execute(sql`
        SELECT id FROM articles
        WHERE pipeline_stage = 'approved'
          AND approved_at IS NOT NULL
          AND approved_at < ${staleThreshold}
          AND title_ka IS NOT NULL
        LIMIT 20
      `)
    : await db.execute(sql`
        SELECT id FROM articles
        WHERE pipeline_stage = 'approved'
          AND approved_at IS NOT NULL
          AND approved_at < ${staleThreshold}
        LIMIT 20
      `);

  // ... rest unchanged
};
```

### A5: Config Routes — Add Typed Config Helpers

**File:** `packages/api/src/routes/config.ts`
**Location:** After existing helpers (line 55)

The existing `getConfigValue` wraps with `Number()` and `upsertConfig` wraps with `String()`. This breaks for arrays (`translation_scores`) and strings (`posting_language`). Add typed helpers that pass values through Drizzle's JSONB handling:

```typescript
/**
 * Read a typed value from app_config. Drizzle auto-parses JSONB.
 * Use for arrays, strings, and complex types that Number()/String() would break.
 */
const getTypedConfig = async <T>(deps: ApiDeps, key: string, fallback: T): Promise<T> => {
  const [row] = await deps.db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  return row ? (row.value as T) : fallback;
};

/**
 * Write a typed value to app_config. Drizzle handles JSONB serialization.
 * Use for arrays, strings, and complex types.
 */
const upsertTypedConfig = async (deps: ApiDeps, key: string, value: unknown) => {
  const [row] = await deps.db
    .insert(appConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: new Date() },
    })
    .returning();
  return row;
};
```

**Note:** Existing `getConfigValue`/`upsertConfig`/`getBooleanConfig`/`upsertBooleanConfig` remain unchanged. The new helpers are used only by translation config routes.

---

## 5. Implementation: New Code (B1-B6)

### B1: Translation Package (Gemini + OpenAI)

Create `packages/translation/` — two concrete provider functions with a shared type, no interface/factory abstraction.

**Package structure:**
```
packages/translation/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts         # Re-exports
    ├── types.ts         # TranslationResult type
    ├── gemini.ts        # translateWithGemini function
    ├── openai.ts        # translateWithOpenAI function
    ├── prompts.ts       # buildTranslationPrompt + DEFAULT_INSTRUCTIONS
    └── pricing.ts       # calculateTranslationCost (Gemini + OpenAI pricing)
```

#### `packages/translation/package.json`
```json
{
  "name": "@watch-tower/translation",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "openai": "^4.73.0",
    "@watch-tower/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
```

#### `packages/translation/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

#### `packages/translation/src/types.ts`
```typescript
export type TranslationResult = {
  titleKa: string | null;
  summaryKa: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  error?: string;
};
```

#### `packages/translation/src/prompts.ts`
```typescript
export const DEFAULT_TRANSLATION_INSTRUCTIONS =
  "Translate the following English news content into Georgian. " +
  "Maintain a professional, news-appropriate tone. " +
  "Keep proper nouns (company names, person names) in their original form. " +
  "Technical terms like Bitcoin, blockchain, AI may remain in English " +
  "if no widely-accepted Georgian equivalent exists. " +
  "The translation should be natural and fluent, not word-for-word.";

export const buildTranslationPrompt = (
  title: string,
  summary: string,
  instructions: string,
): string => {
  return `${instructions}

---

TITLE (English):
${title}

SUMMARY (English):
${summary}

---

Respond with ONLY valid JSON in this exact format:
{"title_ka": "Georgian title here", "summary_ka": "Georgian summary here"}`;
};
```

#### `packages/translation/src/pricing.ts`
```typescript
// Pricing in microdollars per 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  // Gemini
  "gemini-2.0-flash": { input: 75_000, output: 300_000 },
  "gemini-2.0-pro": { input: 1_250_000, output: 5_000_000 },
  "gemini-1.5-flash": { input: 75_000, output: 300_000 },
  "gemini-1.5-pro": { input: 1_250_000, output: 5_000_000 },
  // OpenAI
  "gpt-4o-mini": { input: 150_000, output: 600_000 },
  "gpt-4o": { input: 2_500_000, output: 10_000_000 },
  "gpt-4.1-mini": { input: 400_000, output: 1_600_000 },
  "gpt-4.1-nano": { input: 100_000, output: 400_000 },
};

export const calculateTranslationCost = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): number => {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round(inputCost + outputCost);
};
```

#### `packages/translation/src/gemini.ts`
```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { TranslationResult } from "./types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "./prompts.js";
import { logger } from "@watch-tower/shared";

export const translateWithGemini = async (
  apiKey: string,
  model: string,
  title: string,
  summary: string,
  instructions?: string,
): Promise<TranslationResult> => {
  const prompt = buildTranslationPrompt(
    title,
    summary,
    instructions || DEFAULT_TRANSLATION_INSTRUCTIONS,
  );

  const startTime = Date.now();

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const genModel = client.getGenerativeModel({
      model,
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 1024,
      },
    });

    const result = await genModel.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const latencyMs = Date.now() - startTime;

    // Parse JSON response
    let parsed: { title_ka?: string; summary_ka?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn(`[translation] JSON parse failed: ${text.slice(0, 200)}`);
      return {
        titleKa: null,
        summaryKa: null,
        error: "Failed to parse translation response",
        latencyMs,
      };
    }

    // Extract usage metadata
    const usageMetadata = response.usageMetadata;
    const usage = usageMetadata
      ? {
          inputTokens: usageMetadata.promptTokenCount ?? 0,
          outputTokens: usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: usageMetadata.totalTokenCount ?? 0,
        }
      : undefined;

    return {
      titleKa: parsed.title_ka ?? null,
      summaryKa: parsed.summary_ka ?? null,
      usage,
      latencyMs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`[translation] Gemini API error: ${errorMsg}`);
    return {
      titleKa: null,
      summaryKa: null,
      error: errorMsg,
      latencyMs: Date.now() - startTime,
    };
  }
};
```

#### `packages/translation/src/openai.ts`
```typescript
import OpenAI from "openai";
import type { TranslationResult } from "./types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "./prompts.js";
import { logger } from "@watch-tower/shared";

export const translateWithOpenAI = async (
  apiKey: string,
  model: string,
  title: string,
  summary: string,
  instructions?: string,
): Promise<TranslationResult> => {
  const prompt = buildTranslationPrompt(
    title,
    summary,
    instructions || DEFAULT_TRANSLATION_INSTRUCTIONS,
  );

  const startTime = Date.now();

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const latencyMs = Date.now() - startTime;
    const text = response.choices[0]?.message?.content ?? "";

    // Parse JSON response
    let parsed: { title_ka?: string; summary_ka?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn(`[translation] OpenAI JSON parse failed: ${text.slice(0, 200)}`);
      return {
        titleKa: null,
        summaryKa: null,
        error: "Failed to parse translation response",
        latencyMs,
      };
    }

    const usage = response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    return {
      titleKa: parsed.title_ka ?? null,
      summaryKa: parsed.summary_ka ?? null,
      usage,
      latencyMs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`[translation] OpenAI API error: ${errorMsg}`);
    return {
      titleKa: null,
      summaryKa: null,
      error: errorMsg,
      latencyMs: Date.now() - startTime,
    };
  }
};
```

#### `packages/translation/src/index.ts`
```typescript
export type { TranslationResult } from "./types.js";
export { translateWithGemini } from "./gemini.js";
export { translateWithOpenAI } from "./openai.js";
export { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "./prompts.js";
export { calculateTranslationCost } from "./pricing.js";
```

### B2: Shared Package — Queue Constants + Env Schema

#### Add queue constants (`packages/shared/src/queues.ts`)

```typescript
// ADD after existing constants:
export const QUEUE_TRANSLATION = "pipeline-translation";
export const JOB_TRANSLATION_BATCH = "translation-batch";
```

#### Add translation API keys to env schema (`packages/shared/src/schemas/env.ts`)

Add to `baseEnvSchema` (OPENAI_API_KEY already exists for embeddings):
```typescript
// Translation (Gemini)
GOOGLE_AI_API_KEY: z.string().optional().transform((v) => v || undefined),
// Note: OPENAI_API_KEY already defined above for embeddings — reused for translation
```

### B3: Translation Worker

**File:** `packages/worker/src/processors/translation.ts` (NEW)

```typescript
import { Worker, Queue } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  QUEUE_TRANSLATION,
  JOB_TRANSLATION_BATCH,
  JOB_DISTRIBUTION_IMMEDIATE,
  logger,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { appConfig, llmTelemetry } from "@watch-tower/db";
import {
  translateWithGemini,
  translateWithOpenAI,
  calculateTranslationCost,
} from "@watch-tower/translation";

type TranslationDeps = {
  connection: { host: string; port: number };
  db: Database;
  distributionQueue?: Queue;
};

type TranslationConfig = {
  postingLanguage: string;
  scores: number[];
  provider: string; // "gemini" | "openai"
  model: string;
  instructions: string;
  enabledSince: string | null; // ISO timestamp
};

/**
 * Read all translation config from app_config in one query.
 */
async function getTranslationConfig(db: Database): Promise<TranslationConfig> {
  const keys = [
    "posting_language",
    "translation_scores",
    "translation_provider",
    "translation_model",
    "translation_instructions",
    "translation_enabled_since",
  ];

  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const m = new Map(rows.map((r) => [r.key, r.value]));

  return {
    postingLanguage: (m.get("posting_language") as string) ?? "en",
    scores: (m.get("translation_scores") as number[]) ?? [3, 4, 5],
    provider: (m.get("translation_provider") as string) ?? "gemini",
    model: (m.get("translation_model") as string) ?? "gemini-2.0-flash",
    instructions: (m.get("translation_instructions") as string) ?? "",
    enabledSince: (m.get("translation_enabled_since") as string) ?? null,
  };
}

/**
 * Resolve API key for the configured provider.
 */
function getTranslationApiKey(provider: string): string | undefined {
  switch (provider) {
    case "gemini":
      return process.env.GOOGLE_AI_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    default:
      return undefined;
  }
}

type ClaimedArticle = {
  id: string;
  title: string;
  llmSummary: string;
  importanceScore: number;
  pipelineStage: string;
};

export const createTranslationWorker = ({ connection, db, distributionQueue }: TranslationDeps) => {
  return new Worker(
    QUEUE_TRANSLATION,
    async (job) => {
      if (job.name !== JOB_TRANSLATION_BATCH) {
        return { skipped: true, reason: "unknown_job_type" };
      }

      // 1. Read config
      const config = await getTranslationConfig(db);

      // Only run if Georgian mode is active
      if (config.postingLanguage !== "ka") {
        return { skipped: true, reason: "english_mode" };
      }

      // Check API key for configured provider
      const apiKey = getTranslationApiKey(config.provider);
      if (!apiKey) {
        logger.warn(`[translation] no API key for provider: ${config.provider}`);
        return { skipped: true, reason: "no_api_key" };
      }

      // 2. ATOMIC CLAIM: Get articles needing translation
      // Queries by importance_score + translation_status (NOT pipeline_stage)
      // This catches both 'scored' (3-4) and 'approved' (5) articles
      const scoreList = config.scores.length > 0 ? config.scores : [3, 4, 5];

      // Backfill guard: only translate articles created after translation was enabled
      const enabledSince = config.enabledSince
        ? new Date(config.enabledSince)
        : new Date(); // If no timestamp, only process from now

      const claimResult = await db.execute(sql`
        UPDATE articles
        SET translation_status = 'translating'
        WHERE id IN (
          SELECT id FROM articles
          WHERE importance_score = ANY(${`{${scoreList.join(",")}}`}::smallint[])
            AND translation_status IS NULL
            AND llm_summary IS NOT NULL
            AND title_ka IS NULL
            AND scored_at IS NOT NULL
            AND created_at > ${enabledSince}
          ORDER BY created_at ASC
          LIMIT 10
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id,
          title,
          llm_summary as "llmSummary",
          importance_score as "importanceScore",
          pipeline_stage as "pipelineStage"
      `);

      const claimed = claimResult.rows as ClaimedArticle[];

      if (claimed.length === 0) {
        return { processed: 0 };
      }

      logger.info(`[translation] claimed ${claimed.length} articles`);

      // 3. Translate each article
      let translated = 0;
      let failed = 0;
      const telemetryRows: {
        articleId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costMicrodollars: number;
        latencyMs: number;
      }[] = [];

      for (const article of claimed) {
        // Call the configured provider
        const translate = config.provider === "openai" ? translateWithOpenAI : translateWithGemini;
        const result = await translate(
          apiKey,
          config.model,
          article.title,
          article.llmSummary,
          config.instructions || undefined,
        );

        if (result.error || !result.titleKa || !result.summaryKa) {
          // Mark as failed (translation_status only, pipeline_stage untouched)
          await db.execute(sql`
            UPDATE articles
            SET translation_status = 'failed'
            WHERE id = ${article.id}::uuid
          `);
          failed++;
          logger.warn({ articleId: article.id, error: result.error }, "[translation] failed");
        } else {
          // Save translation
          await db.execute(sql`
            UPDATE articles
            SET
              title_ka = ${result.titleKa},
              llm_summary_ka = ${result.summaryKa},
              translation_model = ${config.model},
              translation_status = 'translated',
              translated_at = NOW()
            WHERE id = ${article.id}::uuid
          `);
          translated++;
          logger.info({ articleId: article.id }, "[translation] completed");

          // Collect telemetry
          if (result.usage) {
            telemetryRows.push({
              articleId: article.id,
              model: config.model,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
              costMicrodollars: calculateTranslationCost(
                config.model,
                result.usage.inputTokens,
                result.usage.outputTokens,
              ),
              latencyMs: result.latencyMs,
            });
          }

          // 4. Auto-post: If article is already 'approved' (score 5 auto-approve),
          // queue it for distribution now that translation is ready
          if (article.pipelineStage === "approved" && distributionQueue) {
            // Check if auto-post is enabled for any platform
            const [autoPostRow] = await db
              .select({ value: appConfig.value })
              .from(appConfig)
              .where(eq(appConfig.key, "auto_post_telegram"));
            const autoPostEnabled =
              autoPostRow?.value === true || autoPostRow?.value === "true";

            if (autoPostEnabled) {
              await distributionQueue.add(
                JOB_DISTRIBUTION_IMMEDIATE,
                { articleId: article.id },
                { jobId: `dist-ka-${article.id}` },
              );
              logger.info(
                { articleId: article.id },
                "[translation] queued approved article for distribution",
              );
            }
          }
          // If pipeline_stage is 'scored' (3-4), do nothing — user will schedule manually
        }
      }

      // 5. Batch insert telemetry
      if (telemetryRows.length > 0) {
        try {
          await db.insert(llmTelemetry).values(
            telemetryRows.map((t) => ({
              articleId: t.articleId,
              operation: "translate" as const,
              provider: config.provider,
              model: t.model,
              isFallback: false,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              totalTokens: t.totalTokens,
              costMicrodollars: t.costMicrodollars,
              latencyMs: t.latencyMs,
            })),
          );
        } catch (err) {
          logger.error("[translation] telemetry insert failed", err);
        }
      }

      logger.info(`[translation] batch: ${translated} translated, ${failed} failed`);
      return { processed: claimed.length, translated, failed };
    },
    { connection, concurrency: 1 },
  );
};
```

### B4: Worker Bootstrap — Translation Queue + Worker

**File:** `packages/worker/src/index.ts`

**Imports (add after existing imports):**
```typescript
import { QUEUE_TRANSLATION, JOB_TRANSLATION_BATCH } from "@watch-tower/shared";
import { createTranslationWorker } from "./processors/translation.js";
```

**Queue creation (after distributionQueue, around line 132):**
```typescript
// Translation queue
const translationQueue = new Queue(QUEUE_TRANSLATION, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});
```

**Worker creation (after distributionWorker, around line 279):**
```typescript
// Translation worker (needs at least one translation provider key)
const hasTranslationKey = !!(env.GOOGLE_AI_API_KEY || env.OPENAI_API_KEY);
const translationWorker = hasTranslationKey
  ? createTranslationWorker({
      connection,
      db,
      distributionQueue: hasAnyPlatform ? distributionQueue : undefined,
    })
  : null;
```

**Error handlers (after distribution error handlers, around line 336):**
```typescript
if (translationWorker) {
  translationWorker.on("failed", (job, err) => {
    logger.error(`[translation] job ${job?.id ?? "unknown"} failed`, err.message);
  });
  translationWorker.on("error", (err) => {
    logger.error("[translation] worker error", err.message);
  });
  translationWorker.on("stalled", (jobId) => {
    logger.warn(`[translation] job ${jobId} stalled - will be retried`);
  });
}
```

**Clean failed jobs (add to the block around line 339-344):**
```typescript
await translationQueue.clean(0, 0, "failed");
```

**Recurring job (after LLM brain recurring job setup, around line 404):**
```typescript
// Translation recurring job (every 15 seconds)
if (translationWorker) {
  await translationQueue.add(
    JOB_TRANSLATION_BATCH,
    {},
    { repeat: { every: 15_000 }, jobId: "translation-batch-repeat" },
  );
  logger.info("[worker] translation enabled (gemini/openai)");
} else {
  logger.info("[worker] translation disabled (no GOOGLE_AI_API_KEY or OPENAI_API_KEY)");
}
```

**Graceful shutdown (add to shutdown function, around line 449-458):**
```typescript
await translationWorker?.close();
await translationQueue.close();
```

### B5: Translation Zombie Reset

**File:** `packages/worker/src/processors/maintenance.ts`

Add a new function after `resetZombieScoringArticles` (after line 190):

```typescript
/**
 * Reset articles stuck in 'translating' state (translation_status only).
 * Does NOT touch pipeline_stage — translation is decoupled.
 * Uses 10 min threshold for stuck translations.
 */
const resetZombieTranslations = async (db: Database) => {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);

  // Reset stuck 'translating' → NULL (allows re-claim)
  const translatingResult = await db.execute(sql`
    UPDATE articles
    SET translation_status = NULL
    WHERE translation_status = 'translating'
      AND created_at < ${staleThreshold}
    RETURNING id
  `);
  if (translatingResult.rows.length > 0) {
    logger.warn(
      `[maintenance] reset ${translatingResult.rows.length} zombie translating articles`,
    );
  }

  // Reset 'failed' → NULL after 1 hour (allows retry)
  const failedThreshold = new Date(Date.now() - 60 * 60 * 1000);
  const failedResult = await db.execute(sql`
    UPDATE articles
    SET translation_status = NULL
    WHERE translation_status = 'failed'
      AND created_at < ${failedThreshold}
    RETURNING id
  `);
  if (failedResult.rows.length > 0) {
    logger.warn(
      `[maintenance] reset ${failedResult.rows.length} failed translations for retry`,
    );
  }
};
```

Call it from `resetZombieArticles` (line 195-198):
```typescript
const resetZombieArticles = async (db: Database) => {
  await resetZombieEmbeddingArticles(db);
  await resetZombieScoringArticles(db);
  await resetZombieTranslations(db);  // ADD
};
```

### B6: API Routes — Translation Config Endpoints

**File:** `packages/api/src/routes/config.ts`

Add after the emergency stop routes (after line 286):

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Translation Settings
// Controls Georgian translation and posting language.
// ─────────────────────────────────────────────────────────────────────────────

// GET /config/translation
app.get("/config/translation", { preHandler: deps.requireApiKey }, async () => {
  const keys = [
    "posting_language",
    "translation_scores",
    "translation_provider",
    "translation_model",
    "translation_instructions",
  ];

  const rows = await deps.db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const m = new Map(rows.map((r) => [r.key, r.value]));

  return {
    posting_language: (m.get("posting_language") as string) ?? "en",
    scores: (m.get("translation_scores") as number[]) ?? [3, 4, 5],
    provider: (m.get("translation_provider") as string) ?? "gemini",
    model: (m.get("translation_model") as string) ?? "gemini-2.0-flash",
    instructions: (m.get("translation_instructions") as string) ?? "",
  };
});

// PATCH /config/translation
app.patch<{
  Body: {
    posting_language?: "en" | "ka";
    scores?: number[];
    provider?: "gemini" | "openai";
    model?: string;
    instructions?: string;
  };
}>("/config/translation", { preHandler: deps.requireApiKey }, async (request, reply) => {
  const { posting_language, scores, provider, model, instructions } = request.body ?? {};

  // Validate posting_language
  if (posting_language !== undefined && !["en", "ka"].includes(posting_language)) {
    return reply.code(400).send({ error: "posting_language must be 'en' or 'ka'" });
  }

  // Validate scores
  if (scores !== undefined) {
    if (!Array.isArray(scores) || scores.some((s) => s < 1 || s > 5)) {
      return reply.code(400).send({ error: "scores must be an array of numbers 1-5" });
    }
  }

  // Validate provider
  if (provider !== undefined && !["gemini", "openai"].includes(provider)) {
    return reply.code(400).send({ error: "provider must be 'gemini' or 'openai'" });
  }

  const updates: { key: string; value: unknown }[] = [];

  if (posting_language !== undefined) {
    updates.push({ key: "posting_language", value: posting_language });

    // Backfill guard: when switching to Georgian, record when it was enabled
    if (posting_language === "ka") {
      updates.push({
        key: "translation_enabled_since",
        value: new Date().toISOString(),
      });
    }
  }
  if (scores !== undefined) updates.push({ key: "translation_scores", value: scores });
  if (provider !== undefined) updates.push({ key: "translation_provider", value: provider });
  if (model !== undefined) updates.push({ key: "translation_model", value: model });
  if (instructions !== undefined) {
    updates.push({ key: "translation_instructions", value: instructions });
  }

  for (const { key, value } of updates) {
    await upsertTypedConfig(deps, key, value);
  }

  logger.info("[config] translation settings updated");
  return { success: true };
});
```

**Note:** Add `inArray` to the drizzle-orm import at the top of the file.

### B7: Articles API — Add Translation Fields

**File:** `packages/api/src/routes/articles.ts`

**Change 1: GET /articles list query (lines 103-121)**

Add to the `.select()`:
```typescript
title_ka: articles.titleKa,
llm_summary_ka: articles.llmSummaryKa,
translation_status: articles.translationStatus,
```

**Change 2: GET /articles/:id detail query (lines 154-173)**

Add to the `.select()`:
```typescript
title_ka: articles.titleKa,
llm_summary_ka: articles.llmSummaryKa,
translation_status: articles.translationStatus,
translation_model: articles.translationModel,
translated_at: articles.translatedAt,
```

### B8: Frontend — API Types + Translation Settings Tab

#### Update Article type (`packages/frontend/src/api.ts`, after line 501)

```typescript
export type Article = {
  // ... existing fields ...
  title_ka: string | null;              // ADD
  llm_summary_ka: string | null;        // ADD
  translation_status: string | null;    // ADD
};
```

#### Add translation config API functions (`packages/frontend/src/api.ts`)

```typescript
// Translation config
export type TranslationConfig = {
  posting_language: "en" | "ka";
  scores: number[];
  provider: "gemini" | "openai";
  model: string;
  instructions: string;
};

export const getTranslationConfig = async (): Promise<TranslationConfig> => {
  const res = await fetch(`${API_URL}/config/translation`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get translation config");
  return res.json();
};

export const updateTranslationConfig = async (
  config: Partial<TranslationConfig>,
): Promise<void> => {
  const res = await fetch(`${API_URL}/config/translation`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to update translation config");
};
```

#### Add Translation tab to SiteRules.tsx

Add a "Translation" tab to the existing tab navigation in `packages/frontend/src/pages/SiteRules.tsx`:

```tsx
// Tab: { id: "translation", label: "Translation" }

// State:
const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(null);

// Load on mount:
useEffect(() => {
  getTranslationConfig().then(setTranslationConfig);
}, []);

// Tab content:
{activeTab === "translation" && (
  <div className="space-y-6">
    {/* Posting Language Toggle */}
    <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-amber-200">Posting Language</h3>
          <p className="text-sm text-amber-200/70">
            All posts will use this language. Georgian requires translation to be configured.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              updateTranslationConfig({ posting_language: "en" });
              setTranslationConfig((prev) => prev ? { ...prev, posting_language: "en" } : null);
              toast.success("Posting language set to English");
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              translationConfig?.posting_language === "en"
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-slate-700 text-slate-300"
            }`}
          >
            English
          </button>
          <button
            onClick={() => {
              updateTranslationConfig({ posting_language: "ka" });
              setTranslationConfig((prev) => prev ? { ...prev, posting_language: "ka" } : null);
              toast.success("Posting language set to Georgian");
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              translationConfig?.posting_language === "ka"
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-slate-700 text-slate-300"
            }`}
          >
            Georgian
          </button>
        </div>
      </div>
    </div>

    {/* Scores to Translate */}
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h3 className="text-lg font-medium mb-4">Translate Articles with Score</h3>
      <div className="flex gap-4">
        {[3, 4, 5].map((score) => (
          <label key={score} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={translationConfig?.scores.includes(score)}
              onChange={(e) => {
                const newScores = e.target.checked
                  ? [...(translationConfig?.scores ?? []), score]
                  : (translationConfig?.scores ?? []).filter((s) => s !== score);
                updateTranslationConfig({ scores: newScores });
                setTranslationConfig((prev) => prev ? { ...prev, scores: newScores } : null);
              }}
              className="rounded border-slate-600"
            />
            <span className="text-sm text-slate-200">Score {score}</span>
          </label>
        ))}
      </div>
    </div>

    {/* Translation Provider & Model */}
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h3 className="text-lg font-medium mb-4">Translation Provider & Model</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-sm text-slate-400 mb-2">Provider</label>
          <select
            value={translationConfig?.provider ?? "gemini"}
            onChange={(e) => {
              const provider = e.target.value as "gemini" | "openai";
              // Auto-switch to default model for new provider
              const defaultModel = provider === "openai" ? "gpt-4o-mini" : "gemini-2.0-flash";
              updateTranslationConfig({ provider, model: defaultModel });
              setTranslationConfig((prev) =>
                prev ? { ...prev, provider, model: defaultModel } : null,
              );
            }}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm"
          >
            <option value="gemini">Gemini (Google)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-2">Model</label>
          <select
            value={translationConfig?.model ?? "gemini-2.0-flash"}
            onChange={(e) => {
              updateTranslationConfig({ model: e.target.value });
              setTranslationConfig((prev) => prev ? { ...prev, model: e.target.value } : null);
            }}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm"
          >
            {translationConfig?.provider === "openai" ? (
              <>
                <option value="gpt-4o-mini">gpt-4o-mini (fast, cheap)</option>
                <option value="gpt-4o">gpt-4o (quality)</option>
                <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                <option value="gpt-4.1-nano">gpt-4.1-nano</option>
              </>
            ) : (
              <>
                <option value="gemini-2.0-flash">gemini-2.0-flash (fast, cheap)</option>
                <option value="gemini-2.0-pro">gemini-2.0-pro (quality)</option>
                <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                <option value="gemini-1.5-pro">gemini-1.5-pro</option>
              </>
            )}
          </select>
        </div>
      </div>
    </div>

    {/* Translation Instructions */}
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h3 className="text-lg font-medium mb-4">Translation Instructions</h3>
      <p className="text-sm text-slate-400 mb-4">
        Customize how the AI translates content to Georgian
      </p>
      <textarea
        value={translationConfig?.instructions ?? ""}
        onChange={(e) => {
          setTranslationConfig((prev) =>
            prev ? { ...prev, instructions: e.target.value } : null,
          );
        }}
        onBlur={() => {
          if (translationConfig) {
            updateTranslationConfig({ instructions: translationConfig.instructions });
            toast.success("Instructions saved");
          }
        }}
        rows={6}
        className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm"
        placeholder="Translate the following English news summary into Georgian..."
      />
    </div>
  </div>
)}
```

#### Show Georgian translation badge in Articles.tsx

In `packages/frontend/src/pages/Articles.tsx`, after the LLM summary display (around line 340-344), add a translation indicator:

```tsx
{article.llm_summary && (
  <p className="text-xs text-slate-400 mt-1 line-clamp-2">
    {article.llm_summary}
  </p>
)}
{article.translation_status === "translated" && article.llm_summary_ka && (
  <p className="text-xs text-slate-500 mt-1 line-clamp-2 border-l-2 border-emerald-700 pl-2">
    KA: {article.llm_summary_ka}
  </p>
)}
{article.translation_status === "translating" && (
  <span className="text-xs text-amber-400 mt-1">Translating...</span>
)}
{article.translation_status === "failed" && (
  <span className="text-xs text-red-400 mt-1">Translation failed</span>
)}
```

---

## 6. Change Map

| # | File | Change | Scope |
|---|------|--------|-------|
| A1 | `packages/worker/src/processors/llm-brain.ts` | Wrap immediate distribution with posting_language check | ~15 lines |
| A2 | `packages/worker/src/processors/distribution.ts` | Add Georgian fields to RETURNING, language-aware formatting + rollback | ~30 lines |
| A3 | `packages/worker/src/processors/maintenance.ts` | Add Georgian fields to scheduled posts query + language formatting | ~25 lines |
| A4 | `packages/worker/src/processors/maintenance.ts` | Georgian guard in rescue function | ~15 lines |
| A5 | `packages/api/src/routes/config.ts` | Add `getTypedConfig`/`upsertTypedConfig` helpers | ~20 lines |
| B1 | `packages/translation/` (NEW) | Translation package: Gemini + OpenAI (types, gemini, openai, prompts, pricing) | ~280 lines |
| B2 | `packages/shared/src/queues.ts` | Add QUEUE_TRANSLATION, JOB_TRANSLATION_BATCH | 2 lines |
| B2 | `packages/shared/src/schemas/env.ts` | Add GOOGLE_AI_API_KEY | 1 line |
| B3 | `packages/worker/src/processors/translation.ts` (NEW) | Translation worker processor | ~200 lines |
| B4 | `packages/worker/src/index.ts` | Translation queue + worker creation + shutdown | ~40 lines |
| B5 | `packages/worker/src/processors/maintenance.ts` | Zombie reset for translation_status | ~30 lines |
| B6 | `packages/api/src/routes/config.ts` | Translation config GET/PATCH endpoints | ~70 lines |
| B7 | `packages/api/src/routes/articles.ts` | Add title_ka, llm_summary_ka, translation_status to queries | ~10 lines |
| B8 | `packages/frontend/src/api.ts` | Article type update + translation config API functions | ~30 lines |
| B8 | `packages/frontend/src/pages/SiteRules.tsx` | Translation settings tab | ~100 lines |
| B8 | `packages/frontend/src/pages/Articles.tsx` | Translation status badges | ~15 lines |
| DB | `packages/db/src/schema.ts` | 5 new columns on articles | 5 lines |
| DB | `packages/db/seed.sql` | Translation config seeds | 6 lines |

**Total new files:** 2 (translation package, translation worker)
**Total modified files:** ~12
**Estimated total code:** ~900 lines

---

## 7. Testing Checklist

### Translation Worker
- [ ] Skips when `posting_language = "en"`
- [ ] Claims articles with matching scores AND `translation_status IS NULL` AND `scored_at IS NOT NULL`
- [ ] Catches both `scored` (3-4) and `approved` (5) articles (queries by importance_score, not pipeline_stage)
- [ ] Respects `translation_enabled_since` backfill guard
- [ ] Sets `translation_status = 'translating'` during claim (atomic, FOR UPDATE SKIP LOCKED)
- [ ] On success: stores `title_ka`, `llm_summary_ka`, `translation_model`, `translation_status = 'translated'`, `translated_at`
- [ ] On failure: sets `translation_status = 'failed'` (does NOT touch pipeline_stage)
- [ ] Queues distribution for `approved` articles after successful translation
- [ ] Does NOT queue distribution for `scored` articles (manual approval needed)
- [ ] Inserts telemetry to `llm_telemetry` with `operation = 'translate'`

### Auto-Post Gating (Critical)
- [ ] English mode + score 5: LLM brain queues immediate distribution (unchanged)
- [ ] Georgian mode + score 5: LLM brain SKIPS distribution queue
- [ ] Georgian mode + translation complete + approved: Translation worker queues distribution
- [ ] Georgian mode + translation failed: Article stays in pipeline_stage unchanged, `translation_status = 'failed'`

### Distribution Worker
- [ ] Claims `approved` articles as before (unchanged WHERE clause)
- [ ] In English mode: uses `title` / `llm_summary` (unchanged)
- [ ] In Georgian mode + translation ready: uses `title_ka` / `llm_summary_ka`
- [ ] In Georgian mode + translation missing: rolls back to `approved`, returns `awaiting_translation`
- [ ] formatPost receives correct language content (social providers are language-agnostic)

### Maintenance Worker
- [ ] Scheduled posts use correct language fields based on `posting_language`
- [ ] Scheduled posts fail gracefully if Georgian mode but no translation
- [ ] Rescue function skips untranslated articles in Georgian mode
- [ ] Zombie reset: `translation_status = 'translating'` → `NULL` after 10 min
- [ ] Zombie reset: `translation_status = 'failed'` → `NULL` after 1 hour

### API & Config
- [ ] GET /config/translation returns all translation settings
- [ ] PATCH /config/translation updates settings correctly
- [ ] Switching to Georgian sets `translation_enabled_since` timestamp
- [ ] `getTypedConfig` reads arrays and strings without Number()/String() wrapping
- [ ] `upsertTypedConfig` writes arrays and strings as proper JSONB
- [ ] GET /articles returns `title_ka`, `llm_summary_ka`, `translation_status`
- [ ] GET /articles/:id returns full translation fields

### Frontend
- [ ] Translation tab in SiteRules shows language toggle, score checkboxes, model select, instructions
- [ ] Language toggle switches between English and Georgian
- [ ] Score checkboxes update `translation_scores` in real-time
- [ ] Articles page shows translation status badges (translated, translating, failed)
- [ ] Articles page shows Georgian summary when available

### Edge Cases
- [ ] Switch from English → Georgian mid-pipeline: only new articles get translated (backfill guard)
- [ ] Switch from Georgian → English mid-pipeline: distribution immediately uses English fields
- [ ] No GOOGLE_AI_API_KEY and no OPENAI_API_KEY: translation worker doesn't start, English mode works normally
- [ ] Gemini API error: article gets `translation_status = 'failed'`, zombie reset retries after 1 hour
- [ ] OpenAI API error: same behavior as Gemini failure path
- [ ] Switch provider Gemini → OpenAI mid-pipeline: next batch uses OpenAI, existing translations kept
- [ ] Provider set to "openai" but no OPENAI_API_KEY: worker logs warning, skips batch
- [ ] Georgian text displays correctly (Unicode)

---

## 8. Final Implementation Checkups

After all code is implemented, run through these verification gates before considering the task done.

### 8.1 SQL Schema & Migrations

- [ ] **Drizzle schema matches DB** — Run `npm run db:generate` and verify no unexpected diff. The 5 new columns (`title_ka`, `llm_summary_ka`, `translation_model`, `translation_status`, `translated_at`) must appear in the migration
- [ ] **Migration runs cleanly** — `npm run db:migrate` completes without errors on a fresh DB and on an existing DB with data
- [ ] **Index created** — `idx_articles_translation_pending` partial index exists for the translation worker claim query
- [ ] **Seed SQL valid** — `npm run db:seed` inserts all 5 translation config keys (`posting_language`, `translation_scores`, `translation_provider`, `translation_model`, `translation_instructions`) without conflict errors
- [ ] **Column types correct** — `translation_status` is `TEXT` (not enum), allowing flexible values without migration on change
- [ ] **No orphaned references** — New columns have no FK constraints (they're flat text/timestamp columns)

### 8.2 Environment Configuration

- [ ] **`GOOGLE_AI_API_KEY`** — Added to `baseEnvSchema` in `packages/shared/src/schemas/env.ts` as optional
- [ ] **`OPENAI_API_KEY`** — Already exists in env schema (used for embeddings), confirm it's still present and optional
- [ ] **`.env.example` updated** — Both keys documented with comments:
  ```env
  # Translation (at least one required for Georgian mode)
  GOOGLE_AI_API_KEY=your-gemini-api-key
  # OPENAI_API_KEY already used for embeddings, also used for translation
  ```
- [ ] **Worker starts without translation keys** — If neither `GOOGLE_AI_API_KEY` nor `OPENAI_API_KEY` is set, worker logs info and skips translation worker creation (no crash)
- [ ] **Worker starts with only one key** — If only Gemini OR only OpenAI key is set, translation worker starts successfully. Switching provider to one without a key logs warning and skips batch gracefully
- [ ] **No env vars leaked to frontend** — API keys are only in worker/API packages, never in `VITE_*` prefixed vars

### 8.3 UI Wiring Verification

- [ ] **Translation tab appears** — SiteRules page shows "Translation" tab alongside existing tabs (Domain Whitelist, Feed Limits, etc.)
- [ ] **Language toggle works** — Switching English ↔ Georgian calls `PATCH /config/translation` and persists across page reload
- [ ] **Score checkboxes persist** — Checking/unchecking scores saves immediately to backend, reflects on reload
- [ ] **Provider dropdown works** — Switching Gemini ↔ OpenAI auto-updates model dropdown options and saves both `provider` + `model`
- [ ] **Model dropdown shows correct options** — Gemini models when Gemini selected, OpenAI models when OpenAI selected
- [ ] **Instructions textarea saves on blur** — Not on every keystroke; saved value matches what backend returns
- [ ] **Articles page shows translation badges** — `translation_status` displayed as colored badge (translating = amber, translated = emerald, failed = red)
- [ ] **Articles page shows Georgian summary** — When `translation_status = 'translated'`, Georgian summary visible with "KA:" prefix
- [ ] **Article type includes new fields** — Frontend `Article` type has `title_ka`, `llm_summary_ka`, `translation_status` — TypeScript build passes

### 8.4 API Wiring Verification

- [ ] **GET /config/translation** — Returns all 5 fields (posting_language, scores, provider, model, instructions)
- [ ] **PATCH /config/translation** — Accepts partial updates, validates posting_language/scores/provider
- [ ] **Backfill guard set** — When switching posting_language to "ka", `translation_enabled_since` is set in app_config
- [ ] **GET /articles includes translation fields** — Both list and detail endpoints return `title_ka`, `llm_summary_ka`, `translation_status`
- [ ] **JSONB values stored correctly** — `translation_scores` stored as JSON array `[3,4,5]` not string `"[3,4,5]"`; `posting_language` stored as JSON string `"ka"` not double-encoded `"\"ka\""`
- [ ] **`inArray` import added** — `config.ts` imports `inArray` from drizzle-orm for the translation config query

### 8.5 Worker Wiring Verification

- [ ] **Translation queue created** — `QUEUE_TRANSLATION` queue exists in worker bootstrap with proper retry config
- [ ] **Repeatable job registered** — `JOB_TRANSLATION_BATCH` fires every 15 seconds
- [ ] **Graceful shutdown includes translation** — Both `translationWorker?.close()` and `translationQueue.close()` in shutdown handler
- [ ] **Error handlers registered** — `failed`, `error`, `stalled` handlers on translation worker
- [ ] **Failed jobs cleaned** — `translationQueue.clean(0, 0, "failed")` in startup cleanup
- [ ] **Queue constants exported** — `QUEUE_TRANSLATION` and `JOB_TRANSLATION_BATCH` exported from `@watch-tower/shared`
- [ ] **Translation package in workspace** — `packages/translation` listed in root `package.json` workspaces, `npm install` resolves `@watch-tower/translation`
- [ ] **Build succeeds** — `npm run build` passes for all packages including new `@watch-tower/translation`

---

## Summary

This task adds Georgian translation to Watch Tower using a **decoupled `translation_status` column** that avoids breaking any existing pipeline logic:

1. **No new pipeline stages** — `pipeline_stage` values remain unchanged, all existing workers untouched
2. **Independent `translation_status`** — `NULL → translating → translated/failed`, operates orthogonally to pipeline
3. **Gemini + OpenAI** — two concrete functions, no heavy abstraction, switchable via UI
4. **Backfill guard** — `translation_enabled_since` prevents translating old articles
5. **Language-aware distribution** — reads `posting_language` at format time, rolls back if translation missing
6. **Auto-post gating** — Georgian mode defers distribution until translation completes

### Architecture Guarantee

```
Existing pipeline (UNCHANGED):
  ingested → embedding → embedded → scoring → scored/approved/rejected → posting → posted

Translation layer (ORTHOGONAL):
  translation_status: NULL → translating → translated/failed
  Queries by: importance_score + translation_status + scored_at
  Never touches: pipeline_stage

Distribution (EXTENDED):
  Still claims: pipeline_stage = 'approved' (unchanged)
  New: reads posting_language, uses title_ka/llm_summary_ka when "ka"
  New: rolls back to 'approved' if Georgian but untranslated
```
