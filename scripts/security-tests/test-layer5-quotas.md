# Layer 5: Article Quotas Test (Manual)

Tests that article quotas are enforced:
- Per-fetch limit (default: 100 articles)
- Daily limit per source (default: 500 articles/day)

## Why Manual?

Testing quotas requires:
- A source with many articles (> 100)
- Running the ingest pipeline multiple times
- Checking database counts

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_ARTICLES_PER_FETCH` | 100 | Max articles per single fetch |
| `MAX_ARTICLES_PER_SOURCE_DAILY` | 500 | Max articles per source per day |

Source-specific overrides can be set via:
- `rss_sources.max_articles_per_fetch`
- `rss_sources.max_articles_per_day`

## Test Steps

### Test A: Per-Fetch Limit

1. Find a source with many articles (> 100):
   ```sql
   -- Check which sources have the most articles
   SELECT s.name, s.url, COUNT(a.id) as article_count
   FROM rss_sources s
   LEFT JOIN articles a ON a.source_id = s.id
   GROUP BY s.id
   ORDER BY article_count DESC
   LIMIT 10;
   ```

2. Or add a high-volume RSS feed:
   - Hacker News: `https://hnrss.org/frontpage` (limited)
   - Reddit: `https://www.reddit.com/r/news/.rss` (many items)

3. Trigger ingest and check worker logs:
   ```bash
   LOG_LEVEL=debug npm run dev:worker
   ```

4. Look for quota-related logs:
   ```
   [ingest] articles limited by quota
   original: 150, limited: 100
   ```

5. Verify in database:
   ```sql
   -- Check articles added in the last fetch
   SELECT source_id, COUNT(*) as count, MAX(created_at) as last_fetch
   FROM articles
   WHERE created_at > NOW() - INTERVAL '5 minutes'
   GROUP BY source_id;
   ```

### Test B: Daily Limit

1. Set a low daily limit for testing:
   ```sql
   -- Set a specific source to have a low daily limit
   UPDATE rss_sources
   SET max_articles_per_day = 10
   WHERE name = 'Your Test Source';
   ```

2. Trigger multiple ingests for that source.

3. After the first fetch adds 10 articles, subsequent fetches should log:
   ```
   [ingest] daily quota exhausted, skipping
   dailyUsed: 10, dailyLimit: 10
   ```

4. Verify in database:
   ```sql
   -- Count today's articles for a source
   SELECT COUNT(*) as today_count
   FROM articles
   WHERE source_id = 'your-source-id'
     AND created_at >= CURRENT_DATE;
   ```

### Test C: Source-Specific Override

1. Set a source with custom limits:
   ```sql
   -- Give one source a higher limit
   UPDATE rss_sources
   SET max_articles_per_fetch = 200,
       max_articles_per_day = 1000
   WHERE name = 'High Volume Source';
   ```

2. Verify the override is used (check worker logs):
   ```
   [quota] article quota calculated
   perFetchLimit: 200, dailyLimit: 1000
   ```

## Verification Queries

```sql
-- Check quota usage for all sources today
SELECT
  s.name,
  s.max_articles_per_fetch,
  s.max_articles_per_day,
  COUNT(a.id) as articles_today
FROM rss_sources s
LEFT JOIN articles a ON a.source_id = s.id
  AND a.created_at >= CURRENT_DATE
GROUP BY s.id
ORDER BY articles_today DESC;

-- Check recent fetch runs with quota info
SELECT
  s.name,
  f.item_count as items_in_feed,
  f.item_added as items_inserted,
  f.error_message,
  f.finished_at
FROM feed_fetch_runs f
JOIN rss_sources s ON s.id = f.source_id
ORDER BY f.finished_at DESC
LIMIT 20;
```

## Expected Behavior

| Scenario | Expected Result |
|----------|-----------------|
| Feed has 150 items, limit is 100 | Only 100 inserted, log shows "limited by quota" |
| Daily limit reached | Zero inserted, log shows "daily quota exhausted" |
| Source-specific override | Uses source's limit instead of global default |
| No override set | Uses global `MAX_ARTICLES_PER_*` from env |

## Worker Log Examples

**Per-fetch limit applied:**
```
[ingest] articles limited by quota
  sourceId: abc-123
  original: 157
  limited: 100
  perFetchLimit: 100
  dailyRemaining: 400
```

**Daily limit exhausted:**
```
[ingest] daily quota exhausted, skipping
  sourceId: abc-123
  dailyUsed: 500
  dailyLimit: 500
```

## Pass Criteria

- [ ] Per-fetch limit enforced (no more than limit inserted per fetch)
- [ ] Daily limit enforced (quota resets at midnight)
- [ ] Source-specific overrides respected
- [ ] Global defaults used when no override set
- [ ] Appropriate logs generated for quota events
- [ ] fetch_runs table shows correct item_count vs item_added
