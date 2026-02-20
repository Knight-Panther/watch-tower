# LLM Brain & Intelligence Layer — Improvement Roadmap

## Goal

Transform Watch Tower from a personal news monitoring tool into a sellable intelligence platform.
Target buyers: PR agencies, investment firms, corporate strategy teams, niche content agencies.

**Core pitch:** "Monitor 500+ sources in your industry, surface what matters, scored and explained by AI, delivered to your Telegram/Slack/email every morning."

---

## Current State — What's Solid

| Component | Status | Notes |
|-----------|--------|-------|
| RSS ingestion + date filtering | Production-ready | Battle-tested, edge cases handled |
| URL dedup | Production-ready | PostgreSQL UNIQUE, zero cost |
| Semantic dedup (embeddings) | Production-ready | pgvector, 0.85 threshold, batch 50 |
| LLM scoring + summarization | Functional | Works but lacks explainability |
| Multi-platform distribution | Production-ready | Rate limits, health checks, error recovery |
| Pipeline reliability | Production-ready | Zombie recovery, self-healing jobs, atomic claims |
| Translation (Georgian) | Production-ready | Gemini/OpenAI, retry logic |
| AI image generation | Production-ready | gpt-image-1-mini + R2 + canvas compositor |

---

## Priority Improvements

### P1: Score Explanation (Trust Builder)

**Problem:** Scores are 1-5 with no reasoning. Clients ask "why did this get a 3?"
**Solution:** LLM returns a 1-2 sentence explanation alongside the score.
**Implementation:**
- Add `score_reasoning` text column to `articles` table
- Modify LLM brain prompt to return `{ score, summary, reasoning }`
- Store reasoning in DB, display in dashboard tooltip or expandable row
- Include in daily digest

**Effort:** Small — prompt change + one new column + minor UI
**Impact:** High — clients trust the system, reduces "is this AI any good?" friction

---

### P2: Daily Digest (The Product's Front Door)

**Problem:** Clients must open dashboard to see what happened. Most won't.
**Solution:** Automated daily summary delivered to Telegram/email every morning.
**Content:**
- Top 5 articles by score (with reasoning)
- Score distribution chart (how many 5s, 4s, 3s today)
- New sources that produced high-scoring articles
- Trend summary: "AI regulation was the dominant topic today"

**Implementation:**
- New BullMQ job: `daily-digest` (cron: 8:00 AM client timezone)
- LLM generates digest from top articles of the past 24h
- Deliver via Telegram message or email (SendGrid/Resend)
- Configurable: time, format, platforms

**Effort:** Medium — new job + LLM digest prompt + delivery
**Impact:** Very high — this is what clients interact with daily. If the digest is good, they stay subscribed.

---

### P3: Keyword/Entity Alerts (The "Monitor My Competitor" Feature)

**Problem:** Everything is score-based. Clients want: "ping me when anyone mentions [CompanyX]."
**Solution:** User-defined keyword/entity watchlist with instant Telegram/email alerts.
**Implementation:**
- New table: `alert_rules` (keywords, entities, min_score, delivery_channel)
- After scoring, check article title + summary against active rules
- On match: queue immediate notification (separate from social posting)
- UI: simple form — keyword, min score threshold, notification channel

**Effort:** Medium — new table, post-scoring hook, notification delivery
**Impact:** High — this is the #1 feature intelligence buyers expect. "Tell me when X happens."

---

### P4: Per-Sector Dedup Threshold

**Problem:** Single similarity threshold globally (configurable via `SIMILARITY_THRESHOLD` env var, default 0.85, currently set to 0.65). Crypto news is very repetitive (needs tighter), biotech papers are more unique (needs looser).
**Solution:** Add `similarity_threshold` column to `sectors` table, override global default.
**Implementation:**
- Add column to sectors table (default NULL = use global 0.85)
- Modify semantic dedup query to use per-sector threshold
- UI: slider in sector settings

**Effort:** Small — one column, one query change, one UI element
**Impact:** Medium — reduces false positives/negatives for specific content types

---

### P5: Source Quality Scoring

**Problem:** All RSS sources treated equally. No visibility into which sources produce signal vs noise.
**Solution:** Track average article score per source over time. Surface in dashboard.
**Implementation:**
- Aggregate query: `AVG(importance_score) GROUP BY source_id` over rolling 30 days
- Display in RSS Sources page as a quality indicator
- Optional: auto-flag sources that consistently produce score 1-2 articles
- Future: weight source quality into article scoring

**Effort:** Small — aggregate query on existing data + UI display
**Impact:** Medium — helps clients prune bad sources, improves signal-to-noise over time

---

### P6: Trend/Topic Detection

**Problem:** System scores individual articles but doesn't detect patterns — "AI regulation is spiking today."
**Solution:** Cluster related articles by embedding similarity, detect volume spikes per cluster.
**Implementation:**
- Periodic job: cluster recent articles by embedding proximity
- LLM labels each cluster with a topic name
- Detect volume spikes vs historical baseline
- Include in daily digest: "Trending: AI regulation (12 articles, 3x normal volume)"

**Effort:** Large — clustering logic, baseline tracking, LLM labeling
**Impact:** Very high — this is what separates a news feed from an intelligence platform. But build after P1-P3 are validated with paying clients.

---

### P7: User Feedback Loop (Build After 500+ Decisions)

**Problem:** Scoring has no learning mechanism. If LLM consistently over/under-scores certain content, there's no way to detect or correct it.
**Solution:** Track approve/reject decisions as implicit feedback signals. Surface patterns — don't auto-adjust scores.
**What to track:**
- Per-source: approval rate over time (e.g., "Reuters articles get approved 90%, CryptoBlogs 30%")
- Per-sector: score distribution vs approval rate (e.g., "Score-3 biotech articles get approved 60% — maybe threshold is too high")
- Per-client: which scores they override most (useful for multi-tenant)

**Implementation:**
- No new tables needed — `pipeline_stage` transitions already record approve/reject decisions
- Aggregate query: approval rate by source, by sector, by score bracket over rolling 30 days
- Display in dashboard as "Source Quality" and "Scoring Accuracy" panels
- Admin can use insights to adjust scoring prompts or source selection

**What this is NOT:**
- Not a weighted average formula (discussed and dropped — not enough data to calibrate weights, adds debugging complexity, double-counts what LLM scoring prompt already considers)
- Not auto-adjusting scores (too risky — silent changes erode trust)
- Not ML training (overkill at this stage)

**Effort:** Small-medium — aggregate queries on existing data + dashboard display
**Impact:** Medium — builds confidence in scoring over time, helps tune prompts with data instead of guessing. Only valuable after enough decision volume (500+).

---

## Sellability Checklist

Before approaching first client:

- [ ] P1: Score explanation implemented and visible in dashboard
- [ ] P2: Daily digest running and delivering via Telegram
- [ ] P3: At least basic keyword alerts (even if just exact match)
- [ ] Landing page explaining the product (not the dashboard — a marketing page)
- [ ] Demo instance running with a compelling sector (e.g., "AI & Tech" or "Fintech")
- [ ] Professional domain + SSL (not raw IP)
- [ ] Clean dashboard without Georgian-specific UI for English clients

## Go-to-Market Strategy

### Target Audience
1. PR agencies monitoring industry news for clients
2. Hedge funds / investment research teams (small-mid size)
3. Corporate strategy/competitive intelligence teams
4. Niche newsletter operators who curate content

### Pricing Model
- **Setup fee:** $500-1000 one-time (covers RSS source configuration, social account wiring)
- **Monthly:** $200-500 depending on volume (sources, articles/day, platforms)
- **Enterprise:** $1000+/month for custom scoring rules, API access, dedicated support

### Sales Channel
- LinkedIn outreach (direct messages to agency founders, heads of content)
- Show the live demo — existing Watch Tower pages are proof it works
- Offer 2-week free trial on a separate instance

### Deployment Model (Phase 1)
- Separate VPS per client ($10-20/month Hetzner)
- Same codebase, isolated database/Redis
- Manual setup per client (1 day)
- No multi-tenancy needed until 10+ clients

### Deployment Model (Phase 2 — 10+ clients)
- Multi-tenant architecture (tenant_id on all tables)
- Single deployment, shared infrastructure
- Self-service onboarding
- Proper auth (not nginx basic auth)

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

---

## UI Flexibility Note

The frontend dashboard should be treated as adaptable — not locked to current layout. As LLM improvements land (score reasoning, alerts, source quality, feedback panels), the UI will need rearrangement. Keep components modular so new panels/columns/views can be added without rewriting existing pages. Don't over-invest in pixel-perfect design until P1-P3 features are stable.

---

## Technical Debt to Address Before Selling

| Issue | Impact | Fix |
|-------|--------|-----|
| Articles list shuffles on action (no tiebreaker sort) | Annoying UX | Add secondary sort `published_at DESC` in API |
| No proper auth system (nginx basic auth only) | Unprofessional for clients | Add JWT or session-based auth |
| Translation UI visible in English mode | Confusing for English clients | Conditionally hide Georgian features |
| No onboarding flow | Client can't self-setup | At minimum: guided RSS source + social account setup |
