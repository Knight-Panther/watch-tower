# Task 200 — LLM Brain Scoring Module: Production-Grade Upgrade

## Objective

Upgrade the scoring prompt, provider configuration, and response handling to achieve
more precise, consistent, and production-ready article scoring across all three LLM
providers (DeepSeek, OpenAI, Claude).

---

## Impact Surface Map

Every change in this task touches files across the monorepo. This map must be
consulted before implementing each fix to avoid logical breaks.

```
packages/
├── shared/src/
│   ├── prompt-builder.ts          ← MODIFY (rewrite prompt assembly)
│   ├── schemas/scoring-config.ts  ← MODIFY (add new config fields)
│   └── index.ts                   ← CHECK (re-exports, no change expected)
│
├── llm/src/
│   ├── prompts.ts                 ← MODIFY (unify with prompt-builder, add system prompt)
│   ├── schemas.ts                 ← MODIFY (tighten summary limit, add validation)
│   ├── claude.ts                  ← MODIFY (system/user split, temperature, max_tokens)
│   ├── openai.ts                  ← MODIFY (system/user split, temperature, max_tokens)
│   ├── deepseek.ts                ← CHECK (inherits from openai.ts — verify changes propagate)
│   ├── types.ts                   ← MODIFY (add systemPrompt to ScoringRequest)
│   ├── provider.ts                ← CHECK (interface may need systemPrompt)
│   ├── fallback.ts                ← CHECK (passes through to provider.score())
│   ├── pricing.ts                 ← NO CHANGE
│   └── index.ts                   ← CHECK (re-exports)
│
├── worker/src/
│   ├── processors/llm-brain.ts    ← MODIFY (pass system prompt, use new resolvePrompt)
│   ├── processors/maintenance.ts  ← NO CHANGE (reads scores, doesn't produce them)
│   ├── processors/distribution.ts ← NO CHANGE (reads llm_summary, doesn't produce it)
│   ├── index.ts                   ← NO CHANGE (deps passthrough)
│   └── job-registry.ts            ← NO CHANGE
│
├── api/src/routes/
│   ├── scoring-rules.ts           ← MODIFY (new config fields in validation + preview)
│   ├── articles.ts                ← NO CHANGE (reads score/summary, no format change)
│   └── config.ts                  ← NO CHANGE
│
├── db/src/
│   ├── schema.ts                  ← NO CHANGE (score remains smallint 1-5, summary remains text)
│   └── seed.sql                   ← OPTIONAL (update legacy prompts to structured config)
│
├── frontend/src/
│   ├── api.ts                     ← MODIFY (ScoringConfig type gets new fields)
│   ├── pages/ScoringRules.tsx     ← MODIFY (new config fields in editor form)
│   ├── pages/Articles.tsx         ← NO CHANGE (score display unchanged)
│   └── hooks/useServerEvents.ts   ← NO CHANGE (event shapes unchanged)
```

### What Does NOT Change (Safety Guarantees)

- Score range stays **1-5** (smallint in DB, Zod 1-5 in schema)
- `pipeline_stage` values unchanged: `embedded → scoring → scored/approved/rejected/scoring_failed`
- SSE event shapes unchanged: `article:scored`, `article:approved`, `article:rejected`
- Threshold logic unchanged (sector > global DB > env, 0 = OFF)
- `post_deliveries` flow unchanged
- Telemetry format unchanged (`score_and_summarize` operation, same cost calc)
- Fallback provider mechanism unchanged

---

## Fixes & Upgrades (Implementation Order)

### Fix 1 — System/User Message Split
**Priority: CRITICAL | Risk: MEDIUM**

**Problem:** All three providers receive everything in a single `user` message — role
definition, scoring rubric, few-shot examples, AND the article. LLMs perform
significantly better when stable instructions go in `system` and variable content
goes in `user`. This also enables prompt caching (Claude caches system prompts
across calls, reducing latency and cost on batches).

**What changes:**

The `LLMProvider.score()` method currently receives `ScoringRequest.promptTemplate`
which is a single merged string. We need to split this into two parts:
- `systemPrompt` — role, rubric, output format, examples (stable per-sector)
- `userMessage` — article title + content + sector (changes per article)

**File-by-file changes:**

1. **`packages/llm/src/types.ts`** — Add `systemPrompt?: string` to `ScoringRequest`

   ```typescript
   export type ScoringRequest = {
     articleId: string;
     title: string;
     contentSnippet: string | null;
     sectorName?: string;
     promptTemplate?: string;   // KEEP for backward compat (legacy prompts)
     systemPrompt?: string;     // NEW — stable instructions
   };
   ```

   **Trace:** `ScoringRequest` is used in:
   - `claude.ts` → score() method — will use systemPrompt
   - `openai.ts` → score() method — will use systemPrompt
   - `deepseek.ts` → inherits from openai.ts — automatically gets it
   - `fallback.ts` → passes request through — no change needed
   - `worker/processors/llm-brain.ts` → builds requests — must populate systemPrompt

2. **`packages/llm/src/prompts.ts`** — Add new functions:
   - `buildSystemPrompt(rubric, examples, outputFormat)` → returns system message
   - `buildUserMessage(title, content, sector)` → returns user message
   - KEEP `formatScoringPrompt()` and `SCORING_WITH_SUMMARY_PROMPT` for legacy compat
     but mark as `@deprecated`
   - KEEP `MAX_CONTENT_LENGTH = 10000` (used by user message builder)

   **Trace:** `formatScoringPrompt` is imported by `claude.ts` and `openai.ts`.
   Both will switch to the new functions. Legacy path preserved for old
   `promptTemplate` strings (backward compat with existing scoring_rules rows).

3. **`packages/llm/src/claude.ts`** — Modify `score()`:
   ```typescript
   // BEFORE: single user message
   messages: [{ role: "user", content: prompt }]

   // AFTER: system + user split
   system: request.systemPrompt ?? undefined,
   messages: [{ role: "user", content: userMessage }]
   ```
   If `request.systemPrompt` is undefined (legacy path), fall back to current
   single-message behavior.

   **Trace:** Anthropic SDK `messages.create()` accepts `system` parameter natively.
   No SDK changes needed. Prompt caching is automatic for repeated system prompts.

4. **`packages/llm/src/openai.ts`** — Modify `score()`:
   ```typescript
   // BEFORE: single user message
   messages: [{ role: "user", content: prompt }]

   // AFTER: system + user
   messages: [
     ...(request.systemPrompt ? [{ role: "system" as const, content: request.systemPrompt }] : []),
     { role: "user", content: userMessage }
   ]
   ```

   **Trace:** OpenAI chat completions API supports `system` role natively.
   DeepSeek uses OpenAI-compatible API — system role works identically.
   `deepseek.ts` inherits from `OpenAILLMProvider` — gets this for free.

5. **`packages/shared/src/prompt-builder.ts`** — Split `buildScoringPrompt()` into:
   - `buildScoringSystemPrompt(config, sectorName)` → rubric + format + examples
   - `buildScoringUserMessage(title, content, sector)` → article data only
   - KEEP `buildScoringPrompt()` as a wrapper that concatenates both (backward compat
     for API preview endpoint + legacy path)

   **Trace:** `buildScoringPrompt` is imported by:
   - `worker/processors/llm-brain.ts` → will switch to split functions
   - `api/routes/scoring-rules.ts` → preview endpoint will show combined (no change)

6. **`packages/worker/src/processors/llm-brain.ts`** — Update `resolvePrompt()` to
   return `{ systemPrompt, userMessage }` instead of a single string. Update request
   building to populate both fields.

   **Trace:** Only internal to worker. No downstream impact.

**Hidden gem:** The `resolvePrompt()` function currently has three priority levels
(structured config > legacy promptTemplate > default). After this change:
- Structured config → split into system + user (new path)
- Legacy promptTemplate → stays as single merged string in `promptTemplate` field (old path)
- Default → split into system + user (new path)

Providers must handle BOTH: if `systemPrompt` exists use split, else use
`promptTemplate` as single user message. This prevents breaking existing
scoring_rules rows that have legacy prompt_template strings.

---

### Fix 2 — Temperature Control
**Priority: CRITICAL | Risk: LOW**

**Problem:** No temperature parameter set. Defaults are 1.0 (Claude) and 1.0 (OpenAI/DeepSeek).
For classification tasks, lower temperature (0.1–0.3) produces dramatically more
consistent scores. Same article scored twice at temp=1.0 can give score 3 then score 4.

**What changes:**

1. **`packages/llm/src/claude.ts`** — Add `temperature: 0.2` to `messages.create()`

2. **`packages/llm/src/openai.ts`** — Add `temperature: 0.2` to `chat.completions.create()`

3. **`packages/llm/src/deepseek.ts`** — Inherits from openai.ts. Verify it propagates.

**Trace:** Temperature is a provider API parameter only. No downstream impact on
parsing, storage, or display. Zero risk of breaking anything.

**Design decision:** Hardcode 0.2 rather than making it configurable. Scoring is a
classification task — there is no legitimate reason to want high temperature here.
Adding it to ScoringConfig would be over-engineering and confuse users.

---

### Fix 3 — Increase max_tokens from 256 to 512
**Priority: HIGH | Risk: LOW**

**Problem:** At 256 max_tokens, if the model writes detailed reasoning (which we
WANT for chain-of-thought), the output gets truncated mid-JSON → parse failure →
fallback score 3. This silently degrades scoring quality.

**What changes:**

1. **`packages/llm/src/claude.ts`** — Change `max_tokens: 256` → `max_tokens: 512`
2. **`packages/llm/src/openai.ts`** — Change `max_tokens: 256` → `max_tokens: 512`

**Trace:**
- Cost impact: ~2x on output tokens per call. But scoring calls are small
  (input ~2-3k tokens, output ~100-200 tokens typically). The 512 is a ceiling,
  not a target. Actual output rarely exceeds 200 tokens.
- `calculateLLMCost()` in `pricing.ts` uses actual token counts from API response,
  not max_tokens. Cost tracking remains accurate.
- `llm_telemetry` records actual usage. No schema change needed.
- DeepSeek inherits from openai.ts — gets this automatically.

---

### Fix 4 — Concrete Scoring Rubric with Observable Signals
**Priority: CRITICAL | Risk: MEDIUM**

**Problem:** Current score definitions are vague:
- "Not newsworthy" vs "Low importance" — what's the boundary?
- "Moderate importance" vs "High importance" — subjective
- No concrete signals for the model to evaluate

This causes the biggest consistency problem: borderline articles (3 vs 4) are
scored inconsistently. DeepSeek is especially affected because it's less capable
at nuanced classification than Claude.

**What changes:**

1. **`packages/shared/src/schemas/scoring-config.ts`** — Update default score definitions:

   ```
   score1: "Noise — press releases, promotional content, SEO articles, product listings,
            routine HR announcements, no new information beyond what is already known"

   score2: "Routine — scheduled earnings reports meeting expectations, minor personnel
            changes, incremental updates to previously reported stories, conference
            attendance announcements"

   score3: "Noteworthy — new development in an ongoing story, notable partnership or
            collaboration, regulatory filing, earnings with modest surprise, product
            launch from established company"

   score4: "Significant — unexpected corporate action (M&A, IPO filing, major lawsuit),
            policy shift with broad impact, earnings with major surprise, security breach
            affecting users, leadership change at major company"

   score5: "Breaking/Urgent — market-moving event, catastrophic incident, unprecedented
            regulatory action, major geopolitical development affecting markets, critical
            infrastructure failure, confirmed major data breach at scale"
   ```

   **Trace:** These are DEFAULT values in the Zod schema. They affect:
   - New sectors without custom scoring_rules → use these defaults
   - Frontend ScoringRules.tsx → shows these as placeholder/default text in form
   - API preview endpoint → generates prompt with these
   - Existing scoring_rules rows with custom score1-5 text → NOT affected (DB values override defaults)

   **Hidden gem:** Existing scoring_rules rows that have custom `score_criteria` JSON
   in the DB will NOT be affected by default changes. Only sectors using defaults
   (no scoring_rules row, or empty score_criteria) get the new rubric. This is safe.

2. **`packages/shared/src/prompt-builder.ts`** — Add "decision signals" instruction
   AFTER the score definitions:

   ```
   DECISION SIGNALS (evaluate these for every article):
   - Novelty: Is this genuinely new information or a restatement of known facts?
   - Surprise: Was this expected by the market/industry or unexpected?
   - Scope: Does this affect one company, a sector, or the broader market?
   - Urgency: Does this require immediate attention or is it informational?
   - Source credibility: Is this from a primary source or aggregated reporting?
   ```

   **Trace:** This is purely prompt text. Only affects scoring behavior. No
   downstream code impact.

---

### Fix 5 — Few-Shot Calibration Examples
**Priority: CRITICAL | Risk: LOW**

**Problem:** Zero examples in the prompt. LLMs anchor scoring much more consistently
when given 2-3 boundary examples showing what a "3 vs 4" or "1 vs 2" decision
looks like. This is the single highest-ROI prompt engineering technique.

**What changes:**

1. **`packages/shared/src/prompt-builder.ts`** — Add calibration examples to the
   system prompt section. These go in the stable system prompt (not the user message):

   ```
   CALIBRATION EXAMPLES:

   Title: "Acme Corp expands operations to 3 new European markets"
   Score: 3 | Reasoning: Expansion is noteworthy but expected growth for the company.
   No surprise element. Affects one company only.

   Title: "Acme Corp acquires rival Beta Inc for $2.1B in surprise all-cash deal"
   Score: 4 | Reasoning: M&A is a significant corporate action. "Surprise" and the
   size ($2.1B) indicate this was not priced in. Affects sector competitive dynamics.

   Title: "Global semiconductor supply chain halted after major fab fire in Taiwan"
   Score: 5 | Reasoning: Critical infrastructure failure affecting entire industry.
   Market-moving. Urgent. Multiple sectors impacted.

   Title: "TechStartup announces new logo and brand refresh"
   Score: 1 | Reasoning: Pure promotional content. No new information about business
   operations, products, or market dynamics.
   ```

2. **`packages/shared/src/schemas/scoring-config.ts`** — Add optional `examples` field:

   ```typescript
   examples: z.array(z.object({
     title: z.string().max(200),
     score: z.number().int().min(1).max(5),
     reasoning: z.string().max(300),
   })).max(6).default([])
   ```

   When empty array (default), use the hardcoded calibration examples above.
   When populated, use custom examples instead.

   **Trace of new schema field:**
   - `shared/prompt-builder.ts` → reads `config.examples` to build prompt ✓
   - `shared/index.ts` → re-exports type, no change needed ✓
   - `api/routes/scoring-rules.ts` → Zod validates automatically via `scoringConfigSchema` ✓
   - `frontend/api.ts` → `ScoringConfig` type needs `examples` field added ✓
   - `frontend/pages/ScoringRules.tsx` → OPTIONAL: add examples editor to UI
     (can defer this — default examples work without UI)
   - `worker/processors/llm-brain.ts` → no change (reads config, passes to prompt builder) ✓
   - DB `scoring_rules.score_criteria` JSONB → accepts any JSON, no migration needed ✓

   **Hidden gem:** Because `score_criteria` is JSONB with no strict DB schema,
   adding a new field to the Zod schema is backward-compatible. Old rows without
   `examples` get the Zod default (empty array → hardcoded examples).

---

### Fix 6 — Unify the Two Divergent Prompt Paths
**Priority: HIGH | Risk: MEDIUM**

**Problem:** Two prompt templates exist:
- `packages/llm/src/prompts.ts` → `SCORING_WITH_SUMMARY_PROMPT` (hardcoded, includes
  `Sector: {sector}` and `Consider: novelty, impact...`)
- `packages/shared/src/prompt-builder.ts` → `buildScoringPrompt()` (structured config,
  missing sector in body, missing "Consider" factors)

The hardcoded prompt is used when NO custom config exists and the legacy
`promptTemplate` is also empty. The structured builder is used when `score_criteria`
JSONB has content. They produce different scoring behavior.

**What changes:**

1. **`packages/llm/src/prompts.ts`** —
   - Mark `SCORING_WITH_SUMMARY_PROMPT` as `@deprecated`
   - Mark `formatScoringPrompt()` as `@deprecated`
   - Add new exports: `buildSystemPrompt()`, `buildUserMessage()`
   - KEEP the deprecated functions for compilation (other code may import them)
     but the worker will stop using them

2. **`packages/shared/src/prompt-builder.ts`** — Becomes the SINGLE source of truth
   for prompt generation. Add sector to the user message template. Add decision
   signals. Add few-shot examples.

3. **`packages/worker/src/processors/llm-brain.ts`** — `resolvePrompt()` changes:

   **BEFORE:**
   ```
   structured config → buildScoringPrompt()     → single string
   legacy prompt     → raw promptTemplate string → single string
   default           → buildScoringPrompt()     → single string
   ```

   **AFTER:**
   ```
   structured config → buildScoringSystemPrompt() + buildScoringUserMessage() → split
   legacy prompt     → promptTemplate as user message (no system)              → legacy
   default           → buildScoringSystemPrompt() + buildScoringUserMessage() → split
   ```

   **Trace:** The provider's `score()` method handles both:
   - If `systemPrompt` present → use system/user split
   - If only `promptTemplate` present → use single user message (legacy)

   This means existing scoring_rules rows with old `prompt_template` text
   continue working without migration. New rows and defaults get the improved path.

**Hidden gem:** The `api/routes/scoring-rules.ts` preview endpoint calls
`buildScoringPrompt()` to show what prompt the worker will use. After unification,
this should call the new `buildScoringSystemPrompt() + buildScoringUserMessage()`
with sample article data to show a realistic preview. Update the preview to
show both system and user parts.

---

### Fix 7 — Add Sector to Structured Prompt Body
**Priority: HIGH | Risk: LOW**

**Problem:** `buildScoringPrompt()` in `prompt-builder.ts` uses `sectorName` only in
the role line: `"You are a ${sectorName} news analyst"`. The article metadata section
has `Article Title: {title}` and `Article Content: {content}` but NO `Sector: {sector}`.

The hardcoded `SCORING_WITH_SUMMARY_PROMPT` in `prompts.ts` DOES include
`Sector: {sector}`. This inconsistency means structured-config sectors get weaker
sector context.

**What changes:**

1. **`packages/shared/src/prompt-builder.ts`** — In the new `buildScoringUserMessage()`,
   include sector:
   ```
   Sector: {sector}
   Article Title: {title}
   Article Content: {content}
   ```

**Trace:** Pure prompt text change. No impact on parsing, storage, or downstream code.
Sector name is already available in the worker (fetched from DB, passed as `sectorName`).

---

### Fix 8 — Chain-of-Thought Ordering (Reasoning Before Score)
**Priority: MEDIUM | Risk: LOW**

**Problem:** Current prompt example output is:
```json
{"score": 3, "summary": "...", "reasoning": "..."}
```

This biases the model to pick a score FIRST and rationalize AFTER. For more
accurate classification, the model should reason first, then commit to a score.

**What changes:**

1. **`packages/shared/src/prompt-builder.ts`** — Change output format instruction:
   ```
   Respond with ONLY valid JSON:
   {"reasoning": "Brief analysis of decision signals", "score": N, "summary": "..."}
   ```

   The JSON key ORDER matters for autoregressive models — they generate left-to-right.
   Putting `reasoning` first forces the model to think before scoring.

2. **`packages/llm/src/schemas.ts`** — No change needed. `ScoringResponseSchema`
   already accepts reasoning as optional. JSON parsing is key-order-independent.

**Trace:**
- `parseScoringResponse()` uses `JSON.parse()` which is key-order-independent ✓
- `ScoringResponseSchema` Zod schema validates by key name, not position ✓
- DB stores `importance_score` and `llm_summary` separately, not raw JSON ✓
- Frontend displays score and summary from DB columns, not raw LLM output ✓
- Telemetry records score value, not JSON structure ✓
- **Zero downstream impact. Safe change.**

---

### Fix 9 — Summary Character Limit Alignment
**Priority: MEDIUM | Risk: LOW**

**Problem:** Prompt says `max 200 characters` but `ScoringResponseSchema` in
`schemas.ts` allows `.max(500)`. The model sometimes outputs 300+ char summaries
that pass validation but are longer than intended.

**What changes:**

1. **`packages/llm/src/schemas.ts`** — Keep `.max(500)` in Zod but add `.transform()`
   to truncate at the configured limit:
   ```typescript
   summary: z.string().max(500).optional().nullable()
     .transform((v) => v && v.length > 280 ? v.slice(0, 277) + "..." : v),
   ```

   Use 280 as the hard cap (tweet-length, safe for all social platforms).

   **Alternatively:** Read `summaryMaxChars` from config and pass it to the parser.
   But this couples the parser to config, adding complexity. The transform approach
   is simpler and sufficient.

**Trace:**
- `articles.llm_summary` is `text` type in DB — no length constraint ✓
- Frontend truncates display with CSS — handles any length ✓
- Social posting templates may have their own truncation — independent ✓
- Distribution worker reads `llm_summary` as-is — shorter is better for posts ✓

---

### Fix 10 — Anti-Hallucination Guard
**Priority: MEDIUM | Risk: LOW**

**Problem:** The model can fabricate facts in the summary that aren't in the article.
For a media monitoring system that posts to social media, hallucinated facts in
summaries are a credibility disaster.

**What changes:**

1. **`packages/shared/src/prompt-builder.ts`** — Add to SUMMARY REQUIREMENTS section:
   ```
   SUMMARY REQUIREMENTS:
   - Maximum {summaryMaxChars} characters
   - Tone: {summaryTone}
   - Language: {summaryLanguage}
   - Style: {summaryStyle}
   - CRITICAL: Only include facts explicitly stated in the article. Do NOT infer,
     speculate, or add information not present in the provided text.
   - If the article content is empty or insufficient, summarize based on the title only
     and note the limitation.
   ```

**Trace:** Pure prompt instruction. No code impact.

---

### Fix 11 — Edge Case Handling Instructions
**Priority: MEDIUM | Risk: LOW**

**Problem:** No guidance for: empty content, non-English articles, very short
articles, obviously duplicated content, articles that are just a title.

**What changes:**

1. **`packages/shared/src/prompt-builder.ts`** — Add edge case section to system prompt:
   ```
   EDGE CASES:
   - If article content is empty or very short (title only): Score based on title alone.
     Default to score 2 unless the title clearly indicates high importance.
   - If article appears to be in a non-English language: Score the content as-is based
     on whatever you can understand. Do not penalize for language.
   - If article content says "[truncated]": The full article was longer. Score based on
     available content without penalizing for incompleteness.
   - If article is clearly promotional/sponsored content: Score 1 regardless of topic.
   ```

**Trace:** Pure prompt instruction. No code impact.

**Hidden gem:** The content truncation signal solves Fix 12 from the original
analysis. `formatScoringPrompt()` already appends `"... [truncated]"` when content
exceeds 10k chars. Now the prompt tells the model what that means.

---

### Fix 12 — Prompt Preview Update for API
**Priority: LOW | Risk: LOW**

**Problem:** After splitting into system + user prompts, the API preview endpoint
at `POST /scoring-rules/preview` and `GET /scoring-rules/:sectorId` needs to
show both parts.

**What changes:**

1. **`packages/api/src/routes/scoring-rules.ts`** — Update preview response:

   ```typescript
   // BEFORE
   return { prompt: buildScoringPrompt(config, sectorName) };

   // AFTER
   return {
     system_prompt: buildScoringSystemPrompt(config, sectorName),
     user_message_template: buildScoringUserMessage("{title}", "{content}", sectorName),
     combined_preview: buildScoringPrompt(config, sectorName), // backward compat
   };
   ```

   **Trace:**
   - Frontend `ScoringRules.tsx` reads `prompt_preview` from GET response and
     `prompt` from POST preview. Both need updating to show the new format.
   - This is a display-only change. No scoring behavior impact.

---

### Fix 13 — Frontend ScoringConfig Type Sync
**Priority: LOW | Risk: LOW**

**Problem:** After adding `examples` field to `ScoringConfig` schema (Fix 5),
the frontend TypeScript type must match.

**What changes:**

1. **`packages/frontend/src/api.ts`** — Add `examples` to `ScoringConfig` type:
   ```typescript
   export type ScoringConfig = {
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
     examples: Array<{ title: string; score: number; reasoning: string }>;  // NEW
   };
   ```

2. **`packages/frontend/src/pages/ScoringRules.tsx`** — Two options:
   - **Option A (recommended):** Don't add UI for examples yet. The default
     hardcoded examples work. Show them as read-only in the prompt preview.
   - **Option B (future):** Add examples editor (title + score + reasoning per row).
     Defer to a future task — not needed for scoring precision improvement.

**Trace:** Zod default `[]` means API returns empty array → frontend type must
accept it. Existing scoring_rules rows without `examples` in JSONB → Zod adds
default `[]` → backward compatible.

---

## Implementation Order (Dependency-Safe)

```
Phase 1 — Zero-risk provider config (no prompt changes)
├── Fix 2: Temperature control (claude.ts, openai.ts)
└── Fix 3: max_tokens increase (claude.ts, openai.ts)

Phase 2 — Prompt rewrite (shared package first, then LLM package)
├── Fix 4: Concrete scoring rubric (shared/schemas/scoring-config.ts)
├── Fix 5: Few-shot examples + schema field (shared/schemas/scoring-config.ts)
├── Fix 7: Sector in prompt body (shared/prompt-builder.ts)
├── Fix 8: Chain-of-thought ordering (shared/prompt-builder.ts)
├── Fix 10: Anti-hallucination guard (shared/prompt-builder.ts)
└── Fix 11: Edge case handling (shared/prompt-builder.ts)

Phase 3 — System/User split (most complex, depends on Phase 2)
├── Fix 1: System/user message split (types.ts, claude.ts, openai.ts, prompts.ts, prompt-builder.ts)
├── Fix 6: Unify two prompt paths (prompts.ts, prompt-builder.ts, llm-brain.ts)
└── Fix 9: Summary limit alignment (schemas.ts)

Phase 4 — API + Frontend sync
├── Fix 12: Preview endpoint update (scoring-rules.ts)
└── Fix 13: Frontend type sync (api.ts, ScoringRules.tsx)
```

### Phase 1 → Phase 2 boundary
Phase 1 is purely provider-level config (temperature, max_tokens). Can be deployed
independently. Phase 2 changes prompt content but keeps single-message architecture.
Can also be deployed independently.

### Phase 2 → Phase 3 boundary
Phase 3 restructures how prompts are sent (single message → system+user). This is
the riskiest phase because it touches the provider interface. But the legacy fallback
(if systemPrompt is undefined, use old path) makes it safe to deploy incrementally.

### Phase 3 → Phase 4 boundary
Phase 4 is display-only changes. Zero scoring behavior impact. Can be deployed
last or deferred.

---

## Verification Plan

After implementation, verify with:

1. **Build check:** `npm run build` — all packages must compile
2. **Lint check:** `npm run lint` — no new violations
3. **Manual test:** Run `npm run pipeline:reset && npm run dev`, let pipeline
   ingest + score a batch. Verify:
   - Scores are in 1-5 range
   - Summaries are under 280 chars
   - `llm_telemetry` shows correct provider/model
   - `reasoning` field is populated (chain-of-thought working)
   - No parse failures in worker logs (JSON output clean)
   - Articles auto-approve/reject at correct thresholds
   - SSE events fire correctly in dashboard
4. **Provider fallback test:** Temporarily break primary provider API key,
   verify fallback kicks in and scores correctly
5. **Legacy compat test:** If any scoring_rules rows have old `prompt_template`
   strings, verify they still work (single-message fallback path)

---

## Risk Register

| Risk | Mitigation |
|------|-----------|
| DeepSeek handles system prompt differently than OpenAI | DeepSeek uses OpenAI-compatible API, system role is supported. Test explicitly. |
| Existing scoring_rules with custom score_criteria JSONB lose new fields | Zod defaults fill missing fields. Backward compatible by design. |
| Few-shot examples bias scoring toward example patterns | Use diverse, generic examples (not sector-specific). Sector-specific examples go in per-sector config. |
| Lower temperature makes model refuse to score edge cases | Edge case instructions (Fix 11) explicitly tell model to still score. |
| Longer reasoning increases token cost | max_tokens=512 is a ceiling. Typical output stays ~150-200 tokens. Monitor via telemetry. |
| Summary truncation at 280 chars cuts mid-word | Use `lastIndexOf(" ")` for clean word-boundary truncation. |
| Preview endpoint returns different format, breaks frontend | Include `combined_preview` field for backward compat. Frontend updates in Phase 4. |
