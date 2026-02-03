# Task 7: Scoring Rules UI

## Overview

Add a dashboard UI for non-technical users to configure per-sector scoring and summarization rules without editing SQL or understanding prompt engineering.

## Architecture Decision: "Compile on Read" with Fallback

**Why this approach (vs alternatives):**

| Approach | Pros | Cons |
|----------|------|------|
| **Compile on Save** (Gemini) | No worker changes | Two sources of truth, sync risk |
| **Raw prompt editing** (Codex) | Simple | Users can break prompts |
| **Compile on Read** (chosen) | Single source of truth, graceful migration | Tiny runtime cost (~0.01ms) |

**Architecture:**

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Frontend UI   │      │    API Layer    │      │     Worker      │
│                 │      │                 │      │                 │
│ • Form fields   │ ───→ │ • Validate JSON │      │ • Read config   │
│ • Live preview  │      │ • Save config   │ ───→ │ • Build prompt  │
│ • Save button   │      │   ONLY          │      │ • Score article │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │       Database        │
                    │ ┌───────────────────┐ │
                    │ │ score_criteria    │ │ ← Structured JSON (authoritative)
                    │ │ prompt_template   │ │ ← Legacy fallback (read-only)
                    │ └───────────────────┘ │
                    └───────────────────────┘
```

**Worker logic:**
1. If `score_criteria` has data → build prompt from structured config
2. Else if `prompt_template` exists → use legacy text (backward compat)
3. Else → use default config

**Benefits:**
- Single source of truth (no sync issues)
- Graceful migration (existing data works unchanged)
- Prompt format changes = code change only (no DB migration)
- Performance cost negligible (0.01ms vs 1000ms LLM call)

---

## Phase 1: Shared Schema & Prompt Builder

### 1.1 Create Zod Schema for Scoring Config

**File:** `packages/shared/src/schemas/scoring-config.ts`

```typescript
import { z } from "zod";

export const scoringConfigSchema = z.object({
  // Scoring guidance
  priorities: z.array(z.string().min(1).max(100)).max(20).default([]),
  ignore: z.array(z.string().min(1).max(100)).max(20).default([]),

  // Score definitions (what each level means)
  score1: z
    .string()
    .max(500)
    .default("Not newsworthy (press releases, minor updates, promotional content)"),
  score2: z.string().max(500).default("Low importance (routine news, minor developments)"),
  score3: z.string().max(500).default("Moderate importance (notable but not urgent)"),
  score4: z.string().max(500).default("High importance (significant developments, major launches)"),
  score5: z
    .string()
    .max(500)
    .default("Critical importance (industry-changing news, major breaking stories)"),

  // Summary settings
  summaryMaxChars: z.number().int().min(50).max(500).default(200),
  summaryTone: z.enum(["professional", "casual", "urgent"]).default("professional"),
  summaryLanguage: z.string().min(1).max(50).default("English"),
  summaryStyle: z
    .string()
    .max(300)
    .default("Start with the key fact. Include company or person name when relevant."),
});

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

// Default config for new sectors or when no config exists
export const defaultScoringConfig: ScoringConfig = scoringConfigSchema.parse({});
```

### 1.2 Create Prompt Builder Utility

**File:** `packages/shared/src/prompt-builder.ts`

```typescript
import type { ScoringConfig } from "./schemas/scoring-config.js";

/**
 * Builds a complete scoring prompt from structured configuration.
 * Called by the worker at runtime (cost: ~0.01ms, negligible vs LLM call).
 */
export function buildScoringPrompt(config: ScoringConfig, sectorName: string): string {
  const prioritiesSection =
    config.priorities.length > 0
      ? `\nPRIORITIZE articles about: ${config.priorities.join(", ")}`
      : "";

  const ignoreSection =
    config.ignore.length > 0
      ? `\nDE-PRIORITIZE articles about: ${config.ignore.join(", ")}`
      : "";

  return `You are a ${sectorName} news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise summary (max ${config.summaryMaxChars} characters)
${prioritiesSection}${ignoreSection}

SCORING CRITERIA:
1 = ${config.score1}
2 = ${config.score2}
3 = ${config.score3}
4 = ${config.score4}
5 = ${config.score5}

SUMMARY REQUIREMENTS:
- Maximum ${config.summaryMaxChars} characters
- Tone: ${config.summaryTone}
- Language: ${config.summaryLanguage}
- Style: ${config.summaryStyle}

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": N, "summary": "...", "reasoning": "..."}`;
}
```

### 1.3 Export from Shared Package

**File:** `packages/shared/src/index.ts`

Add these exports:

```typescript
// Scoring config schema and utilities
export {
  scoringConfigSchema,
  defaultScoringConfig,
  type ScoringConfig,
} from "./schemas/scoring-config.js";
export { buildScoringPrompt } from "./prompt-builder.js";
```

### 1.4 Implementation Checklist

- [ ] Create `packages/shared/src/schemas/scoring-config.ts`
- [ ] Create `packages/shared/src/prompt-builder.ts`
- [ ] Add exports to `packages/shared/src/index.ts`
- [ ] Run `npm run build` in shared package
- [ ] Verify no TypeScript errors

---

## Phase 2: Worker Integration

### 2.1 Modify LLM Brain Processor

**File:** `packages/worker/src/processors/llm-brain.ts`

**Changes needed:**

1. Import new utilities:
```typescript
import {
  // ... existing imports
  buildScoringPrompt,
  defaultScoringConfig,
  type ScoringConfig,
} from "@watch-tower/shared";
```

2. Update `SectorRule` type to include config:
```typescript
type SectorRule = {
  promptTemplate: string | null;
  config: ScoringConfig | null;  // ADD THIS
  autoApprove: number;
  autoReject: number;
};
```

3. Update the SQL query fetching rules (~line 118) to also fetch `score_criteria`:
```typescript
const rulesResult = await db.execute(sql`
  SELECT
    sector_id as "sectorId",
    prompt_template as "promptTemplate",
    score_criteria as "config",           -- ADD THIS
    auto_approve_threshold as "autoApprove",
    auto_reject_threshold as "autoReject"
  FROM scoring_rules
  WHERE sector_id = ANY(${sectorIdsLiteral}::uuid[])
`);
```

4. Add helper function to resolve prompt (after the sectorRules Map population):
```typescript
/**
 * Resolves the scoring prompt for an article.
 * Priority: structured config > legacy prompt_template > default config
 */
const resolvePrompt = (sectorId: string | null, sectorName: string | null): string | undefined => {
  if (!sectorId) return undefined;

  const rules = sectorRules.get(sectorId);
  if (!rules) return undefined;

  // Priority 1: Structured config (new system)
  if (rules.config && Object.keys(rules.config).length > 0) {
    return buildScoringPrompt(rules.config as ScoringConfig, sectorName ?? "General");
  }

  // Priority 2: Legacy prompt_template (backward compat)
  if (rules.promptTemplate) {
    return rules.promptTemplate;
  }

  // Priority 3: Default config
  return buildScoringPrompt(defaultScoringConfig, sectorName ?? "General");
};
```

5. Update the scoring request building (~line 151) to use the resolver:
```typescript
const requests: ScoringRequest[] = articles.map((a) => {
  const rules = a.sectorId ? sectorRules.get(a.sectorId) : undefined;
  return {
    articleId: a.id,
    title: a.title,
    contentSnippet: a.contentSnippet,
    sectorName: a.sectorName ?? undefined,
    promptTemplate: resolvePrompt(a.sectorId, a.sectorName),  // USE RESOLVER
  };
});
```

### 2.2 Implementation Checklist

- [ ] Add imports for new shared utilities
- [ ] Update `SectorRule` type
- [ ] Update SQL query to fetch `score_criteria`
- [ ] Add `resolvePrompt` helper function
- [ ] Update request building to use resolver
- [ ] Test with existing data (should use legacy prompt_template)
- [ ] Test with empty score_criteria (should use legacy prompt_template)
- [ ] Run `npm run build` to verify

---

## Phase 3: API Endpoints

### 3.1 Create Scoring Rules Routes

**File:** `packages/api/src/routes/scoring-rules.ts`

```typescript
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { scoringRules, sectors } from "@watch-tower/db";
import {
  scoringConfigSchema,
  defaultScoringConfig,
  buildScoringPrompt,
  type ScoringConfig,
} from "@watch-tower/shared";

type Deps = { db: Database };

export function registerScoringRulesRoutes(app: FastifyInstance, { db }: Deps) {
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /scoring-rules - List all rules with sector info
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/scoring-rules", async () => {
    const rows = await db
      .select({
        id: scoringRules.id,
        sectorId: scoringRules.sectorId,
        sectorName: sectors.name,
        sectorSlug: sectors.slug,
        config: scoringRules.scoreCriteria,
        promptTemplate: scoringRules.promptTemplate,
        autoApproveThreshold: scoringRules.autoApproveThreshold,
        autoRejectThreshold: scoringRules.autoRejectThreshold,
        updatedAt: scoringRules.updatedAt,
      })
      .from(scoringRules)
      .innerJoin(sectors, eq(scoringRules.sectorId, sectors.id));

    return rows.map((r) => {
      // Determine if using structured config or legacy prompt
      const hasStructuredConfig = r.config && Object.keys(r.config as object).length > 0;

      return {
        id: r.id,
        sector_id: r.sectorId,
        sector_name: r.sectorName,
        sector_slug: r.sectorSlug,
        config: hasStructuredConfig ? r.config : defaultScoringConfig,
        is_legacy: !hasStructuredConfig && !!r.promptTemplate,
        auto_approve_threshold: r.autoApproveThreshold,
        auto_reject_threshold: r.autoRejectThreshold,
        updated_at: r.updatedAt,
      };
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /scoring-rules/:sectorId - Get single rule with preview
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { sectorId: string } }>(
    "/scoring-rules/:sectorId",
    async (req, reply) => {
      const { sectorId } = req.params;

      // Get sector info
      const [sector] = await db
        .select({ id: sectors.id, name: sectors.name })
        .from(sectors)
        .where(eq(sectors.id, sectorId));

      if (!sector) {
        return reply.status(404).send({ error: "Sector not found" });
      }

      // Get rule if exists
      const [rule] = await db
        .select()
        .from(scoringRules)
        .where(eq(scoringRules.sectorId, sectorId));

      const hasStructuredConfig = rule?.scoreCriteria &&
        Object.keys(rule.scoreCriteria as object).length > 0;

      const config = hasStructuredConfig
        ? (rule.scoreCriteria as ScoringConfig)
        : defaultScoringConfig;

      // Generate preview of what prompt the worker will use
      const promptPreview = buildScoringPrompt(config, sector.name);

      return {
        sector_id: sectorId,
        sector_name: sector.name,
        config,
        is_legacy: !hasStructuredConfig && !!rule?.promptTemplate,
        legacy_prompt: rule?.promptTemplate ?? null,
        auto_approve_threshold: rule?.autoApproveThreshold ?? 5,
        auto_reject_threshold: rule?.autoRejectThreshold ?? 2,
        prompt_preview: promptPreview,
        updated_at: rule?.updatedAt ?? null,
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /scoring-rules/:sectorId - Save structured config
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { sectorId: string };
    Body: {
      config: unknown;
      auto_approve_threshold?: number;
      auto_reject_threshold?: number;
    };
  }>("/scoring-rules/:sectorId", async (req, reply) => {
    const { sectorId } = req.params;
    const {
      config,
      auto_approve_threshold = 5,
      auto_reject_threshold = 2,
    } = req.body;

    // Validate config against schema
    const parsed = scoringConfigSchema.safeParse(config);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid configuration",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Validate thresholds
    if (
      !Number.isInteger(auto_approve_threshold) ||
      auto_approve_threshold < 1 ||
      auto_approve_threshold > 5
    ) {
      return reply.status(400).send({
        error: "auto_approve_threshold must be integer 1-5",
      });
    }
    if (
      !Number.isInteger(auto_reject_threshold) ||
      auto_reject_threshold < 1 ||
      auto_reject_threshold > 5
    ) {
      return reply.status(400).send({
        error: "auto_reject_threshold must be integer 1-5",
      });
    }
    if (auto_reject_threshold >= auto_approve_threshold) {
      return reply.status(400).send({
        error: "auto_reject_threshold must be less than auto_approve_threshold",
      });
    }

    // Verify sector exists
    const [sector] = await db
      .select({ id: sectors.id, name: sectors.name })
      .from(sectors)
      .where(eq(sectors.id, sectorId));

    if (!sector) {
      return reply.status(404).send({ error: "Sector not found" });
    }

    // Upsert rule (only saves structured config, not prompt_template)
    await db
      .insert(scoringRules)
      .values({
        sectorId,
        scoreCriteria: parsed.data,
        promptTemplate: "", // Empty - worker will build from config
        autoApproveThreshold: auto_approve_threshold,
        autoRejectThreshold: auto_reject_threshold,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: scoringRules.sectorId,
        set: {
          scoreCriteria: parsed.data,
          autoApproveThreshold: auto_approve_threshold,
          autoRejectThreshold: auto_reject_threshold,
          updatedAt: new Date(),
        },
      });

    // Return preview of compiled prompt
    const promptPreview = buildScoringPrompt(parsed.data, sector.name);

    return {
      success: true,
      prompt_preview: promptPreview,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /scoring-rules/:sectorId - Remove custom rule (use defaults)
  // ─────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { sectorId: string } }>(
    "/scoring-rules/:sectorId",
    async (req) => {
      const { sectorId } = req.params;
      await db.delete(scoringRules).where(eq(scoringRules.sectorId, sectorId));
      return { success: true, message: "Rule deleted, sector will use default settings" };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /scoring-rules/preview - Preview prompt without saving
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Body: { config: unknown; sector_name: string };
  }>("/scoring-rules/preview", async (req, reply) => {
    const { config, sector_name } = req.body;

    if (!sector_name || typeof sector_name !== "string") {
      return reply.status(400).send({ error: "sector_name is required" });
    }

    const parsed = scoringConfigSchema.safeParse(config);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid configuration",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const prompt = buildScoringPrompt(parsed.data, sector_name);
    return { prompt };
  });
}
```

### 3.2 Register Routes in Server

**File:** `packages/api/src/server.ts`

Add import:
```typescript
import { registerScoringRulesRoutes } from "./routes/scoring-rules.js";
```

Add registration (after other route registrations):
```typescript
registerScoringRulesRoutes(app, { db });
```

### 3.3 Implementation Checklist

- [ ] Create `packages/api/src/routes/scoring-rules.ts`
- [ ] Add import to `packages/api/src/server.ts`
- [ ] Add route registration call
- [ ] Run `npm run build` in api package
- [ ] Test endpoints with curl/Postman:
  - [ ] `GET /scoring-rules` returns list
  - [ ] `GET /scoring-rules/:sectorId` returns single rule with preview
  - [ ] `PUT /scoring-rules/:sectorId` saves and returns preview
  - [ ] `DELETE /scoring-rules/:sectorId` removes rule
  - [ ] `POST /scoring-rules/preview` returns compiled prompt

---

## Phase 4: Frontend UI

### 4.1 Add API Client Functions

**File:** `packages/frontend/src/api.ts`

Add types and functions:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Scoring Rules
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoringConfig {
  priorities: string[];
  ignore: string[];
  score1: string;
  score2: string;
  score3: string;
  score4: string;
  score5: string;
  summaryMaxChars: number;
  summaryTone: "professional" | "casual" | "urgent";
  summaryLanguage: string;
  summaryStyle: string;
}

export interface ScoringRule {
  id?: string;
  sector_id: string;
  sector_name: string;
  sector_slug?: string;
  config: ScoringConfig;
  is_legacy: boolean;
  auto_approve_threshold: number;
  auto_reject_threshold: number;
  prompt_preview?: string;
  updated_at: string | null;
}

export async function listScoringRules(): Promise<ScoringRule[]> {
  const res = await fetch(`${API_URL}/scoring-rules`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch scoring rules");
  return res.json();
}

export async function getScoringRule(sectorId: string): Promise<ScoringRule> {
  const res = await fetch(`${API_URL}/scoring-rules/${sectorId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch scoring rule");
  return res.json();
}

export async function saveScoringRule(
  sectorId: string,
  config: ScoringConfig,
  autoApprove: number,
  autoReject: number
): Promise<{ success: boolean; prompt_preview: string }> {
  const res = await fetch(`${API_URL}/scoring-rules/${sectorId}`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      config,
      auto_approve_threshold: autoApprove,
      auto_reject_threshold: autoReject,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to save scoring rule");
  }
  return res.json();
}

export async function deleteScoringRule(sectorId: string): Promise<void> {
  const res = await fetch(`${API_URL}/scoring-rules/${sectorId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to delete scoring rule");
}

export async function previewScoringPrompt(
  config: ScoringConfig,
  sectorName: string
): Promise<{ prompt: string }> {
  const res = await fetch(`${API_URL}/scoring-rules/preview`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ config, sector_name: sectorName }),
  });
  if (!res.ok) throw new Error("Failed to preview prompt");
  return res.json();
}
```

### 4.2 Create Scoring Rules Page

**File:** `packages/frontend/src/pages/ScoringRules.tsx`

Page structure:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Scoring Rules                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Sector: [Technology ▼]                              [Reset to Defaults]    │
│                                                                             │
│  ┌─────────────────────────────────────┬───────────────────────────────────┐│
│  │ SCORING SETTINGS                    │ PROMPT PREVIEW                    ││
│  │                                     │                                   ││
│  │ Topics to Prioritize                │ ┌───────────────────────────────┐ ││
│  │ ┌─────────────────────────────────┐ │ │ You are a Technology news    │ ││
│  │ │ [AI breakthroughs] [security ×] │ │ │ analyst...                   │ ││
│  │ │ [+ Add topic]                   │ │ │                               │ ││
│  │ └─────────────────────────────────┘ │ │ PRIORITIZE: AI breakthroughs │ ││
│  │                                     │ │                               │ ││
│  │ Topics to Ignore                    │ │ SCORING CRITERIA:             │ ││
│  │ ┌─────────────────────────────────┐ │ │ 1 = Not newsworthy...        │ ││
│  │ │ [press releases] [promos ×]    │ │ │ 2 = Low importance...        │ ││
│  │ │ [+ Add topic]                   │ │ │ ...                           │ ││
│  │ └─────────────────────────────────┘ │ │                               │ ││
│  │                                     │ │ SUMMARY REQUIREMENTS:         │ ││
│  │ Score Definitions                   │ │ - Max 200 characters          │ ││
│  │ ★☆☆☆☆ [Not newsworthy, press... ] │ │ - Tone: professional          │ ││
│  │ ★★☆☆☆ [Low importance, routine...] │ │ ...                           │ ││
│  │ ★★★☆☆ [Moderate importance...    ] │ │                               │ ││
│  │ ★★★★☆ [High importance, major... ] │ └───────────────────────────────┘ ││
│  │ ★★★★★ [Critical, industry-chang...] │                                   ││
│  │                                     │                                   ││
│  │ Summary Settings                    │                                   ││
│  │ Max Length:  [====●=====] 200 chars │                                   ││
│  │ Tone:        [Professional ▼]       │                                   ││
│  │ Language:    [English        ]      │                                   ││
│  │ Style:       [Start with key fact...]│                                   ││
│  │                                     │                                   ││
│  │ Thresholds                          │                                   ││
│  │ Auto-approve: [5 ▼]  Auto-reject: [2 ▼]                                ││
│  │                                     │                                   ││
│  └─────────────────────────────────────┴───────────────────────────────────┘│
│                                                                             │
│                                          [Cancel] [Save Changes]            │
│                                                                             │
│  ⚠️ This sector is using a legacy prompt. Saving will migrate to the new   │
│     structured format.                                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key components to build:**

1. **Sector selector dropdown** - Load sectors, show which have custom rules
2. **Tag input component** - For priorities and ignore lists (reusable)
3. **Score definition inputs** - 5 text areas with star indicators
4. **Summary settings section** - Slider, dropdown, text inputs
5. **Threshold dropdowns** - 1-5 selectors with validation
6. **Live preview panel** - Updates as user types (debounced)
7. **Save/Reset buttons** - With loading states
8. **Legacy warning banner** - Shows when migrating from old format

### 4.3 Add Navigation Link

**File:** `packages/frontend/src/components/Layout.tsx`

Add to navigation items:

```typescript
{ to: "/scoring-rules", label: "Scoring Rules", icon: SlidersHorizontalIcon }
```

### 4.4 Add Route

**File:** `packages/frontend/src/App.tsx`

Add import and route:

```typescript
import ScoringRules from "./pages/ScoringRules";

// In Routes:
<Route path="/scoring-rules" element={<ScoringRules />} />
```

### 4.5 Implementation Checklist

- [ ] Add types and API functions to `packages/frontend/src/api.ts`
- [ ] Create `packages/frontend/src/pages/ScoringRules.tsx`
- [ ] Create reusable `TagInput` component if not exists
- [ ] Add navigation link in `Layout.tsx`
- [ ] Add route in `App.tsx`
- [ ] Test UI functionality:
  - [ ] Sector switching loads correct config
  - [ ] Form fields update preview in real-time
  - [ ] Save shows success toast
  - [ ] Reset to defaults works
  - [ ] Validation errors display properly
  - [ ] Legacy warning shows for old-format rules

---

## Phase 5: Testing & Polish

### 5.1 End-to-End Testing

- [ ] Create new rule for sector without existing rule
- [ ] Edit existing structured rule
- [ ] Edit sector with legacy prompt (should migrate)
- [ ] Delete rule and verify defaults are used
- [ ] Verify worker uses new config after save:
  1. Save a rule with distinctive priorities
  2. Trigger article scoring
  3. Check LLM telemetry or logs for new prompt

### 5.2 Edge Cases

- [ ] Sector with no rule at all (uses global defaults)
- [ ] Empty priorities/ignore arrays (should work)
- [ ] Very long score definitions (test 500 char limit)
- [ ] Special characters in text fields (quotes, newlines)
- [ ] Concurrent edits (last save wins)

### 5.3 UX Polish (Optional Enhancements)

- [ ] **Unsaved changes warning** - Prompt before leaving page
- [ ] **Presets dropdown** - "Strict Analyst", "Casual Blogger", etc.
- [ ] **Copy to other sectors** - Duplicate config to multiple sectors
- [ ] **Test Drive** - Paste article URL, see score/summary preview
- [ ] **Diff view** - Show what changed before saving
- [ ] **History** - View previous versions (requires new table)

---

## Files Summary

| Action | Package | File |
|--------|---------|------|
| Create | shared | `src/schemas/scoring-config.ts` |
| Create | shared | `src/prompt-builder.ts` |
| Modify | shared | `src/index.ts` |
| Create | api | `src/routes/scoring-rules.ts` |
| Modify | api | `src/server.ts` |
| Modify | worker | `src/processors/llm-brain.ts` |
| Modify | frontend | `src/api.ts` |
| Create | frontend | `src/pages/ScoringRules.tsx` |
| Modify | frontend | `src/components/Layout.tsx` |
| Modify | frontend | `src/App.tsx` |

## Dependencies

- No new npm packages required
- Uses existing: Zod (shared), Drizzle (db), Fastify (api), React + Tailwind (frontend)

## Migration Notes

- **No database migration needed** - Uses existing `score_criteria` JSONB column
- **Backward compatible** - Existing `prompt_template` values continue to work
- **Gradual adoption** - Sectors migrate when user saves via new UI
- **Rollback safe** - If issues, worker falls back to `prompt_template`
