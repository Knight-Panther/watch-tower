# SmartHub — Pipeline Intelligence Advisor

## Implementation Rules (MUST FOLLOW)

### Rule 1: Dependency Tree First
Before modifying ANY file, trace its dependency tree:
1. Read the file's imports to identify upstream dependencies
2. Search for files that import FROM this file (downstream consumers)
3. Understand the full chain: `shared → worker → api → frontend`
4. Edit in dependency order (leaf packages first, consumers last)
5. **Never edit a file without reading its current state first**

### Rule 2: Ground Truth Over Guide
This implementation guide is a PLAN, not gospel. Before implementing each step:
1. **Read the actual current code** — schema, routes, processors may have changed since this plan was written
2. **Check if patterns match** — if the guide says "copy digest pattern" but digest has been refactored, follow the NEW pattern
3. **Question the guide** — if something doesn't make sense against the actual codebase, stop and investigate
4. **Validate assumptions** — indexes, column names, type shapes, function signatures — verify before using

### Rule 3: Progress Tracking
After completing each step, mark it done in this file:
- `[ ]` = not started
- `[WIP]` = work in progress
- `[DONE]` = completed and verified (build clean)
- `[SKIP]` = intentionally skipped with reason

Update this checklist as you go so new conversation windows can see progress:

```
[ ] Step 1:  Schema — advisor_reports table + 3 missing indexes
[ ] Step 2:  Shared constants + types (queues.ts, types.ts)
[ ] Step 3:  Stats collector (advisor-stats.ts)
[ ] Step 4:  LLM advisor (advisor-llm.ts)
[ ] Step 5:  Worker wiring (maintenance.ts, index.ts)
[ ] Step 6:  API routes (advisor.ts, server.ts)
[ ] Step 7:  Frontend page (Advisor.tsx, api helpers, Layout, App)
[ ] Step 8:  Seed app_config defaults
[ ] Step 9:  TTL cleanup integration
[ ] Step 10: SSE event for report-ready notification
```

### Rule 4: Build Verification
After each step that modifies TypeScript:
1. Run `npm run build` (or the affected package build)
2. Fix any type errors before moving to the next step
3. Do NOT accumulate build errors across steps

### Rule 5: CLAUDE.md Is Stale
`CLAUDE.md` may NOT reflect the latest state of the codebase. Treat it as reference context, not source of truth. When in doubt:
1. Read the actual source files — they are the ground truth
2. If CLAUDE.md says a table/route/processor exists, verify it in code before depending on it
3. After SmartHub is fully implemented, update CLAUDE.md to document the new feature

### Rule 6: Use Subagents for Heavy Lifting
Use subagents (Agent tool) wherever they make sense during implementation:
- **Explore agents** — to scan dependency trees before editing, find all consumers of a module, verify patterns
- **Refactor agents** — for repetitive edits across multiple files (e.g., adding imports, updating type exports)
- **TypeScript agents** — for complex type definitions, generic constraints, Zod schema authoring
- **Test agents** — to write tests for the stats collector and advisor logic
- **Parallel agents** — launch multiple agents simultaneously for independent tasks (e.g., schema + types can be explored in parallel)

Don't do everything sequentially when agents can parallelize the work.

---

## Overview

A periodic intelligence layer that analyzes 30 days of pipeline data (scores, rejections, dedup, source quality, costs, operator behavior) and produces actionable recommendations with one-click "Apply" buttons. Runs daily on the existing maintenance queue. One LLM call per run (~$0.017/day).

**Pattern**: Same architecture as Daily Digest — maintenance queue job + direct LLM SDK call + new table + new UI page.

---

## Implementation Steps

### Step 1: Schema — `advisor_reports` Table + Missing Indexes

**New table: `advisor_reports`**

```
id              uuid PK
status          text          'collecting' | 'analyzing' | 'ready' | 'failed'
stats_snapshot  jsonb         Raw computed stats (useful even without LLM)
recommendations jsonb         LLM-generated structured recommendations array
summary         text          LLM-generated natural language overview (2-3 sentences)
recommendation_count  integer Number of recommendations generated
applied_count   integer       How many recommendations operator applied (starts 0)
llm_provider    text          Which LLM was used
llm_model       text          Model name
llm_tokens_in   integer
llm_tokens_out  integer
llm_cost_microdollars integer
llm_latency_ms  integer
error_message   text          null on success
triggered_by    text          'scheduled' | 'manual'
created_at      timestamp     default now()
```

**Recommendations JSONB structure:**

```typescript
type AdvisorRecommendation = {
  id: string;                    // unique per recommendation (for Apply tracking)
  category: "source" | "keyword" | "threshold" | "prompt" | "interval" | "dedup" | "cost" | "alert";
  priority: "high" | "medium" | "low";
  title: string;                 // Short headline: "Disable TechBuzz — signal collapsed"
  reason: string;                // Detailed explanation with data points
  action: {
    type: "disable_source" | "change_interval" | "add_reject_keyword" | "remove_reject_keyword"
         | "add_priority" | "remove_priority" | "change_sector_threshold"
         | "change_global_threshold" | "change_similarity_threshold" | "info_only";
    endpoint: string;            // e.g. "PATCH /sources/:id"
    params: Record<string, any>; // e.g. { sourceId: "uuid", active: false }
  } | null;                      // null for info-only observations
  applied_at: string | null;     // ISO timestamp when operator applied it
};
```

**Missing indexes to add (validated as necessary):**

```sql
-- Dedup rate queries (currently NO index on is_semantic_duplicate)
CREATE INDEX idx_articles_dedup_source ON articles (is_semantic_duplicate, source_id);

-- Cost-per-sector JOIN (llm_telemetry.article_id not indexed)
CREATE INDEX idx_llm_telemetry_article ON llm_telemetry (article_id);

-- Trend analysis date range queries (scored_at not indexed)
CREATE INDEX idx_articles_scored_at ON articles (scored_at, importance_score);
```

**Files to modify:**
- `packages/db/src/schema.ts` — add `advisorReports` table + 3 new indexes
- Generate migration via `npm run db:generate`

**Validated against code:**
- Table pattern matches `digestRuns` / `digestDrafts` (JSONB + status lifecycle)
- Index gaps confirmed by schema.ts audit — only 5 indexes exist on articles table, none on `scored_at` or `is_semantic_duplicate`
- `llm_telemetry.article_id` has no index (only `created_at`, `provider`, `operation` are indexed)

**Risk:** Migration on production with 60 days of articles. Index creation on `articles` table may take 1-5 seconds. Use `CREATE INDEX CONCURRENTLY` in migration if table is large.

---

### Step 2: Shared Constants + Types

**Add to `packages/shared/src/queues.ts`:**

```typescript
export const JOB_PIPELINE_ADVISOR = "pipeline-advisor";
```

**Add to `packages/shared/src/types.ts`:**

```typescript
// SmartHub advisor types
export type AdvisorCategory =
  | "source" | "keyword" | "threshold" | "prompt"
  | "interval" | "dedup" | "cost" | "alert";

export type AdvisorPriority = "high" | "medium" | "low";

export type AdvisorActionType =
  | "disable_source" | "change_interval"
  | "add_reject_keyword" | "remove_reject_keyword"
  | "add_priority" | "remove_priority" | "remove_ignore"
  | "change_sector_threshold" | "change_global_threshold"
  | "change_similarity_threshold" | "info_only";

export interface AdvisorAction {
  type: AdvisorActionType;
  endpoint: string;
  params: Record<string, unknown>;
}

export interface AdvisorRecommendation {
  id: string;
  category: AdvisorCategory;
  priority: AdvisorPriority;
  title: string;
  reason: string;
  action: AdvisorAction | null;
  applied_at: string | null;
}

export interface AdvisorStatsSnapshot {
  generated_at: string;
  window_days: number;
  total_articles: number;
  total_scored: number;
  total_rejected: number;
  total_duplicates: number;
  sources: SourceStats[];
  sectors: SectorStats[];
  rejection_breakdown: RejectionStats;
  score_distribution: Record<string, number>;
  score_trend: ScoreTrend;
  keyword_effectiveness: KeywordStats[];
  category_correlations: CategoryCorrelation[];
  dedup_patterns: DedupStats;
  cost_summary: CostStats;
  operator_overrides: OperatorOverrideStats;
  fetch_efficiency: FetchEfficiencyStats[];
  platform_delivery: PlatformDeliveryStats;
  alert_effectiveness: AlertEffectivenessStats[];
}
```

(Full sub-type definitions included in implementation, kept brief here.)

**Validated against code:**
- Follows existing pattern: `shared/src/types.ts` already exports `ScoringResult`, `AlertTemplateConfig`, digest types
- Queue constant follows naming: `JOB_DAILY_DIGEST`, `JOB_MAINTENANCE_CLEANUP`, etc.

**Risk:** None. Pure type additions, no runtime impact.

---

### Step 3: Stats Collector — Pure SQL Aggregation

**New file: `packages/worker/src/processors/advisor-stats.ts`**

This is the core intelligence — pure SQL queries that compute all signals. No LLM involved. The output is a `AdvisorStatsSnapshot` JSON object.

**Stats to collect (13 queries, validated feasible):**

#### 3a. Per-Source Performance (uses `idx_articles_source_published`)
```sql
SELECT source_id, importance_score, COUNT(*)
FROM articles
WHERE scored_at >= now() - interval '30 days'
  AND importance_score IS NOT NULL
GROUP BY source_id, importance_score
```
Computes: signal_ratio, avg_score, total_scored per source.

**ALSO:** 7-day vs previous 7-day trend per source (signal_ratio_current vs signal_ratio_previous). Detects quality collapse.

**Validated:** Existing `/stats/source-quality` endpoint does identical query (stats.ts:218-286). We reuse the pattern.

#### 3b. Per-Source Rejection Rate (uses `idx_articles_sector_stage`)
```sql
SELECT source_id,
  COUNT(*) FILTER (WHERE pipeline_stage = 'rejected') as rejected,
  COUNT(*) FILTER (WHERE pipeline_stage IN ('approved','posted','scored')) as not_rejected
FROM articles
WHERE created_at >= now() - interval '30 days'
GROUP BY source_id
```

**Validated:** `idx_articles_stage` covers `pipeline_stage` lookups.

#### 3c. Per-Source Dedup Rate (NEEDS new `idx_articles_dedup_source`)
```sql
SELECT source_id,
  COUNT(*) FILTER (WHERE is_semantic_duplicate = true) as duplicates,
  COUNT(*) as total
FROM articles
WHERE created_at >= now() - interval '30 days'
GROUP BY source_id
```

**Risk without index:** Full table scan on 60 days of articles (~10k-100k rows). With index: instant. **MUST add index in Step 1.**

#### 3d. Pre-Filter Keyword Hit Frequency (text parsing, acceptable for batch)
```sql
SELECT rejection_reason, COUNT(*) as hits
FROM articles
WHERE pipeline_stage = 'rejected'
  AND rejection_reason LIKE 'pre-filter:%'
  AND created_at >= now() - interval '30 days'
GROUP BY rejection_reason
```
Then parse in TypeScript: extract keyword and field from `"pre-filter: keyword 'X' matched in Y"` pattern.

**Validated:** Existing analytics endpoint does identical LIKE matching (stats.ts:326-340). Acceptable performance for daily batch.

#### 3e. Score Distribution + 7-Day Trend (uses new `idx_articles_scored_at`)
```sql
-- Current 7 days
SELECT importance_score, COUNT(*) FROM articles
WHERE scored_at >= now() - interval '7 days' GROUP BY importance_score;
-- Previous 7 days
SELECT importance_score, COUNT(*) FROM articles
WHERE scored_at BETWEEN now() - interval '14 days' AND now() - interval '7 days'
GROUP BY importance_score;
```
Detect: score inflation, deflation, threshold drift.

#### 3f. Category-to-Score Correlation (MAJOR untapped signal)
```sql
SELECT unnest(article_categories) as category, importance_score, COUNT(*)
FROM articles
WHERE scored_at >= now() - interval '30 days'
  AND article_categories IS NOT NULL
  AND importance_score IS NOT NULL
GROUP BY category, importance_score
ORDER BY category, importance_score
```
Produces: which RSS `<category>` tags correlate with high (4-5) vs low (1-2) scores.

**Validated:** `article_categories text[]` is populated in feed.ts:140-150. `unnest()` is standard PostgreSQL. No index needed for daily batch.

**Risk:** Large result set if many unique categories. Cap at top 50 categories by frequency.

#### 3g. Operator Override Detection (score-3 manual approvals)
```sql
SELECT source_id, sector_id, COUNT(*) as override_count
FROM articles
WHERE importance_score <= 3
  AND pipeline_stage IN ('approved', 'posted')
  AND approved_at IS NOT NULL
  AND created_at >= now() - interval '30 days'
GROUP BY source_id, sector_id
```
Detects: "Operator consistently approves score-3 articles from source X" → threshold may be too strict.

**Validated:** `approved_at` timestamp exists on articles table. `pipeline_stage` is indexed. No `approved_by` field, but the logic is: if `importance_score < auto_approve_threshold AND pipeline_stage = 'approved'`, it was manual.

**Caveat:** Must read current `auto_approve_threshold` from app_config to compare. If threshold is 4, then score-3 approvals are manual. If threshold is 3, they're auto. Read threshold first.

#### 3h. Feed Fetch Efficiency (uses `idx_feed_fetch_runs_source_status`)
```sql
SELECT source_id,
  COUNT(*) as total_fetches,
  COUNT(*) FILTER (WHERE status = 'success') as successes,
  COUNT(*) FILTER (WHERE item_added = 0 AND status = 'success') as empty_fetches,
  AVG(duration_ms) FILTER (WHERE status = 'success') as avg_duration_ms
FROM feed_fetch_runs
WHERE created_at >= now() - interval '14 days'   -- NOTE: 14d TTL, not 30d!
GROUP BY source_id
```

**Critical finding:** `feed_fetch_runs` TTL is 14 days (cleanup in maintenance.ts). We CANNOT do 30-day fetch analysis. **Use 14-day window for fetch stats only.** Everything else uses 30-day.

#### 3i. Duplicate Chain Analysis (which source is "original" vs "follower")
```sql
SELECT
  dup.source_id as follower_source_id,
  orig.source_id as original_source_id,
  COUNT(*) as dupe_count,
  AVG(dup.similarity_score) as avg_similarity
FROM articles dup
JOIN articles orig ON dup.duplicate_of_id = orig.id
WHERE dup.is_semantic_duplicate = true
  AND dup.created_at >= now() - interval '30 days'
GROUP BY dup.source_id, orig.source_id
ORDER BY dupe_count DESC
```

**Validated:** `duplicate_of_id` FK exists on articles table. JOIN is on primary key (indexed).

#### 3j. Cost Per Sector (NEEDS new `idx_llm_telemetry_article`)
```sql
SELECT a.sector_id, SUM(t.cost_microdollars) as total_cost,
  COUNT(DISTINCT a.id) as articles_scored,
  COUNT(DISTINCT a.id) FILTER (WHERE a.importance_score >= 4) as useful_articles
FROM llm_telemetry t
JOIN articles a ON t.article_id = a.id
WHERE t.operation = 'score_and_summarize'
  AND t.created_at >= now() - interval '30 days'
GROUP BY a.sector_id
```

**Risk without index:** `llm_telemetry` table may have 30k+ rows. JOIN without index on `article_id` = slow. **MUST add index in Step 1.**

#### 3k. Platform Delivery Stats
```sql
SELECT platform,
  COUNT(*) FILTER (WHERE status = 'posted') as success,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  COUNT(*) as total
FROM post_deliveries
WHERE created_at >= now() - interval '30 days'
GROUP BY platform
```

**Validated:** `idx_post_deliveries_status` exists. Fast query.

#### 3l. Alert Rule Effectiveness
```sql
SELECT ad.rule_id, ar.keywords, COUNT(*) as fires,
  COUNT(DISTINCT ad.matched_keyword) as unique_keywords_matched
FROM alert_deliveries ad
JOIN alert_rules ar ON ad.rule_id = ar.id
WHERE ad.sent_at >= now() - interval '30 days'
GROUP BY ad.rule_id, ar.keywords
```

**Validated:** `idx_alert_deliveries_rule` exists.

#### 3m. Stale Priority/Ignore Detection
```sql
-- For each sector's priorities, check if any articles in last 30d matched
-- This requires reading scoring_rules.score_criteria JSONB per sector
-- Then checking article titles/categories for each priority keyword
```

This is application-level logic, not pure SQL. Read scoring rules per sector, then count articles matching each priority/ignore keyword. Flag keywords with 0 matches in 30 days.

**Implementation:** TypeScript loop over sectors → per-keyword count query. ~50 keywords max across all sectors → 50 lightweight queries. Acceptable for daily batch.

---

### Step 4: LLM Advisor — Structured Prompt + JSON Output

**New file: `packages/worker/src/processors/advisor-llm.ts`**

Takes the `AdvisorStatsSnapshot` from Step 3 and feeds it to an LLM asking for structured recommendations.

**LLM Provider + Model Selection (same registry as Digest Slots):**

Operator picks provider + model in UI. Validated against the same whitelist used by digest-slots API (`packages/api/src/routes/digest-slots.ts`):

| Provider | Models | Cost/call (est.) | Notes |
|----------|--------|-----------------|-------|
| **claude** | `claude-sonnet-4-20250514` (default), `claude-opus-4-20250514`, `claude-haiku-4-5-20251001` | $0.017 / $0.017 / $0.002 | Best structured JSON output |
| **openai** | `gpt-4o`, `gpt-4o-mini`, `o3-mini` | $0.012 / $0.0005 / TBD | Good JSON, cheapest with mini |
| **deepseek** | `deepseek-chat`, `deepseek-reasoner` | $0.0004 / TBD | Extremely cheap, good enough |
| **gemini** | `gemini-2.5-flash`, `gemini-2.5-pro` | $0.0005 / $0.012 | Flash is cost-effective |

**Default:** `openai` + `gpt-4o` (matches digest defaults from `packages/shared/src/digest-defaults.ts`).
**Why not Claude default?** Advisor is a daily non-critical analysis. gpt-4o is 30% cheaper than Claude Sonnet and produces equally good structured JSON for analytics. Operator can upgrade to Claude Opus or o3-mini if they want deeper reasoning.

**API key resolution** (same as digest):
```typescript
const resolveApiKey = (provider: string, apiKeys: ApiKeys): string | null => {
  if (provider === "claude") return apiKeys.anthropic ?? null;
  if (provider === "openai") return apiKeys.openai ?? null;
  if (provider === "deepseek") return apiKeys.deepseek ?? null;
  if (provider === "gemini") return apiKeys.googleAi ?? null;
  return null;
};
```
Keys come from env vars already loaded in worker index.ts (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_AI_API_KEY`). No new env vars needed.

**Fallback behavior:** If selected provider's API key is missing or call fails → try LLM_FALLBACK_PROVIDER from env (if configured). If that also fails → report status = `failed`, stats_snapshot still saved (useful without LLM).

**LLM call pattern** (copy from digest.ts:1069-1147):
- Direct SDK instantiation (Anthropic / OpenAI / DeepSeek / Gemini — all 4 supported)
- `max_tokens: 2000`, `temperature: 0.2` (more deterministic than digest's 0.3)
- API key resolved via `resolveApiKey()` from worker deps `apiKeys` object
- Cost calculated via `calculateLLMCost(provider, model, inputTokens, outputTokens)` from `@watch-tower/llm`
- Telemetry recorded with `operation: "pipeline_advisor"`

**Provider validation on config save** (API side):
```typescript
const VALID_PROVIDERS = ["claude", "openai", "deepseek", "gemini"];
const VALID_MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-20250514"],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
};
```
Reuse the exact same constants from `digest-slots.ts`. Extract to shared if not already.

**System prompt:**

```
You are a pipeline optimization advisor for a news monitoring system.
You analyze statistical patterns from RSS ingestion, LLM scoring, and content
distribution to produce actionable recommendations.

Output valid JSON matching this schema:
{
  "summary": "2-3 sentence overview of pipeline health",
  "recommendations": [
    {
      "id": "rec_<random_8chars>",
      "category": "source|keyword|threshold|prompt|interval|dedup|cost|alert",
      "priority": "high|medium|low",
      "title": "Short headline (under 80 chars)",
      "reason": "Detailed explanation with specific numbers from the stats",
      "action": {
        "type": "<action_type>",
        "endpoint": "HTTP method + route",
        "params": { ... parameters for the API call }
      } OR null for info-only observations
    }
  ]
}

Rules:
- Maximum 15 recommendations per report
- Always include specific numbers (percentages, counts, costs) in reasons
- Only recommend actions where the data clearly supports the change
- "high" priority = immediate action needed (quality collapse, cost waste, broken source)
- "medium" = should address within a week
- "low" = nice to have optimization
- For threshold changes, always state current value and suggested value
- For keyword additions, always state which sector and why
- Never recommend removing a source that has >40% signal ratio
- Never recommend lowering auto_approve_threshold below auto_reject_threshold
```

**User prompt:** Serialized `AdvisorStatsSnapshot` as formatted text sections (not raw JSON — too verbose, wastes tokens).

```
=== PIPELINE HEALTH (last 30 days) ===
Total articles: 4,523 | Scored: 3,891 | Rejected: 1,204 | Duplicates: 632

=== SCORE DISTRIBUTION ===
Score 1: 342 (8.8%) | Score 2: 567 (14.6%) | Score 3: 1,823 (46.8%)
Score 4: 891 (22.9%) | Score 5: 268 (6.9%)
7-day trend: Score 4+ down 12% vs previous week

=== SOURCE PERFORMANCE (top issues) ===
TechBuzz: signal 12% (was 45% 2 weeks ago), 890 articles, $4.20 cost
CryptoDaily: 90% empty fetches, interval 15min, 3 articles/day actual
Reuters: 0% duplicate rate (always original), signal 67%
...

=== PRE-FILTER KEYWORDS ===
"sponsored": 23 hits/week (all would score 1-2) ✓ effective
"press release": appears in 15 score-1 articles/week, NOT in reject list
...

=== OPERATOR OVERRIDES ===
47% of score-3 articles manually approved in Crypto sector
...

=== CATEGORY PATTERNS ===
"Press Release" category: 89% score 1-2
"AI" category: 68% score 4-5
...
```

**JSON response parsing** (copy pattern from `packages/llm/src/schemas.ts:35-63`):
1. Strip markdown code fences
2. Extract JSON object via regex
3. Validate with Zod schema (`AdvisorResponseSchema`)
4. Graceful fallback: if parse fails, store raw text in `error_message`, set status `failed`

**Validated against code:**
- Scoring already does JSON extraction + Zod validation (`parseScoringResponse`)
- Digest already does direct SDK calls (exact same multi-provider switch)
- Telemetry recording follows identical pattern (digest.ts:700-740)

**Token budget estimate:**
- System prompt: ~400 tokens
- User prompt (stats): ~800-1200 tokens (formatted text is more compact than JSON)
- Output: ~1000-1500 tokens (15 recommendations × ~100 tokens each)
- **Total: ~2500-3000 tokens per call**
- **Cost: ~$0.017/call (Claude Sonnet) or ~$0.0004/call (DeepSeek)**

**Risk:** LLM may produce invalid JSON. Mitigation: Zod validation + retry once with "fix your JSON" follow-up message. If still fails, status = `failed` with raw text stored.

**Risk:** LLM may hallucinate source names or UUIDs. Mitigation: System prompt includes actual source/sector names+IDs from stats. Validate all IDs in `params` against known entities before storing.

---

### Step 5: Advisor Processor — Wire into Maintenance Queue

**Modify: `packages/worker/src/processors/maintenance.ts`**

Add the advisor as a new job handler in `createMaintenanceWorker()`, following the digest pattern exactly.

**Scheduling mechanism — two options (chose Option A):**

**Option A: app_config time-based (like digest)**
- `advisor_enabled` (boolean, default true)
- `advisor_time` (HH:MM, default "06:00")
- `advisor_timezone` (IANA, default "UTC")
- `advisor_provider` (string, default "openai" — one of: claude, openai, deepseek, gemini)
- `advisor_model` (string, default "gpt-4o" — validated against VALID_MODELS[provider])

Check in scheduler loop (runs every 30s): if current time matches `advisor_time` ± 2 minutes AND no report generated today → queue `JOB_PIPELINE_ADVISOR`.

**Why Option A over simple `repeat: { every: 86400000 }`:**
- Timezone-aware (run at 06:00 operator local time, not UTC midnight)
- Configurable via UI without worker restart
- Idempotency: check `advisor_reports.created_at` for today → skip if already ran
- Matches the proven digest scheduling pattern exactly

**Implementation in scheduler:**
```typescript
// Inside JOB_MAINTENANCE_SCHEDULE handler, after digest slot checks:
const advisorEnabled = configMap.get("advisor_enabled") !== "false";
if (advisorEnabled) {
  const advisorTime = configMap.get("advisor_time") ?? "06:00";
  const advisorTz = configMap.get("advisor_timezone") ?? "UTC";
  // Same time-check logic as digest slots (maintenance.ts:93-176)
  // Check if report already exists for today
  // If due: queue JOB_PIPELINE_ADVISOR
}
```

**Worker wiring in `packages/worker/src/index.ts`:**
- Add `JOB_PIPELINE_ADVISOR` import from shared/queues
- No new deps needed — advisor uses same `db`, `apiKeys`, `connection` already passed to maintenance worker

**Validated against code:**
- `createMaintenanceWorker` receives `{ connection, db, apiKeys, ... }` (index.ts:255-271)
- Job constants registered in self-healing loop (index.ts:603-614)
- Scheduler check pattern proven in digest slot scheduling (maintenance.ts:93-176)

**Risk:** Maintenance worker is single-concurrency. Stats collection (13 SQL queries) may take 5-30 seconds. LLM call may take 5-15 seconds. Total: ~20-45 seconds. This blocks other maintenance jobs during execution.

**Mitigation:** Acceptable. Maintenance scheduler runs every 30s. One advisor run per day taking 45s just delays one scheduler cycle. Digest already takes similar time.

---

### Step 6: API Routes — CRUD + Apply

**New file: `packages/api/src/routes/advisor.ts`**

Register as `registerAdvisorRoutes(app, deps)` in `server.ts`.

**Endpoints:**

#### `GET /advisor/latest`
Returns the most recent advisor report with status `ready`.
```json
{
  "id": "uuid",
  "status": "ready",
  "summary": "Pipeline health is good but 3 sources need attention...",
  "recommendations": [...],
  "recommendation_count": 12,
  "applied_count": 3,
  "stats_snapshot": { ... },
  "created_at": "2025-01-15T06:00:00Z"
}
```

#### `GET /advisor/history?limit=10`
Returns recent reports (for trend comparison).

#### `POST /advisor/run`
Trigger manual advisor run. Queues `JOB_PIPELINE_ADVISOR` with `triggered_by: 'manual'`.
Returns `{ queued: true }`.

#### `PATCH /advisor/reports/:id/recommendations/:recId/apply`
Mark a recommendation as applied. Sets `applied_at` timestamp in the JSONB.

**Does NOT execute the action** — frontend calls the existing config/sources/scoring-rules API directly. This endpoint just tracks that it was applied.

**Why frontend executes the action (not backend)?**
- All action endpoints already exist and are validated (Step 2 agent confirmed all 8 types)
- Frontend already has API helpers for all these endpoints
- Operator sees the exact API call being made (transparency)
- No new permission/auth concerns (uses same API_KEY)
- Apply tracking is decoupled from action execution (if API call fails, recommendation isn't marked applied)

#### `GET /advisor/config`
Returns advisor configuration from app_config.

#### `PATCH /advisor/config`
Update advisor settings. Payload:
```json
{
  "enabled": true,
  "time": "06:00",
  "timezone": "Asia/Tbilisi",
  "provider": "claude",
  "model": "claude-sonnet-4-20250514",
  "window_days": 30
}
```
**Validation:**
- `provider` must be in `VALID_PROVIDERS` (claude, openai, deepseek, gemini)
- `model` must be in `VALID_MODELS[provider]` — reject if model doesn't belong to provider
- `time` must be HH:MM format
- `timezone` must be valid IANA timezone (use `Intl.DateTimeFormat` to validate, same as digest)
- `window_days` must be 7-60 (min 7 for meaningful stats, max 60 matches article TTL)

**Validated against code:**
- Route registration follows `registerXRoutes(app, deps)` pattern (server.ts)
- All routes use `{ preHandler: deps.requireApiKey }` for auth
- JSONB field updates use Drizzle's `sql` tagged template for partial JSONB updates

**Risk:** JSONB array update (marking one recommendation as applied) requires careful SQL. Use:
```sql
UPDATE advisor_reports
SET recommendations = jsonb_set(
  recommendations,
  (SELECT CONCAT('{', idx::text, ',applied_at}')
   FROM jsonb_array_elements(recommendations) WITH ORDINALITY arr(elem, idx)
   WHERE elem->>'id' = $recId),
  to_jsonb(now()::text)
)
WHERE id = $reportId
```

Alternative (simpler): Read full recommendations array, update in TypeScript, write back. Acceptable for single-user system.

---

### Step 7: Frontend — `/advisor` Page (SmartHub)

**New file: `packages/frontend/src/pages/Advisor.tsx`**

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│  SmartHub — Pipeline Intelligence         [Run Now]  │
│  Last analysis: 2h ago · 12 recommendations          │
├─────────────────────────────────────────────────────┤
│  Summary: "Pipeline is healthy. 3 sources show       │
│  signal decay. Pre-filter saves $4.20/week. Score-3  │
│  override rate suggests lowering threshold."          │
├─────────────────────────────────────────────────────┤
│  Filter: [All] [High] [Medium] [Low]                 │
│          [Sources] [Keywords] [Thresholds] [Cost]     │
├─────────────────────────────────────────────────────┤
│  🔴 HIGH — Disable TechBuzz                          │
│  Signal ratio collapsed from 45% → 12% over 2 weeks. │
│  888 articles scored, only 106 useful. Cost: $4.20    │
│  [Apply: Disable Source]  [Dismiss]                   │
├─────────────────────────────────────────────────────┤
│  🟡 MEDIUM — Add 'press release' to Biotech rejects  │
│  15 articles/week with this phrase score 1-2.         │
│  Estimated savings: $0.30/week LLM cost.              │
│  [Apply: Add Keyword]  [Dismiss]                      │
├─────────────────────────────────────────────────────┤
│  🟢 LOW — Increase CryptoDaily interval to 60min     │
│  90% of fetches return 0 new articles. Source only    │
│  publishes ~4x/day.                                   │
│  [Apply: Change Interval]  [Dismiss]                  │
├─────────────────────────────────────────────────────┤
│  ── Settings ──                                       │
│  Schedule: [06:00]  Timezone: [Asia/Tbilisi ▾]        │
│                                                       │
│  AI Provider:  [OpenAI ▾]                             │
│  Model:        [gpt-4o ▾]                             │
│                                                       │
│  Available providers & models:                        │
│  ┌────────────┬───────────────────────────────────┐   │
│  │ Claude     │ Sonnet 4 · Opus 4 · Haiku 4.5    │   │
│  │ OpenAI     │ GPT-4o · GPT-4o Mini · o3-mini   │   │
│  │ DeepSeek   │ Chat · Reasoner                   │   │
│  │ Gemini     │ Flash · Pro                       │   │
│  └────────────┴───────────────────────────────────┘   │
│  (Model dropdown filters based on selected provider)  │
│                                                       │
│  Est. cost/run: $0.012  ·  Est. monthly: $0.36        │
│  [Enabled ✓]                                          │
└─────────────────────────────────────────────────────┘
```

**Apply button behavior:**
1. Show confirmation modal: "This will {action description}. Proceed?"
2. Call the existing API endpoint (e.g., `PATCH /sources/:id { active: false }`)
3. On success: call `PATCH /advisor/reports/:id/recommendations/:recId/apply`
4. Update card UI: show "Applied ✓" badge, gray out buttons

**API helpers — add to `packages/frontend/src/api/`:**
- `getLatestAdvisorReport()`
- `getAdvisorHistory(limit)`
- `triggerAdvisorRun()`
- `markRecommendationApplied(reportId, recId)`
- `getAdvisorConfig()` / `updateAdvisorConfig()`

**Validated against code:**
- Frontend pattern: React 19 + Tailwind + fetch API (matches all other pages)
- Navigation: Add to `Layout.tsx` sidebar + `App.tsx` route
- API key header: already handled by global fetch wrapper

---

### Step 8: Seed app_config Defaults

**Modify: `packages/db/src/seed.ts` (or seed via API)**

Add default config values:
```
advisor_enabled       = "true"
advisor_time          = "06:00"
advisor_timezone      = "UTC"
advisor_provider      = "openai"
advisor_model         = "gpt-4o"
advisor_window_days   = "30"
```

**Why `openai/gpt-4o` as default (not Claude)?**
- Advisor is non-critical daily analytics — doesn't need the best model
- gpt-4o: $0.012/call vs Claude Sonnet: $0.017/call (30% cheaper)
- Both produce equally good structured JSON for this use case
- Operator can switch to any provider/model in Settings panel at any time
- If OpenAI key is missing but Anthropic exists, worker falls back automatically

**Validated:** app_config is key-value text store. Existing pattern has 30+ keys. All read via `WHERE key IN (...)` queries. Digest slots use identical provider/model config pattern.

---

### Step 9: TTL Cleanup Integration

**Modify: `packages/worker/src/processors/maintenance.ts` (cleanup handler)**

Add cleanup for advisor_reports:
```typescript
// Delete advisor reports older than 90 days (keep 3 months of history)
const advisorTtl = parseInt(configMap.get("advisor_reports_ttl_days") ?? "90");
```

**Add to seed:** `advisor_reports_ttl_days = "90"`

**Validated:** Existing cleanup handler (maintenance.ts) already cleans 6 table types with configurable TTLs. Same pattern.

---

### Step 10: SSE Event for Real-Time Notification

**Modify: `packages/worker/src/processors/maintenance.ts` (advisor handler)**

After advisor report is generated, publish SSE event:
```typescript
eventPublisher.publish({
  type: "advisor:report_ready",
  data: { reportId, recommendationCount, highPriorityCount }
});
```

**Frontend:** Layout.tsx SSE handler shows toast notification: "SmartHub: 12 new recommendations (3 high priority)"

**Validated:** SSE publisher already used for article scoring, posting events. Same `eventPublisher.publish()` pattern.

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| LLM returns invalid JSON | Medium | Low | Zod validation + retry once + fallback to `failed` status |
| LLM hallucinates source IDs | Low | Medium | Validate all IDs against DB before storing |
| Stats queries slow on large DB | Low | Low | New indexes (Step 1) + daily batch is acceptable |
| Maintenance worker blocked during advisor run | Medium | Low | 45s max, delays one scheduler cycle |
| feed_fetch_runs only 14d data | Confirmed | Low | Use 14d window for fetch stats, document limitation |
| Operator applies bad recommendation | Low | Medium | Confirmation modal + all actions are reversible |
| Token budget exceeds limit | Very Low | Low | Stats are formatted text (~1200 tokens), well under limits |

## What This Intentionally Does NOT Do

- **No auto-apply** — always human-in-the-loop
- **No ML models** — pure SQL stats + LLM reasoning (same tools we already use)
- **No new infrastructure** — runs on existing maintenance queue, existing Redis, existing LLM providers
- **No real-time analysis** — daily batch is the right cadence for strategic recommendations
- **No per-article recommendations** — operates at source/sector/config level only
- **No score_reasoning text mining** — deferred to v2 (would require embedding reasoning text, significant complexity)

## Deferred to v2 (After Proving Value)

1. **Score reasoning text analysis**: Embed `score_reasoning` text, cluster by theme, detect LLM reasoning patterns. Requires separate embedding pipeline.
2. **Automated A/B testing**: Apply recommendation to subset of sources, measure impact, auto-rollback if signal degrades.
3. **Trend alerts**: Real-time detection of signal ratio collapse (not just daily batch).
4. **Cross-instance learning**: If multi-tenant, share anonymized patterns across clients.
5. **Prompt rewriting**: LLM generates improved scoring prompts based on approval/rejection patterns. High risk, needs careful validation.

## Implementation Order

| Step | Effort | Dependencies | Can Parallelize |
|------|--------|-------------|-----------------|
| 1. Schema + indexes | Small | None | ✓ |
| 2. Shared types | Small | None | ✓ with Step 1 |
| 3. Stats collector | Large | Step 1 (indexes) | ✓ with Step 2 |
| 4. LLM advisor | Medium | Step 2 (types) | ✓ with Step 3 |
| 5. Worker wiring | Medium | Steps 3, 4 | — |
| 6. API routes | Medium | Step 1 (table) | ✓ with Steps 3-5 |
| 7. Frontend page | Large | Step 6 | — |
| 8. Seed config | Small | Step 1 | ✓ with anything |
| 9. TTL cleanup | Small | Step 1 | ✓ with anything |
| 10. SSE events | Small | Step 5 | — |

**Critical path:** Step 1 → Step 3 → Step 5 → Step 7
**Total estimate:** One focused implementation cycle.
