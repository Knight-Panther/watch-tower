-- Seed data for local development

insert into sectors (name, slug, default_max_age_days) values
  ('Technology', 'technology', 7),
  ('Finance', 'finance', 5),
  ('Science', 'science', 10);

insert into rss_sources (url, name, active, sector_id, ingest_interval_minutes) values
  ('https://feeds.arstechnica.com/arstechnica/index', 'Ars Technica', true,
    (select id from sectors where slug = 'technology'), 60),
  ('https://www.theverge.com/rss/index.xml', 'The Verge', true,
    (select id from sectors where slug = 'technology'), 30),
  ('https://feeds.feedburner.com/TechCrunch', 'TechCrunch', true,
    (select id from sectors where slug = 'technology'), 45);
