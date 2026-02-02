-- Seed data for local development
-- Safe to run multiple times (ON CONFLICT DO NOTHING)

INSERT INTO sectors (name, slug, default_max_age_days) VALUES
  ('Technology', 'technology', 7),
  ('Finance', 'finance', 5),
  ('Science', 'science', 10)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 15, 5),
  ('https://www.theverge.com/rss/index.xml', 'The Verge', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 15, 5),
  ('https://www.wired.com/feed/rss', 'Wired', true,
    (SELECT id FROM sectors WHERE slug = 'science'), 15, 5)
ON CONFLICT (url) DO NOTHING;

INSERT INTO app_config (key, value, updated_at) VALUES
  ('feed_items_ttl_days', '60', NOW()),
  ('feed_fetch_runs_ttl_hours', '336', NOW()),
  ('llm_telemetry_ttl_days', '30', NOW()),
  ('article_images_ttl_days', '30', NOW()),
  ('post_deliveries_ttl_days', '30', NOW())
ON CONFLICT (key) DO NOTHING;

-- Seed default scoring rules for each sector
-- Custom prompts and thresholds per sector
INSERT INTO scoring_rules (sector_id, prompt_template, auto_approve_threshold, auto_reject_threshold)
SELECT
  s.id,
  CASE s.slug
    WHEN 'technology' THEN 'You are a technology news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (press releases, minor updates, promotional content)
2 = Low importance (routine news, minor developments)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments, major product launches)
5 = Critical importance (industry-changing news, major security issues)

Consider: novelty, potential impact on tech industry, timeliness, credibility.

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'

    WHEN 'finance' THEN 'You are a financial news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (minor market moves, routine earnings)
2 = Low importance (routine news, small developments)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant market events, major earnings surprises)
5 = Critical importance (market crashes, major policy changes, banking crises)

Consider: market impact potential, timeliness, credibility of source.

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'

    WHEN 'science' THEN 'You are a science news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (incremental research, press releases)
2 = Low importance (routine studies, minor discoveries)
3 = Moderate importance (notable research findings)
4 = High importance (significant breakthroughs, major studies)
5 = Critical importance (paradigm-shifting discoveries, major health findings)

Consider: scientific significance, peer review status, potential real-world impact.

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'

    ELSE 'You are a news analyst specializing in ' || s.name || ' news.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (press releases, minor updates)
2 = Low importance (routine news)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments)
5 = Critical importance (major breaking news)

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": 3, "summary": "Summary here.", "reasoning": "Explanation"}'
  END,
  5, -- auto_approve_threshold
  2  -- auto_reject_threshold
FROM sectors s
ON CONFLICT (sector_id) DO NOTHING;
