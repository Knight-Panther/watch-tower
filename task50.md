# Task 50: Manual "Translate" Button for Individual Articles

## Goal

Add a "Translate" button in the Articles UI that lets the user manually trigger Georgian translation for a specific article, bypassing the automatic score-based filter. Once translated, the article flows through the existing Georgian pipeline (image gen → distribution) as if it had been auto-translated.

## Motivation

Currently, translation only runs for articles whose `importance_score` matches `translation_scores` in `app_config` (e.g., [4, 5]). If the user likes a score-3 article but `translation_scores` is [4, 5], there's no way to translate it. In Georgian mode (`posting_language = "ka"`), untranslated articles cannot be posted — the distribution worker blocks them. This feature bridges that gap.

---

## Implementation Plan

### 1. New Translation Status Value: `"queued"`

No schema change needed. Add `"queued"` as a new string value for the existing `translation_status` text column.

**Updated state machine:**
```
NULL ───► queued ───► translating ───► translated  (success)
  │                       │
  │                       ▼
  └──── failed ────────► exhausted  (≥5 attempts)
```

`"queued"` means: user explicitly requested translation, bypass score/backfill filters.

### 2. API Endpoint: `POST /articles/:id/translate`

**File:** `packages/api/src/routes/articles.ts`

```
POST /articles/:id/translate
```

**Request:** No body needed.

**Response (200):**
```json
{
  "id": "uuid",
  "translation_status": "queued"
}
```

**Validation (return 400/409):**
| Check | Error | Code |
|-------|-------|------|
| Article not found | `"Article not found"` | 404 |
| `llm_summary IS NULL` | `"Article has not been scored yet"` | 400 |
| `translation_status = 'queued'` | `"Translation already queued"` | 409 |
| `translation_status = 'translating'` | `"Translation already in progress"` | 409 |
| `translation_status = 'translated'` | `"Article already translated"` | 409 |
| `posting_language !== 'ka'` | `"Georgian mode is not active"` | 400 |

**DB Update (atomic):**
```sql
UPDATE articles
SET
  translation_status = 'queued',
  translation_attempts = 0,    -- reset for fresh start (important for exhausted articles)
  translation_error = NULL,     -- clear previous error
  title_ka = NULL,              -- clear stale translation (for re-translate scenario)
  llm_summary_ka = NULL
WHERE id = $id::uuid
  AND llm_summary IS NOT NULL
RETURNING id, translation_status
```

**Why reset `translation_attempts` to 0?** This allows `exhausted` articles (which hit 5 attempts) to get a fresh set of retries when the user explicitly requests translation.

**Why clear `title_ka`/`llm_summary_ka`?** Supports future "re-translate" use case. Also, the worker's claim query has `AND title_ka IS NULL` — if we don't clear these, the worker won't pick up previously translated articles.

### 3. Worker Claim Query Modification

**File:** `packages/worker/src/processors/translation.ts` (line ~134-159)

The current WHERE clause filters by `importance_score = ANY($scores)`, `created_at > $enabledSince`, and `(translation_status IS NULL OR translation_status = 'failed')`.

**Modified claim query:**
```sql
UPDATE articles
SET
  translation_status = 'translating',
  translation_attempts = translation_attempts + 1,
  translated_at = NOW()          -- claim timestamp (overwritten on completion)
WHERE id IN (
  SELECT id FROM articles
  WHERE (
    -- Normal auto-translation path (score-based)
    (
      importance_score = ANY($scores)
      AND (translation_status IS NULL OR translation_status = 'failed')
      AND created_at > $enabledSince
    )
    -- Manual translate path (user-requested, bypass score + backfill filters)
    OR translation_status = 'queued'
  )
  AND llm_summary IS NOT NULL
  AND title_ka IS NULL
  AND scored_at IS NOT NULL
  AND translation_attempts < $MAX_TRANSLATION_ATTEMPTS
  ORDER BY
    -- Prioritize manually queued articles (user is waiting)
    CASE WHEN translation_status = 'queued' THEN 0 ELSE 1 END,
    created_at ASC
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING ...
```

**Key changes:**
- `OR translation_status = 'queued'` — bypasses score filter AND `enabledSince` backfill guard
- `translated_at = NOW()` — stamps claim time so zombie reset has a reliable "how long ago was this claimed?" reference (see §4)
- Priority ordering: queued articles first (user is watching the UI)
- All shared guards remain: `llm_summary IS NOT NULL`, `title_ka IS NULL`, `scored_at IS NOT NULL`, `translation_attempts < 5`

### 4. Maintenance Worker: Fix Zombie Reset Timestamp (CRITICAL)

**File:** `packages/worker/src/processors/maintenance.ts` (line ~213-247)

**Bug (found by Codex review):** The current zombie reset uses `created_at` to decide if a `translating` article is stuck:
```sql
-- CURRENT (broken for old articles)
WHERE translation_status = 'translating'
  AND created_at < ${staleThreshold}     -- staleThreshold = now() - 10 min
```
`created_at` reflects when the article was **ingested**, not when translation was claimed. For a 2-week-old article that was just manually queued and claimed 1 second ago, `created_at < (now - 10min)` is **always true** → maintenance immediately resets it to NULL, killing the in-progress translation.

**Fix:** Change both zombie checks to use `translated_at` instead of `created_at`. The claim query (§3) now sets `translated_at = NOW()` on claim, so this accurately reflects "when translation started."

```sql
-- FIXED: use translated_at (set during claim)
UPDATE articles
SET translation_status = NULL
WHERE translation_status = 'translating'
  AND translated_at < ${staleThreshold}

-- Same fix for failed reset
UPDATE articles
SET translation_status = NULL
WHERE translation_status = 'failed'
  AND translated_at < ${failedThreshold}
```

**Why this works:** `translated_at` is set to `NOW()` when the worker claims the article (§3), then overwritten with the actual completion time on success. If the worker crashes, `translated_at` stays at claim time, and after 10 minutes maintenance correctly identifies it as stuck. For old articles that were just claimed, `translated_at` = seconds ago → NOT less than the 10-min threshold → safe from zombie reset.

**Note:** `'queued'` status is still NOT touched by maintenance. It safely waits for the worker.

### 5. Frontend: API Client Function

**File:** `packages/frontend/src/api.ts`

```typescript
export const translateArticle = async (
  id: string,
): Promise<{ id: string; translation_status: string }> => {
  const res = await fetch(`${API_URL}/articles/${id}/translate`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to queue translation");
  }
  return res.json();
};
```

### 6. Frontend: "Translate" Button in Articles Table

**File:** `packages/frontend/src/pages/Articles.tsx`

Add a "Translate" button in the Actions column (`<td>` at ~line 717).

**Button visibility conditions (ALL must be true):**
- `postingLanguage === "ka"`
- `article.llm_summary !== null` (article has been scored)
- `article.translation_status` is one of: `null`, `"failed"`, `"exhausted"`
- `article.pipeline_stage` is one of: `"scored"`, `"approved"`, `"posted"` (not `rejected`, `duplicate`, `ingested`, `embedded`)

**Button should NOT show when:**
- `postingLanguage === "en"` (Georgian mode off)
- `translation_status === "translated"` (already done)
- `translation_status === "translating"` (in progress)
- `translation_status === "queued"` (already queued)
- Article has no `llm_summary` (not scored yet)

**Button styling:** Similar to existing action buttons (teal/cyan color to distinguish from approve/reject).

**Click handler:**
```typescript
const handleTranslate = async (article: Article) => {
  try {
    await translateArticle(article.id);
    toast.success("Translation queued");
    loadArticles(); // refresh to show updated status
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue translation";
    toast.error(message);
  }
};
```

**Inline status indicator** (already exists in the Title/Summary column but ensure `"queued"` is handled):
- `translation_status === "queued"` → show "Translation queued..." with a subtle indicator (similar to existing "Translating..." for `translating` status)

---

## Edge Cases & Potential Bugs

### Edge Case 1: Article Older Than `translation_enabled_since`
**Scenario:** User switched to Georgian mode today, but wants to translate a week-old article.
**Risk:** Worker's `created_at > $enabledSince` filter would block it.
**Solution:** The `OR translation_status = 'queued'` branch bypasses the `enabledSince` check entirely. Manually queued articles are exempt from the backfill guard.

### Edge Case 2: Article Score Not In `translation_scores`
**Scenario:** `translation_scores = [4, 5]`, article has score 3.
**Risk:** Worker's `importance_score = ANY($scores)` filter would block it.
**Solution:** Same as above — `queued` status bypasses the score filter.

### Edge Case 3: `exhausted` Article Retry
**Scenario:** Article failed translation 5 times (status = `exhausted`). User clicks "Translate" to retry.
**Risk:** Worker's `translation_attempts < 5` would block it.
**Solution:** API resets `translation_attempts = 0` when setting `queued`. The article gets a fresh 5-attempt budget.

### Edge Case 4: Double-Click / Concurrent Requests
**Scenario:** User clicks "Translate" twice rapidly.
**Risk:** Two API calls hit the server. First one succeeds, second should be idempotent.
**Solution:** API returns 409 Conflict if `translation_status` is already `queued` or `translating`. Frontend disables the button after first click (optimistic UI update via `loadArticles()`).

### Edge Case 5: Worker Not Running / No API Key
**Scenario:** User clicks "Translate" but the worker has no translation API key configured.
**Risk:** Article stays in `queued` state forever.
**Solution:** The API endpoint should check `posting_language === "ka"` before allowing the queue. The actual API key check happens at worker level — if no key, the worker logs a warning and skips. The article will remain `queued` until the worker gets a key. This is acceptable — no data loss, just delayed. Optionally, a future enhancement could show "No translation API key configured" as a warning.

### Edge Case 6: `posting_language` Switches to `"en"` After Queuing
**Scenario:** User queues translation, then switches posting_language to "en" before the worker picks it up.
**Risk:** Worker early-exits with `if (config.postingLanguage !== "ka") return` — the `queued` article is never processed.
**Solution:** This is actually acceptable behavior. If the user switched back to English mode, they presumably no longer need Georgian translation. The `queued` status stays inert. If they switch back to `"ka"`, the worker will pick it up again. No data loss. Optionally, the API could clear `queued` status when switching to English (future enhancement).

### Edge Case 7: Article in `scored` Stage After Translation
**Scenario:** Score-3 article is `scored` (not approved). User manually translates it.
**Risk:** After translation, the worker's chaining logic checks `if (article.pipelineStage === "approved")` — only approved articles get auto-distributed. Scored articles do NOT get auto-distributed.
**Solution:** This is correct behavior. The user still needs to click "Schedule" to manually schedule the post. The translation just prepares the Georgian text. The existing `handleSchedule` in Articles.tsx already passes `title_ka`/`llm_summary_ka` when scheduling in Georgian mode.

### Edge Case 8: Article in `approved` Stage After Translation
**Scenario:** Score-4 article is auto-approved but `translation_scores = [5]` (not in list). User manually translates it.
**Risk:** After translation, the worker chains to distribution (image gen or direct). This is auto-posting.
**Solution:** This is the intended behavior per the user's requirement ("treat it with the existing logic"). If auto-post platforms are enabled, the translated+approved article will be auto-posted. If the user doesn't want auto-posting, they should disable the auto-post toggles first.

### Edge Case 9: Maintenance Zombie Reset vs Old Articles (CRITICAL FIX)
**Scenario:** User manually translates a 2-week-old article. Worker claims it (`translating`). Maintenance runs 30s later.
**Risk (original bug):** Zombie reset used `created_at` — old articles are immediately reset to NULL, killing in-progress translation. If the API call then fails, `failed` → NULL by maintenance, but score doesn't match auto-translate range → article is stuck.
**Solution:** Claim query now sets `translated_at = NOW()`. Zombie reset checks `translated_at` instead of `created_at`. This accurately reflects "how long has this been claimed?" regardless of article age. See §4 for full fix.

**Note:** `queued` status is still NOT touched by maintenance — only `translating` and `failed` are reset.

### Edge Case 10: Worker Picks Up `queued` Article, Translation Fails
**Scenario:** Manual translation attempt fails (API error).
**Risk:** Does it follow the normal retry path?
**Solution:** Yes. The worker sets `translation_status = 'failed'` (or `'exhausted'` if max attempts hit). The article goes through the exact same retry lifecycle as auto-translated articles. Maintenance will reset `failed` → NULL after `translation_retry_minutes`, worker picks it up again.

### Edge Case 11: Race Between Auto-Translation and Manual Queue
**Scenario:** `translation_scores = [3, 4, 5]` and user manually translates a score-3 article that the worker would also auto-translate.
**Risk:** Both the auto path (score match) and manual path (queued) could claim it.
**Solution:** `FOR UPDATE SKIP LOCKED` prevents double-claim. Only one path wins. Since we prioritize `queued` in the ORDER BY, the manual request gets served first. No conflict.

### Edge Case 12: UI Shows "Translate" for Already Auto-Translating Articles
**Scenario:** Article's score matches `translation_scores` and is currently being auto-translated (`translation_status = 'translating'`).
**Risk:** UI might still show the Translate button.
**Solution:** Button visibility excludes `translating` and `queued` statuses. Only shows for NULL, `failed`, `exhausted`.

---

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `packages/api/src/routes/articles.ts` | Add `POST /articles/:id/translate` endpoint |
| 2 | `packages/worker/src/processors/translation.ts` | Modify claim query: add `queued` path + set `translated_at = NOW()` on claim + priority ordering |
| 3 | `packages/worker/src/processors/maintenance.ts` | Fix zombie reset: `created_at` → `translated_at` in both translating + failed checks |
| 4 | `packages/frontend/src/api.ts` | Add `translateArticle()` function |
| 5 | `packages/frontend/src/pages/Articles.tsx` | Add "Translate" button + `queued` status display |

**No schema migration needed.** The `translation_status` column is a text field — `"queued"` is just a new string value. `translated_at` already exists.

**No new BullMQ jobs needed.** The existing repeatable `translation-batch` job (every 15s) picks up `queued` articles via the modified claim query.

**No changes to:** distribution.ts, llm-brain.ts, image-generation.ts, or any downstream worker. They all handle translated articles the same way regardless of how the translation was triggered.

---

## Testing Plan

1. **Happy path**: Georgian mode ON, translation_scores=[4,5], score-3 article → click Translate → verify `translation_status` goes `queued` → `translating` → `translated` → Georgian text appears in UI
2. **Exhausted retry**: Manually create an `exhausted` article → click Translate → verify attempts reset to 0 → translation proceeds
3. **Double-click guard**: Click Translate twice fast → first succeeds, second returns 409
4. **English mode guard**: Switch to `posting_language = "en"` → verify Translate button disappears
5. **Approved article chain**: Approve a score-4 article, translation_scores=[5] → click Translate → verify it chains to distribution after translation
6. **Scored article no-chain**: Score-3 `scored` article → click Translate → verify it does NOT auto-distribute → user must Schedule manually
7. **Old article bypass**: Article older than `translation_enabled_since` → click Translate → verify worker picks it up (backfill guard bypassed)
