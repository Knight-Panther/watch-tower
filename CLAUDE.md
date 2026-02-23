# Watch Tower

Independent media monitoring agent. Scans RSS feeds by sector, deduplicates (URL + semantic), scores articles with LLM for importance, and distributes to social media with approval workflow. Includes keyword alerts, daily intelligence digests, and Georgian translation.

## Pipeline Architecture

```
[1] INGEST ──→ [2] SEMANTIC DEDUP ──→ [3] PRE-FILTER ──→ [4] LLM BRAIN ──→ [5] TRANSLATE ──→ [6] IMAGE GEN ──→ [7] DISTRIBUTE
(fetch+enrich)   (embed+compare)       (hard reject)      (score+reason)     (ka translation)  (news cards)     (approve+post)
  ↑ captures:                                                  ↓ scored
  categories[]                                           [ALERT CHECK]
  content:encoded                                            ↓ match
  (1500 chars)                                         [INSTANT NOTIFY]
```

**Additional output channels (bypass distribution pipeline):**
- **Keyword Alerts** — instant Telegram notification when scored articles match keywords
- **Daily Digest** — LLM-curated intelligence briefing to Telegram/Facebook/LinkedIn

## Tech Stack

- **API**: Fastify (TypeScript)
- **Worker**: BullMQ job processor (TypeScript)
- **Frontend**: React 19 + Vite + Tailwind CSS
- **Database**: PostgreSQL 16 + pgvector (via Drizzle ORM)
- **Queue/Cache**: Redis 7
- **LLM**: Provider abstraction (Claude, OpenAI, DeepSeek) with fallback support
- **Embeddings**: OpenAI text-embedding-3-small (1536 dims)
- **Translation**: Gemini (Google AI) + OpenAI, Georgian (ka) language support
- **Image Generation**: OpenAI gpt-image-1-mini + canvas compositor
- **Object Storage**: Cloudflare R2 (AI-generated news card images)
- **Real-time**: Server-Sent Events (SSE) for live dashboard updates
- **Social**: Telegram Bot API, Facebook Graph API, LinkedIn API
- **Monorepo**: npm workspaces + Turborepo
- **Deployment**: Docker Compose on VPS + nginx reverse proxy

## Package Structure

```
packages/
├── db/            # Drizzle schema, migrations, client factory
├── shared/        # Queue constants, env schemas, shared types
├── llm/           # LLM provider abstraction (Claude, OpenAI, DeepSeek + fallback)
├── embeddings/    # Embedding generation + pgvector similarity search
├── translation/   # Georgian translation (Gemini, OpenAI providers)
├── social/        # Social poster abstraction (Telegram, Facebook, LinkedIn)
├── worker/        # Pipeline processors (ingest, dedup, score, translate, image-gen, distribute, alerts, digest)
├── api/           # Fastify REST API
└── frontend/      # React admin dashboard
```

**Dependency graph:**
```
frontend → api (HTTP)
api → db, shared
worker → db, shared, llm, embeddings, translation, social
llm → shared
embeddings → db
translation → shared
social → shared
```

## Commands

```bash
# Infrastructure
npm run infra:up           # Start PostgreSQL + Redis (Docker Compose)
npm run infra:down         # Stop containers

# Database (Drizzle)
npm run db:generate        # Generate migrations from schema changes
npm run db:migrate         # Run pending migrations
npm run db:push            # Push schema directly (dev only)
npm run db:studio          # Open Drizzle Studio (DB GUI)
npm run db:seed            # Seed app_config + sample data

# Development (Turborepo)
npm run dev                # Run all services in parallel
npm run dev:api            # API only (builds dependencies first)
npm run dev:worker         # Worker only
npm run dev:frontend       # Frontend only
npm run build              # Build all packages

# Code Quality
npm run lint               # ESLint
npm run format             # Prettier

# Pipeline Operations
npm run pipeline:reset     # Flush Redis + truncate articles/deliveries/telemetry + reset fetch timestamps

# Production Deployment
docker compose -f docker-compose.prod.yml up -d --build    # Start production stack
./deploy/setup-client.sh <clientname>                       # Provision new client instance
./deploy/deploy.sh                                          # Update running instance
./deploy/deploy-all.sh                                      # Update all client instances
./deploy/backup.sh                                          # Backup PostgreSQL database
```

## Database Schema

Core tables (PostgreSQL + pgvector):

| Table | Purpose |
|-------|---------|
| `sectors` | Feed categories (Biotech, Crypto, Stocks, etc.) |
| `rss_sources` | Feed URLs + ingest config |
| `articles` | Core entity: title, snippet, categories, embedding, score, reasoning, pipeline_stage, translation fields |
| `scoring_rules` | Per-sector LLM prompt templates + thresholds + reject keywords |
| `social_accounts` | Connected platform credentials + post templates + rate limits |
| `post_deliveries` | Scheduled/immediate posting per article per platform |
| `feed_fetch_runs` | Fetch attempt telemetry |
| `llm_telemetry` | LLM API call tracking (tokens, cost, latency) — also tracks digest + translation costs |
| `article_images` | AI-generated news card images (OpenAI gpt-image-1-mini + R2 storage) |
| `app_config` | Key-value settings (auto_post toggles, emergency_stop, digest_*, translation_*) |
| `platform_health` | Social platform health status, token expiry tracking |
| `allowed_domains` | RSS source domain whitelist (security) |
| `alert_rules` | Keyword alert rules (keywords[], min_score, telegram_chat_id, active) |
| `alert_deliveries` | Alert notification audit trail (rule_id, article_id, matched_keyword, status) |

### Articles Table Key Columns

| Column | Type | Purpose |
|--------|------|---------|
| `article_categories` | `text[]` | RSS `<category>` tags (captured at ingest) |
| `content_snippet` | `text` | Enriched snippet (up to 1500 chars from `content:encoded`) |
| `importance_score` | `smallint` | LLM score (1-5) |
| `score_reasoning` | `text` | LLM explanation of the score (up to 1000 chars) |
| `rejection_reason` | `text` | Why article was rejected (pre-filter keyword, LLM score, or manual) |
| `pipeline_stage` | `text` | Current stage in pipeline |
| `title_ka` / `llm_summary_ka` | `text` | Georgian translations |
| `translation_status` | `text` | NULL → translating → translated / failed / exhausted |

**Pipeline stages** (on `articles.pipeline_stage`):
`ingested` → `embedded` → `scored` → `approved`/`rejected` → `posted` (or `duplicate`)

**Posting is controlled by `post_deliveries`** — article stays `approved`, delivery row tracks scheduling.

## BullMQ Queues

| Queue | Job | Concurrency | Purpose |
|-------|-----|-------------|---------|
| `pipeline-ingest` | `ingest-fetch` | 5 | Fetch RSS, date/URL filter, capture categories + enriched snippet |
| `pipeline-semantic-dedup` | `semantic-batch` | 2 | Embed batch of 50, vector search, mark dupes |
| `pipeline-llm-brain` | `llm-score-batch` | 1 | Pre-filter reject → score + summarize + reason batch of 10 → alert check |
| `pipeline-translation` | `translation-batch` | 1 | Translate approved articles to Georgian (Gemini/OpenAI) |
| `pipeline-image-generation` | `image-generate` | 1 | Generate AI news card images (gpt-image-1-mini + R2) |
| `pipeline-distribution` | `distribution-immediate` | 1 | Post individual articles to platforms |
| `maintenance` | schedule/cleanup/post-scheduler/health-check/daily-digest | 1 | Recurring scheduling, TTL cleanup, post dispatch, platform health, digest |

**Chaining:** Each processor queries DB for unprocessed articles and queues the next stage. Database `pipeline_stage` is the source of truth (not queue state).

## Score Reasoning

LLM returns a `reasoning` field with every score explaining the decision. Displayed as:
- **Articles table**: hover tooltip on score badge
- **Schedule modal**: prominent display before manual approval
- **Stored in**: `articles.score_reasoning` (up to 1000 chars, truncated by Zod schema)

## RSS Enrichment (P2-A)

Ingest captures richer data than basic RSS parsing:
- **`content:encoded`**: Full article body from RSS (configured in `secure-rss.ts` customFields), truncated to 1500 chars (vs 500 default snippet)
- **`categories`**: RSS `<category>` tags stored in `article_categories text[]` array
- Both flow into LLM scoring prompt for better accuracy

## Pre-Filter: Hard Reject Before LLM (P2-B)

Articles matching `reject_keywords` (per-sector, configured in Scoring Rules UI) are rejected BEFORE reaching the LLM, saving API costs.

- **Check order**: title → categories → content_snippet
- **Matching**: Word-boundary regex (`\bkeyword\b`, case-insensitive) — prevents "AI" matching "FAIRY"
- **Audit trail**: `rejection_reason` column records exact keyword + match location
- **Separate from `ignore`**: `ignore` is a soft LLM hint; `reject_keywords` is a hard gate

## Keyword Alerts (P3)

Instant Telegram notifications when scored articles match keyword rules. Bypasses the entire distribution pipeline.

- **Tables**: `alert_rules` (keywords[], min_score, telegram_chat_id, active) + `alert_deliveries` (audit trail)
- **Hook point**: After LLM scoring in `llm-brain.ts` → calls `checkAndFireAlerts()` from `alert-processor.ts`
- **Matching**: Shared `matchesKeyword()` function (word-boundary regex, same as pre-filter)
- **Cooldown**: Redis key `alert:cooldown:{ruleId}:{keyword}` with 5-min TTL — prevents alert storms
- **Telegram**: Direct Bot API call via `telegram-alert.ts` (not SocialProvider). Per-rule chat_id supported
- **UI**: Standalone `/alerts` page with CRUD, tag-style keyword input, expandable delivery history

## Daily Digest (P4)

LLM-curated intelligence briefing delivered on schedule. The primary client-facing output.

- **No new queue**: `JOB_DAILY_DIGEST` runs on `QUEUE_MAINTENANCE`. Scheduler checks time/tz/day every 30s.
- **LLM call**: Direct SDK instantiation in `digest.ts` (Claude, OpenAI, or DeepSeek). NOT via LLMProvider interface.
- **Analyst role**: Configurable system prompt persona per client (VC analyst, PR monitor, market intel, etc.)
- **Article selection**: `scored_at > last_digest_sent_at` AND `importance_score >= min_score`, sorted by score DESC
- **Reference system**: LLM outputs `[#1, #3]` refs → Telegram gets `<a href>` links, Facebook/LinkedIn get text-only
- **Georgian mode**: English LLM generation → Gemini/OpenAI translation to Georgian (post-processing, not dependent on article-level translation)
- **Multi-platform**: Telegram (HTML with links), Facebook (plaintext, refs stripped), LinkedIn (plaintext, refs stripped)
- **Idempotency**: `last_digest_sent_at` within 1 hour → skip. Prevents double-send on worker restart.
- **Test digest**: `POST /config/digest/test` — queues with `isTest: true`, skips `last_digest_sent_at` update
- **Config**: 15+ keys in `app_config` (digest_enabled, digest_time, digest_timezone, digest_days, digest_min_score, digest_language, digest_system_prompt, digest_translation_prompt, digest_provider, digest_model, digest_translation_provider, digest_translation_model, digest_telegram_chat_id, digest_telegram_enabled, digest_facebook_enabled, digest_linkedin_enabled)
- **UI**: Standalone `/digest` page with schedule, content, system prompt textarea, translation prompt textarea, analyst role presets, platform toggles, test button

## Source Quality Dashboard (P5)

Operator tool for identifying signal vs noise sources.

- **API endpoint**: `GET /stats/source-quality` — 30-day rolling window aggregation
- **Metrics per source**: signal ratio (% scoring 4+), score distribution (1-5 counts), avg score, total scored
- **Frontend**: Color-coded badges on Home page (green ≥40%, amber ≥15%, red <15%)
- **Use**: Identify noise sources (low signal ratio) to disable or deprioritize

## Code Conventions

### Naming
- **Database columns**: snake_case (`sector_id`, `pipeline_stage`)
- **Drizzle schema**: camelCase properties mapping to snake_case columns
- **TypeScript code**: camelCase
- **Constants**: UPPER_SNAKE_CASE (`QUEUE_INGEST`, `JOB_INGEST_FETCH`)
- **Route registrars**: `registerXRoutes(app, deps)`
- **Worker factories**: `createXWorker(deps)` or `createXProcessor(deps)`

### Patterns
- **Dependency injection**: Services receive typed deps objects
- **Factory pattern**: `createDb()`, `createLLMProvider()`, `createXWorker()`
- **Provider abstraction**: Interfaces for LLM, embeddings, social platforms
- **Pipeline stage machine**: Articles progress through stages via `pipeline_stage` column
- **Batch processing**: Embed in batches of 50, LLM score in batches of 10
- **Delivery-controlled posting**: `post_deliveries` table controls when/where to post (not pipeline stage)
- **Event-driven chaining**: Each worker queues the next stage after completion
- **Atomic upserts**: CTE pattern (`WITH existing AS (UPDATE ... RETURNING id) INSERT ... WHERE NOT EXISTS`) for idempotent writes

### Formatting (Prettier)
- Semicolons: yes
- Quotes: double
- Trailing commas: all
- Line width: 100

## Frontend Pages

| Route | Component | Nav Label | Purpose |
|-------|-----------|-----------|---------|
| `/` | Home | Home | RSS sources + signal ratio badges |
| `/monitoring` | Monitoring | Monitoring | Pipeline health + source fetch status |
| `/article-scheduler` | ArticleScheduler | Article Scheduler | Article list with approval/rejection/scheduling |
| `/sectors` | SectorManagement | Sectors | Sector CRUD |
| `/scoring-rules` | ScoringRules | LLM Brain | Per-sector priorities, ignore, reject keywords, score definitions, examples |
| `/media-channels` | MediaChannelControl | Media Channels | Social account management + templates |
| `/image-template` | ImageTemplate | Image Template | AI news card designer |
| `/site-rules` | SiteRules | Restrictions | Domain whitelist, feed limits, CORS, emergency controls |
| `/alerts` | Alerts | Alerts | Keyword alert rules CRUD + delivery history |
| `/digest` | DigestSettings | Daily Digest | Digest schedule, prompts, platform toggles, test button |
| `/settings` | Settings | DB/Telemetry | Database tools, LLM telemetry |

## API Routes

17 route modules registered in `server.ts`:

| Module | Key Endpoints |
|--------|--------------|
| `health` | `GET /health` |
| `sectors` | CRUD for sectors |
| `sources` | CRUD for RSS sources |
| `config` | `GET/PATCH /config/digest`, `POST /config/digest/test`, app_config KV |
| `ingest` | Trigger manual ingest |
| `stats` | `GET /stats/source-quality`, pipeline stats |
| `events` | SSE stream (`/events`) |
| `telemetry` | LLM cost/token tracking |
| `articles` | Article list/detail with filters, approval/rejection |
| `scheduled` | Scheduled posting management |
| `scoring-rules` | Per-sector scoring config CRUD |
| `reset` | Pipeline reset |
| `social-accounts` | Platform credential management |
| `credits` | Credit/usage tracking |
| `site-rules` | Domain whitelist, feed limits, emergency stop |
| `provider-health` | Platform health checks |
| `alerts` | Alert rules CRUD + delivery history |

## Environment Variables

```env
# Environment
NODE_ENV=development          # development | production (affects rate limiting, etc.)
LOG_LEVEL=info                # debug | info | warn | error

# Database (PostgreSQL)
DATABASE_URL=postgres://watchtower:watchtower@127.0.0.1:5432/watchtower

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# API
API_KEY=local-dev-key
PORT=3001

# Embeddings (OpenAI)
OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
SIMILARITY_THRESHOLD=0.85

# LLM Brain
ANTHROPIC_API_KEY=sk-ant-...
# DEEPSEEK_API_KEY=sk-...
LLM_PROVIDER=claude              # 'claude' | 'openai' | 'deepseek'
# LLM_CLAUDE_MODEL=claude-sonnet-4-20250514
# LLM_OPENAI_MODEL=gpt-4o-mini
# LLM_DEEPSEEK_MODEL=deepseek-chat
# LLM_FALLBACK_PROVIDER=openai   # Optional fallback on API failure
# LLM_FALLBACK_MODEL=gpt-4o-mini
LLM_AUTO_APPROVE_THRESHOLD=5     # Score >= this → auto-approve (default 5)
LLM_AUTO_REJECT_THRESHOLD=2      # Score <= this → auto-reject (default 2)

# Translation (Georgian)
GOOGLE_AI_API_KEY=...             # For Gemini translation provider

# Image Generation + R2 Storage
R2_ACCOUNT_ID=...                 # Cloudflare R2 account
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_URL=...                 # Public URL prefix for generated images

# Social Platforms
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=-100...
FB_PAGE_ID=...
FB_ACCESS_TOKEN=...
LINKEDIN_AUTHOR_TYPE=person       # 'person' | 'organization'
LINKEDIN_AUTHOR_ID=...
LINKEDIN_ACCESS_TOKEN=...

# Frontend
VITE_API_URL=http://localhost:3001
VITE_API_KEY=local-dev-key

# Security (see Security Hardening section)
MAX_FEED_SIZE_MB=5                    # Max RSS feed size in MB
MAX_ARTICLES_PER_FETCH=100            # Max articles per single fetch
MAX_ARTICLES_PER_SOURCE_DAILY=500     # Max articles per source per day
ALLOWED_ORIGINS=http://localhost:5173 # Comma-separated allowed CORS origins
API_RATE_LIMIT_PER_MINUTE=200         # Global API rate limit
```

## Logging

Control log verbosity via `LOG_LEVEL` environment variable:

| Level | Output |
|-------|--------|
| `debug` | All logs including verbose per-feed parsing details |
| `info` | Startup, shutdown, scheduler events (default) |
| `warn` | Warnings only |
| `error` | Errors only |

## Cost Optimization Strategy

Filtering is ordered cheapest-first:
1. **Date filter** — FREE (in-memory during RSS parse)
2. **URL dedup** — FREE (PostgreSQL UNIQUE constraint, ON CONFLICT DO NOTHING)
3. **Semantic dedup** — ~$0.02/1M tokens (embeddings API, batch 50)
4. **Pre-filter hard reject** — FREE (in-memory keyword match before LLM call)
5. **LLM scoring** — Most expensive, batch 10 per call, combined score+summary+reasoning

Articles store `title + content_snippet` (enriched up to 1500 chars from `content:encoded`).

## Approval & Posting Workflow

**Scoring outcomes:**
- Score >= 4 → auto-approve + immediate post (per-platform toggles: `auto_post_telegram`, `auto_post_facebook`, `auto_post_linkedin`)
- Score 1-2 → auto-reject (with `rejection_reason: "llm-score: N"`)
- Score 3 → manual review in dashboard (reasoning visible on hover)

**Pre-filter rejection:**
- Articles matching `reject_keywords` → auto-reject before LLM (with `rejection_reason: "pre-filter: keyword 'X' matched in title/categories/content"`)

**Manual approval flow (combined modal):**
1. User clicks "Approve" on scored article — sees score reasoning in modal
2. Modal shows: date picker, time picker, platform checkboxes
3. On submit: article → `approved`, `post_deliveries` row created with `scheduled_at`
4. Maintenance worker polls due deliveries every 30s and posts

## Social Posting

- **Telegram**: Bot API, chat/channel posting (active)
- **Facebook**: Graph API, page posting (active)
- **LinkedIn**: API, personal profile or organization posting (active)
- Per-platform rate limiting (Redis sliding window)
  - Telegram: 20/hour (generous)
  - Facebook: 1/hour (conservative, ~25/day limit)
  - LinkedIn: 4/hour (safe, 100/day limit)
- Individual article posts (no digest/batch format)
- Scheduling via `post_deliveries.scheduled_at` column
- Post templates: per-platform customizable formats (stored in `social_accounts.post_template`)

### Token Expiration

| Platform | Token Lifetime | Refresh Strategy |
|----------|---------------|------------------|
| Telegram | Never expires | N/A |
| Facebook | ~60 days | Manual re-auth or use long-lived page token |
| LinkedIn | ~60 days | Manual re-auth (offline_access requires partner approval) |

## Translation (Georgian)

Articles scoring >= 4 are automatically translated to Georgian (`ka`) after approval.

- **Providers**: Gemini (Google AI) primary, OpenAI fallback
- **Fields**: `title_ka`, `llm_summary_ka` on articles table
- **Status tracking**: `translation_status` column (`NULL` → `translating` → `translated` | `failed` | `exhausted`)
- **Retry**: up to 3 attempts (`translation_attempts`), then marked `exhausted`
- **Backfill guard**: `translation_enabled_since` in app_config prevents re-translating old articles
- **Config**: `translation_provider`, `translation_model`, `posting_language` in app_config
- **Queue**: `pipeline-translation`, polls every 15s for untranslated approved articles
- **Language control**: `posting_language` in app_config (`ka` = post Georgian text, `en` = post English)

## AI Image Generation

Auto-generates news card images for approved articles using OpenAI + Cloudflare R2.

- **Provider**: OpenAI `gpt-image-1-mini` for base image generation
- **Compositor**: Canvas-based news card builder (gradient backgrounds, text wrapping, branding)
- **Storage**: Cloudflare R2 with public URL for social media embedding
- **Template**: Configurable via Image Template designer page (fonts, colors, layouts)
- **Queue**: `pipeline-image-generation`, polls every 30s
- **Table**: `article_images` tracks generation status, R2 keys, cost (microdollars)
- **Config**: `image_generation_enabled` in app_config toggles the feature

## Real-time Events (SSE)

Dashboard receives live updates via Server-Sent Events instead of polling.

- **API endpoint**: `/events` — SSE stream for real-time article/pipeline updates
- **Publisher**: Worker emits events via Redis pub/sub (`watch-tower:events` channel)
- **Frontend**: Layout.tsx maintains SSE connection with auto-reconnect, shows connection status indicator
- **Events**: New articles ingested, scores assigned, posts delivered, etc.

## Security Hardening (9-Layer Defense)

| Layer | Protection | Configurable Via |
|-------|------------|------------------|
| 1. Domain Whitelist | Only trusted RSS source domains allowed | DB + UI (Site Rules page) |
| 2. URL Validation | Block `file://`, private IPs, localhost, cloud metadata | Code only |
| 3. Feed Size Limit | Max bytes per RSS fetch (default 5MB) | Env + UI |
| 4. XXE Protection | Secure XML parser config (no external entities) | Code only |
| 5. Article Quotas | Per-fetch limit (100) + daily limit per source (500) | Env + UI (per-source override) |
| 6. CORS Whitelist | Only allowed frontend origins can call API | Env |
| 7. API Rate Limiting | Per-endpoint request limits (200/min global) | Env + UI display |
| 8. Kill Switch | Emergency stop all social posting | UI toggle |
| 9. Nginx Basic Auth | Login required to access dashboard | Nginx config |

## Development Workflow

```bash
npm run infra:up           # Start PostgreSQL + Redis
npm run db:push            # Sync schema to local DB
npm run dev                # Start API + Worker + Frontend
```

## Production Deployment

### Deployment Toolkit

All deployment files are ready in the repo:

| File | Purpose |
|------|---------|
| `docker-compose.prod.yml` | Full production stack: postgres, redis, api, worker, frontend, nginx |
| `.env.production.template` | All env vars documented with CHANGEME placeholders |
| `packages/api/Dockerfile` | 3-stage build (deps → build → runtime), includes shared + db |
| `packages/worker/Dockerfile` | 3-stage build + native deps (canvas, sharp), includes all 6 workspace packages |
| `packages/frontend/Dockerfile` | 2-stage (Vite build → nginx static), accepts VITE_* build args |
| `deploy/nginx/nginx.conf` | Reverse proxy, basic auth, SSE support (no buffering), rate limiting, SSL-ready |
| `deploy/setup-client.sh` | Provision new client: clone, generate secrets, setup auth, build, migrate, seed, start |
| `deploy/deploy.sh` | Update running instance: git pull, rebuild, rolling restart, health check |
| `deploy/deploy-all.sh` | Iterate all `/opt/watchtower/*/` instances and deploy each |
| `deploy/backup.sh` | pg_dump + gzip, keeps last 14 backups, cron-ready |

### Deploy New Client Instance

```bash
# On VPS
git clone <repo> /opt/watchtower/acme-corp
cd /opt/watchtower/acme-corp
./deploy/setup-client.sh acme-corp    # Interactive — generates secrets, asks for auth password
nano .env                              # Fill in API keys (OpenAI, Anthropic, Telegram, etc.)
docker compose -f docker-compose.prod.yml up -d --build
```

### Update Running Instance

```bash
cd /opt/watchtower/acme-corp
./deploy/deploy.sh                     # git pull → rebuild → migrate → rolling restart → health check
```

### Environment Variables to Change for Production

| Variable | Development | Production |
|----------|-------------|------------|
| `NODE_ENV` | `development` | `production` |
| `DATABASE_URL` | `localhost` | `postgres://...:@postgres:5432/...` (Docker service name) |
| `REDIS_HOST` | `127.0.0.1` | `redis` (Docker service name) |
| `API_KEY` | `local-dev-key` | Strong random string (`openssl rand -hex 32`) |
| `VITE_API_URL` | `http://localhost:3001` | `https://yourdomain.com/api` |
| `VITE_API_KEY` | `local-dev-key` | Same as API_KEY |
| `LOG_LEVEL` | `debug` | `info` or `warn` |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | `https://yourdomain.com` |

### SSL Setup (Let's Encrypt)

1. Uncomment certbot service in `docker-compose.prod.yml`
2. Run: `docker compose -f docker-compose.prod.yml run --rm certbot certonly --webroot -w /var/www/certbot -d yourdomain.com`
3. Uncomment HTTPS server block in `deploy/nginx/nginx.conf`, replace `yourdomain.com`
4. Enable HTTP→HTTPS redirect (uncomment line 13 in nginx.conf)
5. Restart nginx: `docker compose -f docker-compose.prod.yml restart nginx`

### Post-Deploy Verification

```bash
# Check API health (no auth required)
curl https://yourdomain.com/api/health

# Watch worker pipeline
docker compose -f docker-compose.prod.yml logs -f worker

# Check all containers running
docker compose -f docker-compose.prod.yml ps

# Test digest delivery
# → Go to /digest page, configure, click "Send Test Digest"

# Daily backup (add to crontab)
# 0 3 * * * /opt/watchtower/acme-corp/deploy/backup.sh /opt/watchtower/acme-corp
```

### Security Hardening Checklist

- [ ] Generate strong `API_KEY` (`openssl rand -hex 32`) — setup-client.sh does this automatically
- [ ] Use HTTPS for all public endpoints (Let's Encrypt)
- [ ] Set `NODE_ENV=production`
- [ ] Configure `ALLOWED_ORIGINS` with production frontend URL
- [ ] Seed `allowed_domains` table with trusted RSS source domains
- [ ] Configure Nginx Basic Auth (setup-client.sh creates `.htpasswd`)
- [ ] Rotate social platform tokens before expiry (LinkedIn/Facebook: 60 days)
- [ ] Set up daily backup cron job
- [ ] Test kill switch functionality before going live
- [ ] Test digest delivery (schedule + test button)

## What's Left Before First Client

### Code-Complete (nothing left to build):
- [x] P1: Score reasoning in dashboard
- [x] P2: RSS enrichment + pre-filter + prompt enrichment
- [x] P3: Keyword alerts via Telegram
- [x] P4: Daily digest with analyst role + multi-platform
- [x] P5: Source quality dashboard
- [x] Deployment scripts + Docker production stack

### Deployment-Day Tasks (no code changes needed):
- [ ] **Get a VPS** — Hetzner ~$10/mo, run `setup-client.sh`
- [ ] **Point domain + SSL** — DNS A record → VPS IP, run certbot, update nginx config
- [ ] **Add RSS sources** — via dashboard, seed allowed_domains first
- [ ] **Configure scoring rules** — per-sector priorities, ignore lists, reject keywords
- [ ] **Set up digest** — via `/digest` page (time, timezone, analyst role, platforms)
- [ ] **Let pipeline run overnight** — builds demo data (scored articles, signal ratios)
- [ ] **Landing page** — standalone marketing site explaining the product (not part of this codebase)

### Phase 3 — After First Paying Client:
- [ ] P6: Global dedup threshold in DB (UI slider, currently env-only)
- [ ] P7: Feedback loop analytics (approval patterns, scoring accuracy)

## Key Architecture Decisions

1. **Direct PostgreSQL** (not Supabase client) — faster for batch operations, pgvector support, type-safe queries via Drizzle
2. **Pipeline stage on article row** — database is source of truth, enables reprocessing any stage independently
3. **Denormalized sector_id on articles** — avoids JOIN through rss_sources on every vector/LLM query
4. **Separate packages for llm/embeddings/social** — clean interfaces, testable, swappable providers
5. **Turborepo** — handles build dependency graph automatically, caches builds
6. **Self-healing job registry** — repeatable BullMQ jobs auto-recover every 30s if Redis is wiped
7. **Startup provider health checks** — validates all API keys (LLM, embedding, translation, social) at worker boot
8. **Delivery-controlled posting** — `post_deliveries` table decouples approval from posting; article stays `approved`, delivery row tracks per-platform scheduling
9. **Digest on maintenance queue** — no separate queue; scheduler checks time/tz/day every 30s and queues digest job when due
10. **Alerts bypass distribution** — keyword alerts go directly to Telegram via Bot API, no rate limiting or scheduling (only 5-min cooldown)

## Completed Features

All core pipeline and intelligence features:

1. Infrastructure hardening & reliability
2. Semantic Dedup Pipeline (embeddings + pgvector)
3. LLM Brain Pipeline (scoring + summarization + reasoning + multi-provider)
4. LLM Token Telemetry
5. Articles Panel + Distribution Pipeline (Telegram)
6. Scheduled Posting System
7. Facebook & LinkedIn Integration
8. Rate Limiting & Provider Hardening
9. Platform Health Monitoring (token validity, expiry tracking, emergency brake)
10. Security Hardening (9-layer defense system, Site Rules UI)
11. Georgian Translation (Gemini/OpenAI)
12. AI Image Generation (gpt-image-1-mini + R2 + canvas compositor)
13. Real-time Events (SSE)
14. Post Template System (per-platform customizable formats)
15. Self-healing Job Registry (auto-recovery after Redis wipe)
16. Score Reasoning (P1) — persisted to DB, displayed in dashboard + approval modal
17. RSS Enrichment (P2-A) — content:encoded (1500 chars), categories extraction
18. Pre-Filter Hard Reject (P2-B) — keyword matching before LLM, rejection audit trail
19. Prompt Enrichment (P2-C) — categories in LLM scoring prompt
20. Keyword Alerts (P3) — instant Telegram notifications with Redis cooldown
21. Daily Digest (P4) — LLM-curated briefing, configurable prompts, multi-platform, Georgian translation
22. Source Quality Dashboard (P5) — signal ratio, score distribution, color-coded badges
23. Production Deployment Toolkit — Docker, nginx, setup/deploy/backup scripts

---

## Codex Delegation Pattern

This project uses a two-agent workflow: **Claude** (senior architect) + **Codex** (implementation assistant).

### When to Delegate to Codex

| Delegate | Do NOT Delegate |
|----------|-----------------|
| Adding constants/exports to existing files | Architectural decisions |
| Repetitive edits across multiple files | New feature design |
| Adding similar patterns (new routes, new workers) | Debugging complex issues |
| Writing boilerplate from clear specs | Anything requiring judgment calls |
| Running tests and reporting results | Database migrations |
| Adding types to existing code | Security-sensitive code |
| **Code scanning** (summarize files, find patterns, list exports) | Complex debugging requiring context |

### How to Delegate (Automated)

Claude runs Codex directly via Bash - no copy/paste needed:

```bash
# Read-only tasks (analysis, code search)
codex exec --full-auto -C "c:\Users\VM-Dev\Desktop\watch-tower" -o codex-result.txt "TASK..."

# Write tasks (file edits) - required for any file modifications
codex exec --dangerously-bypass-approvals-and-sandbox -C "c:\Users\VM-Dev\Desktop\watch-tower" -o codex-result.txt "TASK..."
```

**Note:** `--full-auto` creates a read-only sandbox on Windows. For file writes, use the bypass flag with tightly scoped tasks.

**Workflow:**
1. Claude runs `codex exec` via Bash tool (2 min timeout)
2. Codex executes task, output saved to `codex-result.txt`
3. Claude reads result file to verify changes
4. Claude reviews changes, runs lint/build if needed
5. If blocked, Claude provides hints and re-delegates
