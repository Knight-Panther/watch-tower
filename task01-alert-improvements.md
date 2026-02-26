# Task 01: Alert System — Production-Ready Improvements

## Context

Alerts are functional but have gaps that would hurt production use: no DB cleanup, hardcoded message format without article URL, unreliable regex-only keyword matching, no user guidance, and no visibility into what gets injected into LLM. This task makes alerts production-ready, semantically intelligent, and compelling for paying customers.

---

## Design Decisions

- **LLM-based keyword matching** — instead of regex matching after scoring, inject alert keywords INTO the LLM scoring prompt. The LLM already reads every article, scores it, and writes a summary — we add ~100 tokens to also check keyword relevance. The LLM returns `matched_alert_keywords[]` per article. This gives semantic matching for free: keyword "robot" matches an article about "Beijing humanoid manufacturer" even if the word "robot" never appears. Regex can't do this. Zero extra LLM calls.
- **Sector-linked alert rules** — optional `sector_id` on `alert_rules`. When scoring sector X's articles, only inject keywords from sector X's rules (+ global rules where sector_id is NULL). Sectors with no alert rules get zero extra tokens injected. Saves tokens at scale, improves accuracy (keyword "Tesla" in Stocks sector ≠ "Tesla" in Tech sector).
- **Advisory warning, not rate limiting** — alerts are "don't miss this" notifications. Silently dropping them defeats the purpose. Instead: deliver ALL alerts, track volume per chat ID, and send a single warning message when hourly volume exceeds a configurable threshold (default 30). User gets nudged to tighten keywords, but never misses an alert.
- **No retry logic** — by design, alerts are fire-and-forget instant notifications. Failed alerts get status `failed` with error message, that's it.
- **Remove regex category matching from alerts** — RSS categories are unreliable (generic "AI" tag on a datacenter article would false-match). With LLM matching, this is irrelevant — the LLM understands context and won't false-match.
- **Template as JSONB on alert_rules** — simple toggle-based config, NULL means defaults. Lighter than PostTemplateConfig.
- **Test alert via inline fetch** — API package can't import worker utils (dependency graph: api → db, shared only). Test endpoint makes direct Telegram API call (~15 lines, avoids circular dependency).
- **Dual-condition triggers: score threshold + keywords** — each rule has `min_score` (1-5) AND keywords. Both must match: article score >= min_score AND at least one keyword is semantically relevant. This lets users create rules like "alert me on anything scoring 4+ about OpenAI" or "alert me on ALL articles scoring 5 (critical)" by using broad keywords. The score filter is the first gate — cheap check before keyword matching even runs.
- **Single-word keywords recommended** — LLM handles semantic expansion, so users add individual words like "robot", "OpenAI", "CRISPR". Each rule fires if ANY keyword is semantically relevant. Pairs/phrases like "chinese robot" also work — the LLM understands context. But single words give broader coverage since the LLM expands meaning.
- **Alert keywords visible on LLM Brain page** — read-only card per sector showing which alert keywords get injected into the scoring prompt. Transparency: user sees exactly what the LLM receives.

---

## Phase 1: Schema + Worker Backend

### 1A. Add columns to `alert_rules`
**File:** `packages/db/src/schema.ts` (alertRules table)

Add after `updatedAt` column:
```typescript
sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "cascade" }),  // null = all sectors
template: jsonb("template"),                                    // AlertTemplateConfig | null
muteUntil: timestamp("mute_until", { withTimezone: true }),     // null = not muted
```

Then run: `npm run db:generate && npm run db:migrate`

All columns nullable — no backfill needed. NULL sectorId = global (matches all sectors). NULL template = use defaults. NULL muteUntil = not muted. Zero-downtime migration.

### 1B. Inject alert keywords into LLM scoring prompt
**File:** `packages/worker/src/processors/llm-brain.ts`

In the scoring flow (where the prompt is built per batch):

1. Determine which sector(s) are in the current batch
2. Fetch active alert rules: `WHERE (sector_id = batchSectorId OR sector_id IS NULL) AND active = true`
3. Collect unique keywords from those rules
4. If keywords exist, append to the scoring prompt:
   ```
   ALERT KEYWORDS: [robot, OpenAI, Tesla, CRISPR]
   For each article, check if any of these alert keywords are semantically relevant
   to the article's topic. Return matched keywords in the "matched_alert_keywords" field.
   Only include keywords that are clearly relevant — not just mentioned in passing.
   If no keywords match, return an empty array.
   ```
5. If no keywords for this sector → inject nothing, prompt unchanged, zero extra tokens

### 1C. Update LLM response schema
**File:** `packages/worker/src/processors/llm-brain.ts`

Add to the per-article Zod response schema:
```typescript
matched_alert_keywords: z.array(z.string()).default([]),
```

After parsing LLM response, pass `matchedAlertKeywords` through to the alert articles mapping:
```typescript
const alertArticles = successes.map((s) => ({
  articleId: s.id,
  title: claimed.title,
  llmSummary: s.summary,
  url: claimed.url,
  sectorName: claimed.sectorName,
  score: s.score,
  matchedAlertKeywords: s.matched_alert_keywords ?? [],
}));
```

### 1D. Rework alert-processor.ts
**File:** `packages/worker/src/processors/alert-processor.ts`

**Update ScoredArticle type** — remove `articleCategories`, add new fields:
```typescript
type ScoredArticle = {
  articleId: string;
  title: string;
  llmSummary: string | null;
  url: string;                      // for template "Read more" link
  sectorName: string | null;        // for template sector display
  score: number;
  matchedAlertKeywords: string[];   // from LLM response
};
```

**Replace regex matching with LLM-matched keywords.** Current logic iterates rules × keywords × regex. New logic:
```typescript
for (const article of articles) {
  if (article.matchedAlertKeywords.length === 0) continue;

  for (const rule of activeRules) {
    if (article.score < rule.minScore) continue;
    if (rule.muteUntil && new Date(rule.muteUntil) > new Date()) continue;

    // Find first keyword that both: LLM flagged AND rule contains
    const matchedKeyword = rule.keywords.find((kw) =>
      article.matchedAlertKeywords.some(
        (mk) => mk.toLowerCase() === kw.toLowerCase()
      )
    );
    if (!matchedKeyword) continue;

    // ... cooldown check, format, send (same as before)
  }
}
```

**Remove** the `matchesKeyword` import and all regex matching logic from this file.

**Add AlertTemplateConfig type + defaults:**
```typescript
type AlertTemplateConfig = {
  showUrl: boolean;      // "Read more →" link
  showSummary: boolean;  // LLM summary text
  showScore: boolean;    // "Score: 4/5 (High)" line
  showSector: boolean;   // Sector name in meta line
  alertEmoji: string;    // Default "🔔"
};

const DEFAULT_ALERT_TEMPLATE: AlertTemplateConfig = {
  showUrl: true, showSummary: true, showScore: true, showSector: true, alertEmoji: "🔔",
};
```

**Rewrite `formatAlertMessage`** to respect toggles:
- Always show: alert emoji + rule name + matched keyword
- Conditional: score badge, sector name, title (always), summary, URL link
- Read template from `rule.template` JSONB, merge with defaults via spread

### 1E. Advisory warning for high alert volume
**File:** `packages/worker/src/processors/alert-processor.ts`

After all alerts in a batch are sent, check volume:

1. Use Redis INCR on key `alert_volume:{chatId}` with 1-hour EXPIRE to track sends
2. Read `alert_warning_threshold` from appConfig (default: 30, configurable)
3. If count > threshold AND no warning sent recently (check Redis key `alert_warned:{chatId}`, 1hr TTL):
   - Send ONE warning message to that chat:
     ```
     ⚠️ High alert volume: {count} alerts in the last hour.
     Consider using more specific keywords to reduce noise.
     Manage rules → {alertsPageUrl}
     ```
   - Set `alert_warned:{chatId}` with 1hr TTL (so warning only fires once per hour)
4. No blocking, no dropping — every alert is still delivered

### 1G. Quiet hours check
**File:** `packages/worker/src/processors/alert-processor.ts`

Before sending any alerts in a batch:

1. Read `alert_quiet_start` and `alert_quiet_end` from appConfig (HH:MM format, null = disabled)
2. If both set and current time (in configured timezone) falls within the range → skip all alerts silently
3. Write `alert_deliveries` rows with status `quiet_hours` for audit trail
4. If either is null → quiet hours disabled, proceed normally

Note: quiet hours are global (not per-rule). Uses `alert_quiet_timezone` from appConfig (defaults to digest timezone).

### 1F. Add alert_deliveries TTL cleanup
**File:** `packages/worker/src/processors/maintenance.ts` (after digest_runs cleanup)

Import `alertDeliveries` from `@watch-tower/db`.

Add cleanup block (same pattern as other tables):
```typescript
// Alert deliveries cleanup
try {
  const alertDeliveriesTtlDays = await getConfigNumber(db, "alert_deliveries_ttl_days", 30);
  const alertDeliveriesCutoff = new Date(Date.now() - alertDeliveriesTtlDays * 86_400_000);
  await db.delete(alertDeliveries).where(lt(alertDeliveries.sentAt, alertDeliveriesCutoff));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[maintenance] alert_deliveries cleanup failed: ${msg}`);
  errors.push("alert_deliveries");
}
```

---

## Phase 2: API Routes

### 2A. Alert deliveries TTL endpoints
**File:** `packages/api/src/routes/config.ts`

- Add `alertDeliveriesTtl: { min: 1, max: 60, unit: "days" }` to CONSTRAINTS object
- Add `GET /config/alert-deliveries-ttl` → returns `{ days }` (default 30)
- Add `PATCH /config/alert-deliveries-ttl` → accepts `{ days: 1-60 }`
- Same getConfigValue/upsertConfig pattern as other TTL endpoints

### 2B. Alert warning threshold config endpoint
**File:** `packages/api/src/routes/config.ts`

- `GET /config/alert-warning-threshold` → returns `{ per_hour }` (default 30)
- `PATCH /config/alert-warning-threshold` → accepts `{ per_hour: 10-200 }`

This is an advisory threshold — not a rate limit. Controls when the "high volume" warning fires, not when alerts stop.

### 2G. Quiet hours config endpoints
**File:** `packages/api/src/routes/config.ts`

- `GET /config/alert-quiet-hours` → returns `{ start: "00:00" | null, end: "07:00" | null, timezone: "..." }`
- `PATCH /config/alert-quiet-hours` → accepts `{ start, end, timezone }` — both null = disabled
- Validate: start < end (or allow overnight wrap like 23:00–07:00), HH:MM format

### 2C. Update alerts.ts CRUD for new fields
**File:** `packages/api/src/routes/alerts.ts`

- Add `template`, `mute_until`, and `sector_id` to `mapRule` response
- Accept `template` and `sector_id` in POST and PUT body handlers
- Validate template shape loosely (JSONB, frontend enforces structure)
- Validate sector_id exists if provided

### 2D. Test alert endpoint
**File:** `packages/api/src/routes/alerts.ts`

`POST /alerts/:id/test`:
- Read rule from DB, get chatId + rule name + keywords
- Read `TELEGRAM_BOT_TOKEN` from env
- Direct `fetch` to `https://api.telegram.org/bot.../sendMessage` (NOT importing worker utils)
- Send formatted test message: "🛎️ Test Alert: {name}" + keyword list + min_score + sector name
- Return `{ sent: true }` or 502 with `{ sent: false, error: "Telegram rejected: ..." }`

### 2E. Mute/unmute endpoints
**File:** `packages/api/src/routes/alerts.ts`

- `POST /alerts/:id/mute` — body `{ hours?: number }` (default 24, max 168 = 1 week)
  - Sets `muteUntil = now + hours`, returns updated rule
- `POST /alerts/:id/unmute` — clears `muteUntil` to null, returns updated rule

### 2F. Sector keywords endpoint (for LLM Brain page)
**File:** `packages/api/src/routes/alerts.ts`

`GET /alerts/sector-keywords/:sectorId`:
- Fetch alert rules where `sector_id = sectorId OR sector_id IS NULL` and `active = true`
- Return `{ keywords: string[], rule_count: number }` (deduplicated keyword list)
- Lightweight — only returns what the LLM Brain page needs to display

---

## Phase 3: Frontend

### 3A. Alert deliveries TTL in Settings cleanup tab
**File:** `packages/frontend/src/api/config.ts` — add `getAlertDeliveriesTtl()` + `setAlertDeliveriesTtl(days)` functions

**File:** `packages/frontend/src/pages/Settings.tsx` — add row to DB cleanup table:
- State: `alertDeliveriesTtlDays` + `alertDeliveriesTtlError`
- Load in `Promise.all` alongside other TTLs
- Table row: "Alert Deliveries" | input (1-60) + "days" | human hint | Save | description
- Same pattern as existing Post Deliveries row

### 3B. Frontend API types + functions
**File:** `packages/frontend/src/api/alerts.ts`

- Add `AlertTemplateConfig` type (showUrl, showSummary, showScore, showSector, alertEmoji)
- Add `template: AlertTemplateConfig | null`, `mute_until: string | null`, and `sector_id: string | null` to `AlertRule` type
- Add functions: `testAlertRule(id)`, `muteAlertRule(id, hours)`, `unmuteAlertRule(id)`, `getSectorKeywords(sectorId)`
- Accept `template` and `sector_id` in create/update payloads

### 3C. Guidance box on Alerts page
**File:** `packages/frontend/src/pages/Alerts.tsx` (between header and CreateForm)

Info box explaining how alerts work:
- Each rule has **two triggers**: minimum score (1-5) AND keywords. Both must match — article must score at or above your threshold AND have a keyword match
- Set **min_score = 1** to alert on everything matching your keywords regardless of importance
- Set **min_score = 4 or 5** to only get alerts for high-importance matches (reduces noise)
- Keywords are matched **semantically by LLM** — "robot" will catch articles about humanoid manufacturers even if the word "robot" doesn't appear. Single words AND phrases both work
- Prefer **single specific words** ("OpenAI", "CRISPR", "Tesla") over vague terms ("AI", "tech")
- Assign a **sector** to scope alerts — keywords only get checked against that sector's articles (saves cost, improves accuracy)
- Alerts fire immediately after LLM scoring — no scheduling delay
- 5-minute cooldown prevents duplicates per rule+article pair
- Use **Test** button to verify your chat ID works before waiting for a real match
- You'll get a warning if alert volume is high — tighten keywords or raise threshold in Settings

### 3D. Template toggles in CreateForm + EditForm
**File:** `packages/frontend/src/pages/Alerts.tsx`

Collapsible "Customize message template" section in both forms (before submit button):
- Checkboxes: Show article URL, Show LLM summary, Show score badge, Show sector name
- Emoji input field (max 4 chars)
- All default to ON, emoji defaults to "🔔"
- Add `template: AlertTemplateConfig` to form state types

### 3E. Sector selector in CreateForm + EditForm
**File:** `packages/frontend/src/pages/Alerts.tsx`

- Add sector dropdown (same as LLM Brain page selector) with an "All sectors" option (null)
- Load sectors list on mount (reuse `listSectors` from API)
- Display sector name as a badge on RuleCard in display mode

### 3F. Test button + Mute button on RuleCard
**File:** `packages/frontend/src/pages/Alerts.tsx`

Display mode action buttons (alongside Active/Edit/Delete):
- **Test** — calls `testAlertRule(id)`, shows toast success/failure
- **Mute** — dropdown with selectable durations: 1h, 4h, 12h, 24h, 48h
- **Unmute** — shown when `rule.mute_until > now`, clears mute
- When muted: amber indicator "Muted until {date}" below rule name
- Add `isTesting` and `isMuting` loading states

### 3H. Warning threshold + quiet hours + alert count on Alerts page
**File:** `packages/frontend/src/pages/Alerts.tsx`

**Page header stat**: "42 alerts sent this week" — fetch count from API (new lightweight endpoint or derive from delivery history).

**Settings section** (collapsible, below guidance box or at bottom of page):
- **Warning threshold**: input (10-200) + "per hour" label + Save — controls when Telegram warning fires
- **Quiet hours**: two time pickers (start + end) + timezone selector + Save — leave empty to disable
- Both read/write via config endpoints (2B, 2G)

### 3G. Alert keywords card on LLM Brain page
**File:** `packages/frontend/src/pages/ScoringRules.tsx`

Read-only card between "Reject Before Scoring" and "Score Definitions" sections:

```
┌──────────────────────────────────────────────────┐
│ 🔔 Alert Keywords (from Alert Rules)             │
│ Injected into LLM prompt for this sector.        │
│                                                  │
│  [OpenAI] [Tesla] [CRISPR]       ← read-only    │
│                                                  │
│  From 2 active rules · Manage on Alerts page →   │
│                                                  │
│  — or if empty: —                                │
│  No alert rules for this sector. Create one →    │
└──────────────────────────────────────────────────┘
```

- Fetch `GET /alerts/sector-keywords/:sectorId` when sector changes
- Display as blue/violet read-only tags (visually distinct from green/red/orange)
- Link to `/alerts` page for management
- Shows rule count for context ("From 2 active rules")

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `packages/db/src/schema.ts` | Add `sectorId`, `template` JSONB, `muteUntil` timestamp to alertRules |
| `packages/worker/src/processors/llm-brain.ts` | Fetch alert keywords per sector, inject into prompt, add `matched_alert_keywords` to response schema, pass to alertArticles |
| `packages/worker/src/processors/alert-processor.ts` | Replace regex with LLM-matched keywords, add template rendering, mute check, advisory warning, updated ScoredArticle type |
| `packages/worker/src/processors/maintenance.ts` | Add alert_deliveries TTL cleanup block |
| `packages/api/src/routes/config.ts` | Alert TTL + warning threshold config endpoints |
| `packages/api/src/routes/alerts.ts` | Template + sector_id in CRUD, test endpoint, mute/unmute, sector-keywords endpoint |
| `packages/frontend/src/api/alerts.ts` | Types + test/mute/unmute/sectorKeywords API functions |
| `packages/frontend/src/api/config.ts` | Alert deliveries TTL functions |
| `packages/frontend/src/pages/Settings.tsx` | Alert Deliveries TTL row in DB cleanup tab |
| `packages/frontend/src/pages/Alerts.tsx` | Guidance box, sector selector, template UI, test button, mute |
| `packages/frontend/src/pages/ScoringRules.tsx` | Read-only alert keywords card per sector |

---

## Verification

1. `npm run db:generate && npm run db:migrate` — migration applies cleanly
2. `npm run build` — all 9 packages compile
3. Manual: Create rule with sector + keywords → go to LLM Brain page → verify keywords shown in read-only card
4. Manual: Trigger scoring for that sector → check worker logs for `matched_alert_keywords` in LLM response
5. Manual: Verify alert fires for semantic match (keyword "robot", article about "humanoid manufacturer")
6. Manual: Create rule with custom template (URL off) → verify alert message has no link
7. Manual: Click **Test** on a rule → verify Telegram message received in target chat
8. Manual: Mute (select 1h) → trigger scoring → verify no alert sent → **Unmute** → verify alerts resume
9. Manual: Settings > DB Cleanup tab → verify "Alert Deliveries" row appears, save TTL value
10. Manual: Trigger high volume (>30/hr) → verify single warning message sent, not repeated
11. Manual: Set quiet hours (00:00–07:00) → trigger scoring during that window → verify alerts skipped with `quiet_hours` status
12. Manual: Verify "X alerts sent this week" counter in Alerts page header
13. Manual: Verify warning threshold + quiet hours controls on Alerts page

---

## Resolved Decisions

- **Mute hours**: Selectable dropdown — 1h, 4h, 12h, 24h, 48h (not just one-click)
- **Warning threshold visibility**: Show on Alerts page itself (not hidden in Settings)
- **Quiet hours**: Yes — customizable time range (e.g., 00:00–07:00), can be left empty (disabled). Stored in `app_config` as `alert_quiet_start` + `alert_quiet_end` (HH:MM format, null = disabled)
- **Alert count stat**: Yes — informational counter in Alerts page header ("42 alerts sent this week")
- **LLM keyword expansion at creation time**: Dropped — no longer needed since LLM does semantic matching at scoring time. Typing "robotics" already catches "robot", "humanoid", etc.
