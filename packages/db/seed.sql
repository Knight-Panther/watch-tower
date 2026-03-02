-- LEGACY: Basic 3-sector seed for minimal local development.
-- For production deployments, use seed-sectors.sql (8 sectors with full scoring config).
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
  ('post_deliveries_ttl_days', '30', NOW()),
  -- Platform auto-post toggles (enable when ready to post to each platform)
  ('auto_post_telegram', 'true', NOW()),
  ('auto_post_facebook', 'false', NOW()),
  ('auto_post_linkedin', 'false', NOW()),
  -- Scoring thresholds (0 = OFF for auto-approve, range 1-5 for auto-reject)
  ('auto_approve_threshold', '5', NOW()),
  ('auto_reject_threshold', '2', NOW()),
  -- Security: Kill switch (Layer 8) - stops ALL social posting when enabled
  ('emergency_stop', 'false', NOW()),
  -- Translation settings (Georgian)
  ('posting_language', '"en"', NOW()),
  ('translation_scores', '[3, 4, 5]', NOW()),
  ('translation_provider', '"gemini"', NOW()),
  ('translation_model', '"gemini-2.5-flash"', NOW()),
  ('translation_instructions', '"Translate the following English news content into Georgian. Maintain a professional, news-appropriate tone. Keep proper nouns (company names, person names) in their original form. Technical terms like Bitcoin, blockchain, AI may remain in English if no widely-accepted Georgian equivalent exists. The translation should be natural and fluent, not word-for-word."', NOW()),
  -- Image generation settings (disabled by default)
  ('image_generation_enabled', 'false', NOW()),
  ('image_generation_min_score', '4', NOW()),
  ('image_generation_quality', '"medium"', NOW()),
  ('image_generation_size', '"1024x1536"', NOW()),
  ('image_generation_prompt', '""', NOW()),
  ('image_template', '{"titlePosition":{"x":10,"y":70},"titleAlignment":"left","titleMaxWidth":80,"titleFontSize":42,"titleFontFamily":"Noto Sans Georgian","titleColor":"#FFFFFF","backdropEnabled":true,"backdropColor":"#000000B3","backdropPadding":24,"backdropBorderRadius":12,"watermarkPosition":{"x":85,"y":5},"watermarkScale":0.15}', NOW()),
  -- Dedup sensitivity (0.50-0.99, higher = stricter matching)
  ('similarity_threshold', '0.65', NOW())
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

-- Seed social accounts so the Templates page has data for each platform
-- Credentials are empty since actual tokens come from environment variables
-- Templates can be customized via the frontend Templates page
-- Note: Using WHERE NOT EXISTS since there's no unique constraint on platform
--
-- Rate limits based on official platform limits:
-- Telegram: ~30 msg/sec to different chats -> 20/hr (very generous)
-- Facebook: ~25 posts/24hr per page -> 1/hr (conservative)
-- LinkedIn: 100 posts/day per org -> 4/hr (safe)
INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour)
SELECT 'telegram', 'Primary Telegram Channel', '{}'::jsonb, true, 20
WHERE NOT EXISTS (SELECT 1 FROM social_accounts WHERE platform = 'telegram');

INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour)
SELECT 'facebook', 'Company Facebook Page', '{}'::jsonb, true, 1
WHERE NOT EXISTS (SELECT 1 FROM social_accounts WHERE platform = 'facebook');

INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour)
SELECT 'linkedin', 'Company LinkedIn Page', '{}'::jsonb, true, 4
WHERE NOT EXISTS (SELECT 1 FROM social_accounts WHERE platform = 'linkedin');

-- To update existing records with realistic rate limits, run:
-- UPDATE social_accounts SET rate_limit_per_hour = 20 WHERE platform = 'telegram';
-- UPDATE social_accounts SET rate_limit_per_hour = 1 WHERE platform = 'facebook';
-- UPDATE social_accounts SET rate_limit_per_hour = 4 WHERE platform = 'linkedin';

-- ─── Domain Whitelist (Security Layer 1) ─────────────────────────────────────
-- Only RSS sources from these domains can be added.
-- Add your trusted news sources here.

INSERT INTO allowed_domains (domain, notes) VALUES
  -- Existing seed sources (domain must match URL extraction)
  ('bbci.co.uk', 'BBC News (feeds.bbci.co.uk)'),
  ('theverge.com', 'The Verge - Tech News'),
  ('wired.com', 'Wired Magazine'),
  -- Major news agencies
  ('reuters.com', 'Reuters News Agency'),
  ('apnews.com', 'Associated Press'),
  ('bbc.com', 'BBC News (international)'),
  ('npr.org', 'NPR News'),
  -- Financial news
  ('bloomberg.com', 'Bloomberg Financial News'),
  ('wsj.com', 'Wall Street Journal'),
  ('ft.com', 'Financial Times'),
  ('cnbc.com', 'CNBC Financial'),
  -- Tech news
  ('techcrunch.com', 'TechCrunch'),
  ('arstechnica.com', 'Ars Technica'),
  -- Crypto news
  ('coindesk.com', 'CoinDesk - Crypto News'),
  ('cointelegraph.com', 'Cointelegraph - Crypto News')
ON CONFLICT (domain) DO NOTHING;
