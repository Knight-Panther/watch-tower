# Task 14: Georgian Translation Layer

Add a modular translation layer that converts English article summaries to Georgian using Gemini (or other LLM providers). This enables posting in Georgian across all social platforms with a single global toggle.

---

## Table of Contents

1. [Requirements Summary](#1-requirements-summary)
2. [Architecture Analysis](#2-architecture-analysis)
3. [Integration Strategy](#3-integration-strategy)
4. [Schema Changes](#4-schema-changes)
5. [Implementation Steps](#5-implementation-steps)
6. [Testing Checklist](#6-testing-checklist)

---

## 1. Requirements Summary

### Translation Layer (Pipeline)

| Setting | Value |
|---------|-------|
| Trigger | Automatic after LLM scoring, for configured scores |
| Scores to translate | Configurable checkboxes: ☑3 ☑4 ☑5 |
| Global enable/disable | Toggle in Settings UI |
| Input | `title` + `llm_summary` (English) |
| Output | `title_ka` + `llm_summary_ka` (Georgian) |
| Model | UI-selectable (Gemini default, swappable to Claude/OpenAI/DeepSeek/others when added) |
| Instructions | Global textarea for style/tone (per-sector later) |
| Backfill old articles | No, only new articles going forward |

### Posting Behavior

| Setting | Value |
|---------|-------|
| Language toggle | Global ON/OFF in Site Rules |
| Scope | All platforms, all posts (auto + scheduled) |
| Override per post | No |
| Template vars when OFF | `{title}` → title, `{summary}` → llm_summary |
| Template vars when ON | `{title}` → title_ka, `{summary}` → llm_summary_ka |
| Missing translation | Block posting with error message |

### Auto-Post Gating (Critical)

| Mode | Behavior |
|------|----------|
| `posting_language = 'en'` | Auto-post immediately after scoring (current behavior, unchanged) |
| `posting_language = 'ka'` | LLM brain skips auto-post → Translation worker translates → Translation worker queues distribution |

**Flow diagram:**
```
English mode:
  LLM Brain scores → queues distribution immediately → posts in English

Georgian mode:
  LLM Brain scores → SKIPS distribution queue
       ↓
  Translation worker picks up scored articles
       ↓
  Translates → stores title_ka, llm_summary_ka
       ↓
  Queues distribution → posts in Georgian
```

### Provider Modularity

| Requirement | Implementation |
|-------------|----------------|
| Interface abstraction | `TranslationProvider` interface |
| Factory pattern | `createTranslationProvider(config)` |
| Config storage | `app_config` table (UI changeable, no restart) |
| API keys | Environment variables (secure) |
| Pricing/telemetry | Same pattern as LLM package |

---

## 2. Architecture Analysis

### 2.1 Existing LLM Package Pattern (Template for Translation)

```
packages/llm/src/
├── index.ts          # Re-exports all public APIs
├── types.ts          # ScoringRequest, ScoringResult, LLMProviderConfig
├── provider.ts       # LLMProvider interface + createLLMProvider factory
├── schemas.ts        # Zod schema for JSON response parsing
├── prompts.ts        # Prompt templates with {title}, {content} placeholders
├── pricing.ts        # Microdollar cost tracking per provider/model
├── claude.ts         # Claude implementation
├── openai.ts         # OpenAI implementation (reusable for compatible APIs)
├── deepseek.ts       # DeepSeek (extends OpenAI with custom baseUrl)
└── fallback.ts       # LLMProviderWithFallback wrapper
```

**Key Interface:**
```typescript
interface LLMProvider {
  readonly name: string;
  readonly model: string;
  score(request: ScoringRequest): Promise<ScoringResult>;
}
```

**Factory Pattern:**
```typescript
const createLLMProvider = (config: LLMProviderConfig): LLMProvider => {
  switch (config.provider) {
    case "claude": return new ClaudeLLMProvider(...);
    case "openai": return new OpenAILLMProvider(...);
    case "deepseek": return new DeepSeekLLMProvider(...);
  }
};
```

### 2.2 Existing Worker Pipeline

```
[Ingest] → ingested
    ↓
[Semantic Dedup] → embedding → embedded (or duplicate)
    ↓
[LLM Brain] → scoring → scored/approved/rejected (or scoring_failed)
    ↓                              ↓
[Distribution] → posting      [Manual Review]
    ↓
posted (or posting_failed)
```

**Actual Pipeline Stages (from codebase):**
- `ingested` - Article fetched from RSS
- `embedding` - Claimed for embedding (in-progress)
- `embedded` - Embedding complete, ready for scoring
- `duplicate` - Semantic duplicate detected
- `scoring` - Claimed for LLM scoring (in-progress)
- `scored` - Scoring complete (score 3-4, needs review)
- `scoring_failed` - LLM API error
- `approved` - Manually approved or auto-approved (score 5)
- `rejected` - Manually rejected or auto-rejected (score 1-2)
- `posting` - Claimed for distribution (in-progress)
- `posted` - Successfully posted to social platforms
- `posting_failed` - Social API error

**Worker Bootstrap (`packages/worker/src/index.ts`):**
- Creates 5 BullMQ queues with retry configs
- Conditionally creates workers based on API key availability
- Registers repeatable jobs (scheduler every 30s, cleanup daily)
- Self-healing: `ensureRepeatableJobs()` called every 30s

**LLM Brain Processor Pattern:**
1. Atomic claim: `UPDATE articles SET pipeline_stage = 'scoring' WHERE pipeline_stage = 'embedded' LIMIT 10`
2. Fetch sector rules from `scoring_rules` table
3. Build prompts using `buildScoringPrompt(config, sectorName)`
4. Call `llmProvider.score()` for each article
5. Bulk update with `UNNEST` pattern
6. Insert telemetry to `llm_telemetry`
7. Queue distribution for auto-approved articles **⚠️ Telegram only, when `auto_post_telegram = true`**

**Important:** Distribution worker updates `articles.pipeline_stage` only. The `post_deliveries` table is used by the maintenance worker for scheduled posts.

### 2.3 Existing Scoring Rules Pattern

**Database Table (`scoring_rules`):**
```sql
sector_id UUID (FK)
prompt_template TEXT (legacy)
score_criteria JSONB (structured ScoringConfig)
auto_approve_threshold SMALLINT
auto_reject_threshold SMALLINT
model_preference TEXT
```

**API Routes (`packages/api/src/routes/scoring-rules.ts`):**
- `GET /scoring-rules` - List all with sector info
- `GET /scoring-rules/:sectorId` - Get with prompt preview
- `PUT /scoring-rules/:sectorId` - Upsert config + thresholds
- `DELETE /scoring-rules/:sectorId` - Reset to defaults
- `POST /scoring-rules/preview` - Preview prompt without saving

**Frontend (`packages/frontend/src/pages/ScoringRules.tsx`):**
- Sector selector dropdown
- Two-column: editor left, live preview right
- Tag inputs for priorities/ignore lists
- Score definition textareas (1-5)
- Summary settings (tone, language, max chars)
- Auto-approve/reject threshold sliders

### 2.4 Existing App Config Pattern

**Storage:** Key-value in `app_config` table
```sql
key TEXT PRIMARY KEY
value JSONB
updated_at TIMESTAMP
```

**API Routes (`packages/api/src/routes/config.ts`):**
- Helper functions: `getConfigValue()`, `getBooleanConfig()`, `upsertConfig()`
- GET/PATCH endpoints per config item
- Constraint validation before save
- **⚠️ Current helpers only handle numbers/booleans** - need new pattern for JSON arrays

**JSONB Value Handling (Important):**
- Drizzle returns JSONB as already-parsed JavaScript objects
- Do NOT double-encode with `JSON.stringify()` when reading
- When writing: store as raw value, Drizzle handles serialization
- Example: `translation_scores` stored as `[3, 4, 5]` (array), not `"[3, 4, 5]"` (string)

**Frontend (`packages/frontend/src/pages/SiteRules.tsx`):**
- Tab-based interface (Domain Whitelist, Feed Limits, API Security, Emergency Controls)
- Toggle switches for boolean configs
- Input fields with validation

### 2.5 Existing Post Template Pattern

**Schema (`packages/shared/src/schemas/post-template.ts`):**
```typescript
PostTemplateConfig = {
  showBreakingLabel: boolean
  showSectorTag: boolean
  showTitle: boolean
  showSummary: boolean
  showUrl: boolean
  showImage: boolean
  breakingEmoji: string
  breakingText: string
  urlLinkText: string
}
```

**Social Provider Usage:**
```typescript
provider.formatPost(
  { title, summary, url, sector },
  template
) → string
```

### 2.6 Existing Social Posting Flow

**Distribution Worker:**
1. Check kill switch (`emergency_stop`)
2. For each platform: check enabled, health, rate limit
3. Get template from `social_accounts` or default
4. Format post using `provider.formatPost(article, template)`
5. Post via provider
6. Update `post_deliveries` status

**Scheduled Posts (Maintenance Worker):**
- Same flow but claims from `post_deliveries` where `scheduled_at <= NOW()`

---

## 3. Integration Strategy

### 3.1 New Package: `packages/translation`

Create new package following LLM package pattern:

```
packages/translation/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Re-exports
    ├── types.ts              # TranslationRequest, TranslationResult
    ├── provider.ts           # TranslationProvider interface + factory
    ├── prompts.ts            # Translation prompt template
    ├── pricing.ts            # Cost tracking for translation models
    └── providers/
        ├── gemini.ts         # Google Gemini implementation
        ├── claude.ts         # Claude implementation
        └── openai.ts         # OpenAI implementation
```

### 3.2 New Pipeline Stage

Insert translation stage after LLM scoring:

```
[LLM Brain] → scored/approved/rejected
                    ↓
            [Translation] → translated (new stage)
                    ↓
            [Distribution]
```

**New Pipeline Stages:**
- `translating` - Article claimed for translation
- `translated` - Translation complete (or skipped if disabled/not qualifying)
- `translation_failed` - Translation API error

**Stage Flow:**
```
scored → translating → translated → (existing flow continues)
                 ↓
         translation_failed (manual retry needed)
```

### 3.3 New Queue & Job

```typescript
// packages/shared/src/queues.ts
export const QUEUE_TRANSLATION = "pipeline-translation";
export const JOB_TRANSLATION_BATCH = "translation-batch";
```

### 3.4 Config Keys in app_config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `translation_enabled` | boolean | false | Master toggle |
| `translation_scores` | number[] | [3,4,5] | Which scores to translate |
| `translation_provider` | string | "gemini" | Provider name |
| `translation_model` | string | "gemini-2.0-flash" | Model identifier |
| `translation_instructions` | string | (default prompt) | Custom style/tone |
| `posting_language` | string | "en" | Global: "en" or "ka" |

### 3.5 Integration Points

| Component | Change |
|-----------|--------|
| `packages/shared/queues.ts` | Add QUEUE_TRANSLATION, JOB_TRANSLATION_BATCH |
| `packages/shared/schemas/` | Add translation-config.ts schema |
| `packages/db/src/schema.ts` | Add title_ka, llm_summary_ka, translation_model to articles |
| `packages/worker/src/index.ts` | Create translation queue & worker |
| `packages/worker/src/processors/` | Add translation.ts processor |
| `packages/worker/src/processors/llm-brain.ts` | Queue translation after scoring |
| `packages/api/src/routes/config.ts` | Add translation config endpoints |
| `packages/api/src/routes/site-rules.ts` | Add posting language toggle endpoint |
| `packages/social/src/providers/*.ts` | Update formatPost to use language-aware fields |
| `packages/frontend/src/pages/SiteRules.tsx` | Add Translation Settings tab |
| `packages/frontend/src/api.ts` | Add translation API functions |

---

## 4. Schema Changes

### 4.1 Database Migration

```sql
-- Add Georgian translation columns to articles
ALTER TABLE articles ADD COLUMN title_ka TEXT;
ALTER TABLE articles ADD COLUMN llm_summary_ka TEXT;
ALTER TABLE articles ADD COLUMN translation_model TEXT;

-- Update pipeline_stage check constraint (if exists) or document new stages:
-- Valid stages: ingested, embedded, scored, translating, translated,
--               translation_failed, approved, rejected, posting, posted,
--               posting_failed, duplicate
```

### 4.2 App Config Seeds

```sql
-- Translation settings (seeded with defaults)
INSERT INTO app_config (key, value, updated_at) VALUES
  ('translation_enabled', 'false', NOW()),
  ('translation_scores', '[3, 4, 5]', NOW()),
  ('translation_provider', '"gemini"', NOW()),
  ('translation_model', '"gemini-2.0-flash"', NOW()),
  ('translation_instructions', '"Translate the following English news summary into Georgian. Maintain a professional, news-appropriate tone. Keep proper nouns (company names, person names) in their original form. Technical terms like Bitcoin, blockchain, AI may remain in English if no widely-accepted Georgian equivalent exists. The translation should be natural and fluent, not word-for-word."', NOW()),
  ('posting_language', '"en"', NOW())
ON CONFLICT (key) DO NOTHING;
```

---

## 5. Implementation Steps

### Phase 1: Translation Package (Foundation)

#### Step 1.1: Create package structure
```bash
mkdir -p packages/translation/src/providers
```

Create `packages/translation/package.json`:
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
    "@anthropic-ai/sdk": "^0.30.1",
    "openai": "^4.73.0",
    "@watch-tower/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
```

Create `packages/translation/tsconfig.json`:
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

#### Step 1.2: Create types.ts
```typescript
// packages/translation/src/types.ts

export type TranslationProviderType = "gemini" | "claude" | "openai";

export type TranslationRequest = {
  articleId: string;
  title: string;
  summary: string;
  targetLanguage: string;        // 'ka' for Georgian
  instructions?: string;         // Custom style/tone instructions
};

export type TranslationResult = {
  articleId: string;
  titleTranslated: string | null;
  summaryTranslated: string | null;
  error?: string;

  // Telemetry
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs?: number;
};

export type TranslationProviderConfig = {
  provider: TranslationProviderType;
  apiKey: string;
  model?: string;
};

export const DEFAULT_TRANSLATION_MODELS: Record<TranslationProviderType, string> = {
  gemini: "gemini-2.0-flash",
  claude: "claude-3-haiku-20240307",
  openai: "gpt-4o-mini",
};
```

#### Step 1.3: Create provider.ts (interface + factory)
```typescript
// packages/translation/src/provider.ts

import type { TranslationRequest, TranslationResult, TranslationProviderConfig } from "./types.js";
import { GeminiTranslationProvider } from "./providers/gemini.js";
import { ClaudeTranslationProvider } from "./providers/claude.js";
import { OpenAITranslationProvider } from "./providers/openai.js";

export interface TranslationProvider {
  readonly name: string;
  readonly model: string;
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

export const createTranslationProvider = (
  config: TranslationProviderConfig
): TranslationProvider => {
  switch (config.provider) {
    case "gemini":
      return new GeminiTranslationProvider(config.apiKey, config.model);
    case "claude":
      return new ClaudeTranslationProvider(config.apiKey, config.model);
    case "openai":
      return new OpenAITranslationProvider(config.apiKey, config.model);
    default:
      throw new Error(`Unknown translation provider: ${config.provider}`);
  }
};
```

#### Step 1.4: Create prompts.ts
```typescript
// packages/translation/src/prompts.ts

export const DEFAULT_TRANSLATION_INSTRUCTIONS = `Translate the following English news summary into Georgian. Maintain a professional, news-appropriate tone. Keep proper nouns (company names, person names) in their original form. Technical terms like Bitcoin, blockchain, AI may remain in English if no widely-accepted Georgian equivalent exists. The translation should be natural and fluent, not word-for-word.`;

export const buildTranslationPrompt = (
  title: string,
  summary: string,
  instructions: string
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

#### Step 1.5: Create pricing.ts
```typescript
// packages/translation/src/pricing.ts

export const TRANSLATION_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  gemini: {
    "gemini-2.0-flash": { input: 75_000, output: 300_000 },      // $0.075/$0.30 per 1M
    "gemini-2.0-pro": { input: 1_250_000, output: 5_000_000 },   // $1.25/$5.00 per 1M
    "gemini-1.5-flash": { input: 75_000, output: 300_000 },
    "gemini-1.5-pro": { input: 1_250_000, output: 5_000_000 },
  },
  claude: {
    "claude-3-haiku-20240307": { input: 250_000, output: 1_250_000 },
    "claude-3-5-sonnet-20241022": { input: 3_000_000, output: 15_000_000 },
  },
  openai: {
    "gpt-4o-mini": { input: 150_000, output: 600_000 },
    "gpt-4o": { input: 2_500_000, output: 10_000_000 },
  },
};

export const calculateTranslationCost = (
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number => {
  const pricing = TRANSLATION_PRICING[provider]?.[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round(inputCost + outputCost);
};
```

#### Step 1.6: Create Gemini provider
```typescript
// packages/translation/src/providers/gemini.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { TranslationProvider } from "../provider.js";
import type { TranslationRequest, TranslationResult } from "../types.js";
import { DEFAULT_TRANSLATION_MODELS } from "../types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "../prompts.js";
import { logger } from "@watch-tower/shared";

export class GeminiTranslationProvider implements TranslationProvider {
  private client: GoogleGenerativeAI;
  readonly name = "gemini";
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model ?? DEFAULT_TRANSLATION_MODELS.gemini;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const prompt = buildTranslationPrompt(
      request.title,
      request.summary,
      request.instructions ?? DEFAULT_TRANSLATION_INSTRUCTIONS
    );

    const startTime = Date.now();

    try {
      const model = this.client.getGenerativeModel({
        model: this.model,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 1024,
        }
      });

      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      const latencyMs = Date.now() - startTime;

      // Parse JSON response
      let parsed: { title_ka?: string; summary_ka?: string };
      try {
        parsed = JSON.parse(text);
      } catch {
        logger.warn(`[gemini-translation] JSON parse failed for ${request.articleId}: ${text.slice(0, 200)}`);
        return {
          articleId: request.articleId,
          titleTranslated: null,
          summaryTranslated: null,
          error: "Failed to parse translation response",
          latencyMs,
        };
      }

      // Extract usage metadata
      const usageMetadata = response.usageMetadata;
      const usage = usageMetadata ? {
        inputTokens: usageMetadata.promptTokenCount ?? 0,
        outputTokens: usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: usageMetadata.totalTokenCount ?? 0,
      } : undefined;

      return {
        articleId: request.articleId,
        titleTranslated: parsed.title_ka ?? null,
        summaryTranslated: parsed.summary_ka ?? null,
        usage,
        latencyMs,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`[gemini-translation] API error for ${request.articleId}: ${errorMsg}`);
      return {
        articleId: request.articleId,
        titleTranslated: null,
        summaryTranslated: null,
        error: errorMsg,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
```

#### Step 1.7: Create Claude provider
```typescript
// packages/translation/src/providers/claude.ts

import Anthropic from "@anthropic-ai/sdk";
import type { TranslationProvider } from "../provider.js";
import type { TranslationRequest, TranslationResult } from "../types.js";
import { DEFAULT_TRANSLATION_MODELS } from "../types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "../prompts.js";
import { logger } from "@watch-tower/shared";

export class ClaudeTranslationProvider implements TranslationProvider {
  private client: Anthropic;
  readonly name = "claude";
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_TRANSLATION_MODELS.claude;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const prompt = buildTranslationPrompt(
      request.title,
      request.summary,
      request.instructions ?? DEFAULT_TRANSLATION_INSTRUCTIONS
    );

    const startTime = Date.now();

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const latencyMs = Date.now() - startTime;
      const textBlock = response.content.find((b) => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : "";

      // Parse JSON response
      let parsed: { title_ka?: string; summary_ka?: string };
      try {
        // Strip markdown code fences if present
        const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        logger.warn(`[claude-translation] JSON parse failed for ${request.articleId}: ${text.slice(0, 200)}`);
        return {
          articleId: request.articleId,
          titleTranslated: null,
          summaryTranslated: null,
          error: "Failed to parse translation response",
          latencyMs,
        };
      }

      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      };

      return {
        articleId: request.articleId,
        titleTranslated: parsed.title_ka ?? null,
        summaryTranslated: parsed.summary_ka ?? null,
        usage,
        latencyMs,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`[claude-translation] API error for ${request.articleId}: ${errorMsg}`);
      return {
        articleId: request.articleId,
        titleTranslated: null,
        summaryTranslated: null,
        error: errorMsg,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
```

#### Step 1.8: Create OpenAI provider
```typescript
// packages/translation/src/providers/openai.ts

import OpenAI from "openai";
import type { TranslationProvider } from "../provider.js";
import type { TranslationRequest, TranslationResult } from "../types.js";
import { DEFAULT_TRANSLATION_MODELS } from "../types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "../prompts.js";
import { logger } from "@watch-tower/shared";

export class OpenAITranslationProvider implements TranslationProvider {
  private client: OpenAI;
  readonly name = "openai";
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model ?? DEFAULT_TRANSLATION_MODELS.openai;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const prompt = buildTranslationPrompt(
      request.title,
      request.summary,
      request.instructions ?? DEFAULT_TRANSLATION_INSTRUCTIONS
    );

    const startTime = Date.now();

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
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
        logger.warn(`[openai-translation] JSON parse failed for ${request.articleId}: ${text.slice(0, 200)}`);
        return {
          articleId: request.articleId,
          titleTranslated: null,
          summaryTranslated: null,
          error: "Failed to parse translation response",
          latencyMs,
        };
      }

      const usage = response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined;

      return {
        articleId: request.articleId,
        titleTranslated: parsed.title_ka ?? null,
        summaryTranslated: parsed.summary_ka ?? null,
        usage,
        latencyMs,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`[openai-translation] API error for ${request.articleId}: ${errorMsg}`);
      return {
        articleId: request.articleId,
        titleTranslated: null,
        summaryTranslated: null,
        error: errorMsg,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
```

#### Step 1.9: Create index.ts
```typescript
// packages/translation/src/index.ts

export type {
  TranslationRequest,
  TranslationResult,
  TranslationProviderConfig,
  TranslationProviderType,
} from "./types.js";
export { DEFAULT_TRANSLATION_MODELS } from "./types.js";
export type { TranslationProvider } from "./provider.js";
export { createTranslationProvider } from "./provider.js";
export { GeminiTranslationProvider } from "./providers/gemini.js";
export { ClaudeTranslationProvider } from "./providers/claude.js";
export { OpenAITranslationProvider } from "./providers/openai.js";
export {
  DEFAULT_TRANSLATION_INSTRUCTIONS,
  buildTranslationPrompt,
} from "./prompts.js";
export {
  TRANSLATION_PRICING,
  calculateTranslationCost,
} from "./pricing.js";
```

---

### Phase 2: Shared Package Updates

#### Step 2.1: Add queue constants
```typescript
// packages/shared/src/queues.ts - ADD:

export const QUEUE_TRANSLATION = "pipeline-translation";
export const JOB_TRANSLATION_BATCH = "translation-batch";
```

#### Step 2.2: Add translation config schema
```typescript
// packages/shared/src/schemas/translation-config.ts (NEW FILE)

import { z } from "zod";

export const translationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  scores: z.array(z.number().min(1).max(5)).default([3, 4, 5]),
  provider: z.enum(["gemini", "claude", "openai"]).default("gemini"),
  model: z.string().default("gemini-2.0-flash"),
  instructions: z.string().max(2000).default(""),
});

export type TranslationConfig = z.infer<typeof translationConfigSchema>;

export const defaultTranslationConfig: TranslationConfig = translationConfigSchema.parse({});
```

#### Step 2.3: Add env schema for Gemini
```typescript
// packages/shared/src/schemas/env.ts - ADD to baseEnvSchema (around line 21-91):

// Translation provider keys
GOOGLE_AI_API_KEY: z.string().optional().transform((v) => v || undefined),
```

**Note:** The env schema is in `baseEnvSchema`, not `coreEnvSchema`. Also add to `.env.example`:
```env
# Translation (Gemini)
GOOGLE_AI_API_KEY=your-gemini-api-key
```

#### Step 2.4: Export new schema
```typescript
// packages/shared/src/index.ts - ADD:

export * from "./schemas/translation-config.js";
```

---

### Phase 3: Database Schema Updates

#### Step 3.1: Update articles table
```typescript
// packages/db/src/schema.ts - ADD to articles table:

// Georgian translation fields
titleKa: text("title_ka"),
llmSummaryKa: text("llm_summary_ka"),
translationModel: text("translation_model"),
```

#### Step 3.2: Create migration
```bash
npm run db:generate
```

#### Step 3.3: Seed translation config defaults
```sql
-- packages/db/seed.sql - ADD:

-- Translation settings
INSERT INTO app_config (key, value, updated_at) VALUES
  ('translation_enabled', 'false', NOW()),
  ('translation_scores', '[3, 4, 5]', NOW()),
  ('translation_provider', '"gemini"', NOW()),
  ('translation_model', '"gemini-2.0-flash"', NOW()),
  ('translation_instructions', '"Translate the following English news summary into Georgian. Maintain a professional, news-appropriate tone. Keep proper nouns in their original form. Technical terms may remain in English if no Georgian equivalent exists."', NOW()),
  ('posting_language', '"en"', NOW())
ON CONFLICT (key) DO NOTHING;
```

---

### Phase 4: Worker Implementation

#### Step 4.1: Create translation processor
```typescript
// packages/worker/src/processors/translation.ts (NEW FILE)

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
import { articles, appConfig, llmTelemetry } from "@watch-tower/db";
import {
  createTranslationProvider,
  calculateTranslationCost,
  type TranslationProviderType,
} from "@watch-tower/translation";

type TranslationDeps = {
  connection: { host: string; port: number };
  db: Database;
  distributionQueue: Queue; // For auto-posting in Georgian mode
};

type TranslationConfigFromDb = {
  enabled: boolean;
  scores: number[];
  provider: TranslationProviderType;
  model: string;
  instructions: string;
};

// Helper: Get translation config from app_config
async function getTranslationConfig(db: Database): Promise<TranslationConfigFromDb> {
  const keys = [
    "translation_enabled",
    "translation_scores",
    "translation_provider",
    "translation_model",
    "translation_instructions",
  ];

  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const configMap = new Map(rows.map((r) => [r.key, r.value]));

  return {
    enabled: configMap.get("translation_enabled") === true || configMap.get("translation_enabled") === "true",
    scores: (configMap.get("translation_scores") as number[]) ?? [3, 4, 5],
    provider: (configMap.get("translation_provider") as TranslationProviderType) ?? "gemini",
    model: (configMap.get("translation_model") as string) ?? "gemini-2.0-flash",
    instructions: (configMap.get("translation_instructions") as string) ?? "",
  };
}

// Helper: Get API key for provider
function getApiKey(provider: TranslationProviderType): string {
  switch (provider) {
    case "gemini":
      return process.env.GOOGLE_AI_API_KEY ?? "";
    case "claude":
      return process.env.ANTHROPIC_API_KEY ?? "";
    case "openai":
      return process.env.OPENAI_API_KEY ?? "";
  }
}

export const createTranslationWorker = ({ connection, db, distributionQueue }: TranslationDeps) => {
  return new Worker(
    QUEUE_TRANSLATION,
    async (job) => {
      if (job.name !== JOB_TRANSLATION_BATCH) {
        logger.warn({ jobName: job.name }, "[translation] unknown job type");
        return { skipped: true, reason: "unknown_job_type" };
      }

      // 1. Check if translation is enabled
      const config = await getTranslationConfig(db);
      if (!config.enabled) {
        logger.debug("[translation] disabled, skipping batch");
        return { skipped: true, reason: "disabled" };
      }

      // 2. Check API key availability
      const apiKey = getApiKey(config.provider);
      if (!apiKey) {
        logger.warn(`[translation] no API key for provider: ${config.provider}`);
        return { skipped: true, reason: "no_api_key" };
      }

      // 3. ATOMIC CLAIM: Get scored articles that need translation
      const scoreList = config.scores.length > 0 ? config.scores : [3, 4, 5];
      const claimResult = await db.execute(sql`
        UPDATE articles
        SET pipeline_stage = 'translating'
        WHERE id IN (
          SELECT id FROM articles
          WHERE pipeline_stage = 'scored'
            AND importance_score = ANY(${scoreList}::smallint[])
            AND llm_summary IS NOT NULL
            AND llm_summary_ka IS NULL
          ORDER BY created_at
          LIMIT 10
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, title, llm_summary as "llmSummary"
      `);

      const claimed = claimResult.rows as { id: string; title: string; llmSummary: string }[];

      if (claimed.length === 0) {
        return { processed: 0 };
      }

      logger.info(`[translation] claimed ${claimed.length} articles for translation`);

      // 4. Create provider
      const provider = createTranslationProvider({
        provider: config.provider,
        apiKey,
        model: config.model,
      });

      // 5. Translate each article
      const results: { id: string; success: boolean; error?: string }[] = [];
      const telemetryRows: {
        articleId: string;
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costMicrodollars: number;
        latencyMs: number;
      }[] = [];

      for (const article of claimed) {
        const result = await provider.translate({
          articleId: article.id,
          title: article.title,
          summary: article.llmSummary,
          targetLanguage: "ka",
          instructions: config.instructions || undefined,
        });

        if (result.error || !result.titleTranslated || !result.summaryTranslated) {
          // Mark as translation_failed
          await db
            .update(articles)
            .set({ pipelineStage: "translation_failed" })
            .where(eq(articles.id, article.id));

          results.push({ id: article.id, success: false, error: result.error });
          logger.warn({ articleId: article.id, error: result.error }, "[translation] failed");
        } else {
          // Save translation
          await db
            .update(articles)
            .set({
              titleKa: result.titleTranslated,
              llmSummaryKa: result.summaryTranslated,
              translationModel: config.model,
              pipelineStage: "translated",
            })
            .where(eq(articles.id, article.id));

          results.push({ id: article.id, success: true });

          // Collect telemetry
          if (result.usage) {
            telemetryRows.push({
              articleId: article.id,
              provider: config.provider,
              model: config.model,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
              costMicrodollars: calculateTranslationCost(
                config.provider,
                config.model,
                result.usage.inputTokens,
                result.usage.outputTokens
              ),
              latencyMs: result.latencyMs ?? 0,
            });
          }

          logger.info({ articleId: article.id }, "[translation] completed");

          // 7. Auto-post in Georgian mode (if enabled)
          // Check if auto-posting is enabled and article qualifies
          const [autoPostRow] = await db
            .select({ value: appConfig.value })
            .from(appConfig)
            .where(eq(appConfig.key, "auto_post_telegram"));

          const autoPostEnabled = autoPostRow?.value === true || autoPostRow?.value === "true";

          // Get the article's score to check against auto-post threshold
          const [articleRow] = await db
            .select({ score: articles.importanceScore })
            .from(articles)
            .where(eq(articles.id, article.id));

          const articleScore = articleRow?.score ?? 0;

          // Auto-post threshold is typically 5 (score 5 = auto-approve)
          if (autoPostEnabled && articleScore >= 5) {
            await distributionQueue.add(
              JOB_DISTRIBUTION_IMMEDIATE,
              { articleId: article.id },
              { jobId: `dist-ka-${article.id}` }
            );
            logger.info({ articleId: article.id }, "[translation] queued for auto-post (Georgian)");
          }
        }
      }

      // 8. Batch insert telemetry
      if (telemetryRows.length > 0) {
        try {
          await db.insert(llmTelemetry).values(
            telemetryRows.map((t) => ({
              articleId: t.articleId,
              operation: "translate",
              provider: t.provider,
              model: t.model,
              isFallback: false,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              totalTokens: t.totalTokens,
              costMicrodollars: t.costMicrodollars,
              latencyMs: t.latencyMs,
            }))
          );
        } catch (err) {
          logger.error("[translation] telemetry insert failed", err);
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      logger.info(`[translation] batch complete: ${successCount} translated, ${failCount} failed`);

      return { processed: claimed.length, success: successCount, failed: failCount };
    },
    { connection, concurrency: 1 }
  );
};
```

#### Step 4.2: Update worker index.ts
```typescript
// packages/worker/src/index.ts - ADD:

import { QUEUE_TRANSLATION, JOB_TRANSLATION_BATCH } from "@watch-tower/shared";
import { createTranslationWorker } from "./processors/translation.js";

// After other queue creations:
const translationQueue = new Queue(QUEUE_TRANSLATION, { connection: redisConnection });

// After other worker creations (conditional on GOOGLE_AI_API_KEY or other provider keys):
const hasTranslationKey = !!(env.GOOGLE_AI_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
let translationWorker: Worker | null = null;

if (hasTranslationKey) {
  translationWorker = createTranslationWorker({
    connection: redisConnection,
    db,
    distributionQueue, // Pass existing distribution queue for auto-posting
  });
  logger.info("[worker] translation worker started");
}

// Add repeatable job in job registry:
// In ensureRepeatableJobs or startup:
await translationQueue.add(
  JOB_TRANSLATION_BATCH,
  {},
  { repeat: { every: 15_000 }, jobId: "translation-batch-repeat" }
);

// Add to graceful shutdown:
if (translationWorker) await translationWorker.close();
await translationQueue.close();
```

#### Step 4.3: Update LLM brain with auto-post gating
```typescript
// packages/worker/src/processors/llm-brain.ts
// Around line 379-401 where immediate distribution is queued

// BEFORE queueing immediate distribution, check posting language:
const [langRow] = await db
  .select({ value: appConfig.value })
  .from(appConfig)
  .where(eq(appConfig.key, "posting_language"));

const postingLanguage = (langRow?.value as string) ?? "en";

// Only auto-post immediately if in English mode
// Georgian mode: translation worker will handle auto-posting after translation
if (postingLanguage === "ka") {
  logger.debug("[llm-brain] Georgian mode, skipping immediate distribution (translation worker will handle)");
  // Skip queueing distribution - translation worker will do it after translating
} else {
  // English mode: queue immediate distribution as usual
  if (autoPostTelegram && articleScore >= 5) {
    await distributionQueue.add(
      JOB_DISTRIBUTION_IMMEDIATE,
      { articleId },
      { jobId: `dist-${articleId}` }
    );
  }
}
```

**Key change:** When `posting_language = 'ka'`, LLM brain does NOT queue immediate distribution. The translation worker will pick up scored articles, translate them, then queue distribution.

---

### Phase 5: API Routes

#### Step 5.0: Update /articles endpoint to include translation fields
```typescript
// packages/api/src/routes/articles.ts - UPDATE the select queries

// In GET /articles (list) around line 103-121, add to select:
titleKa: articles.titleKa,
llmSummaryKa: articles.llmSummaryKa,
translationModel: articles.translationModel,

// In GET /articles/:id (single) around line 154-173, add same fields

// This ensures frontend can display both English and Georgian content
```

#### Step 5.1: Add translation config endpoints
```typescript
// packages/api/src/routes/config.ts - ADD:

// GET /config/translation
app.get<{ Reply: TranslationConfig }>(
  "/config/translation",
  { preHandler: deps.requireApiKey },
  async (_, reply) => {
    const keys = [
      "translation_enabled",
      "translation_scores",
      "translation_provider",
      "translation_model",
      "translation_instructions",
    ];

    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, keys));

    const configMap = new Map(rows.map((r) => [r.key, r.value]));

    return reply.send({
      enabled: configMap.get("translation_enabled") === true || configMap.get("translation_enabled") === "true",
      scores: (configMap.get("translation_scores") as number[]) ?? [3, 4, 5],
      provider: (configMap.get("translation_provider") as string) ?? "gemini",
      model: (configMap.get("translation_model") as string) ?? "gemini-2.0-flash",
      instructions: (configMap.get("translation_instructions") as string) ?? "",
    });
  }
);

// PATCH /config/translation
app.patch<{ Body: Partial<TranslationConfig> }>(
  "/config/translation",
  { preHandler: deps.requireApiKey },
  async (request, reply) => {
    const { enabled, scores, provider, model, instructions } = request.body;

    const updates: { key: string; value: unknown }[] = [];

    if (enabled !== undefined) updates.push({ key: "translation_enabled", value: enabled });
    if (scores !== undefined) updates.push({ key: "translation_scores", value: scores });
    if (provider !== undefined) updates.push({ key: "translation_provider", value: provider });
    if (model !== undefined) updates.push({ key: "translation_model", value: model });
    if (instructions !== undefined) updates.push({ key: "translation_instructions", value: instructions });

    for (const { key, value } of updates) {
      await deps.db
        .insert(appConfig)
        .values({ key, value: JSON.stringify(value), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: appConfig.key,
          set: { value: JSON.stringify(value), updatedAt: new Date() },
        });
    }

    logger.info(`[config] translation settings updated`);
    return reply.send({ success: true });
  }
);

// GET /config/posting-language
app.get(
  "/config/posting-language",
  { preHandler: deps.requireApiKey },
  async (_, reply) => {
    const [row] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "posting_language"));

    return reply.send({ language: (row?.value as string) ?? "en" });
  }
);

// PATCH /config/posting-language
app.patch<{ Body: { language: "en" | "ka" } }>(
  "/config/posting-language",
  { preHandler: deps.requireApiKey },
  async (request, reply) => {
    const { language } = request.body;

    if (!["en", "ka"].includes(language)) {
      return reply.code(400).send({ error: "Language must be 'en' or 'ka'" });
    }

    await deps.db
      .insert(appConfig)
      .values({ key: "posting_language", value: JSON.stringify(language), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: JSON.stringify(language), updatedAt: new Date() },
      });

    logger.info(`[config] posting language set to: ${language}`);
    return reply.send({ language });
  }
);
```

---

### Phase 6: Social Provider Updates

#### Step 6.1: Update formatPost to accept language-aware article
```typescript
// packages/social/src/types.ts - UPDATE ArticleForPost:

export type ArticleForPost = {
  title: string;
  titleKa?: string | null;      // ADD
  summary: string;
  summaryKa?: string | null;    // ADD
  url: string;
  sector: string;
};
```

#### Step 6.2: Update distribution worker to use posting language
```typescript
// packages/worker/src/processors/distribution.ts - UPDATE:

// At the top of job processing, after kill switch check:
const [langRow] = await db
  .select({ value: appConfig.value })
  .from(appConfig)
  .where(eq(appConfig.key, "posting_language"));

const postingLanguage = (langRow?.value as string) ?? "en";

// When formatting post:
const articleForPost = {
  title: postingLanguage === "ka" && article.titleKa ? article.titleKa : article.title,
  summary: postingLanguage === "ka" && article.llmSummaryKa ? article.llmSummaryKa : (article.llmSummary || article.title),
  url: article.url,
  sector: article.sectorName || "News",
};

// BLOCKING: If Georgian mode but no translation available
if (postingLanguage === "ka" && (!article.titleKa || !article.llmSummaryKa)) {
  logger.warn({ articleId }, "[distribution] Georgian mode but no translation available");
  results.push({
    platform: name,
    success: false,
    error: "No Georgian translation available",
  });
  continue;
}

const text = provider!.formatPost(articleForPost, template);
```

#### Step 6.3: Same update for maintenance.ts scheduled posts
```typescript
// packages/worker/src/processors/maintenance.ts - UPDATE processScheduledPosts():

// Same pattern as distribution.ts - check posting_language config
// Use titleKa/llmSummaryKa when language is 'ka'
// Block with error if Georgian mode but no translation
```

#### Step 6.4: Add zombie reset for translation stages
```typescript
// packages/worker/src/processors/maintenance.ts - ADD to resetZombieArticles():

// Reset zombie translating articles (stuck for >10 min)
const translatingResetResult = await db.execute(sql`
  UPDATE articles
  SET pipeline_stage = 'scored'
  WHERE pipeline_stage = 'translating'
    AND updated_at < NOW() - INTERVAL '10 minutes'
  RETURNING id
`);

if (translatingResetResult.rows.length > 0) {
  logger.warn(`[maintenance] reset ${translatingResetResult.rows.length} zombie translating articles`);
}

// Reset translation_failed articles (retry after 1 hour)
const translationFailedResetResult = await db.execute(sql`
  UPDATE articles
  SET pipeline_stage = 'scored'
  WHERE pipeline_stage = 'translation_failed'
    AND updated_at < NOW() - INTERVAL '1 hour'
  RETURNING id
`);

if (translationFailedResetResult.rows.length > 0) {
  logger.warn(`[maintenance] reset ${translationFailedResetResult.rows.length} translation_failed articles for retry`);
}
```

---

### Phase 7: Frontend Implementation

#### Step 7.1: Add API functions
```typescript
// packages/frontend/src/api.ts - ADD:

// Translation config types
export type TranslationConfig = {
  enabled: boolean;
  scores: number[];
  provider: string;
  model: string;
  instructions: string;
};

// Get translation config
export const getTranslationConfig = async (): Promise<TranslationConfig> => {
  const res = await fetch(`${API_URL}/config/translation`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get translation config");
  return res.json();
};

// Update translation config
export const updateTranslationConfig = async (
  config: Partial<TranslationConfig>
): Promise<void> => {
  const res = await fetch(`${API_URL}/config/translation`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to update translation config");
};

// Get posting language
export const getPostingLanguage = async (): Promise<"en" | "ka"> => {
  const res = await fetch(`${API_URL}/config/posting-language`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get posting language");
  const data = await res.json();
  return data.language;
};

// Set posting language
export const setPostingLanguage = async (language: "en" | "ka"): Promise<void> => {
  const res = await fetch(`${API_URL}/config/posting-language`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
  });
  if (!res.ok) throw new Error("Failed to set posting language");
};
```

#### Step 7.2: Add Translation Settings tab to SiteRules.tsx
```tsx
// packages/frontend/src/pages/SiteRules.tsx - ADD new tab:

// In tab navigation, add:
{ id: "translation", label: "Translation" }

// Add state:
const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(null);
const [postingLanguage, setPostingLanguageState] = useState<"en" | "ka">("en");

// Add load effect:
useEffect(() => {
  getTranslationConfig().then(setTranslationConfig);
  getPostingLanguage().then(setPostingLanguageState);
}, []);

// Add Translation tab content:
{activeTab === "translation" && (
  <div className="space-y-6">
    {/* Enable/Disable Toggle */}
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Georgian Translation</h3>
          <p className="text-sm text-slate-400">
            Automatically translate scored articles to Georgian
          </p>
        </div>
        <button
          onClick={() => {
            const newEnabled = !translationConfig?.enabled;
            updateTranslationConfig({ enabled: newEnabled });
            setTranslationConfig((prev) => prev ? { ...prev, enabled: newEnabled } : null);
            toast.success(newEnabled ? "Translation enabled" : "Translation disabled");
          }}
          className={`rounded-full px-4 py-2 text-sm font-medium ${
            translationConfig?.enabled
              ? "bg-emerald-500/20 text-emerald-200"
              : "bg-slate-700 text-slate-300"
          }`}
        >
          {translationConfig?.enabled ? "Enabled" : "Disabled"}
        </button>
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
            <span>Score {score}</span>
          </label>
        ))}
      </div>
    </div>

    {/* Provider & Model Selection */}
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h3 className="text-lg font-medium mb-4">Translation Provider</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-sm text-slate-400 mb-2">Provider</label>
          <select
            value={translationConfig?.provider ?? "gemini"}
            onChange={(e) => {
              updateTranslationConfig({ provider: e.target.value });
              setTranslationConfig((prev) => prev ? { ...prev, provider: e.target.value } : null);
            }}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2"
          >
            <option value="gemini">Gemini (Google)</option>
            <option value="claude">Claude (Anthropic)</option>
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
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2"
          >
            {/* Gemini models */}
            <option value="gemini-2.0-flash">gemini-2.0-flash</option>
            <option value="gemini-2.0-pro">gemini-2.0-pro</option>
            <option value="gemini-1.5-flash">gemini-1.5-flash</option>
            {/* Claude models */}
            <option value="claude-3-haiku-20240307">claude-3-haiku</option>
            <option value="claude-3-5-sonnet-20241022">claude-3.5-sonnet</option>
            {/* OpenAI models */}
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="gpt-4o">gpt-4o</option>
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
          setTranslationConfig((prev) => prev ? { ...prev, instructions: e.target.value } : null);
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

    {/* Posting Language Toggle */}
    <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-amber-200">Global Posting Language</h3>
          <p className="text-sm text-amber-200/70">
            All posts will use this language (requires translation to be enabled for Georgian)
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setPostingLanguage("en");
              setPostingLanguageState("en");
              toast.success("Posting language set to English");
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              postingLanguage === "en"
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-slate-700 text-slate-300"
            }`}
          >
            English
          </button>
          <button
            onClick={() => {
              if (!translationConfig?.enabled) {
                toast.error("Enable translation first");
                return;
              }
              setPostingLanguage("ka");
              setPostingLanguageState("ka");
              toast.success("Posting language set to Georgian");
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              postingLanguage === "ka"
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-slate-700 text-slate-300"
            }`}
          >
            Georgian (ქართული)
          </button>
        </div>
      </div>
    </div>
  </div>
)}
```

#### Step 7.3: Update Article cards to show both summaries
```tsx
// packages/frontend/src/pages/Articles.tsx - UPDATE article display:

// In article list, show both summaries if available:
<div className="text-sm text-slate-400 line-clamp-2">
  {article.llm_summary}
</div>
{article.llm_summary_ka && (
  <div className="text-sm text-slate-500 line-clamp-2 mt-1 border-l-2 border-slate-700 pl-2">
    🇬🇪 {article.llm_summary_ka}
  </div>
)}
```

---

## 6. Testing Checklist

### Unit Tests
- [ ] Translation provider factory creates correct provider
- [ ] Gemini provider parses JSON response correctly
- [ ] Claude provider parses JSON response correctly
- [ ] OpenAI provider parses JSON response correctly
- [ ] Pricing calculation returns correct microdollars
- [ ] Prompt builder includes custom instructions

### Integration Tests
- [ ] Translation worker claims articles with correct scores
- [ ] Translation worker skips when disabled
- [ ] Translation worker saves title_ka and llm_summary_ka
- [ ] Translation worker inserts telemetry
- [ ] **Translation worker queues distribution for auto-post (Georgian mode)**
- [ ] API returns correct translation config
- [ ] API updates translation config correctly
- [ ] API returns/sets posting language
- [ ] **API /articles returns title_ka, llm_summary_ka fields**

### Auto-Post Gating Tests (Critical)
- [ ] **English mode + score 5**: LLM brain queues immediate distribution
- [ ] **Georgian mode + score 5**: LLM brain SKIPS distribution queue
- [ ] **Georgian mode + translation complete**: Translation worker queues distribution
- [ ] **Georgian mode + translation failed**: Article stays in translation_failed, no post
- [ ] **Maintenance resets zombie translating articles after 10 min**
- [ ] **Maintenance resets translation_failed articles after 1 hour**

### E2E Tests
- [ ] Enable translation via UI
- [ ] Select scores to translate via UI
- [ ] Change provider/model via UI
- [ ] Update instructions via UI
- [ ] Toggle posting language via UI
- [ ] Verify article shows Georgian translation
- [ ] Verify post uses correct language based on toggle
- [ ] Verify posting blocked when Georgian mode but no translation

### Manual Verification
- [ ] Georgian text displays correctly (Unicode)
- [ ] Translation quality is acceptable
- [ ] Telemetry shows translation costs
- [ ] Error handling shows user-friendly messages
- [ ] **Switch from English to Georgian mode mid-pipeline works correctly**

---

## Summary

This task adds a complete Georgian translation layer to Watch Tower:

1. **New `@watch-tower/translation` package** - Modular provider architecture (Gemini, Claude, OpenAI)
2. **Database columns** - `title_ka`, `llm_summary_ka`, `translation_model`
3. **Translation worker** - Processes scored articles based on config, queues distribution for auto-post
4. **Auto-post gating** - English mode: immediate post; Georgian mode: post after translation
5. **API endpoints** - Translation config + posting language + articles with new fields
6. **Maintenance updates** - Zombie reset for `translating` and `translation_failed` stages
7. **Frontend UI** - Translation settings tab in Site Rules
8. **Social posting** - Uses correct language based on global toggle, blocks if translation missing

### Key Architecture Decision: Auto-Post Gating

```
English mode (posting_language = 'en'):
  LLM Brain → scores article → queues distribution → posts immediately

Georgian mode (posting_language = 'ka'):
  LLM Brain → scores article → SKIPS distribution queue
       ↓
  Translation Worker → translates → stores title_ka, llm_summary_ka
       ↓
  Translation Worker → queues distribution → posts in Georgian
```

This ensures zero latency for English auto-posts while guaranteeing Georgian posts wait for translation.

The architecture is fully modular - providers can be swapped via UI without code changes or restarts.
