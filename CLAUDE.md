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
- **LLM**: Provider abstraction (Anthropic Claude + OpenAI)
- **Embeddings**: OpenAI text-embedding-3-small (1536 dims)
- **Social**: Telegram Bot API, Facebook Graph API, LinkedIn API
- **Monorepo**: npm workspaces + Turborepo
- **Deployment**: Docker Compose on VPS

## Package Structure

```
packages/
├── db/            # Drizzle schema, migrations, client factory
├── shared/        # Queue constants, env schemas, shared types
├── llm/           # LLM provider abstraction (Claude + OpenAI)
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
| `post_batches` | Grouped articles for one social post |
| `social_accounts` | Connected platform credentials |
| `post_deliveries` | Per-platform delivery status |
| `feed_fetch_runs` | Fetch attempt telemetry |
| `app_config` | Key-value settings |

**Pipeline stages** (on `articles.pipeline_stage`):
`ingested` → `embedded` → `scored` → `approved`/`rejected` → `posted` (or `duplicate`)

## BullMQ Queues

| Queue | Job | Concurrency | Purpose |
|-------|-----|-------------|---------|
| `pipeline:ingest` | `ingest-fetch` | 5 | Fetch RSS, date/URL filter, store |
| `pipeline:semantic-dedup` | `semantic-batch` | 2 | Embed batch of 50, vector search, mark dupes |
| `pipeline:llm-brain` | `llm-score-batch` | 1 | Score + summarize batch of 10 |
| `pipeline:distribution` | `distribution-build/post` | 3 | Build post batch, send to platforms |
| `maintenance` | schedule/cleanup | 1 | Recurring scheduling + TTL cleanup |

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
- **Event-driven chaining**: Each worker queues the next stage after completion

### Formatting (Prettier)
- Semicolons: yes
- Quotes: double
- Trailing commas: all
- Line width: 100

## Environment Variables

```env
# Database (PostgreSQL)
DATABASE_URL=postgres://watchtower:watchtower@127.0.0.1:5432/watchtower

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# API
API_KEY=local-dev-key
PORT=3001

# LLM Providers (Phase 4 — not yet used)
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# LLM_PROVIDER=claude          # 'claude' | 'openai'

# Frontend
VITE_API_URL=http://localhost:3001
VITE_API_KEY=local-dev-key
```

## Cost Optimization Strategy

Filtering is ordered cheapest-first:
1. **Date filter** — FREE (in-memory during RSS parse)
2. **URL dedup** — FREE (PostgreSQL UNIQUE constraint, ON CONFLICT DO NOTHING)
3. **Semantic dedup** — ~$0.02/1M tokens (embeddings API, batch 50)
4. **LLM scoring** — Most expensive, batch 10 per call, combined score+summary

Articles store only `title + content_snippet` (not full article body).

## Approval Workflow

- Score 5 → auto-approve (configurable per sector via `scoring_rules`)
- Score 1-2 → auto-reject
- Score 3-4 → manual review in dashboard
- Post formats: top5 or top10 bullet-point lists per sector

## Social Posting

- **Telegram**: Bot API, chat/channel posting
- **Facebook**: Graph API, page posting
- **LinkedIn**: API, organization posting
- Per-platform rate limiting (Redis sliding window, default 4/hour)
- Future: AI image generation per post (interface stub exists)

## Development Workflow

```bash
npm run infra:up           # Start PostgreSQL + Redis
npm run db:push            # Sync schema to local DB
npm run dev                # Start API + Worker + Frontend
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

Current tasks:
- (none pending)

Completed:
- `task1_done.md` — Infrastructure hardening & reliability
