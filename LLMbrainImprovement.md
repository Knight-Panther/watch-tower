# LLM Brain & Intelligence Layer — Improvement Roadmap

## Goal

Build Watch Tower into a reliable intelligence tool for personal use, then sell managed instances to clients.

**Business model:** Managed instances — you install, configure, and operate a separate deployment per client. They get a dashboard URL and daily intelligence output. You are the analyst; the tool is your backend.

**Target buyers:** PR agencies, investment firms, corporate strategy teams, niche content agencies.

**Core pitch:** "Monitor 500+ sources in your industry, surface what matters, scored and explained by AI, delivered to your Telegram every morning."

---

## Current State — What's Solid

| Component | Status | Notes |
|-----------|--------|-------|
| RSS ingestion + date filtering | Production-ready | Battle-tested, edge cases handled. Only captures title + snippet (500 chars). Does NOT extract `<category>` tags or `<content:encoded>` |
| URL dedup | Production-ready | PostgreSQL UNIQUE, zero cost |
| Semantic dedup (embeddings) | Production-ready | pgvector, global threshold, batch 50 |
| LLM scoring + summarization | Production-ready | Multi-provider, fallback, batch 10 |
| Score reasoning (LLM layer) | 40% done | Prompt requests it, Zod parses it, type accepts it — but NOT persisted to DB |
| Scoring config system | Production-ready | Per-sector priorities, ignore lists, score definitions, few-shot examples, summary tone/style |
| Multi-platform distribution | Production-ready | Telegram, Facebook, LinkedIn — rate limits, health checks, error recovery |
| Pipeline reliability | Production-ready | Zombie recovery, self-healing jobs, atomic claims |
| Translation (Georgian) | Production-ready | Gemini/OpenAI, retry logic, conditional UI |
| AI image generation | Production-ready | gpt-image-1-mini + R2 + canvas compositor |
| Georgian UI conditionals | Done | Frontend hides Georgian fields when `posting_language = en` |
| Articles sort stability | Done | Tiebreaker sort prevents list shuffle on actions |
| Source type flexibility | Untapped | Reddit, HN, Substack all have RSS feeds — can be added as sources today with zero code changes |

---

## Priority Improvements

### Pipeline with planned additions

```
[1] INGEST (enriched) → [2] SEMANTIC DEDUP → [3] PRE-FILTER (new) → [4] LLM BRAIN (enriched) → [5] TRANSLATE → [6] IMAGE GEN → [7] DISTRIBUTE
  ↑ now captures:              ↓                    ↓ reject              ↓ score + reason
  categories[]            (embed+compare)       (skip LLM)           [ALERT CHECK] (new)
  content:encoded                                                         ↓ match
  (1500 chars)                                                     [INSTANT NOTIFY] (new)
```

---

### P1: Score Reasoning — Persist What's Already Generated

**Problem:** Scores are 1-5 with no visible reasoning. You (or clients) ask "why did this get a 3?" and there's no answer in the dashboard.

**Current state (verified):**
- Prompt already instructs LLM to return reasoning (`packages/shared/src/prompt-builder.ts:64`)
- Zod schema already parses and validates reasoning, truncates to 1000 chars (`packages/llm/src/schemas.ts:21-24`)
- `ScoringResult` type already has `reasoning?: string` field (`packages/llm/src/types.ts:14`)
- Worker receives reasoning from LLM response but **drops it** — the UPDATE query in `llm-brain.ts:335-353` does not write reasoning to DB
- No `score_reasoning` column exists on `articles` table
- API does not return reasoning; frontend does not display it

**What's left to do:**
1. Add `score_reasoning` text column to `articles` table in `schema.ts`
2. Add reasoning to the bulk UPDATE in `llm-brain.ts` (one field in the UNNEST SQL). **Note:** Requires an `escapeReasoning` helper following the same pattern as existing `escapeSummary` (line 326) — escapes backslashes and double quotes for PostgreSQL array literal formatting. Not a security risk (Drizzle parameterizes the value), but needed for valid `text[]` parsing.
3. Add to API article response in `articles.ts`
4. Add tooltip or expandable row in frontend `Articles.tsx`

**Migration strategy:** Run `npm run pipeline:reset` after deploying P1. This wipes all articles and re-processes from scratch, so every article gets reasoning from the first scoring pass. No need to handle NULL reasoning for historical articles in the UI — there won't be any. Avoids migration complexity entirely.

**Effort:** Very small — 4 surgical code changes, ~2 hours
**Impact:** High — builds trust, eliminates "why this score?" questions

---

### P2: Pre-Filter + RSS Enrichment — Hard Reject Before LLM (Cost Gate + Scoring Quality)

This priority has two parts: (A) enrich what we capture from RSS feeds at ingest time, and (B) use that richer data to hard-reject junk before it reaches the LLM.

#### P2-A: RSS Field Enrichment (Ingest-Level)

**Problem:** We currently capture only `title` + `contentSnippet` (500 chars, HTML-stripped) from RSS feeds. Two valuable fields are available but ignored:

**Current state (verified):**
- `feed.ts:134` captures `item.contentSnippet ?? item.content`, truncated to 500 chars (`feed.ts:20-24`)
- `secure-rss.ts:36` sets `customFields: { item: [] }` — empty array, no custom fields extracted
- `rss-parser` already parses `item.categories` (array of `<category>` tags) automatically — we just don't store it
- `rss-parser` supports `content:encoded` via `customFields` — full HTML article body, often 5-10 paragraphs vs the 2-3 sentence snippet
- No `categories` column exists on `articles` table

**Fields to add:**

| RSS Field | How to Extract | Store As | Use For |
|-----------|---------------|----------|---------|
| `item.categories` | Already parsed by rss-parser (zero config) | `article_categories text[]` on articles table | Hard reject ("Sponsored", "Press Release") + LLM scoring context |
| `content:encoded` | Add to `customFields.item` in `secure-rss.ts` | Use as extended `content_snippet` (truncate to 1500 chars instead of 500) | Richer LLM scoring context → better score accuracy |

**Implementation:**
1. `secure-rss.ts`: Add `['content:encoded', 'contentEncoded', { includeSnippet: true }]` to `customFields.item`
2. `feed.ts`: Prefer `item.contentEncoded` over `item.contentSnippet` for richer content. Increase truncation from 500 to 1500 chars
3. `feed.ts`: Capture `item.categories` array (already available on parsed items)
4. `schema.ts`: Add `articleCategories text[]` column to articles table
5. `feed.ts`: Store categories in new column during insert

**Impact on LLM scoring:**
- Currently: LLM scores on title + ~2-3 sentences (500 chars) — often too little context to judge importance accurately
- After: LLM scores on title + ~5-10 sentences (1500 chars) + category tags — significantly better scoring decisions
- Score reasoning (P1) also improves because LLM has more information to explain its score

**Effort:** Small — 5 surgical changes across 3 files
**Impact:** High — single biggest quality uplift for scoring accuracy

#### P2-B: Hard Reject Before LLM (Cost Gate)

**Problem:** Every article reaching the LLM costs money. The existing `ignore` list in `scoring_config` is a soft hint — it tells the LLM to "de-prioritize" but articles still get scored and billed.

**Current state (verified):**
- `scoring_config.ignore[]` exists (`packages/shared/src/schemas/scoring-config.ts:22`) — up to 20 strings
- Used in prompt as `DE-PRIORITIZE articles about: ${config.ignore.join(", ")}` (`prompt-builder.ts:19-20`)
- This is LLM-side filtering only — articles are still sent, tokens are still consumed
- No hard pre-filter exists anywhere in the pipeline between dedup and LLM brain

**Solution:** Add a hard reject blocklist that auto-rejects articles BEFORE they reach the LLM queue. Now that we capture `categories` (P2-A), the reject logic checks both text content AND category tags.

**Implementation:**
- Add `reject_keywords` array to `scoringConfigSchema` (separate from existing soft `ignore`)
- Add `rejection_reason` text column to `articles` table in `schema.ts`
- In `llm-brain.ts`, before adding article to scoring batch, check `title + content_snippet + categories[]` against sector's `reject_keywords`
- Matching articles → `pipeline_stage = 'rejected'` immediately, never sent to LLM
- On match, write `rejection_reason` with the exact keyword and where it matched
- Also populate `rejection_reason` for LLM-scored rejections and manual rejections (unified audit trail)
- UI: simple list editor in Scoring Rules page (alongside existing priorities/ignore)
- Use case-insensitive word boundary matching (not plain substring) to avoid false positives — "AI" should not match "FAIRY TALE". Same matching logic shared with P3 alert rules.
- Category matching is especially effective — "Sponsored" almost never appears in title/snippet but frequently appears in `<category>` tags

**Why separate from `ignore`:**
- `ignore` = "score it lower" (soft, LLM decides)
- `reject_keywords` = "don't score it at all" (hard, saves money)

**Rejection audit trail (`rejection_reason` column):** Every rejected article records WHY it was rejected — the exact keyword, where it matched, and the rejection source. This is essential for auditing keywords and catching false positives.

| Rejection source | `rejection_reason` value |
|---|---|
| Pre-filter: keyword in title | `"pre-filter: keyword 'Sponsored' matched in title"` |
| Pre-filter: keyword in categories | `"pre-filter: keyword 'Press Release' matched in categories"` |
| Pre-filter: keyword in content | `"pre-filter: keyword 'podcast transcript' matched in content_snippet"` |
| LLM scored 1-2 | `"llm-score: 2"` |
| Manual rejection | `"manual"` |

**Articles page UI:**
- Filter dropdown for rejected articles: "All rejected" / "Pre-filtered" / "LLM rejected" / "Manual"
- Each rejected article shows `rejection_reason` inline — operator can immediately see which keyword caught it and whether it was a false positive
- This is how you validate and refine your keyword list over time

**Effort:** Small — extends existing scoring config, one check in worker, one new column
**Impact:** High — directly reduces LLM API costs, especially for noisy sectors (crypto, tech). Audit trail prevents blind keyword blocking.

---

#### P2-C: Scoring Prompt Enrichment (LLM Brain)

**Problem:** The LLM prompt currently receives only `title` and `content_snippet` per article. With P2-A enrichment, two new signals are available that improve scoring accuracy.

**Changes to prompt builder (`prompt-builder.ts`):**
- Include `categories` as topic context: `"Categories: M&A, Technology, Earnings"` — helps LLM calibrate domain relevance
- The longer `content_snippet` (1500 vs 500 chars) flows through automatically — no prompt template change needed, just more text in the article payload
- Include categories in the existing few-shot examples where applicable

**Why this helps scoring:**
- LLM currently guesses domain from title alone. Categories make it explicit: "this is an M&A article" vs "this is a product update"
- More content = fewer wrong scores caused by ambiguous 2-sentence snippets
- Combined with per-sector `priorities[]`, categories enable precise scoring: if sector priorities include "M&A" and article categories include "M&A", the LLM has a clear signal to score higher

**Effort:** Trivial — 2-3 lines in prompt builder
**Impact:** Medium — incremental on top of P2-A, but compounds with existing scoring config

---

### P3: Keyword/Entity Alerts — "Ping Me When X Happens"

**Problem:** Everything is score-based. The tool can't answer: "tell me immediately when anyone mentions [CompanyX]."

**Current state (verified):**
- Zero alert infrastructure — no `alert_rules` table, no notification code, no watchlist concept
- Distribution system only handles social posting (Telegram/Facebook/LinkedIn channels)
- No mechanism for direct-to-user notifications separate from social posting

**Solution:** Keyword watchlist with instant Telegram notifications — a parallel output channel that bypasses the entire distribution pipeline.

**Implementation:**
- New table: `alert_rules` (id, keywords[], min_score, telegram_chat_id, active, created_at)
- New table: `alert_deliveries` (id, rule_id, article_id, sent_at, status) — lightweight audit trail for sent alerts
- After LLM scoring in `llm-brain.ts`, check scored article `title + llm_summary + categories[]` against active alert rules
- On match: send direct Telegram message to configured chat (separate from social posting queue)
- UI: simple form — keyword, optional min score threshold, Telegram chat ID
- Start with case-insensitive word boundary matching (not plain substring — avoids "AI" matching "FAIRY TALE"). Upgrade to regex/entity matching later if needed

**Alerts bypass the distribution pipeline entirely:**
- No `post_deliveries` row — alerts are tracked in `alert_deliveries` instead
- No rate limiting (only the 5-min cooldown per keyword)
- No platform health check — if Telegram is down, alert fails silently (logged in `alert_deliveries`)
- No scheduling — instant send after scoring
- This is intentional: alerts must be fast, not queued behind rate limits

**Alert storm consolidation (Redis-based):**
- Redis key `alert:cooldown:{rule_id}:{keyword}` with 5-minute TTL
- First match: send immediately, set cooldown key
- Subsequent matches within 5 min: accumulate in Redis list
- After cooldown expires: send one consolidated message — *"Alert: 'Google' matched 8 articles"* with the top 3 listed by score
- Prevents 20 separate messages when a keyword matches an entire scoring batch

**Edge cases:**
| Edge Case | Handling |
|-----------|----------|
| Keyword too broad ("the", "market") | UI warning when keyword is < 3 characters. Cooldown prevents spam even for broad keywords |
| Partial word matching ("AI" → "FAIRY") | Word boundary matching by default (not plain substring). Prevents false positives |
| Telegram send fails | Log failure in `alert_deliveries` (status: `failed`). No retry — alerts are time-sensitive, a 30-min-late alert defeats the purpose |
| Pre-filtered articles (P2-B) triggering alerts | Can't happen — pre-filtered articles never reach scoring, so they never trigger alert checks. Correct behavior |
| Many alert rules (50+) | Substring matching on < 50 rules is microseconds. Only becomes a concern at 500+ rules — not relevant for managed instances |
| Worker restart loses Redis cooldown state | Worst case: one duplicate alert batch. Acceptable — cooldown keys rebuild naturally |

**Effort:** Medium — new table, post-scoring hook, Telegram notification, Redis cooldown
**Impact:** Very high — this is the #1 feature intelligence buyers expect. Often the only reason people pay for monitoring tools.

---

### P4: Daily Digest — The Product's Front Door

**Problem:** Most people won't open the dashboard daily. Without a push delivery, the tool is invisible. The digest is what clients interact with — if it reads like an analyst wrote it, they keep paying. If it reads like an RSS dump, they cancel.

**Current state (verified):**
- Zero digest code — no queue, no job, no cron for daily summaries
- Existing queues: ingest, dedup, llm-brain, distribution, translation, image-gen, maintenance
- Distribution only handles individual article posting, no batch/digest mode
- Articles already have `llm_summary` (~200 chars) and `importance_score` — digest input is ready
- Existing LLM provider abstraction can be reused for the digest generation call

#### Why LLM-Generated (Not Template-Only)

A formatted bullet list is what Zapier does for free. What sells is an **intelligence briefing** — the LLM reads the day's top articles and writes a cohesive narrative that connects dots across stories:

> *"AI regulation dominated today: EU finalized the AI Act enforcement timeline, while the US SEC issued new guidance on AI-generated financial advice. Meanwhile, Google and Meta both announced competing open-source models — suggesting an escalation in the foundation model price war."*

That paragraph connects 4 separate articles. No template engine can do that. **This is the $300/month justification.**

**Cost per digest:** ~2000 tokens (20 summaries × 200 chars input + system prompt). That's $0.01-0.03/day. One LLM call per client per day — negligible.

#### Digest Structure

```
📊 Morning Intelligence Brief — Feb 20, 2026
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🧠 Executive Summary                    ← LLM-generated narrative (connects themes)
"AI regulation dominated today..."

🔴 Critical (Score 5)                   ← Grouped by score tier
• Article title — reasoning (from P1)
• Article title — reasoning

🟠 Significant (Score 4)
• Article title — reasoning
• ...

📈 Pipeline Stats                       ← Proves the tool is working
Scanned: 340 articles | Passed filter: 47 | Score 4+: 12
```

#### Analyst Role & Tone Customization (Per-Client)

**This is the killer differentiator.** Same 15 articles, completely different briefing depending on the client's role. The operator configures a custom analyst persona per instance:

| Client Type | Role Setting | Digest Feels Like |
|-------------|-------------|-------------------|
| VC Partner | "Senior technology analyst briefing a venture capital partner on portfolio-relevant developments" | "Two portfolio-relevant deals announced today. The Series B in quantum computing signals..." |
| PR Agency | "Media monitoring specialist briefing a PR team about client coverage and industry positioning" | "Client coverage spiked 40% this week. Competitor X launched a counter-narrative on..." |
| Trading Desk | "Market intelligence analyst identifying pre-market catalysts and sector-moving events" | "Pre-market catalyst: unexpected earnings miss at MegaCorp. Three sell-side downgrades likely..." |
| Corporate Strategy | "Strategic intelligence analyst tracking competitive moves and regulatory shifts in the industry" | "Regulatory watch: two new compliance requirements proposed this week that affect..." |

**Implementation:** One config field does all the work:
- `digest_role` (free text, max 300 chars) — the LLM system prompt persona. Operator writes it once per client during setup. This controls tone, style, grouping, and emphasis — all in natural language instead of dropdowns.
- Example: *"Senior biotech analyst briefing an investment committee. Write in concise, urgent style. Focus on pipeline developments and regulatory signals."*

The role field absorbs what would otherwise be 4 separate dropdowns (tone, grouping, style, focus). One well-written sentence is more powerful and flexible than any preset.

#### Configurable Settings (stored in `app_config`)

10 essential settings (cut from 14 — tone, group_by, frequency, include_executive_summary, include_stats, channel all dropped as unnecessary):

| Setting | Default | Purpose |
|---------|---------|---------|
| `digest_enabled` | `false` | Master toggle |
| `digest_time` | `08:00` | Delivery time (HH:MM) |
| `digest_timezone` | `UTC` | Client timezone (IANA) |
| `digest_days` | `[1,2,3,4,5,6,7]` | Which days to send (1=Mon...7=Sun). Default: every day. Business clients toggle off Sat/Sun |
| `digest_min_score` | `3` | Minimum score for articles to qualify (1-5) |
| `digest_max_articles` | `15` | Max featured articles per digest (5-30) |
| `digest_include_reasoning` | `true` | Show P1 score reasoning per article |
| `digest_language` | `(follows posting_language)` | `en` or `ka` — controls article field selection AND LLM executive summary language. Defaults to global `posting_language` but can be overridden independently |
| `digest_role` | `"Senior intelligence analyst providing a daily briefing on important developments"` | LLM persona — ALL customization lives here (max 300 chars) |
| `digest_telegram_chat_id` | (from existing config) | Delivery target (can differ from social posting chat) |

**Why 10, not 14:** Executive summary and stats are always included (they're the product — no reason to toggle off). Tone is part of the role field. Grouping is decided by the LLM thematically (smarter than mechanical score-tier grouping). Telegram is the only channel for now.

**Language handling (`digest_language`):**
- When `ka`: use `title_ka` / `llm_summary_ka` from DB for article entries; add "Write the executive summary in Georgian" to LLM system prompt
- When `en`: use `title` / `llm_summary` from DB; LLM writes in English (default)
- Fallback: if `digest_language = ka` but an article has `translation_status != 'translated'`, use English fields for that article. Don't block the entire digest because one article hasn't been translated yet
- Independent from global `posting_language` — operator can read English digest while social posts go out in Georgian, or vice versa

#### Article Selection & LLM Flow

**Step 1: Query** — all articles where `scored_at > last_digest_sent_at` AND `importance_score >= digest_min_score`, sorted by score DESC then published_at DESC

**Step 2: Split into two tiers** (simple, mechanical):
- **Featured** (top N by `digest_max_articles`): get individual entries with full detail
- **Context** (remaining): LLM sees titles + scores only for thematic awareness

Example with 40×score-3, 25×score-4, 10×score-5, max=15:
→ Featured: all 10 score-5 + top 5 score-4 = 15 articles with full summaries
→ Context: remaining 60 articles as title + score one-liners
→ LLM sees ALL 75 for theme identification, writes about the featured 15

**Step 3: One LLM call** — system prompt with `digest_role`, user prompt with both tiers. LLM writes executive summary + thematic article grouping. ~3000-5500 tokens input, ~1000 tokens output = $0.01-0.05.

**Step 4: Append stats** (mechanical, no LLM): "Scanned: 340 | Passed filters: 75 | Score 4+: 35"

**Step 5: Format + deliver** via Telegram. Split into 2-3 messages if exceeding 4096 char limit.

**Step 6: Track** — store `last_digest_sent_at` in app_config to prevent article re-inclusion in next digest.

#### Edge Cases & Safeguards

| Edge Case | Handling |
|-----------|----------|
| Zero articles qualify | Skip — don't send empty message |
| LLM call fails | Fall back to template-only digest (bullet list, no executive summary). Client still gets their morning briefing |
| Telegram 4096 char limit | Split into 2-3 sequential messages |
| Non-selected day (`digest_days`) | Cron fires, checks day-of-week, skips if not in `digest_days`. No article tracking update — skipped articles roll into next active day's digest |
| **First digest ever (no `last_digest_sent_at`)** | Use `NOW() - 24 hours` as lookback. Don't dump all historical articles into first digest |
| **"Send Test Digest" button** | Must NOT update `last_digest_sent_at`. Otherwise test at 3pm → real 8am digest next morning skips those articles. Test flag passed to processor to prevent tracking update |
| **Worker restart mid-send** | Update `last_digest_sent_at` BEFORE sending Telegram message. Worst case: tracking updated but send fails → missed digest (self-corrects next day). Without this: send succeeds but tracking fails → duplicate digest next trigger. Missing is better than duplicate |
| **BullMQ cron fires twice (worker restart)** | Check `last_digest_sent_at` — if within last 1 hour, skip. Simple idempotency guard |
| **DST timezone shifts** | Use IANA timezone library (`luxon` or `date-fns-tz`), not manual UTC offsets. "08:00 America/New_York" must shift correctly in March/November |
| **`digest_language = ka` but article not translated** | Use English fields (`title`, `llm_summary`) as fallback for that article. Don't block entire digest for one untranslated article |
| **Multi-sector content** | Single combined digest across ALL sectors. Executive summary connects themes cross-sector — this is where the LLM adds value over a simple bullet list |
| **Late-scored articles** | `scored_at > last_digest_sent_at` means articles scored after digest cutoff wait for next digest. Acceptable — digest is "what was scored since last digest", not "what happened today" |
| **`digest_time` changed mid-day** | Takes effect next day. If today's digest already sent, `last_digest_sent_at` prevents double-send |

#### What Makes Clients Buy It (3 Selling Points)

1. **Executive summary** — Client forwards the digest to their boss. If it reads like a human analyst wrote it, they keep paying. The role customization makes it feel like a dedicated hire.
2. **Consistent delivery** — Same time every morning, zero effort. By week 2 clients stop opening the dashboard — the digest IS the product.
3. **"Scanned 340, surfaced 12"** — Stats section proves value. Client sees 95% of noise filtered. Without this number, they wonder if Google News is enough.

#### Implementation

- New queue constant: `QUEUE_DIGEST` + `JOB_DAILY_DIGEST` in shared package
- New cron job in maintenance worker (triggers at `digest_time` in `digest_timezone`)
- Digest processor: query top articles → build LLM prompt with role/tone → single LLM call → format Telegram message → deliver
- Reuse existing LLM provider abstraction (same `createLLMProvider()` factory)
- Start with Telegram only; add email (SendGrid/Resend) later if clients need it

**Effort:** Medium-Large — new job + digest config schema + LLM prompt with role/tone + Telegram formatting + UI config panel (~3-4 days)
**Impact:** Very high — this is what clients interact with daily. The role customization is the moat.

---

### P5: Source Quality Dashboard — Operator Tool

**Problem:** When managing sources for clients, you need to quickly identify which sources produce signal vs noise.

**Current state (verified):**
- `GET /stats/sources` returns fetch metadata (last run, item count, errors, stale status)
- No aggregate scoring — no `AVG(importance_score)` per source anywhere
- All data needed for this already exists: `articles.importance_score` + `articles.source_id`

**Solution:** Track score distribution and signal ratio per source over rolling 30 days. Surface in dashboard.

**Key metric — Signal Ratio:** Average score alone is misleading. A source averaging 3.0 could mean "all articles score 3" (useless) or "half score 5, half score 1" (actually valuable). The real decision metric is **signal ratio: % of articles scoring 4+** over 30 days.

Example of what the operator sees:

| Source | Score 1 | Score 2 | Score 3 | Score 4 | Score 5 | Total | Signal (4+) |
|--------|---------|---------|---------|---------|---------|-------|-------------|
| Reuters | 2 | 5 | 12 | 18 | 8 | 45 | **58%** |
| CryptoBlog | 15 | 22 | 8 | 2 | 0 | 47 | **4%** |
| TechCrunch | 3 | 8 | 20 | 15 | 4 | 50 | **38%** |

A source producing 4% signal is pure noise — drop it or move to a lower-priority ingest interval. A source at 58% is gold — give it the shortest fetch interval.

**Implementation:**
- Add aggregate query to stats route: `SELECT source_id, importance_score, COUNT(*) FROM articles WHERE scored_at > NOW() - INTERVAL '30 days' GROUP BY source_id, importance_score` — same query complexity as a simple AVG, but returns the full distribution
- Compute per-source: total scored, score distribution (1-5 counts), signal ratio (% scoring 4+), avg score
- Display in RSS Sources page as a quality card per source:
  - Signal ratio badge: green (40%+), amber (15-40%), red (<15%)
  - Mini score distribution bar (horizontal stacked bar showing 1-5 proportions)
  - Total articles scored count (so you know if the ratio is meaningful — 3 articles ≠ reliable signal)
- Auto-flag sources where signal ratio < 10% over 30+ scored articles (confident noise producers)
- Sortable: allow sorting source list by signal ratio (best sources first)
- This is YOUR operator tool — helps you tune each client's source list

**Operator actions this enables:**
- Disable or remove consistently low-signal sources (noise producers draining LLM budget)
- Give high-signal sources shorter `ingest_interval_minutes` so they're fetched first (mitigates "first in wins" dedup issue)
- Identify which sources actually justify their feed slot
- Spot sources that produce high volume but zero signal — these are the biggest cost sinks

**Not automated:** No auto-rotation or auto-disable. You review the data and make the call manually — keeps control explicit.

**Effort:** Small — one aggregate query + UI cards (distribution bar is the only non-trivial UI element)
**Impact:** High — signal ratio is the single most actionable metric for source curation. Directly reduces LLM costs by identifying noise sources.

---

### P6: Global Dedup Threshold in DB (UI-Adjustable)

**Problem:** Similarity threshold is hardcoded in `.env` file (`SIMILARITY_THRESHOLD`). Changing it requires restarting the worker. No visibility in the dashboard.

**Current state (verified):**
- Global threshold from `SIMILARITY_THRESHOLD` env var, passed to worker at startup (`index.ts:271`)
- `semantic-dedup.ts` uses single `similarityThreshold: number` in deps — injected once at worker creation
- `findSimilarArticles()` takes one threshold value, searches across ALL sectors (cross-sector dedup is correct behavior)
- Currently set to 0.65 (aggressive — default is 0.85)

**Decision: Global threshold only, no per-sector.**
Per-sector thresholds were evaluated and dropped. The real duplicate gray zone (0.80-0.92 similarity) is small — most genuine duplicates are 0.95+ and most non-duplicates are below 0.75. A single well-tuned global threshold handles 95% of cases. Sector-specific dedup issues are better solved by source curation (fewer overlapping sources) and ingest interval tuning (high-quality sources fetched first). Per-sector adds Medium implementation effort for near-zero client-visible value.

**Implementation:**
- Add `similarity_threshold` key to `app_config` table (jsonb value, e.g., `0.85`)
- Seed from `SIMILARITY_THRESHOLD` env var on first boot (same pattern as other app_config settings)
- Dedup worker reads threshold from DB at job start (not worker creation) — changes take effect without restart
- UI: slider on Site Rules page (0.50-0.95 range, step 0.05)
- Keep `SIMILARITY_THRESHOLD` env var as fallback if DB key is missing

**Effective dedup control levers (all already exist, P6 just adds UI for the threshold):**

| Lever | Where | Effect |
|-------|-------|--------|
| Global similarity threshold | Site Rules UI (P6) | How similar articles must be to count as duplicates |
| Ingest interval per source | Source settings | High-quality sources fetched first → "first in wins" favors better content |
| Source curation per sector | Source management | Fewer overlapping sources = fewer duplicates to resolve |
| Dedup lookback window | Code constant (30 days) | How far back to compare — rarely needs changing |

**Edge case — threshold changes are forward-only:**
- Dedup is a one-time decision at embed time. Once marked `duplicate` or passed through, that decision is permanent.
- **Raising threshold** (looser, e.g., 0.65 → 0.80): only affects new articles. Old false-positive duplicates remain. Recovery: manual DB reset for affected articles.
- **Lowering threshold** (tighter, e.g., 0.85 → 0.65): new articles may get deduped more aggressively. Old articles unaffected.
- **UI note:** Show warning: "This affects new articles only. Previously deduped articles won't be re-evaluated."

**Effort:** Small — one app_config key, one DB read in worker, one UI slider, env migration
**Impact:** Medium — operator can tune dedup sensitivity without restart or SSH access

---

### P7: User Feedback Loop (Build After 500+ Scored Articles)

**Problem:** No way to detect if scoring is consistently wrong for certain sources or sectors.

**Solution:** Surface approval/rejection patterns from existing data. Don't auto-adjust — inform the operator.

**What to track:**
- Per-source: approval rate over time (e.g., "Reuters approved 90%, CryptoBlogs 30%")
- Per-sector: score distribution vs approval rate
- Score accuracy: what % of score-3 articles get manually approved vs rejected
- Interest signals: which topics get translated + posted most often (implicit priority indicators)

**Current state (verified):**
- `articles.pipeline_stage` tracks current state (approved/rejected/posted)
- `articles.approved_at` timestamp exists
- `articles.importance_score` + `articles.source_id` + `articles.sector_id` all present
- Sufficient for single-user aggregate queries without new tables

**Implementation:**
- Aggregate queries on existing `articles` table — no new tables needed for single-operator use
- Dashboard panels: "Source Quality" and "Scoring Accuracy"
- If/when multi-tenant: will need immutable `decision_events` table with actor/timestamp/action

**Operator actions this enables:**
- "Score-3 AI articles get approved 70% of the time" → maybe lower auto-approve threshold to 3 for that sector
- "Source X has 90% rejection rate" → disable it (or use P5 data to confirm)
- "Translation + posting skews toward topic Y" → add Y to `priorities[]` in scoring config so it scores higher automatically

**What this is NOT:**
- Not auto-adjusting scores (silent changes erode trust — you tune prompts explicitly)
- Not ML training (overkill at this stage)
- Not a weighted average formula (discussed and dropped — adds debugging complexity)

**Effort:** Small-medium — aggregate queries + dashboard display
**Impact:** Medium — helps tune scoring prompts with data instead of guessing. Only valuable after enough volume.

---

## Scoring Calibration Notes

Known issues affecting score accuracy, discovered during Gemini/Codex review:

### Default score 5 is too extreme for most sectors

The built-in score 5 definition reads: *"Breaking/Urgent — market-moving event, catastrophic incident, unprecedented regulatory action, critical infrastructure failure."* The few-shot example is a semiconductor fab fire halting global supply chains. This bar is so high that almost nothing qualifies. A major AI model release from Google correctly gets a 4, not a 5, under these defaults.

**Fix:** Customize `score5` definition and add sector-specific few-shot examples per sector via the Scoring Rules UI. Both fields are already supported in `scoring_rules.score_criteria` JSONB — no code change needed.

### "First in wins" dedup can kill the best version of a story

Pipeline order is: INGEST → DEDUP → SCORE. Dedup marks later duplicates without scoring them. If 20 sources report the same story, the first article to arrive gets scored — regardless of source quality. A weak snippet from a minor blog may win over Reuters' detailed version that arrives seconds later.

**Impact:** The scored article's title + snippet quality directly affects the LLM's score. A weak snippet = lower score for an important story.

**Mitigations:**
- Ensure high-quality sources have shorter `ingest_interval_minutes` so they're fetched first
- Don't set similarity threshold too aggressively — at 0.65, even loosely related articles get deduped
- Future improvement: after dedup clusters articles, pick the longest/richest snippet to score instead of the first chronologically

### Global similarity threshold (currently 0.65) may be too aggressive

Default is 0.85, but the instance is currently set to 0.65. This means articles only need to be 65% similar to be considered duplicates. Related-but-different articles (e.g., "Google releases new model" vs "Google's new model benchmarks analyzed") may get incorrectly deduped. Consider raising to 0.75-0.80 via the UI slider (P6) to find the right balance. Combine with source curation — fewer overlapping sources per sector means fewer borderline duplicates.

---

## Deployment Model

### Phase 1: Managed Instances (Current Plan)

- **Model:** Separate VPS per client ($10-20/month Hetzner)
- **Operator:** You install, configure sources/scoring, manage updates
- **Client access:** Dashboard URL with nginx basic auth (sufficient — you're the admin)
- **Ceiling:** Manageable up to ~5 clients before ops overhead becomes painful

**Needs building:**
- `.env.template` with all vars documented (partially exists as `.env.example`)
- Client setup script: `./setup-client.sh clientname` → provisions DB, runs migrations, seeds config
- Deploy-all script: pushes updates to all client VPSes
- Production docker-compose (API + worker + frontend + nginx)
- Automated DB backup (pg_dump cron)
- Health check monitoring (uptime robot or similar hitting `/api/health`)

**Currently exists:**
- `docker-compose.yml` (dev only — PostgreSQL + Redis)
- Dockerfiles for API and worker (multi-stage builds)
- `.env.example` with documented vars

### Phase 2: SaaS (Only If Demand Proves It)

- **Trigger:** 5+ clients asking for self-service, or ops overhead exceeding revenue
- **Requires:** Auth system, tenant_id on all tables, RBAC, billing, onboarding flow
- **Decision:** Make this call based on actual client feedback, not upfront speculation

---

## Source Type Expansion

**RSS is the core, but other sources already work:**

| Source Type | Works Today | Effort | Notes |
|-------------|-------------|--------|-------|
| Traditional RSS/Atom feeds | Yes | Zero | Core functionality |
| Reddit subreddits | Yes | Zero | `reddit.com/r/subreddit/.rss` — add as RSS source |
| Hacker News | Yes | Zero | RSS/Algolia API feeds available |
| Substack newsletters | Yes | Zero | Native RSS support |
| Twitter/X | No | High + $100+/mo API | Not worth it at current scale |
| LinkedIn monitoring | No | Impossible | No public feed API |

**Action:** Document Reddit/HN/Substack RSS URLs for client onboarding. Expands pitch without writing code.

---

## Pricing Strategy

- **Setup fee:** $500-1000 one-time (covers RSS source configuration, scoring rule tuning, social account wiring)
- **Monthly:** $300-500 depending on volume (sources, articles/day, platforms)
- **Positioning:** Sell the intelligence output, not the software. The daily digest and alerts are the product; the dashboard is proof it works.
- **Infrastructure cost per client:** ~$15 VPS + ~$10-30 LLM API (depends on source volume). Healthy margin at $300+/mo.
- **Sales channel:** LinkedIn outreach to agency founders, heads of content. Live demo with a compelling sector. 2-week free trial on a separate instance.

---

## Implementation Protocol — MANDATORY Before Every P

**The roadmap doc is a SPEC, not a script. The codebase is the ground truth.**

Before implementing ANY priority (P1-P7), follow this exact sequence. Do NOT skip steps. Do NOT blindly apply changes described in the spec without verifying them against the actual code first.

### Step 1: Task Decomposition
- Break the P into concrete, atomic tasks (e.g., "add column X to schema.ts", "modify UPDATE query in llm-brain.ts")
- List every file that will be touched
- Identify which tasks depend on which (ordering constraints)

### Step 2: Full Code Analysis
- Read EVERY file that will be modified — not summaries, not assumptions from the spec, the **actual current code**
- Read related/dependent files: if modifying a worker processor, also read the types it uses, the schema it writes to, the API that reads from it, the frontend that displays it
- Map the data flow end-to-end: where does the data originate → how does it transform → where does it get stored → how does it get read → how does it get displayed

### Step 3: Dependency Tree
- Build the dependency graph for the changes:
  - Schema changes → migration → worker writes → API reads → frontend displays
  - Shared types/constants → who imports them → what breaks if they change
- Identify cross-package dependencies (e.g., adding a field in `packages/db` affects `packages/worker`, `packages/api`, `packages/frontend`)
- Flag any assumptions in the spec that don't match the current code

### Step 4: Gap Analysis
- Compare what the spec says vs what the code actually does
- The spec was written at a point in time — code may have changed since
- Look for: renamed functions, moved files, changed signatures, new patterns introduced, deprecated approaches
- Document any discrepancies before writing a single line of code

### Step 5: Adjustment Plan
- Based on Steps 2-4, determine what ACTUALLY needs to change
- The spec's implementation notes are guidance, not gospel — if the code has a better pattern, use it
- If the spec says "modify line 335" but the code has been refactored and the logic is now on line 412, follow the code
- Confirm the plan before executing

### Step 6: Implement + Verify
- Make changes in dependency order (schema first, then worker, then API, then frontend)
- After each change: verify it doesn't break the build (`npm run build`)
- After all changes: run the full pipeline and verify end-to-end behavior
- Pipeline reset if needed (P1/P2 migration strategy)

**Why this matters:** The roadmap was verified against the codebase at writing time, but code evolves. A blind "apply the spec" approach will produce bugs when the code has drifted from what the spec assumed. Ground truth first, spec second.

---

## Build Order

```
Phase 1: Core quality (use it yourself, prove value)
──────────────────────────────────────────────────
1. P1: Persist score reasoning           (~2 hours — 4 code changes)
2. P2: RSS enrichment + pre-filter       (~1.5 days — ingest enrichment, hard reject, prompt update)
3. P5: Source quality dashboard           (~1 day)

Phase 2: Client-facing features
──────────────────────────────────────────────────
4. P3: Keyword alerts → Telegram          (~2-3 days)
5. P4: Daily digest + role/tone system     (~3-4 days — digest engine, LLM prompt, role customization, UI config)
6. Deployment template + scripts          (~1 day)

─── Ready to sell managed instances ───

Phase 3: Refinement (after first paying clients)
──────────────────────────────────────────────────
7. P6: Global dedup threshold in DB        (~0.5 day — app_config key, worker read, UI slider)
8. P7: Feedback loop analytics            (after 500+ scored articles)
```

---

## Sellability Checklist

Before approaching first client:

- [ ] P1: Score reasoning visible in dashboard
- [ ] P2: Keyword pre-filter active on at least one sector
- [ ] P3: Keyword alerts delivering via Telegram
- [ ] P4: Daily digest with client-specific analyst role delivering via Telegram
- [ ] Deployment script: new client instance in <1 hour
- [ ] Demo instance running with a compelling sector (e.g., "AI & Tech" or "Fintech")
- [ ] Professional domain + SSL (not raw IP)
- [ ] Landing page explaining the product (not the dashboard — a marketing page)

---

## Ideas Explored and Parked

These were discussed and evaluated — kept here for future reference:

| Idea | Verdict | Reason |
|------|---------|--------|
| AI avatar news videos (HeyGen) | Parked | Cool but expensive, audience reception uncertain. Test manually first with HeyGen web UI before automating. |
| Facebook comment auto-responder | Killed | Low volume doesn't justify automation. Spam detection risk. Manual replies are better at current scale. |
| Competitor price monitoring | Killed | Relies entirely on scraping. Sites block bots. Endless maintenance. |
| Georgian meeting minutes (STT) | Testing | Depends on Google STT Georgian accuracy. User to test with real audio. Strong idea if quality passes. |
| Tourism audio guide | Parked | Good concept but business depends on government venue partnerships, not tech. Validate with one free pilot first. |
| Restaurant menu translation | Parked | Low willingness to pay from Georgian restaurant owners. Maybe high-end Tbilisi only. |
| Government tender monitor | Worth exploring | tenders.ge is public structured data (not scraping). Construction companies check it manually. $50-100/month per subscriber. |
| Airbnb dynamic pricing (Georgia) | Worth exploring | Official APIs available. Thousands of hosts in Georgian FB groups. Easy to validate demand with one post. |
| Multi-tenant SaaS | Deferred | Only build if 5+ managed clients prove demand. Don't over-engineer upfront. |
| Full social listening (Twitter/X) | Deferred | API too expensive ($100+/mo). Reddit/HN covered via RSS. Revisit if clients specifically ask. |
| Email digest delivery | Deferred | Telegram first. Add SendGrid/Resend later if clients need email. |

---

## Technical Debt

| Issue | Impact | Status |
|-------|--------|--------|
| ~~Articles list shuffles on action~~ | ~~Annoying UX~~ | **FIXED** — tiebreaker sort in `articles.ts:98-102` |
| ~~Translation UI visible in English mode~~ | ~~Confusing for English clients~~ | **FIXED** — conditional rendering via `posting_language` |
| No deployment automation | Slow client setup | Dockerfiles exist, need production compose + setup script |
| No proper auth system (nginx basic auth) | Fine for managed instances, blocks SaaS | Defer until Phase 2 (SaaS) |
| No onboarding flow | You do setup manually per client | Acceptable for Phase 1 (managed instances) |
| No per-client cost tracking | Can't verify margins per client | Add LLM telemetry grouping by instance (low priority) |

---

## UI Changes Per Feature

Concrete UI additions/modifications needed for each priority item, mapped to existing pages.

### P1: Score Reasoning → Articles Page (`Articles.tsx`)

**Current:** Score column shows a colored badge (1-5). No explanation.
**Change:** Add reasoning tooltip or expandable row on score badge hover/click.
**Options:**
- Tooltip on hover (simplest — shows 1-2 sentence reasoning)
- Expandable row below article (more space, better for mobile)
- Both: tooltip for quick glance, click to expand full reasoning

**Also update:** Schedule Modal (`ScheduleModal.tsx`) — show reasoning alongside score when reviewing article for approval.

### P2: Pre-Filter + RSS Enrichment → LLM Brain Page (`ScoringRules.tsx`) + Articles Page

**Scoring Rules page changes:**
- **Current:** Has "Topics to Prioritize" (green tags) + "Topics to Ignore" (red tags) + score definitions + examples.
- **Change:** Add third tag section: "Hard Reject Keywords" (red/orange tags).
- **UI pattern:** Same tag-list + input as existing priorities/ignore — identical component, just a new section.
- **Label:** "Reject Before Scoring — articles matching these keywords or categories skip LLM entirely (saves cost)"
- **Placement:** Below "Topics to Ignore" section, visually distinct (orange to differentiate from soft ignore).

**Articles page changes:**
- Show `categories` as small chips/tags on each article row (when available)
- Helps operator see at a glance what tags are flowing through feeds
- Filterable: click a category tag to filter articles by that category

### P3: Keyword Alerts → NEW Tab or Section

**Current:** No alert UI exists anywhere.
**Options:**
- **Option A:** New tab in Site Rules page (Restrictions) — fits the "rules" concept
- **Option B:** New standalone nav item "Alerts" — more discoverable
- **Recommended:** Option A for now (less nav clutter), move to standalone page if it grows

**UI elements needed:**
- Alert rules list (keyword, min score threshold, Telegram chat ID, active toggle)
- Add rule form: keyword input + min score dropdown (1-5 or "any") + chat ID input
- Enable/disable toggle per rule
- Delete button per rule
- Recent matches indicator ("last triggered: 2h ago")

### P4: Daily Digest → Site Rules (New "Digest" Tab)

**Current:** No digest config exists anywhere.
**Change:** Add digest configuration panel as a new tab in Site Rules.
**Placement:** Site Rules page, new "Daily Digest" tab (alongside Emergency Controls, Translation Settings).

**UI elements (10 settings, "set and forget" alarm style):**

- Digest enabled/disabled master toggle
- Delivery time picker (hour + minute) + timezone selector
- Day selector: Mon-Sun checkboxes (default: all selected). Business clients uncheck Sat/Sun
  - Visual style: 7 pill buttons in a row (Mon|Tue|Wed|Thu|Fri|Sat|Sun), toggle on/off
- Telegram chat ID input (may differ from social posting chat)
- Language selector: dropdown (`English` / `Georgian`). Defaults to global `posting_language`. Help text: "Controls article language and executive summary language. Independent from social posting language."
- Min score threshold: dropdown (1-5, default 3)
- Max articles per digest: slider (5-30, default 15)
- Include score reasoning toggle (requires P1)
- Analyst role: textarea (max 300 chars) — the LLM persona
  - Placeholder: "Senior intelligence analyst providing a daily briefing on important developments"
  - Help text: "Describe who the analyst is, who they're briefing, and what style to use. This shapes the entire digest."
  - Preset buttons the operator can click to populate:
    - "VC Analyst" → pre-fills VC-focused role text
    - "PR Monitor" → pre-fills PR agency-focused role text
    - "Market Intel" → pre-fills trading desk-focused role text
    - "Corporate Strategy" → pre-fills strategy-focused role text
- "Send Test Digest" button — generates and delivers a digest immediately using current settings + today's articles. **Does NOT update `last_digest_sent_at`** (otherwise next real digest skips those articles)
- Status line below settings: "Next digest: Tomorrow 08:00 (Asia/Tbilisi)" / "Last sent: today 08:01"

### P5: Source Quality → Home Page (`Home.tsx`)

**Current:** Source cards show health dot (green/red/amber), domain, sector, interval. No scoring quality.
**Change:** Add signal ratio + score distribution to each source card.

**UI elements needed:**
- Signal ratio badge: % of articles scoring 4+ over 30 days — green (40%+), amber (15-40%), red (<15%)
- Mini score distribution bar: horizontal stacked bar showing proportion of 1s, 2s, 3s, 4s, 5s (color-coded)
- Article count label: "47 articles scored" (so you know if the ratio is statistically meaningful)
- Avg score as secondary metric (smaller text, below signal ratio)
- "Low signal" flag for sources with signal ratio < 10% AND 30+ scored articles
- Sortable: allow sorting source cards by signal ratio (best sources first)
- Tooltip on distribution bar: hover shows exact counts per score tier

### P6: Global Dedup Threshold → Site Rules Page

**Current:** Threshold is a hidden `.env` value. No visibility or control in dashboard.
**Change:** Add dedup sensitivity slider to Site Rules page (alongside Emergency Controls, Translation Settings).

**UI elements needed:**
- Slider (0.50 - 0.95 range, step 0.05), default from current `SIMILARITY_THRESHOLD` env var
- Label: "Dedup Sensitivity" with help tooltip: "Higher = more strict (only near-identical articles deduped). Lower = more aggressive (related articles also deduped)."
- Current value display (e.g., "0.85 — 85% similarity required")
- Warning text below slider: "Changes affect new articles only. Previously deduped articles won't be re-evaluated."
- Save button (writes to `app_config` key `similarity_threshold`)

### P7: Feedback Loop → Monitoring Page (`Monitoring.tsx`) or NEW Tab

**Current:** Monitoring shows pipeline health + source fetch status. No scoring analytics.
**Change:** Add analytics panels for scoring patterns.

**UI elements needed:**
- **Score Distribution Panel:** Bar chart — how many articles scored 1, 2, 3, 4, 5 over past 30 days
- **Approval Rate by Source:** Table — source name | total scored | approved % | avg score
- **Scoring Accuracy Panel:** Score bracket (1-5) × outcome (approved/rejected/manual) matrix
- **Interest Signals:** Which sectors/topics get translated + posted most (bar chart or ranked list)

**Placement:** Could be a new "Analytics" tab in Monitoring, or a dedicated "Intelligence" page. Keep it separate from operational health monitoring.

### No UI Change Needed

| Feature | Why |
|---------|-----|
| Score 5 calibration | Already configurable via Scoring Rules UI (score definitions + examples) |
| Source fetch priority | Already editable via `ingest_interval_minutes` on source cards |
| Reddit/HN as sources | Just add RSS URLs in existing source form — no UI change |
| Deployment scripts | Backend/ops tooling, no frontend impact |

---

## Analysis Sources

This roadmap was reviewed by Gemini (gemini-3-pro-preview) and Claude (opus-4-6) against the actual codebase.

**Round 1 findings (incorporated):**
- Score reasoning is 40% implemented (LLM layer done, persistence missing)
- Existing `ignore` list is soft (LLM hint), not a hard pre-filter
- Articles shuffle bug and Georgian UI visibility are already fixed
- Scoring config is richer than originally documented (priorities, ignore, examples, tone, style)
- Reddit/HN/Substack work as RSS sources today with zero code changes
- Separate VPS model is viable for ~5 clients before needing automation
- RSS `<category>` tags not extracted despite `rss-parser` parsing them automatically (`customFields.item` is empty)
- `content:encoded` (full article body) available via customFields but not captured — LLM scores on 500-char snippets when 1500 chars is available
- Category-based reject is more reliable than keyword matching for "Sponsored"/"Press Release" (these labels live in `<category>`, not in article text)

**Round 2: Gemini critical review (6 findings, 1 actioned, 1 incorporated, 4 dismissed):**

| # | Finding | Verdict | Action |
|---|---------|---------|--------|
| 1 | P6 effort underestimated for per-sector thresholds | **Correct** — Medium effort, not Small | **Actioned:** Per-sector dropped entirely. P6 simplified to global-in-DB (genuinely Small effort) |
| 2 | P2-A: Drizzle schema missing `array` import for `text[]` | **Wrong** — Drizzle supports `.array()` chain method natively, no separate import | Dismissed |
| 3 | P2-B: Zod schema must be updated before DB gets `reject_keywords` | **Trivially obvious** — standard implementation order | Dismissed |
| 4 | P1: Reasoning field needs array literal escape function in UNNEST pattern | **Correct** (but wrong reasoning — Drizzle parameterizes, so no SQL injection risk; escaping is for valid `text[]` formatting) | **Incorporated** into P1 implementation notes |
| 5 | P4: Clarify app_config KV storage pattern for digest settings | **Minor** — existing KV pattern works fine for 8 settings | Dismissed (existing pattern proven) |
| 6 | P2-B: Implementation location in llm-brain.ts confirmed correct | **Correct but shallow** — missed key insight: placement preserves dedup participation for hard-rejected articles | Dismissed (already documented correctly) |

**Round 2: Dedup architecture review (Claude, code-level analysis):**
- **Rejected articles DO participate in dedup** — `findSimilarArticles()` query excludes only `'duplicate'` and `'ingested'` stages. All other stages (including `rejected`) are valid comparison targets. This is correct.
- **Per-sector dedup dropped** — evaluated and rejected. Gray zone (0.80-0.92 similarity) is too small to justify Medium implementation effort. Source curation and ingest interval tuning are more effective sector-level controls.
- **Cross-sector dedup stays global** — an article in Crypto should still dedup against the same story in Stocks. Global comparison is correct behavior.
- **P2-B pre-filter + dedup interaction is safe** — pre-filtered articles never enter the pipeline (no embedding), so they can't be false dedup targets. Legitimate articles from other sources pass through correctly.
