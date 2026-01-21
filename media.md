# Media Watch Tower: Project Plan (Revised)

This document defines the vision, architecture, and phased build plan for a practical and comprehensive Media Watch Tower that avoids overbuild while supporting growth.

## 1. Project Vision

The **Media Watch Tower** monitors sector-specific RSS sources, filters for freshness, deduplicates semantically, scores importance (including "seismic" events), summarizes in multiple languages, and queues items for scheduled review and publishing. It prioritizes reliability and usefulness over scale in the MVP, while leaving clear extension points for paid APIs and social signals later.

## 2. Key Product Principles

- **Fast and reliable**: poll every 15 minutes, dedupe aggressively, keep data fresh (no older than 5 days).
- **Adaptive by config**: feed polling, thresholds, and model choices are adjustable without code changes.
- **Human-in-the-loop**: scheduled review batches by default, optional auto-post per sector later.
- **Sector-aware**: sources grouped by sectors (biotech, stock markets, AI, space, etc.).
- **Short-form only**: store and post summaries (2-3 sentences); no full article storage needed long-term.
- **Multilingual output**: English analysis, summaries and translations in Georgian, English, Russian (optional).
- **Safe publishing**: support dry-run mode and per-sector posting limits.

## 3. Technology Stack (Server-Hosted)

- **Backend API**: Node.js + TypeScript + Fastify
- **Workers / Queue**: BullMQ + Redis (ingest, analyze, schedule, post)
- **Scheduler**: BullMQ repeatable jobs (15-minute polling)
- **Database**: PostgreSQL (Supabase) + `pgvector`
- **NLP**: Provider-agnostic LLM/embeddings/translation (OpenAI, Claude, DeepSeek, etc.) with fallback heuristics
- **RSS**: `rss-parser` + `undici` with retries/backoff
- **Frontend**: React + Vite + Tailwind CSS
- **Deployment**:
  - Frontend: Cloudflare Pages (static)
  - Backend/Worker: Docker services (API + worker separated)
  - Redis: managed (Upstash/Redis Cloud) or containerized
  - Database: Supabase (managed Postgres)

## 4. Architecture Overview

**Monorepo**

```
/
|-- packages/
|   |-- api/
|   |-- worker/
|   |-- frontend/
|   `-- shared/
|-- infra/
|-- docs/
|-- media.md
```

**Service Roles**

- **API service**: read/write configuration, review queue, and reporting.
- **Worker service**: handles ingestion, dedupe, scoring, summarization, translation, and scheduling.
- **Redis + BullMQ**: job queues for each pipeline stage.

## 5. Pipeline (Job Graph)

1) **Fetch**: poll RSS feeds per sector every 15 minutes (adaptive per feed if configured).
2) **Parse**: extract title, description, published_at, link, source metadata.
3) **Filter**: discard items older than 5 days.
4) **Hard dedupe**: URL + normalized title hash.
5) **Semantic dedupe**:
   - Embed `title + description + snippet (200-400 chars)`.
   - Compare against recent embeddings (last 14 days) using `pgvector`.
   - Similarity thresholds:
     - >= 0.92: duplicate (auto-skip)
     - 0.88-0.92: duplicate if same sector and within 14 days
     - 0.82-0.88: related (keep, link as related)
     - < 0.82: new item
6) **Prefilter (rules)**:
   - `score = source_weight + keyword_weight + recency_bonus + sector_boost`
   - Seismic if score >= threshold or matches critical phrases.
7) **LLM reasoning & classification**:
   - LLM assigns `seismic`, `confidence`, `sector`, `urgency`, and a short rationale.
   - Only run LLM after prefilter to control cost.
8) **Summarize** (LLM): 2-3 sentences in English.
9) **Translate** (LLM): Georgian + Russian (optional).
10) **Cache AI outputs**: hash content to avoid repeated LLM calls across sources.
11) **Queue for review**: scheduled batches by default.
12) **Publish**: per sector rules; initial MVP uses one channel with tags.

## 6. Seismic Scoring Model (MVP)

- **Hybrid strategy**: rules for prefiltering, LLM for final classification.
- **Keywords**: editable list per sector, with weights.
- **Critical phrases**: auto-seismic list (e.g., "acquired", "bankrupt", "SEC investigation").
- **Source weights**: higher trust sources rank higher.
- **Recency**: strong bonus for items < 24 hours.
- **LLM output**: `seismic`, `confidence`, `sector`, `urgency`, `rationale`.
- **UI control**: thresholds, keyword lists, and LLM confidence cutoff per sector.
- **Two-step AI**: optional cheap model for triage, stronger model for final summary/translation.

## 7. Data Model & Retention

**Retention policy**

- **Full items**: 60 days
- **Dedupe window**: 14 days
- **Fingerprints** (title_hash, embedding, posted_at): 180 days

This keeps the DB lean while still preventing reposts of old news.

## 8. UI Requirements (MVP)

- Sector management (create/edit sector, assign sources).
- Source management (RSS URLs + metadata).
- Review queue (scheduled batches, approve/skip).
- Thresholds & keywords (per sector).
- One publishing channel with tags (sector + seismic badge).
- Search and filter by sector, status, date, and score.
- Config panel for polling intervals, model choices, and dry-run mode.

## 9. Social Posting (MVP)

- Manual approval by default with scheduled review batches.
- Auto-post toggle per sector (disabled by default).
- Posting targets (later): LinkedIn, Telegram, Facebook.
- Dry-run mode: simulate posting and log outputs without publishing.

## 10. Risks & Mitigations

- **Noise**: strict freshness filter + dedupe + sector-specific thresholds.
- **API cost**: summarize only for high-score items.
- **Legal**: post summaries and links, avoid full-text storage.
- **Reliability**: retries, source health metrics, and dead-letter queue.
- **Vendor lock-in**: environment-driven LLM config and provider adapters.
- **Platform policies**: rate-limit posting and keep drafts to avoid spam flags.

## 11. Development Phases

### Phase 1: Foundation
- Monorepo setup (api/worker/frontend/shared).
- DB schema and Supabase integration.
- Redis + BullMQ integration.
- RSS fetching and parsing.
- Provider-agnostic LLM adapter + env-based config.

### Phase 2: Core Pipeline
- Filtering, hard dedupe, semantic dedupe.
- Scoring and seismic thresholds.
- Summarization and translation.
- Review queue and scheduling.

### Phase 3: API & UI
- Sector/source management.
- Review queue UI + approval flow.
- Search and filters.

### Phase 4: Publishing
- Posting pipeline + retries.
- Tagging and channel rules.
- Audit logs and metrics.

### Phase 5: Enhancements
- Paid news APIs.
- Social signal sources (optional).
- Advanced dashboards and trend analytics.
