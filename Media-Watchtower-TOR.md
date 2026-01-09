# Media Watchtower Agent – Technical Terms of Reference (TOR)
## MVP Scope for n8n + Supabase + OpenAI

**Project:** Media Watchtower – Automated RSS Content Deduplication, Summarization, and Social Posting  
**Version:** 1.0 (MVP)  
**Date:** January 2026  
**Status:** Development Specification  

---

## 1. Executive Summary

Build an automated n8n workflow that:
- Monitors RSS feeds for new articles
- Deduplicates content using vector embeddings (semantic similarity)
- Filters by age and semantic relevance
- Generates summaries and importance scores (seismic scoring)
- Intelligently posts to Facebook based on priority and frequency limits

This TOR defines **MVP scope** (minimal viable product) and flags areas requiring adjustment as the system scales or adds features post-launch.

---

## 2. Project Scope

### 2.1 In Scope (MVP)

#### Infrastructure & Storage
- **n8n** (self-hosted): workflow orchestration
- **Supabase** (PostgreSQL + pgvector): articles storage, RSS source config, embeddings
- **OpenAI API**: embeddings (text-embedding-3-small) + chat completions (GPT-4 or GPT-4 Turbo)
- **Facebook Graph API**: posting to a single Facebook page

#### Core Workflows
1. **Flow A – Ingestion & Deduplication** (scheduled, runs every 15–60 min, configurable)
2. **Flow B – Posting Scheduler** (scheduled, runs every hour)
3. Optional **Flow C – Maintenance** (backfill, archive cleanup, manual overrides)

#### Data Processing
- RSS feed parsing and content extraction
- Date-based filtering (skip articles older than X days)
- Single-pass vector embedding (title + description/body)
- Semantic duplicate detection (cosine similarity threshold)
- LLM-driven summarization and seismic scoring (1–5 scale)
- Category inference (optional, best-effort)

#### Configuration
- RSS source list stored in Supabase (not Google Sheets initially)
- Global settings table: thresholds, post quotas, scoring rubric
- Per-source settings: max article age, custom categories

### 2.2 Out of Scope (MVP) – Future Enhancements

- **UI/Dashboard:** Supabase dashboard suffices; no custom web interface.
- **Multi-destination posting:** Only Facebook; Twitter/X, LinkedIn, Telegram in v2+.
- **Advanced deduplication:** No recursive embeddings, hierarchical clustering, or multi-stage filtering.
- **Manual editorial UI:** No approval queue UI; status updates done via SQL/Supabase dashboard.
- **Analytics dashboard:** No metrics visualization; logs and Supabase query results only.
- **Content curation rules:** No domain-specific heuristics; LLM score is source of truth.
- **Image/video handling:** Text-only; attachments handled in v2+.
- **Multilingual support:** Assume English RSS feeds; i18n in v2+.
- **Webhook-based ingestion:** Cron-only; event-driven triggers in v2+.

---

## 3. Technical Architecture

### 3.1 Data Model (Supabase PostgreSQL)

#### Table: `articles`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NO | Primary key (auto-gen) |
| `url` | text | NO | Unique constraint; exact deduplication layer |
| `source` | text | NO | RSS source name (FK to `rss_sources.id`) |
| `title` | text | NO | Article title from RSS |
| `published_at` | timestamptz | NO | From RSS pubDate or fallback |
| `created_at` | timestamptz | NO | Default: `now()` |
| `raw_content` | text | YES | Full article text (for re-processing in future) |
| `summary` | text | NO | LLM-generated summary (500 chars max, MVP) |
| `embedding` | vector(1536) | NO | OpenAI embeddings (text-embedding-3-small) |
| `seismic_score` | smallint | NO | 1–5, set by LLM; no NULL |
| `seismic_reason` | text | YES | Short explanation from LLM (why score 4 vs 5) |
| `category` | text | YES | Inferred by LLM (tech, biotech, etc.); best-effort |
| `status` | text | NO | Enum-like: `new`, `queued`, `posted`, `rejected_duplicate`, `rejected_stale`, `expired`, `approved_manual` |
| `duplicate_of_id` | uuid | YES | FK to `articles.id`; set if rejected as semantic duplicate |
| `rejection_reason` | text | YES | Why rejected: `semantic_duplicate`, `too_old`, `exact_url_match`, etc. |
| `posted_at` | timestamptz | YES | When posted to Facebook |
| `posted_to_facebook_id` | text | YES | Facebook post ID for tracking |

**Indexes:**
- PK: `id`
- Unique: `url`
- Index: `(status, seismic_score DESC, published_at DESC)` – for posting scheduler query
- Index: `(created_at DESC)` – for recent articles query
- Vector index on `embedding` using pgvector (IVFFlat or HNSW, depending on table size)

---

#### Table: `rss_sources`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | text | NO | PK; e.g., `"techcrunch_main"`, `"arxiv_ai"` |
| `url` | text | NO | Full RSS feed URL |
| `name` | text | NO | Display name (e.g., "TechCrunch – Main Feed") |
| `active` | boolean | NO | Default: `true`; set to `false` to disable |
| `max_article_age_days` | smallint | NO | Skip articles older than this (e.g., 7 days); if NULL, use global default |
| `category_override` | text | YES | Force a category for all articles from this source |
| `created_at` | timestamptz | NO | Default: `now()` |
| `last_fetched_at` | timestamptz | YES | Updated after each successful fetch (for monitoring) |

**Indexes:**
- PK: `id`
- Index: `(active, last_fetched_at)` – for scheduler efficiency

---

#### Table: `config` (Global Settings)

| Column | Type | Notes |
|--------|------|-------|
| `key` | text | PK; e.g., `"duplicate_similarity_threshold"` |
| `value` | jsonb | Typed value; n8n reads and casts |

**Sample rows (INSERT these):**

```sql
INSERT INTO config (key, value) VALUES
  ('duplicate_similarity_threshold', '"0.85"'),  -- cosine similarity; values >= 0.85 are duplicates
  ('max_article_age_days', '"7"'),               -- global fallback for max age
  ('max_posts_per_day', '"10"'),                 -- hard cap on daily posts
  ('max_posts_per_run', '"2"'),                  -- max articles to post per scheduler run
  ('rss_fetch_interval_minutes', '"15"'),        -- how often Flow A runs (for documentation)
  ('posting_scheduler_interval_minutes', '"60"'),-- how often Flow B runs (for documentation)
  ('seismic_score_rubric', '{"5":"Breaking/highly strategic","4":"Important development","3":"Moderately interesting","2":"Minor update","1":"Very small/noise"}');
```

---

#### Table: `posting_queue` (Optional; for rate-limiting & history)

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NO | PK |
| `article_id` | uuid | NO | FK to `articles.id` |
| `queued_at` | timestamptz | NO | Default: `now()` |
| `posted_at` | timestamptz | YES | When actually posted |
| `status` | text | NO | `pending`, `posted`, `failed` |
| `error_msg` | text | YES | If posting failed, reason |

**Purpose:** Track posting history separate from article table; useful for debugging and quota enforcement.

---

### 3.2 API & Service Integration

#### OpenAI API

**For Embeddings:**
- Model: `text-embedding-3-small`
- Input: concatenated `title + "\n\n" + description_or_body` (truncated to 8000 tokens)
- Output: 1536-dimensional vector
- Cost: ~$0.02 per 1M tokens (very cheap for 500 articles/month)

**For Summarization & Scoring:**
- Model: `gpt-4-turbo` or `gpt-4o` (choose based on cost vs. quality)
- Prompt: (see section 3.3)
- Output: JSON with `{ summary, seismic_score, category, reason }`

#### Supabase

**REST API** (HTTP nodes in n8n):
- CRUD on `articles`, `rss_sources`, `config`
- RPC (remote procedure calls) for:
  - Semantic similarity search with pgvector
  - Aggregations (COUNT posts today, etc.)

**Authentication:** API key (anon + service role key if needed)

#### Facebook Graph API

- **Endpoint:** `POST /me/feed` (or `/PAGE_ID/feed`)
- **Auth:** Page Access Token (long-lived, stored in n8n credentials)
- **Payload:** message text + link
- **Error handling:** capture Facebook error codes (429 = rate limit, 100 = param error, etc.)

---

### 3.3 LLM Prompts & Schemas

#### Summarization & Seismic Scoring Prompt

```
You are a content analyst. Analyze the following article and provide:
1. A concise summary (150–200 words).
2. A seismic score (1–5) based on the rubric below.
3. An optional category (tech, biotech, finance, climate, etc.).
4. A brief reason for the score.

SEISMIC SCORE RUBRIC:
5 – Breaking news or highly strategic for tech/AI/biotech; immediate impact or major announcement.
4 – Important development or significant milestone; affects market/industry meaningfully.
3 – Moderately interesting; niche but relevant; incremental progress or analysis.
2 – Minor update, small feature, marginal news.
1 – Noise, rumor, or very tangential to main interests.

ARTICLE:
Title: {title}
Published: {published_at}
Content: {content_truncated_to_2000_chars}

Respond in this JSON format (no markdown):
{
  "summary": "...",
  "seismic_score": 4,
  "category": "tech",
  "reason": "Reason why score 4 not 5."
}
```

**n8n Implementation Notes:**
- Node type: **OpenAI Chat Completion**
- Temperature: 0.3 (deterministic)
- Max tokens: 500
- Use `response_format: { "type": "json_object" }` to enforce JSON output

---

## 4. Workflow Specifications

### 4.1 Flow A – RSS Ingestion & Deduplication

**Trigger:** Cron (every 15 min, configurable via `config.rss_fetch_interval_minutes`)

**High-Level Steps:**

```
1. Start (Cron)
   ↓
2. Fetch active RSS sources from Supabase
   ↓
3. Loop: For each RSS source
   ├─ 3a. HTTP Request → fetch RSS feed (XML)
   ├─ 3b. RSS Parser node → extract items (title, link, pubDate, description, content:encoded)
   ├─ 3c. Loop: For each item
   │   ├─ 4a. Quick filters (date, exact URL match)
   │   ├─ 4b. Extract / normalize content
   │   ├─ 4c. Compute embedding (OpenAI)
   │   ├─ 4d. Semantic duplicate check (Supabase RPC or SQL)
   │   ├─ 4e. If duplicate → insert with status='rejected_duplicate'
   │   ├─ 4f. If not duplicate → Summarize + Score (OpenAI)
   │   └─ 4g. Insert into articles table
   └─ 5. Update rss_sources.last_fetched_at
   ↓
4. End (log summary: X items fetched, Y inserted, Z duplicates)
```

**Detailed Node Specs:**

#### Node 1: Cron Trigger
- Type: **Cron**
- Expression: `*/15 * * * *` (every 15 min; configurable)
- Timezone: User's timezone (e.g., UTC+4 for Tbilisi)

#### Node 2: Fetch RSS Sources
- Type: **Supabase – Read Records**
- Table: `rss_sources`
- Filter: `active = true`
- Return: all columns

#### Node 3: Loop RSS Sources
- Type: **Loop**
- Input: array from Node 2

#### Node 3a: Fetch RSS Feed
- Type: **HTTP Request**
- Method: GET
- URL: `{{ $item.url }}`
- Headers: `User-Agent: MediaWatchtower/1.0`
- Return format: Body (raw XML)
- Error handling: If 404 or timeout → log warning, continue

#### Node 3b: Parse RSS
- Type: **RSS Read**
- Input: raw XML from 3a
- Output: array of items with: `title`, `link`, `pubDate`, `description`, `content:encoded`, `creator`

#### Node 3c: Loop Items
- Type: **Loop**
- Input: items array from 3b

#### Node 4a: Quick Filters (Date + Exact URL)
- Type: **Switch** (conditional branching)
  
  **Condition 1:** Article age
  - Parse `pubDate` → calculate age in days
  - If age > `max_article_age_days` (from `rss_sources` or global `config`) → **Skip to next item** (set status = `rejected_stale`)
  - Else → continue to 4b

  **Condition 2:** Exact URL match
  - Type: **Supabase – Read Records**
  - Table: `articles`
  - Filter: `url = '{{ $item.link }}'`
  - If count > 0 → skip (already have this exact URL) → set status = `rejected_duplicate` with `duplicate_of_id` = existing ID
  - Else → continue to 4b

#### Node 4b: Extract / Normalize Content
- Type: **Code** (Node.js)
- Input: item from RSS
- Output: 
  ```json
  {
    "url": "{{ $item.link }}",
    "source": "{{ $loop.$parent.item.id }}",
    "title": "{{ $item.title }}",
    "published_at": "{{ $item.pubDate }}",
    "raw_content": "{{ $item.content:encoded || $item.description }}",
    "embedding_input": "{{ $item.title }}\n\n{{ extract_text($item.content:encoded || $item.description, max_tokens=2000) }}"
  }
  ```
- Logic: clean HTML from content (use cheerio or similar), truncate to 2000 chars, escape special chars

#### Node 4c: Compute Embedding
- Type: **OpenAI – Create Embedding**
- Model: `text-embedding-3-small`
- Input text: `{{ $node.Node_4b.json.embedding_input }}`
- Output: 1536-dimensional vector

#### Node 4d: Semantic Duplicate Check
- Type: **Supabase – RPC** (or raw SQL via REST)
- RPC function (to be created in Supabase):
  ```sql
  -- Pseudocode; actual SQL in schema script
  CREATE FUNCTION find_similar_articles(
    p_embedding vector(1536),
    p_threshold float DEFAULT 0.85,
    p_limit int DEFAULT 3
  ) RETURNS TABLE (...) AS $$
  SELECT
    id, url, title, similarity,
    1 - (p_embedding <=> embedding) AS similarity
  FROM articles
  WHERE 1 - (p_embedding <=> embedding) >= p_threshold
  ORDER BY similarity DESC
  LIMIT p_limit;
  $$;
  ```
- Input: embedding from 4c, threshold from `config`
- Output: array of similar articles (or empty if none found)

#### Node 4d-Branch: If Duplicate Found
- Type: **If**
- Condition: `results.length > 0`
- TRUE branch:
  - **Supabase – Create Record** (rejected article)
    - Table: `articles`
    - Fields:
      - `url`, `source`, `title`, `published_at`, `raw_content` (from 4b)
      - `embedding` (from 4c)
      - `status: 'rejected_duplicate'`
      - `duplicate_of_id: {{ results[0].id }}`
      - `rejection_reason: 'semantic_duplicate (similarity: {{ results[0].similarity }})'`
      - `summary: null`
      - `seismic_score: null`
  - Continue to next item
- FALSE branch: continue to 4e (summarization)

#### Node 4e: Summarize & Score (LLM)
- Type: **OpenAI – Chat Completion**
- Prompt: (use template from section 3.3)
- Temperature: 0.3
- Max tokens: 500
- Response format: JSON
- Error handling: If rate-limited or error → retry (n8n built-in) up to 3 times, then log and skip

#### Node 4e-Parse: Parse LLM Output
- Type: **Code** (Node.js)
- Extract: `summary`, `seismic_score`, `category`, `reason`
- Validation: seismic_score must be int 1–5; if not, default to 3
- Escape summary text for SQL insertion

#### Node 4f: Insert Article
- Type: **Supabase – Create Record**
- Table: `articles`
- Fields:
  - `url`, `source`, `title`, `published_at`, `raw_content` (from 4b)
  - `embedding` (from 4c)
  - `summary`, `seismic_score`, `category`, `seismic_reason` (from 4e)
  - `status: 'new'`
  - `rejection_reason: null`

#### Node 5: Update Source Metadata
- Type: **Supabase – Update Record**
- Table: `rss_sources`
- Filter: `id = '{{ $loop.$parent.item.id }}'`
- Update: `last_fetched_at: now()`

#### Node 6: Log Summary
- Type: **Code** (log counts of inserted, duplicates, stale articles)
- Send to monitoring system (Slack, Sentry, or n8n dashboard)

---

### 4.2 Flow B – Posting Scheduler

**Trigger:** Cron (every 60 min, configurable)

**High-Level Steps:**

```
1. Start (Cron)
   ↓
2. Check daily post count (SQL)
   ├─ If >= max_posts_per_day → exit
   └─ Else → continue
   ↓
3. Fetch candidate articles (status='new', sorted by score + date)
   ├─ Limit: max_posts_per_run
   └─ Exclude recent failures (status='error' posted in last 2h) [FUTURE]
   ↓
4. Format post text for each article
   ↓
5. Post to Facebook (with retry logic)
   ├─ If success → update status='posted', posted_at=now(), posted_to_facebook_id
   └─ If failure → log error, leave status='new' [or set='error' in v2]
   ↓
6. End (log: X posted, Y failed)
```

**Detailed Node Specs:**

#### Node 1: Cron Trigger
- Type: **Cron**
- Expression: `0 * * * *` (every hour; configurable)
- Timezone: same as Flow A

#### Node 2: Check Daily Quota
- Type: **Supabase – Execute SQL** (or custom RPC)
  ```sql
  SELECT COUNT(*) AS posted_today
  FROM articles
  WHERE status = 'posted' AND DATE(posted_at) = CURRENT_DATE;
  ```
- Output: `posted_today` count

#### Node 3: Quota Check Conditional
- Type: **If**
- Condition: `posted_today >= {{ $env.MAX_POSTS_PER_DAY }}` (read from `config` table)
- TRUE: Stop workflow (quota reached)
- FALSE: continue to node 4

#### Node 4: Fetch Candidates
- Type: **Supabase – Read Records** (or custom SQL for complex query)
  ```sql
  SELECT
    id, url, title, summary, seismic_score, published_at
  FROM articles
  WHERE status = 'new'
  ORDER BY seismic_score DESC, published_at DESC
  LIMIT {{ $env.MAX_POSTS_PER_RUN }};
  ```
- Output: array of articles to post

#### Node 5: Loop Articles
- Type: **Loop**
- Input: candidates from node 4

#### Node 6: Format Post Text
- Type: **Code** (Node.js)
- Template:
  ```
  📰 [{{ seismic_score }}/5] {{ title }}

  {{ summary }}

  🔗 Read more: {{ url }}

  #MediaWatchtower
  ```
- Validation: ensure text < 2000 chars (Facebook limit)
- Output: formatted post text

#### Node 7: Post to Facebook
- Type: **HTTP Request** (or Facebook node if available)
- Method: POST
- URL: `https://graph.instagram.com/v18.0/{{ $env.FACEBOOK_PAGE_ID }}/feed`
- Headers:
  - `Authorization: Bearer {{ $env.FACEBOOK_PAGE_ACCESS_TOKEN }}`
- Body (form-data or JSON):
  ```json
  {
    "message": "{{ $node.Node_6.json.post_text }}",
    "link": "{{ $item.url }}"
  }
  ```
- Error handling:
  - If 200–299: success
  - If 429 (rate limit): retry in 60s
  - If 100 (param error): log error, mark article as `error` [FUTURE]
  - If network error: retry up to 3 times with exponential backoff

#### Node 8: Update Article Status
- Type: **If** (check if previous POST succeeded)
- TRUE branch (success):
  - **Supabase – Update Record**
    - Table: `articles`
    - Filter: `id = '{{ $item.id }}'`
    - Update:
      - `status: 'posted'`
      - `posted_at: now()`
      - `posted_to_facebook_id: {{ facebook_post_id }}`
  - Optional: **Insert into posting_queue** (for history)
- FALSE branch (error):
  - Log error
  - [FUTURE] Set status = 'error', store error_msg

#### Node 9: Summary Log
- Type: **Code**
- Count: articles posted in this run
- Log to monitoring system

---

### 4.3 Flow C – Maintenance (Optional, v1 or later)

**Trigger:** Daily at 02:00 UTC

**Purpose:** Cleanup, archiving, and optional backfill

**Steps (pseudocode):**

```
1. Archive old "new" articles
   - Articles with status='new' AND published_at < now() - 30 days
   - Set status='expired' (keeps them in DB for audit)

2. Clean up rejected articles (optional)
   - Delete articles with status='rejected_*' AND created_at < now() - 90 days
   - [Or: archive to separate schema]

3. Recompute scores / summaries for high-value articles (FUTURE)
   - If a high-seismic-score article wasn't posted yet, re-run LLM to refine
   - This is a post-MVP optimization

4. Log maintenance stats
```

**Skip for MVP if time-constrained.**

---

## 5. Configuration & Environment Variables

Store in n8n Credentials and Supabase `config` table:

### n8n Credentials

```
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-4-turbo  # or gpt-4o

SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...  # if need elevated permissions

FACEBOOK_PAGE_ID=123456789
FACEBOOK_PAGE_ACCESS_TOKEN=EAA...
```

### Supabase `config` Table

```
duplicate_similarity_threshold=0.85
max_article_age_days=7
max_posts_per_day=10
max_posts_per_run=2
rss_fetch_interval_minutes=15
posting_scheduler_interval_minutes=60
seismic_score_rubric={...}
```

n8n reads these via HTTP REST calls and uses them dynamically.

---

## 6. Error Handling & Logging

### Logging Strategy

- **n8n logs:** Use built-in n8n execution logs for workflow debugging.
- **Application logs:** Insert structured logs into Supabase table `logs` (optional):
  ```sql
  CREATE TABLE logs (
    id uuid PRIMARY KEY,
    flow_name text,
    event text,
    details jsonb,
    created_at timestamptz DEFAULT now()
  );
  ```
- **Monitoring:** (FUTURE) Integrate with Sentry, Slack, or PagerDuty for critical errors.

### Error Scenarios & Recovery

| Scenario | Handler |
|----------|---------|
| RSS feed timeout (>30s) | Log warning, skip source, continue to next source |
| OpenAI API rate limit (429) | Retry with exponential backoff (3–5 attempts) |
| OpenAI API error (5xx) | Log error, skip article, continue to next |
| Supabase connection error | Retry up to 3 times; if all fail, pause workflow (alert ops) |
| Facebook posting rate limit (429) | Stop posting scheduler run; resume in 1 hour |
| Facebook posting param error (100) | Log error, mark article as `error` [FUTURE], continue to next article |
| Malformed RSS (parse error) | Log error, skip source, continue |

### Future Enhancements (v2+)

- Dead letter queue (DLQ) for failed articles
- Automatic retry scheduler (re-attempt posting after 24h)
- Dashboard alert when N% of articles have errors

---

## 7. Performance & Cost Estimates

### Compute & Storage

**Assumption:** ~500 new articles / month (100 from each of 5 RSS sources)

#### Supabase (PostgreSQL + pgvector)
- **Storage:** ~1 MB / month (easily under free tier 10 GB)
- **Cost:** Free tier or ~$20/month for compute
- **Query load:** ~1000 queries/month (very light)

#### OpenAI API Costs
- **Embeddings:** 500 × ~150 tokens avg = 75K tokens/month @ $0.02 per 1M = **$0.002/month** (negligible)
- **Chat completions (GPT-4 Turbo):** 500 × 800 tokens avg = 400K tokens/month @ ~$0.01 per 1K = **~$4/month**
- **Total OpenAI:** ~**$4/month** (very affordable)

#### Facebook API
- **No cost** (free for page posts)

#### n8n (Self-Hosted)
- **Infrastructure:** Your own server (Docker)
- **Cost:** $0 (only infrastructure costs)
- **Monitoring:** Built-in logging

**Total Monthly Cost (MVP):** ~$20–30 (Supabase) + ~$4 (OpenAI) = ~**$25**

---

## 8. Testing & Validation (MVP)

### Unit Tests

- [ ] RSS parser handles malformed XML
- [ ] Date filter correctly identifies stale articles
- [ ] Embedding and similarity search work (test with known duplicates)
- [ ] LLM prompt parsing returns valid JSON
- [ ] Facebook API payload formatting is correct

### Integration Tests

- [ ] End-to-end: Add RSS source → fetch → dedupe → score → insert into DB (use test feed)
- [ ] Posting flow: Fetch articles → format → post to FB (use test page / sandbox)
- [ ] Config reading works correctly from Supabase table

### Data Quality Tests

- [ ] No duplicate URLs in articles table
- [ ] All seismic_scores are 1–5
- [ ] All posting articles have non-null summary + score
- [ ] Embedding vectors are correct dimension (1536)

### Load Testing (FUTURE)

- Test with 1000 articles / day (beyond current scope)

---

## 9. Deployment & Runbook

### Supabase Setup

1. Create PostgreSQL database
2. Install pgvector extension: `CREATE EXTENSION vector;`
3. Run SQL schema script (provided separately) to create tables + indexes + RPC functions
4. Seed `config` table with initial settings
5. Add 2–3 test RSS sources

### n8n Setup

1. Deploy n8n Docker container (self-hosted)
2. Create two workflow definitions (Flow A + Flow B) from provided JSON templates
3. Add credentials:
   - OpenAI API key
   - Supabase URL + anon/service keys
   - Facebook page ID + access token
4. Deploy workflows
5. Configure Cron schedules (every 15 min for A, every 60 min for B)
6. Monitor first 24 hours of execution

### Documentation

- [ ] Data dictionary (all columns explained)
- [ ] Runbook for adding new RSS sources
- [ ] Runbook for adjusting thresholds / quotas
- [ ] FAQ for troubleshooting common issues

---

## 10. Future Enhancements (Post-MVP)

### v1.1

- [ ] Custom web UI for:
  - Adding/editing RSS sources
  - Viewing articles dashboard
  - Manual status overrides
  - Posting history + analytics
- [ ] Optional backfill logic (re-score old articles)
- [ ] Slack integration for high-seismic-score alerts
- [ ] Better error tracking (DLQ + retry queue)

### v2.0

- [ ] Multi-destination posting (Twitter/X, LinkedIn, Telegram)
- [ ] Image/video attachment support
- [ ] Hierarchical categorization (tech → AI → LLMs)
- [ ] Digest-style posts (bundle 3–5 top articles daily)
- [ ] User preferences & personalization
- [ ] Multilingual content support
- [ ] Webhook-based ingestion (for custom content sources)
- [ ] Advanced analytics dashboard (trends, engagement, etc.)
- [ ] A/B testing posting strategies (different times / formats)

### v3.0+ (Blue Sky)

- [ ] Recursive multi-stage deduplication (cross-source clustering)
- [ ] Content recommendation engine
- [ ] Adversarial filtering (detect and suppress clickbait)
- [ ] Community-driven scoring (crowdsourced seismic scores)
- [ ] Event detection (track breaking stories across multiple sources)

---

## 11. Acceptance Criteria (MVP)

**The workflow is considered complete when:**

1. ✅ RSS sources can be added to Supabase; Flow A reads them
2. ✅ Flow A successfully fetches articles, deduplicates by date + embedding, and stores them
3. ✅ LLM generates valid summaries and seismic scores (manual spot-check: 20 articles)
4. ✅ Vector embedding and similarity search work (test: known duplicates are caught)
5. ✅ Flow B successfully posts to Facebook with correct formatting
6. ✅ Posting respects daily quota (`max_posts_per_day`)
7. ✅ Status column correctly tracks article lifecycle (new → posted / rejected)
8. ✅ Both flows run on schedule without crashes for 7 days continuous operation
9. ✅ Logs are accessible for debugging (n8n dashboard + optional Supabase logs table)
10. ✅ Developer has documented runbook for ops team (adding sources, adjusting configs)

---

## 12. Assumptions & Constraints

### Assumptions

- RSS feeds are in standard XML format (RSS 2.0 or Atom)
- Articles are primarily English text
- Article descriptions / content are HTML and need light parsing
- Facebook page is already set up and user has admin access
- n8n is self-hosted (not cloud SaaS)
- Supabase is used as-is (no custom VPC, single region)

### Constraints

- **Article processing latency:** ~10–30 sec per article (due to LLM calls); acceptable for batch job
- **Rate limits:**
  - OpenAI: 90K tokens/min (text-embedding-3-small); not a bottleneck for ~500 articles/month
  - Facebook: 200 requests / hour; not a bottleneck
  - Supabase: free tier has plenty of headroom
- **Embedding model fixed:** Using `text-embedding-3-small` for MVP; swapping to large model in future requires re-embedding entire DB
- **LLM model:** Swapping from GPT-4 to cheaper model (e.g., GPT-3.5) requires prompt tuning

### Known Limitations (MVP)

- No manual editorial queue UI (use SQL / Supabase dashboard to modify status)
- No image/video support (text only)
- Single posting destination (Facebook only)
- No user authentication / multi-tenancy
- Similarity threshold is fixed (0.85); cannot be adjusted per-source in v1
- No analytics / engagement tracking

---

## 13. Success Metrics (MVP)

Track these KPIs post-launch:

| Metric | Target | Notes |
|--------|--------|-------|
| Articles ingested / week | ≥ 100 | Baseline health check |
| Duplicates caught % | ≥ 20% | Indicates good semantic filtering |
| Avg seismic score | 2.5–3.5 | Should be well-distributed; not all 5s or all 1s |
| Posts published / week | 5–15 | Depends on content volume and threshold tuning |
| Facebook engagement | TBD | Track clicks/likes post-launch; adjust scoring if needed |
| Workflow error rate | < 1% | Failures should be rare (network glitches, API hiccups) |
| LLM response time | < 5s | Indicates smooth API calls |

---

## 14. Handoff & Support

### Developer Deliverables

1. **n8n Workflow JSONs** (Flow A + Flow B exported as JSON)
2. **Supabase SQL schema script** (DDL for all tables, indexes, RPC functions)
3. **Environment variables** template (`.env.example`)
4. **Runbook** (Markdown): how to deploy, configure, add RSS sources, troubleshoot
5. **API documentation** (which Supabase RPC functions exist, what they do)
6. **Test data** (sample RSS sources + expected outputs)

### Post-Launch Support

- **First 2 weeks:** Developer available for bug fixes and tuning (threshold adjustments, prompt refinements)
- **Ongoing:** Ops team (you) manages RSS sources, quota adjustments, and monitoring
- **Feature requests:** Log in GitHub issues or Notion; prioritize for v1.1+

---

## 15. Sign-Off & Version History

| Version | Date | Author | Status | Notes |
|---------|------|--------|--------|-------|
| 1.0 | Jan 2026 | [Project Sponsor] | Draft | MVP TOR; ready for development |
| 1.1 | TBD | TBD | — | Updates post-initial feedback |

**Approved by:**
- Project Sponsor: _____________________ (Sign / Date)
- Tech Lead: _____________________ (Sign / Date)
- Ops Lead: _____________________ (Sign / Date)

---

**End of TOR**
