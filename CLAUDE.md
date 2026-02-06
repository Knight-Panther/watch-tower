# Watch Tower

Independent media monitoring agent. Scans RSS feeds by sector, deduplicates (URL + semantic), scores articles with LLM for importance, and distributes to social media with approval workflow.

## Pipeline Architecture

```
[1] INGEST ──→ [2] SEMANTIC DEDUP ──→ [3] LLM BRAIN ──→ [4] DISTRIBUTE
(fetch+filter)   (embed+compare)       (score+summarize)   (approve+post)
```

## Tech Stack

- **API**: Fastify (TypeScript)
- **Worker**: BullMQ job processor (TypeScript)
- **Frontend**: React 19 + Vite + Tailwind CSS
- **Database**: PostgreSQL 16 + pgvector (via Drizzle ORM)
- **Queue/Cache**: Redis 7
- **LLM**: Provider abstraction (Claude, OpenAI, DeepSeek) with fallback support
- **Embeddings**: OpenAI text-embedding-3-small (1536 dims)
- **Social**: Telegram Bot API, Facebook Graph API, LinkedIn API
- **Monorepo**: npm workspaces + Turborepo
- **Deployment**: Docker Compose on VPS

## Package Structure

```
packages/
├── db/            # Drizzle schema, migrations, client factory
├── shared/        # Queue constants, env schemas, shared types
├── llm/           # LLM provider abstraction (Claude, OpenAI, DeepSeek + fallback)
├── embeddings/    # Embedding generation + pgvector similarity search
├── social/        # Social poster abstraction (Telegram, Facebook, LinkedIn)
├── worker/        # Pipeline processors (ingest, dedup, score, distribute)
├── api/           # Fastify REST API
└── frontend/      # React admin dashboard
```

**Dependency graph:**
```
frontend → api (HTTP)
api → db, shared
worker → db, shared, llm, embeddings, social
llm → shared
embeddings → db
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
```

## Database Schema

Core tables (PostgreSQL + pgvector):

| Table | Purpose |
|-------|---------|
| `sectors` | Feed categories (Biotech, Crypto, Stocks, etc.) |
| `rss_sources` | Feed URLs + ingest config |
| `articles` | Core entity: title, snippet, embedding, score, pipeline_stage |
| `scoring_rules` | Per-sector LLM prompt templates + thresholds |
| `social_accounts` | Connected platform credentials (future: DB-stored) |
| `post_deliveries` | Scheduled/immediate posting per article per platform |
| `feed_fetch_runs` | Fetch attempt telemetry |
| `llm_telemetry` | LLM API call tracking (tokens, cost, latency) |
| `article_images` | AI-generated images for posts (future) |
| `app_config` | Key-value settings (incl. `auto_post_score5` toggle, `emergency_stop`) |
| `platform_health` | Social platform health status, token expiry tracking |
| `allowed_domains` | RSS source domain whitelist (security) |

**Pipeline stages** (on `articles.pipeline_stage`):
`ingested` → `embedded` → `scored` → `approved`/`rejected` → `posted` (or `duplicate`)

**Posting is controlled by `post_deliveries`** — article stays `approved`, delivery row tracks scheduling.

## BullMQ Queues

| Queue | Job | Concurrency | Purpose |
|-------|-----|-------------|---------|
| `pipeline:ingest` | `ingest-fetch` | 5 | Fetch RSS, date/URL filter, store |
| `pipeline:semantic-dedup` | `semantic-batch` | 2 | Embed batch of 50, vector search, mark dupes |
| `pipeline:llm-brain` | `llm-score-batch` | 1 | Score + summarize batch of 10 |
| `pipeline:distribution` | `distribution-immediate` | 1 | Post individual articles to platforms |
| `maintenance` | schedule/cleanup/post-scheduler | 1 | Recurring scheduling, TTL cleanup, scheduled post dispatch |

**Chaining:** Each processor queries DB for unprocessed articles and queues the next stage. Database `pipeline_stage` is the source of truth (not queue state).

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

### Formatting (Prettier)
- Semicolons: yes
- Quotes: double
- Trailing commas: all
- Line width: 100

## Environment Variables

```env
# Environment
NODE_ENV=development          # development | production (affects rate limiting, etc.)

# Database (PostgreSQL)
DATABASE_URL=postgres://watchtower:watchtower@127.0.0.1:5432/watchtower

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# API
API_KEY=local-dev-key
PORT=3001
LOG_LEVEL=info                # debug | info | warn | error

# Embeddings (OpenAI)
OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
SIMILARITY_THRESHOLD=0.85

# LLM Brain (see packages/llm/README.md for full guide)
ANTHROPIC_API_KEY=sk-ant-...
# DEEPSEEK_API_KEY=sk-...
LLM_PROVIDER=claude              # 'claude' | 'openai' | 'deepseek'
# LLM_FALLBACK_PROVIDER=openai   # Optional fallback on API failure

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

```bash
# Verbose debugging
LOG_LEVEL=debug npm run dev:worker

# Production (errors only)
LOG_LEVEL=error npm run dev:worker
```

## Cost Optimization Strategy

Filtering is ordered cheapest-first:
1. **Date filter** — FREE (in-memory during RSS parse)
2. **URL dedup** — FREE (PostgreSQL UNIQUE constraint, ON CONFLICT DO NOTHING)
3. **Semantic dedup** — ~$0.02/1M tokens (embeddings API, batch 50)
4. **LLM scoring** — Most expensive, batch 10 per call, combined score+summary

Articles store only `title + content_snippet` (not full article body).

## Approval & Posting Workflow

**Scoring outcomes:**
- Score 5 → auto-approve + immediate post (if `app_config.auto_post_score5 = true`)
- Score 1-2 → auto-reject
- Score 3-4 → manual review in dashboard

**Manual approval flow (combined modal):**
1. User clicks "Approve" on scored article (3-4)
2. Modal shows: date picker, time picker, platform checkboxes
3. On submit: article → `approved`, `post_deliveries` row created with `scheduled_at`
4. Maintenance worker polls due deliveries every 30s and posts

**Posting format:** Individual articles (no batch/digest posting)

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
- Future: AI image generation per post (interface stub exists)

### Token Expiration

| Platform | Token Lifetime | Refresh Strategy |
|----------|---------------|------------------|
| Telegram | Never expires | N/A |
| Facebook | ~60 days | Manual re-auth or use long-lived page token |
| LinkedIn | ~60 days | Manual re-auth (offline_access requires partner approval) |

## Security Hardening (9-Layer Defense)

Watch Tower implements defense-in-depth security to protect against malicious RSS feeds, API abuse, and content injection.

### Security Layers

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

### Domain Whitelist (Layer 1)

- Backend-only list of approved RSS source domains (e.g., `reuters.com`, `bloomberg.com`)
- Stored in `allowed_domains` table, managed via Site Rules UI
- When adding RSS source, domain must be in whitelist or request returns 403
- Protects against SSRF and malicious feed injection

### Article Quotas (Layer 5)

- **Global defaults** set via environment variables
- **Per-source overrides** via `rss_sources.max_articles_per_fetch` and `rss_sources.max_articles_per_day`
- Prevents database flooding from compromised/buggy feeds

### Kill Switch (Layer 8)

- `app_config.emergency_stop = true` stops ALL social posting
- Pipeline continues (fetch, score) but no posts go out
- Toggle via Site Rules UI or API: `POST /config/emergency-stop`

### Nginx Basic Auth (Layer 9)

- Browser login prompt before accessing any page
- Configured at Nginx reverse proxy level (VPS deployment)
- Credentials stored in `/etc/nginx/.htpasswd`
- Free, no code changes required
- `/api/health` excluded from auth (for monitoring tools)

### Frontend: Site Rules Page

New page with tabs for managing security settings:
- **Domain Whitelist** - Add/remove allowed RSS domains
- **Feed Limits** - View global defaults, set per-source overrides
- **API Security** - View CORS origins, rate limits
- **Emergency Controls** - Kill switch toggle

## Development Workflow

```bash
npm run infra:up           # Start PostgreSQL + Redis
npm run db:push            # Sync schema to local DB
npm run dev                # Start API + Worker + Frontend
```

## Production Deployment Checklist

### Environment Variables to Change

| Variable | Development | Production |
|----------|-------------|------------|
| `NODE_ENV` | `development` | `production` |
| `DATABASE_URL` | `localhost` | Production PostgreSQL URL |
| `REDIS_HOST` | `127.0.0.1` | Redis container name or hosted Redis |
| `API_KEY` | `local-dev-key` | Strong random string (32+ chars) |
| `VITE_API_URL` | `http://localhost:3001` | `https://api.yourdomain.com` |
| `VITE_API_KEY` | `local-dev-key` | Same as API_KEY |
| `LOG_LEVEL` | `debug` | `info` or `warn` |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | `https://yourdomain.com` |

### OAuth Redirect URLs

OAuth callbacks happen in the browser, so production URLs must be registered in each platform's developer console:

| Platform | Dev URL | Production URL |
|----------|---------|----------------|
| LinkedIn | `http://localhost:5173/linkedin/callback` | `https://yourdomain.com/linkedin/callback` |
| Facebook | `http://localhost:5173/facebook/callback` | `https://yourdomain.com/facebook/callback` |

**Note:** You can register multiple redirect URLs per app (both dev and prod).

### Docker Considerations

- Inside Docker network: services communicate via container names (e.g., `redis`, `postgres`)
- OAuth redirects: happen in user's browser, need public URLs
- Frontend: static files served by nginx or similar, not Vite dev server
- API/Worker: run as separate containers, share same env vars for database/redis

### Security Hardening

- [ ] Generate strong `API_KEY` (e.g., `openssl rand -hex 32`)
- [ ] Use HTTPS for all public endpoints (Let's Encrypt)
- [ ] Set `NODE_ENV=production` (enables stricter rate limiting)
- [ ] Configure `ALLOWED_ORIGINS` with production frontend URL
- [ ] Seed `allowed_domains` table with trusted RSS source domains
- [ ] Review and adjust `MAX_FEED_SIZE_MB`, `MAX_ARTICLES_PER_FETCH`, `MAX_ARTICLES_PER_SOURCE_DAILY`
- [ ] Configure Nginx Basic Auth with `.htpasswd` file
- [ ] Rotate social platform tokens before expiry (LinkedIn/Facebook: 60 days)
- [ ] Backup PostgreSQL database regularly
- [ ] Monitor Redis memory usage
- [ ] Test kill switch functionality before going live

### Post-Deploy Verification

```bash
# Check API health
curl https://api.yourdomain.com/health

# Check worker logs
docker logs watchtower-worker --tail 100

# Verify social posting works
# (Enable auto_post_telegram in app_config, wait for score 5 article)
```

## Key Architecture Decisions

1. **Direct PostgreSQL** (not Supabase client) — faster for batch operations, pgvector support, type-safe queries via Drizzle
2. **Pipeline stage on article row** — database is source of truth, enables reprocessing any stage independently
3. **Denormalized sector_id on articles** — avoids JOIN through rss_sources on every vector/LLM query
4. **Separate packages for llm/embeddings/social** — clean interfaces, testable, swappable providers
5. **Turborepo** — handles build dependency graph automatically, caches builds

## Priority Tasks

Implementation tasks are tracked in the `priority-tasks/` folder at the project root.

- **Active tasks**: `taskN.md` files contain detailed implementation steps
- **Completed tasks**: Renamed to `taskN_done.md` after all items are implemented
- **Always check this folder first** when starting a new session to understand pending work

Completed:
- `task12_done.md` — Security Hardening (9-layer defense system, Site Rules UI, security tests)
- `task11_done.md` — Platform Health Monitoring (token validity, expiry tracking, emergency brake)
- `task1_done.md` — Infrastructure hardening & reliability
- `task2_done.md` — Stage 2: Semantic Dedup Pipeline
- `task3_done.md` — Stage 3: LLM Brain Pipeline (scoring + summarization + multi-provider)
- `task4_done.md` — LLM Token Telemetry
- `task5_done.md` — Articles Panel + Distribution Pipeline (Telegram)
- `task6_done.md` — Scheduled Posting System
- `task9_done.md` — Facebook & LinkedIn Integration
- `task10_done.md` — Rate Limiting & Provider Hardening

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

### Delegation Prompt Template

```
TASK: [One-line description of what to do]

SCOPE:
- packages/[package]/src/[file].ts

CONTEXT:
- This project uses [relevant pattern]
- See existing code in [reference file] for style

PATTERN:
```typescript
// Example of the pattern to follow
const example = ...
```

OUTPUT:
- Modified [file] with [change]
- Run `npm run lint` to verify

CONSTRAINTS:
- Do NOT modify any other files
- Do NOT add new dependencies
- Match existing code style exactly
```

### After Delegation

1. **Read the result file** (`codex-result.txt`)
2. **Review changes** - check for scope creep or pattern violations
3. **Run verification** - `npm run lint && npm run build`
4. **Integrate or fix** - merge good changes, provide debug hints if blocked

### Codex Rules Reference

Codex follows strict rules defined in `CODEX.md`:
- Execute exactly what is asked
- Never make architectural decisions
- Report blockers instead of guessing
- Stay within specified SCOPE
- Follow existing code patterns

### Example Delegations

**Good (write task):**
```
TASK: Add QUEUE_SEMANTIC constant to shared package
SCOPE: packages/shared/src/index.ts
PATTERN: Follow existing QUEUE_* constants (line 5-8)
OUTPUT: New export `QUEUE_SEMANTIC = "pipeline:semantic-dedup"`
```

**Good (scan task - saves Claude tokens):**
```
TASK: Analyze packages/api/src/routes/stats.ts
OUTPUT: List all database queries, what tables they touch, and any potential N+1 issues
```

**Bad:**
```
TASK: Improve the API performance
```
(Too vague - no scope, no pattern, requires judgment)

### Debugging Assistance

If Codex reports BLOCKED, provide targeted hints:

```
CODEX REPORTED: Type error on line 45
HINT: The function expects `Database` type from @watch-tower/db, not the raw pg Pool.
Import it with: import type { Database } from "@watch-tower/db";
```

Then re-delegate with the hint included in CONTEXT.
