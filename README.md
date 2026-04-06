# Watch Tower

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL+pgvector-4169E1?style=flat&logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white)](https://redis.io/)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=flat&logo=react&logoColor=black)](https://react.dev/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI-powered media monitoring pipeline.** Ingests 500+ RSS sources, deduplicates semantically with pgvector, scores with LLM, translates to Georgian, generates AI news card images, and delivers curated briefings to Telegram, Facebook, and LinkedIn — with a full web dashboard.

```
[INGEST] → [SEMANTIC DEDUP] → [PRE-FILTER] → [LLM SCORE] → [TRANSLATE] → [IMAGE GEN] → [DISTRIBUTE]
  RSS         pgvector            keywords        1-5 score     Georgian      AI cards       social
```

### Key Features

- **7-stage pipeline** with PostgreSQL as source of truth — each stage independently restartable
- **Multi-provider LLM** (Claude / OpenAI / DeepSeek) with automatic fallback
- **Semantic deduplication** via OpenAI embeddings + pgvector cosine similarity
- **Georgian (ka) translation** via Gemini/OpenAI with per-article status tracking
- **AI news card images** via OpenAI gpt-image-1-mini + Cloudflare R2 + canvas compositor
- **Keyword alerts** — instant Telegram notifications when scored articles match rules (LLM semantic matching, per-rule language, muting)
- **Daily digest** — multi-slot LLM briefings with draft approval workflow, per-channel language, cover images
- **SmartHub Advisor** — scheduled pipeline intelligence (13-metric SQL snapshot → LLM recommendations → one-click apply)
- **Real-time dashboard** with Server-Sent Events, approval workflow, analytics, telemetry
- **9-layer security** (domain whitelist, SSRF protection, XXE mitigation, rate limiting, kill switch)
- **Production-ready** Docker Compose stack with Nginx, Let's Encrypt, rolling deploy scripts

---

An automated news monitoring system that scans RSS feeds, scores articles using AI, translates them to Georgian, generates news card images, and distributes them to social media — with full approval workflow and admin dashboard.

## What Does Watch Tower Do?

Think of Watch Tower as an automated newsroom assistant:

1. It checks RSS feeds from news sources you configure (Reuters, Bloomberg, TechCrunch, etc.)
2. It removes duplicate articles (both exact URL matches and semantically similar ones)
3. An AI reads each article and gives it an importance score from 1 to 5
4. High-scoring articles get auto-approved; low-scoring ones get rejected; middle ones wait for your manual review
5. Approved articles get translated to Georgian (optional)
6. AI generates a custom news card image for each approved article
7. The article (with image) gets posted to Telegram, Facebook, and LinkedIn

Everything is configurable from a web dashboard. You control which feeds to monitor, how scoring works per sector, which platforms to post to, and what the posts look like.

---

## The Pipeline (Step by Step)

Articles flow through 6 stages, like a conveyor belt. Each stage is a separate worker process, and the database tracks where every article is in the pipeline.

```
RSS Feeds ──> [1. INGEST] ──> [2. DEDUP] ──> [3. SCORE] ──> [4. TRANSLATE] ──> [5. IMAGE] ──> [6. DISTRIBUTE]
```

### Stage 1: Ingest

**What happens:** The system fetches RSS feeds on a schedule (every few minutes). For each new article, it saves the title, a short snippet, the source URL, and which sector it belongs to (Biotech, Crypto, Stocks, etc.).

**Filters applied (cheapest first):**
- Date filter — skips articles older than a configured cutoff (free, in-memory)
- URL dedup — skips articles we've already seen (free, database unique constraint)

**Where articles go:** `pipeline_stage = ingested`

### Stage 2: Semantic Dedup (Duplicate Detection)

**What happens:** Even if two articles have different URLs, they might cover the same story. This stage generates a mathematical fingerprint (embedding) for each article and compares it against recent articles. If two articles are too similar, the newer one is marked as a duplicate.

**How it works:** Uses OpenAI's embedding model to convert article text into a 1536-number vector. Then uses pgvector (a PostgreSQL extension) to find similar articles. The similarity threshold is configurable (default: 0.85).

**Where articles go:** `pipeline_stage = embedded` (or `duplicate` if too similar)

### Stage 3: LLM Brain (Scoring)

**What happens:** An AI model reads each article's title and snippet, then assigns:
- **Importance score** (1-5): How newsworthy is this?
- **Summary**: A concise English summary of the article

**Scoring is configurable per sector.** In the dashboard (LLM Brain page), you can set:
- Topics to prioritize (articles about these score higher)
- Topics to ignore (articles about these score lower)
- Custom scoring instructions per sector

**What happens based on score:**

| Score | What Happens |
|-------|-------------|
| 5 | Auto-approved, queued for translation + image + posting |
| 4 | Auto-approved, queued for translation + image + posting |
| 3 | Stays in dashboard for manual review |
| 2 | Auto-rejected |
| 1 | Auto-rejected |

The auto-approve and auto-reject thresholds are configurable via environment variables (`LLM_AUTO_APPROVE_THRESHOLD`, `LLM_AUTO_REJECT_THRESHOLD`).

**LLM providers:** The system supports multiple AI providers with automatic fallback:
- **DeepSeek** (default, cheapest)
- **OpenAI** (GPT-4o-mini)
- **Claude** (Anthropic)

If the primary provider's API fails, it automatically tries the fallback provider.

**Where articles go:** `pipeline_stage = scored` then `approved` or `rejected`

### Stage 4: Translation (Georgian)

**What happens:** Approved articles with score >= 4 get their title and summary translated to Georgian. The original English versions are kept alongside the translations.

**What gets translated:**
- Article title -> `title_ka` (Georgian title)
- LLM summary -> `llm_summary_ka` (Georgian summary)

**What does NOT get translated:**
- The source URL (always the original English link)
- The article snippet

**Providers:** Gemini (Google AI) is the primary translator, OpenAI is the fallback.

**Language toggle:** The `posting_language` setting in the dashboard (Settings page) controls which language gets posted:
- `en` = posts use English title + summary
- `ka` = posts use Georgian title + summary

This setting takes effect immediately — no restart needed. The worker checks it on every post attempt.

**Where articles go:** `translation_status = translated` (article stays `approved`)

### Stage 5: Image Generation

**What happens:** An AI generates a unique editorial illustration for each approved article. The image is then composited with the article's title text overlaid on the bottom portion (using a semi-transparent overlay for readability).

**How it works:**
1. OpenAI's `gpt-image-1-mini` generates a base illustration based on the article summary
2. A canvas compositor overlays the Georgian (or English) title on the bottom of the image
3. The final image is uploaded to Cloudflare R2 (cloud storage)
4. The public URL is saved in the database

**The image prompt is customizable** from the dashboard (LLM Brain page). It controls the style, mood, and constraints of generated images.

**Where articles go:** Image saved in `article_images` table (article stays `approved`)

### Stage 6: Distribution (Social Posting)

**What happens:** The article (with image) gets posted to whichever social platforms you've enabled.

**Supported platforms:**
- **Telegram** — Bot sends to a channel/group
- **Facebook** — Posts to a Facebook Page (with optional auto-comment for source URL)
- **LinkedIn** — Posts to a personal profile or organization page

**Two ways articles get distributed:**

1. **Auto-post (immediate):** When an article is auto-approved (score >= threshold) and auto-post is enabled for a platform, it gets queued immediately. There's a 45-second stagger between posts to avoid flooding.

2. **Scheduled post (manual):** When you manually approve an article from the dashboard, you pick a date, time, and which platforms to post to. A scheduler checks every 30 seconds for due posts.

**Rate limiting:** Each platform has its own rate limit to avoid getting banned:
- Telegram: 20 posts/hour
- Facebook: 1 post/hour (~25/day max)
- LinkedIn: 4 posts/hour

These limits are stored in the database and can be changed from the dashboard without restarting.

**Where articles go:** `post_deliveries` table tracks each delivery per platform (article stays `approved`)

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker (for PostgreSQL + Redis)
- API keys (see Environment Variables section)

> **Image generation:** If you enable AI news card images, place your watermark/logo at `packages/worker/assets/watermark/logo.png`. Without this file the image compositor will fail. You can disable image generation entirely via `image_generation_enabled` in the dashboard Settings page.

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL and Redis
npm run infra:up

# 3. Push database schema
npm run db:push

# 4. Copy environment file and fill in your API keys
cp .env.example .env
# Edit .env with your keys (see Environment Variables section)

# 5. Seed initial data (sectors, config)
npm run db:seed

# 6. Start everything (API + Worker + Frontend)
npm run dev
```

The dashboard will be at `http://localhost:5173`.
The API runs at `http://localhost:3001`.

### Other Useful Commands

```bash
npm run dev:api          # Start only the API server
npm run dev:worker       # Start only the background worker
npm run dev:frontend     # Start only the dashboard
npm run build            # Build all packages
npm run db:studio        # Open database GUI (Drizzle Studio)
# Pipeline reset: POST /reset via API, or Settings page in the dashboard
# Flushes Redis + truncates articles/deliveries/telemetry + resets fetch timestamps
```

---

## Environment Variables

Create a `.env` file in the project root. Here's every variable explained:

### Core Infrastructure

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Set to `production` for stricter rate limits and security |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_HOST` | Yes | `127.0.0.1` | Redis server address |
| `REDIS_PORT` | No | `6379` | Redis port |
| `API_KEY` | Yes | — | Secret key that protects API endpoints. Generate with `openssl rand -hex 32` |
| `PORT` | No | `3001` | API server port |
| `LOG_LEVEL` | No | `info` | How much detail to log: `debug`, `info`, `warn`, `error` |

### AI / LLM (for article scoring)

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `LLM_PROVIDER` | No | `claude` | Primary scoring provider: `claude`, `openai`, or `deepseek` |
| `ANTHROPIC_API_KEY` | If using Claude | — | Anthropic API key |
| `OPENAI_API_KEY` | Yes | — | Used for embeddings AND optionally for scoring/translation |
| `DEEPSEEK_API_KEY` | If using DeepSeek | — | DeepSeek API key |
| `LLM_FALLBACK_PROVIDER` | No | — | Backup provider if primary fails (e.g., `openai`) |
| `LLM_FALLBACK_MODEL` | No | — | Model for the fallback provider (e.g., `gpt-4o-mini`) |
| `LLM_AUTO_APPROVE_THRESHOLD` | No | `5` | Score >= this gets auto-approved |
| `LLM_AUTO_REJECT_THRESHOLD` | No | `2` | Score <= this gets auto-rejected |

### Embeddings (for duplicate detection)

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | OpenAI embedding model (uses `OPENAI_API_KEY`) |
| `SIMILARITY_THRESHOLD` | No | `0.85` | How similar two articles must be to count as duplicates (0-1, higher = stricter) |

### Translation (Georgian)

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `GOOGLE_AI_API_KEY` | If using Gemini | — | Google AI API key for Gemini translation. Get from [AI Studio](https://aistudio.google.com/apikey) |

Translation provider, model, and language are configured from the dashboard Settings page (not env vars).

### Image Generation + Storage

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `R2_ACCOUNT_ID` | If images enabled | — | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | If images enabled | — | R2 access key |
| `R2_SECRET_ACCESS_KEY` | If images enabled | — | R2 secret key |
| `R2_BUCKET_NAME` | If images enabled | — | R2 bucket name |
| `R2_PUBLIC_URL` | If images enabled | — | Public URL prefix for images (e.g., `https://pub-xxx.r2.dev`) |

Image generation uses `OPENAI_API_KEY` for the gpt-image-1-mini model.

### Social Platforms

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | If using Telegram | — | Get from @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | If using Telegram | — | Channel/group ID to post to |
| `FB_PAGE_ID` | If using Facebook | — | Facebook Page ID (found in Page About section) |
| `FB_ACCESS_TOKEN` | If using Facebook | — | Page access token with `pages_manage_posts` + `pages_manage_engagement` permissions |
| `LINKEDIN_AUTHOR_TYPE` | If using LinkedIn | `person` | `person` for personal profile, `organization` for company page |
| `LINKEDIN_AUTHOR_ID` | If using LinkedIn | — | Your LinkedIn person ID or organization ID |
| `LINKEDIN_ACCESS_TOKEN` | If using LinkedIn | — | OAuth access token with `w_member_social` scope |

**Token expiration:**
- Telegram: never expires
- Facebook: page tokens derived from long-lived user tokens never expire
- LinkedIn: ~60 days, must be manually re-authorized

### Security

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `MAX_FEED_SIZE_MB` | No | `5` | Max size of a single RSS feed download |
| `MAX_ARTICLES_PER_FETCH` | No | `100` | Max articles to save from one feed fetch |
| `MAX_ARTICLES_PER_SOURCE_DAILY` | No | `500` | Max articles from one source per day |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173` | CORS origins allowed to call the API (comma-separated) |
| `API_RATE_LIMIT_PER_MINUTE` | No | `200` | Max API requests per minute |

### Frontend

| Variable | Required | Default | What It Does |
|----------|----------|---------|-------------|
| `VITE_API_URL` | Yes | — | URL where the API server runs (e.g., `http://localhost:3001`) |
| `VITE_API_KEY` | Yes | — | Same value as `API_KEY` above |

---

## Language Mode (English / Georgian)

Watch Tower supports posting in English or Georgian. Here's how the language system works:

### How to Switch Language

Go to the dashboard **Settings** page and change `posting_language`:
- `en` = posts in English
- `ka` = posts in Georgian

The change takes effect immediately. No restart needed.

### What Happens in Each Mode

**English mode (`en`):**
```
Post title:   FDA Approves New Gene Therapy
Post summary: The FDA has granted breakthrough therapy designation...
Source URL:   https://reuters.com/article/... (always English)
```

**Georgian mode (`ka`):**
```
Post title:   FDA-მ ახალი გენური თერაპია დაამტკიცა
Post summary: FDA-მ გარღვევის თერაპიის აღნიშვნა მიანიჭა...
Source URL:   https://reuters.com/article/... (always English)
```

### Translation Flow

1. Article gets scored (Stage 3)
2. If score >= 4, it's queued for translation
3. Gemini (or OpenAI fallback) translates title + summary to Georgian
4. Both English and Georgian versions are stored side by side
5. At post time, the worker checks `posting_language` and picks the right version

### What If Translation Fails?

- The system retries up to 3 times
- After 3 failures, the article is marked `translation_status = exhausted`
- In Georgian mode, articles without translation are skipped (not posted with English text)
- The article can still be posted manually in English mode

---

## Social Media Posting

### Platform Details

#### Telegram
- Posts as a bot to a channel or group
- Supports text formatting (bold, links)
- Images are sent as photo messages with caption
- Rate limit: 20/hour (generous, Telegram is very permissive)

#### Facebook
- Posts to a Facebook Page (not personal profile)
- Image posts use the `/photos` endpoint
- **Auto-Comment URL:** When enabled, the source link is posted as the first comment instead of cluttering the post text. This looks much cleaner on mobile. Toggle this in Post Templates > Facebook > Auto-Comment URL
- Rate limit: 1/hour (~25/day to stay safe with Facebook's limits)
- Token requires `pages_manage_posts` + `pages_manage_engagement` permissions

#### LinkedIn
- Posts to a personal profile or organization page
- Images are uploaded as a multi-step process (register upload, upload binary, create post)
- Rate limit: 4/hour (100/day limit from LinkedIn)
- Token expires every ~60 days

### Post Templates

Each platform has its own customizable post template. Go to **Media Channel Control > Post Formats** in the dashboard.

You can toggle on/off for each platform:
- **Breaking Label** — "BREAKING" prefix with emoji
- **Sector Tag** — Shows "BIOTECH", "CRYPTO", etc.
- **Title** — Article title
- **Summary** — AI-generated summary
- **URL Link** — Link to the original article (with customizable link text)
- **Image** — AI-generated news card image
- **Auto-Comment URL** (Facebook only) — Posts source URL as first comment instead of in post text

### Auto-Post vs Manual Post

**Auto-post:** Articles scoring >= threshold get posted automatically. Each platform can be toggled independently from the dashboard Settings page (`auto_post_telegram`, `auto_post_facebook`, `auto_post_linkedin`).

**Manual post:** From the Articles page, click an article > Approve > Pick date/time/platforms > Submit. The scheduler handles posting at the scheduled time.

---

## AI Image Generation

### How It Works

1. Article gets approved (score >= 4)
2. OpenAI's `gpt-image-1-mini` generates a base illustration based on the article's summary
3. A canvas compositor adds:
   - The article title (Georgian or English) on the bottom portion
   - A semi-transparent overlay behind the text for readability
   - Branding/watermark elements (configurable)
4. The composed image is uploaded to Cloudflare R2
5. The public URL is attached to social media posts

### Customization

**Image prompt:** Configurable from the LLM Brain page. Controls the visual style of generated images.

**Image template:** Configurable from the Image Template page. Controls:
- Font size, color, and family
- Overlay opacity and position
- Branding elements
- Background gradient colors

### Cost

Using `gpt-image-1-mini` at medium quality:
- ~$0.011 per 1024x1024 image
- ~$0.015 per 1024x1536 image

Cost is tracked per image in the `article_images` table and visible in telemetry.

### What If Image Generation Fails?

- The system retries up to 3 times with exponential backoff
- If all retries fail, the article is posted without an image (text-only fallback)
- Failed images are logged in telemetry for monitoring

---

## Keyword Alerts

Instant Telegram notifications when scored articles match keyword rules — bypasses the distribution pipeline entirely.

- **LLM semantic matching**: Keywords are injected into the scoring prompt; the LLM returns which keywords matched (no brittle regex)
- **Per-rule language**: Each rule can send alerts in English or Georgian (translated via Gemini/OpenAI)
- **Sector scoping**: Rules can be global or limited to a specific sector
- **Cooldown**: 5-minute per-rule/per-article cooldown to avoid duplicate alerts
- **Quiet hours**: Configurable overnight suppression window (IANA timezone aware)
- **Muting**: Per-rule mute for 1h / 4h / 12h / 24h / 48h from the dashboard
- **Audit trail**: Every alert delivery recorded in `alert_deliveries` table

---

## Daily Digest

LLM-curated intelligence briefings delivered on a configurable schedule to Telegram, Facebook, and LinkedIn.

- **Multi-slot**: Multiple independent schedules (e.g., "Morning Brief" at 08:00, "Evening Wrap" at 18:00)
- **Draft approval**: Generated digest → review/edit → approve → post immediately or schedule
- **Per-channel language**: Each slot can deliver in English or Georgian per platform independently
- **Cover images**: Optional AI-generated cover per platform per slot
- **Analyst roles**: Configurable LLM persona (VC analyst, PR monitor, market intel, etc.)
- **Auto-post or manual**: Per-slot toggle for automatic delivery vs. draft review
- **Audit trail**: Every sent digest recorded in `digest_runs` (immutable, includes channel results + score distribution)

---

## SmartHub Advisor

Scheduled LLM-driven pipeline intelligence — analyzes metrics and generates actionable recommendations.

- **13-metric SQL snapshot**: Source quality, sector stats, rejection breakdown, score trends, keyword effectiveness, dedup stats, cost analysis, platform delivery, alert effectiveness, and more
- **Structured recommendations**: Categorized by type (`source`, `keyword`, `threshold`, `prompt`, `cost`, etc.) and priority (`high`/`medium`/`low`)
- **One-click apply**: Each recommendation includes a structured action (`endpoint` + `params`) for direct application
- **Configurable schedule**: Runs daily at a configured time, or triggered manually
- **Apply tracking**: `applied_at` timestamp per recommendation for auditability

---

## Security

Watch Tower has 9 layers of defense to protect against malicious feeds, API abuse, and content injection.

### Layer 1: Domain Whitelist

**What:** Only articles from trusted domains (reuters.com, bloomberg.com, etc.) are accepted.

**Why:** Prevents someone from adding a malicious RSS feed that could inject bad content or try to attack the system.

**Where to manage:** Dashboard > Site Rules > Domain Whitelist

### Layer 2: URL Validation

**What:** Blocks dangerous URL schemes like `file://`, private IP addresses (127.0.0.1, 192.168.x.x), and cloud metadata endpoints.

**Why:** Prevents SSRF attacks where a malicious feed URL could make the server read internal files or cloud credentials.

### Layer 3: Feed Size Limit

**What:** RSS feeds larger than 5MB (configurable) are rejected.

**Why:** Prevents memory exhaustion from a feed that's abnormally large (either malicious or broken).

**Config:** `MAX_FEED_SIZE_MB` env var, or dashboard Site Rules

### Layer 4: XXE Protection

**What:** The XML parser is configured to reject external entities.

**Why:** Prevents XXE attacks where a specially crafted RSS feed could read server files through XML entity references.

### Layer 5: Article Quotas

**What:** Limits how many articles can be saved per fetch (100) and per source per day (500).

**Why:** Prevents database flooding from a compromised or buggy feed that suddenly produces thousands of articles.

**Config:** `MAX_ARTICLES_PER_FETCH`, `MAX_ARTICLES_PER_SOURCE_DAILY` env vars. Per-source overrides available in the dashboard.

### Layer 6: CORS Whitelist

**What:** Only the configured frontend URL can call the API.

**Why:** Prevents other websites from making requests to your API on behalf of a logged-in user.

**Config:** `ALLOWED_ORIGINS` env var

### Layer 7: API Rate Limiting

**What:** Global limit on API requests per minute (default: 200).

**Why:** Prevents brute-force attacks and accidental API flooding.

**Config:** `API_RATE_LIMIT_PER_MINUTE` env var

### Layer 8: Emergency Kill Switch

**What:** One toggle that immediately stops ALL social media posting. The rest of the pipeline (fetch, score, translate) continues, but nothing goes out.

**Why:** If something goes wrong (wrong posts going out, account issues, PR crisis), you can shut it all down instantly.

**Where:** Dashboard > Site Rules > Emergency Controls, or API: `POST /config/emergency-stop`

### Layer 9: Nginx Basic Auth

**What:** A username/password prompt before accessing any page (configured at the web server level).

**Why:** Adds a login barrier even if someone discovers the dashboard URL. No code changes needed.

**Config:** Nginx `.htpasswd` file on the production server

---

## Dashboard Pages

| Page | What It Does |
|------|-------------|
| **Home** | RSS sources overview + signal ratio badges (green/amber/red by source quality) |
| **Monitoring** | Pipeline health, source fetch status, platform health, token expiry warnings |
| **Articles** | Browse all articles, see scores + reasoning, approve/reject, schedule posts |
| **Scheduled** | View upcoming scheduled posts, cancel or reschedule |
| **LLM Brain** | Configure scoring rules per sector (priority topics, ignore, reject keywords, score definitions, examples) |
| **Media Channels** | Customize post templates per platform, manage platform connections, rate limits |
| **Image Template** | Design the news card layout (fonts, colors, overlay, branding) |
| **Alerts** | Keyword alert rules — instant Telegram notifications with LLM semantic matching, muting, language toggle |
| **Digests** | Multi-slot daily digest management — schedule, analyst role, draft approval, per-channel language, cover images |
| **SmartHub** | Pipeline intelligence advisor — LLM-driven recommendations, one-click apply, run history |
| **Analytics** | Score distribution, approval rates, rejection breakdown, source ranking, sector performance (30-day) |
| **Restrictions** | Security: domain whitelist, feed limits, dedup threshold slider, emergency kill switch |
| **DB/Telemetry** | Database tools, LLM API call tracking (tokens, cost, latency), pipeline reset |

---

## Common Operations

### Reset the Pipeline (Fresh Start)

Use the **Settings page** in the dashboard, or call the API directly:

```bash
curl -X POST http://localhost:3001/reset \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'
```

This does:
- Flushes Redis (clears all job queues)
- Truncates articles, post_deliveries, llm_telemetry, feed_fetch_runs tables
- Resets `last_fetched_at` on all RSS sources so they get re-fetched

Then `npm run dev` to start fresh.

### Check Worker Logs

```bash
# Verbose mode (see every feed parse, every score, every post)
LOG_LEVEL=debug npm run dev:worker

# Normal mode
npm run dev:worker

# Errors only
LOG_LEVEL=error npm run dev:worker
```

### Emergency Stop

If posts are going out that shouldn't be:

1. **Dashboard:** Site Rules > Emergency Controls > flip the kill switch
2. **API:** `POST /config/emergency-stop` with your API key
3. The pipeline keeps running (articles still get scored and translated) but nothing gets posted

To resume posting, flip the switch back off.

### Open Database GUI

```bash
npm run db:studio
```

Opens Drizzle Studio in your browser — lets you browse and edit database tables directly.

---

## Troubleshooting

### "Article scored but not posted"

1. Check if auto-post is enabled for the platform (Settings page)
2. Check if the platform rate limit has been hit (Monitoring page)
3. Check if emergency stop is on (Site Rules page)
4. Check if the platform token is expired (Monitoring page shows token expiry)
5. Look at `post_deliveries` table — if status is `failed`, the error message explains why

### "Translation failed"

1. Check if `GOOGLE_AI_API_KEY` is set in `.env`
2. Check `translation_status` on the article — `exhausted` means 3 retries all failed
3. Check `llm_telemetry` table for error messages from the translation provider
4. Verify the translation provider is set correctly in Settings

### "Image not generated"

1. Check if image generation is enabled (Settings > `image_generation_enabled`)
2. Check if `OPENAI_API_KEY` is set (image gen uses OpenAI)
3. Check if R2 credentials are configured (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, etc.)
4. Check `article_images` table — `failed` status includes error message
5. The article will still be posted without an image (text-only fallback)

### "Facebook post has no comment with URL"

1. Check Post Templates > Facebook > Auto-Comment URL is toggled ON
2. Check that Image toggle is also ON (auto-comment only works with image posts)
3. Verify Facebook token has `pages_manage_engagement` permission
4. Comment failures are silent (non-critical) — check worker logs at `debug` level

### "Dashboard shows 'connection lost'"

The dashboard uses Server-Sent Events (SSE) for live updates. If the connection indicator shows disconnected:
1. Check if the API server is running (`npm run dev:api`)
2. Check browser console for errors
3. The dashboard auto-reconnects, so it may just be a temporary network hiccup

### "Worker not processing articles"

1. Check if Redis is running (`npm run infra:up`)
2. Check worker logs for startup errors
3. The worker auto-recovers its job schedule every 30 seconds — if Redis was temporarily down, it will catch up

---

## Project Structure

```
watch-tower/
├── packages/
│   ├── db/            # Database schema and connection (PostgreSQL + pgvector)
│   ├── shared/        # Shared constants, types, and configuration schemas
│   ├── llm/           # AI scoring providers (DeepSeek, OpenAI, Claude)
│   ├── embeddings/    # Duplicate detection (vector similarity search)
│   ├── translation/   # Georgian translation (Gemini, OpenAI)
│   ├── social/        # Social media posting (Telegram, Facebook, LinkedIn)
│   ├── worker/        # Background pipeline processors (all 6 stages)
│   ├── api/           # REST API server (Fastify)
│   └── frontend/      # Admin dashboard (React + Vite + Tailwind)
├── .env               # Your environment variables (not committed to git)
├── CLAUDE.md          # Detailed developer documentation
├── docker-compose.yml # PostgreSQL + Redis containers
└── turbo.json         # Build system configuration
```

### How Packages Depend on Each Other

```
frontend ──> api (HTTP requests)

api ──> db, shared

worker ──> db, shared, llm, embeddings, translation, social

llm ──> shared
embeddings ──> db
translation ──> shared
social ──> shared
```

The `frontend` talks to the `api` over HTTP. The `api` and `worker` both read/write the same database. The `worker` uses `llm`, `embeddings`, `translation`, and `social` packages to do the actual work.

---

## Production Deployment

### What Changes in Production

| Setting | Development | Production |
|---------|-------------|------------|
| `NODE_ENV` | `development` | `production` |
| `DATABASE_URL` | `localhost` | Production PostgreSQL |
| `REDIS_HOST` | `127.0.0.1` | Redis container name |
| `API_KEY` | `local-dev-key` | Strong random key (32+ chars) |
| `VITE_API_URL` | `http://localhost:3001` | `https://api.yourdomain.com` |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | `https://yourdomain.com` |
| `LOG_LEVEL` | `debug` | `info` or `warn` |

### Deployment Checklist

- [ ] Generate strong API key: `openssl rand -hex 32`
- [ ] Set up HTTPS (Let's Encrypt)
- [ ] Configure `ALLOWED_ORIGINS` with production URL
- [ ] Seed `allowed_domains` table with trusted RSS domains
- [ ] Set up Nginx Basic Auth for dashboard access
- [ ] Configure social platform tokens with production redirect URLs
- [ ] Test the emergency kill switch before going live
- [ ] Set up PostgreSQL backups
- [ ] Monitor Redis memory usage

### Docker

The project includes a `docker-compose.yml` for infrastructure (PostgreSQL + Redis). In production, the API, worker, and frontend run as separate containers sharing the same database and Redis.

Inside Docker, services talk to each other by container name (e.g., `redis`, `postgres`). But OAuth redirect URLs (Facebook, LinkedIn) must use public URLs because they redirect in the user's browser.

---

## Cost Breakdown

Watch Tower is designed to minimize API costs with a cheapest-first filtering approach:

| Stage | Cost | Volume |
|-------|------|--------|
| Date filter | Free | All articles |
| URL dedup | Free | All articles |
| Semantic dedup | ~$0.02 per 1M tokens | Batches of 50 |
| LLM scoring | ~$0.01-0.10 per batch | Batches of 10 |
| Translation | ~$0.01 per article | Only score 4-5 |
| Image generation | ~$0.01-0.05 per image | Only score 4-5 |
| Social posting | Free | Platform API, no cost |

Most articles are filtered out by the free stages (date + URL + semantic dedup) before reaching the expensive LLM scoring stage.
