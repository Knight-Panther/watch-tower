-- Seed data for local development

insert into sectors (name, slug, default_max_age_days) values
  ('Technology', 'technology', 7),
  ('Finance', 'finance', 5),
  ('Science', 'science', 10);

insert into rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) values
  ('https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC', true,
    (select id from sectors where slug = 'technology'), 1, 5),
  ('https://www.theverge.com/rss/index.xml', 'The Verge', true,
    (select id from sectors where slug = 'finance'), 1, 5),
  ('https://www.wired.com/feed/rss', 'Wired', true,
    (select id from sectors where slug = 'science'), 1, 5);
