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
