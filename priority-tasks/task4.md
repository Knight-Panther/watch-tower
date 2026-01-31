# Task 4: LLM Token Telemetry

Track actual token usage and costs for all LLM/embedding operations.

## Why This Matters

| Metric | Purpose |
|--------|---------|
| `input_tokens` | See how much article content costs |
| `output_tokens` | See summary generation cost |
| `cost_microdollars` | Calculate actual USD spent |
| `latency_ms` | Monitor API performance |
| `provider` / `is_fallback` | Track when fallback kicks in |

**Dashboard goal:**
```
Today:     1,250 calls | 450K tokens | $0.15
This week: 8,750 calls | 3.2M tokens | $1.05

By provider:
  - DeepSeek: 95% calls, $0.98
  - OpenAI (fallback): 5% calls, $0.07
```

---

## Implementation Steps

### Step 1: Database Schema

**File**: `packages/db/src/schema.ts`

Add new table for LLM telemetry:
```typescript
export const llmTelemetry = pgTable("llm_telemetry", {
  id: uuid("id").primaryKey().defaultRandom(),

  // What was processed
  articleId: uuid("article_id").references(() => articles.id),
  operation: text("operation").notNull(), // 'score_and_summarize', 'embed_batch'

  // Provider info
  provider: text("provider").notNull(),   // 'deepseek', 'openai', 'claude'
  model: text("model").notNull(),         // 'deepseek-chat', 'gpt-4o-mini'
  isFallback: boolean("is_fallback").default(false),

  // Token counts
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),

  // Cost (in USD microdollars for precision)
  costMicrodollars: integer("cost_microdollars"), // $0.001 = 1000 microdollars

  // Timing
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
```

**Run**: `npm run db:generate && npm run db:migrate`

---

### Step 2: Provider Pricing Config

**File**: `packages/llm/src/pricing.ts`

```typescript
// Prices per 1M tokens in microdollars
// $1 = 1,000,000 microdollars
export const LLM_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  deepseek: {
    "deepseek-chat": { input: 140_000, output: 280_000 },  // $0.14/$0.28 per 1M
  },
  openai: {
    "gpt-4o-mini": { input: 150_000, output: 600_000 },    // $0.15/$0.60 per 1M
    "gpt-4o": { input: 2_500_000, output: 10_000_000 },    // $2.50/$10 per 1M
  },
  claude: {
    "claude-sonnet-4-20250514": { input: 3_000_000, output: 15_000_000 }, // $3/$15 per 1M
  },
};

// Embedding pricing (per 1M tokens in microdollars)
export const EMBEDDING_PRICING: Record<string, Record<string, number>> = {
  openai: {
    "text-embedding-3-small": 20_000,  // $0.02 per 1M tokens
    "text-embedding-3-large": 130_000, // $0.13 per 1M tokens
  },
};

/**
 * Calculate cost in microdollars for LLM call
 */
export const calculateLLMCost = (
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number => {
  const pricing = LLM_PRICING[provider]?.[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round(inputCost + outputCost);
};

/**
 * Calculate cost in microdollars for embedding call
 */
export const calculateEmbeddingCost = (
  provider: string,
  model: string,
  tokens: number,
): number => {
  const pricing = EMBEDDING_PRICING[provider]?.[model];
  if (!pricing) return 0;

  return Math.round((tokens / 1_000_000) * pricing);
};

/**
 * Convert microdollars to USD string
 */
export const microdollarsToUsd = (microdollars: number): string => {
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
};
```

---

### Step 3: Update LLM Types

**File**: `packages/llm/src/types.ts`

Add usage tracking to ScoringResult:
```typescript
export type ScoringResult = {
  articleId: string;
  score: number;
  summary?: string;
  reasoning?: string;

  // Token telemetry (populated from API response)
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs?: number;
  isFallback?: boolean; // True if fallback provider was used
};
```

---

### Step 4: Update LLM Providers to Return Usage

**File**: `packages/llm/src/providers/deepseek.ts` (and similar for openai.ts, claude.ts)

All providers already receive token usage from API responses:
- **OpenAI/DeepSeek**: `response.usage.prompt_tokens`, `response.usage.completion_tokens`
- **Anthropic**: `response.usage.input_tokens`, `response.usage.output_tokens`

Update the `score()` method to capture and return this data:
```typescript
const startTime = Date.now();

const response = await this.client.chat.completions.create({...});

const latencyMs = Date.now() - startTime;

return {
  articleId: request.articleId,
  score: parsed.score,
  summary: parsed.summary,
  reasoning: parsed.reasoning,
  usage: response.usage ? {
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
  } : undefined,
  latencyMs,
};
```

For fallback provider, also track `isFallback: true` when fallback is triggered.

---

### Step 5: Log Telemetry in LLM Brain

**File**: `packages/worker/src/processors/llm-brain.ts`

Import telemetry table and pricing:
```typescript
import { llmTelemetry } from "@watch-tower/db";
import { calculateLLMCost } from "@watch-tower/llm";
```

After successful scoring, insert telemetry record:
```typescript
// Inside the success loop, after updating article
if (result.usage) {
  await db.insert(llmTelemetry).values({
    articleId: result.articleId,
    operation: "score_and_summarize",
    provider: llmProvider.name,
    model: llmProvider.model,
    isFallback: result.isFallback ?? false,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    totalTokens: result.usage.totalTokens,
    costMicrodollars: calculateLLMCost(
      result.isFallback ? llmProvider.fallbackName! : llmProvider.name,
      result.isFallback ? llmProvider.fallbackModel! : llmProvider.model,
      result.usage.inputTokens,
      result.usage.outputTokens
    ),
    latencyMs: result.latencyMs,
  });
}
```

---

### Step 6: Log Telemetry in Semantic Dedup

**File**: `packages/worker/src/processors/semantic-dedup.ts`

Track embedding costs (estimate tokens from character count):
```typescript
import { llmTelemetry } from "@watch-tower/db";
import { calculateEmbeddingCost } from "@watch-tower/llm";

// After embedding batch
const estimatedTokens = batch.reduce((sum, a) => {
  // ~4 chars per token for English text
  const chars = (a.title?.length ?? 0) + (a.contentSnippet?.length ?? 0);
  return sum + Math.ceil(chars / 4);
}, 0);

await db.insert(llmTelemetry).values({
  operation: "embed_batch",
  provider: "openai",
  model: embeddingModel,
  isFallback: false,
  inputTokens: estimatedTokens,
  outputTokens: 0,
  totalTokens: estimatedTokens,
  costMicrodollars: calculateEmbeddingCost("openai", embeddingModel, estimatedTokens),
  latencyMs: embedLatencyMs,
});
```

---

### Step 7: API Endpoint for Telemetry

**File**: `packages/api/src/routes/telemetry.ts`

```typescript
import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { microdollarsToUsd } from "@watch-tower/llm";

type TelemetryDeps = { db: Database };

export const registerTelemetryRoutes = (app: FastifyInstance, { db }: TelemetryDeps) => {
  // GET /telemetry/summary
  app.get("/telemetry/summary", async () => {
    const periods = {
      today: "created_at >= CURRENT_DATE",
      last7Days: "created_at >= CURRENT_DATE - INTERVAL '7 days'",
      last30Days: "created_at >= CURRENT_DATE - INTERVAL '30 days'",
    };

    const results: Record<string, unknown> = {};

    for (const [period, condition] of Object.entries(periods)) {
      const stats = await db.execute(sql.raw(`
        SELECT
          COUNT(*)::int as total_calls,
          COALESCE(SUM(total_tokens), 0)::int as total_tokens,
          COALESCE(SUM(cost_microdollars), 0)::int as total_cost_microdollars
        FROM llm_telemetry
        WHERE ${condition}
      `));

      const byProvider = await db.execute(sql.raw(`
        SELECT
          provider,
          COUNT(*)::int as calls,
          COALESCE(SUM(total_tokens), 0)::int as tokens,
          COALESCE(SUM(cost_microdollars), 0)::int as cost_microdollars,
          COUNT(*) FILTER (WHERE is_fallback = true)::int as fallback_calls
        FROM llm_telemetry
        WHERE ${condition}
        GROUP BY provider
      `));

      const byOperation = await db.execute(sql.raw(`
        SELECT
          operation,
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_microdollars), 0)::int as cost_microdollars,
          COALESCE(AVG(latency_ms), 0)::int as avg_latency_ms
        FROM llm_telemetry
        WHERE ${condition}
        GROUP BY operation
      `));

      const row = stats.rows[0] as { total_calls: number; total_tokens: number; total_cost_microdollars: number };

      results[period] = {
        totalCalls: row.total_calls,
        totalTokens: row.total_tokens,
        totalCostUsd: microdollarsToUsd(row.total_cost_microdollars),
        byProvider: Object.fromEntries(
          (byProvider.rows as { provider: string; calls: number; tokens: number; cost_microdollars: number; fallback_calls: number }[])
            .map(r => [r.provider, {
              calls: r.calls,
              tokens: r.tokens,
              costUsd: microdollarsToUsd(r.cost_microdollars),
              fallbackCalls: r.fallback_calls,
            }])
        ),
        byOperation: Object.fromEntries(
          (byOperation.rows as { operation: string; calls: number; cost_microdollars: number; avg_latency_ms: number }[])
            .map(r => [r.operation, {
              calls: r.calls,
              costUsd: microdollarsToUsd(r.cost_microdollars),
              avgLatencyMs: r.avg_latency_ms,
            }])
        ),
      };
    }

    return results;
  });

  // GET /telemetry/daily - Last 30 days breakdown for charts
  app.get("/telemetry/daily", async () => {
    const result = await db.execute(sql`
      SELECT
        DATE(created_at) as date,
        COUNT(*)::int as calls,
        COALESCE(SUM(total_tokens), 0)::int as tokens,
        COALESCE(SUM(cost_microdollars), 0)::int as cost_microdollars
      FROM llm_telemetry
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    return (result.rows as { date: string; calls: number; tokens: number; cost_microdollars: number }[])
      .map(r => ({
        date: r.date,
        calls: r.calls,
        tokens: r.tokens,
        costUsd: microdollarsToUsd(r.cost_microdollars),
      }));
  });
};
```

Register in `packages/api/src/index.ts`:
```typescript
import { registerTelemetryRoutes } from "./routes/telemetry.js";

// After other route registrations
registerTelemetryRoutes(app, { db });
```

---

### Step 8: Frontend Dashboard Component

**File**: `packages/frontend/src/components/TelemetryStats.tsx`

```typescript
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export const TelemetryStats = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["telemetry", "summary"],
    queryFn: () => api.get("/telemetry/summary").json(),
    refetchInterval: 60_000, // Refresh every minute
  });

  if (isLoading) return <div>Loading telemetry...</div>;

  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard
        title="Today"
        calls={data.today.totalCalls}
        tokens={data.today.totalTokens}
        cost={data.today.totalCostUsd}
      />
      <StatCard
        title="Last 7 Days"
        calls={data.last7Days.totalCalls}
        tokens={data.last7Days.totalTokens}
        cost={data.last7Days.totalCostUsd}
      />
      <StatCard
        title="Last 30 Days"
        calls={data.last30Days.totalCalls}
        tokens={data.last30Days.totalTokens}
        cost={data.last30Days.totalCostUsd}
      />
    </div>
  );
};

const StatCard = ({ title, calls, tokens, cost }) => (
  <div className="bg-white rounded-lg shadow p-4">
    <h3 className="text-sm font-medium text-gray-500">{title}</h3>
    <div className="mt-2 space-y-1">
      <p className="text-2xl font-semibold">{cost}</p>
      <p className="text-sm text-gray-600">
        {calls.toLocaleString()} calls | {(tokens / 1000).toFixed(1)}K tokens
      </p>
    </div>
  </div>
);
```

---

## Testing Checklist

- [ ] `llm_telemetry` table created via migration
- [ ] Token counts populated after LLM scoring
- [ ] Embedding costs tracked in semantic-dedup
- [ ] Cost calculation matches expected pricing
- [ ] `GET /telemetry/summary` returns correct aggregations
- [ ] `GET /telemetry/daily` returns 30-day breakdown
- [ ] Fallback calls marked with `is_fallback = true`
- [ ] Dashboard displays costs correctly

---

## API Response Example

```json
GET /telemetry/summary

{
  "today": {
    "totalCalls": 1250,
    "totalTokens": 450000,
    "totalCostUsd": "$0.1500",
    "byProvider": {
      "deepseek": { "calls": 1200, "tokens": 420000, "costUsd": "$0.1200", "fallbackCalls": 0 },
      "openai": { "calls": 50, "tokens": 30000, "costUsd": "$0.0300", "fallbackCalls": 50 }
    },
    "byOperation": {
      "score_and_summarize": { "calls": 1200, "costUsd": "$0.1200", "avgLatencyMs": 850 },
      "embed_batch": { "calls": 50, "costUsd": "$0.0300", "avgLatencyMs": 120 }
    }
  },
  "last7Days": { ... },
  "last30Days": { ... }
}
```

---

## Future Enhancements

Once telemetry data accumulates:
1. **Cost alerts** - Notify when daily spend exceeds threshold
2. **Provider comparison** - A/B test DeepSeek vs OpenAI accuracy/cost
3. **Sector analysis** - Which sectors cost most (prompt optimization targets)
4. **Fallback monitoring** - Alert when fallback rate exceeds threshold
5. **Latency tracking** - Identify slow providers/times
