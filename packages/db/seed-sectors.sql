-- ═══════════════════════════════════════════════════════════════════════════════
-- Watch Tower — Sector & RSS Feed Seed
-- Seismic news monitoring: Tech, Space, Robotics/AI, Biotech, Military,
-- World Politics, Cybersecurity, Energy & Climate
--
-- Safe to run multiple times (ON CONFLICT DO NOTHING / DO UPDATE)
-- Run AFTER seed.sql (requires app_config + social_accounts to exist)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. SECTORS (8 total) ────────────────────────────────────────────────────

INSERT INTO sectors (name, slug, default_max_age_days) VALUES
  ('Technology',           'technology',           3),
  ('Space & Astronomy',    'space-astronomy',      5),
  ('Robotics & AI',        'robotics-ai',          3),
  ('Biotech & Life Sciences', 'biotech',           5),
  ('Military & Defense',   'military-defense',     5),
  ('World Politics',       'world-politics',       3),
  ('Cybersecurity',        'cybersecurity',        3),
  ('Energy & Climate',     'energy-climate',       5)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  default_max_age_days = EXCLUDED.default_max_age_days;

-- ─── 2. ALLOWED DOMAINS (whitelist for RSS sources) ──────────────────────────

INSERT INTO allowed_domains (domain, notes) VALUES
  -- Technology
  ('arstechnica.com',        'Ars Technica — deep technical reporting'),
  ('theverge.com',           'The Verge — consumer tech + policy'),
  ('techcrunch.com',         'TechCrunch — startups + VC'),
  ('wired.com',              'Wired — long-form tech + culture'),
  ('technologyreview.com',   'MIT Technology Review — research-grade'),
  ('bbci.co.uk',             'BBC News feeds (feeds.bbci.co.uk)'),
  -- Space & Astronomy
  ('nasa.gov',               'NASA — official announcements'),
  ('esa.int',                'ESA — European Space Agency'),
  ('spacenews.com',          'SpaceNews — industry + policy'),
  ('space.com',              'Space.com — general space news'),
  ('spaceflightnow.com',     'Spaceflight Now — launch coverage'),
  ('universetoday.com',      'Universe Today — discoveries'),
  -- Robotics & AI
  ('ieee.org',               'IEEE Spectrum (spectrum.ieee.org)'),
  ('therobotreport.com',     'The Robot Report — industrial robotics'),
  ('venturebeat.com',        'VentureBeat — enterprise AI'),
  -- Biotech & Life Sciences
  ('statnews.com',           'STAT News — biomedical journalism'),
  ('biopharmadive.com',      'BioPharma Dive — pharma trade'),
  ('nature.com',             'Nature journals (feeds.nature.com)'),
  ('fiercebiotech.com',      'FierceBiotech — biotech industry'),
  -- Military & Defense
  ('defenseone.com',         'Defense One — DC insider defense'),
  ('breakingdefense.com',    'Breaking Defense — procurement + strategy'),
  ('twz.com',                'The War Zone — operational/technical analysis'),
  ('defensenews.com',        'Defense News — broad defense industry'),
  ('realcleardefense.com',   'RealClearDefense — aggregator'),
  -- World Politics
  ('aljazeera.com',          'Al Jazeera English — Global South/MENA'),
  ('foreignpolicy.com',      'Foreign Policy — premium analysis'),
  ('thediplomat.com',        'The Diplomat — Asia-Pacific geopolitics'),
  ('foreignaffairs.com',     'Foreign Affairs — academic depth'),
  ('ecfr.eu',                'ECFR — European strategic analysis'),
  ('geopoliticalfutures.com','Geopolitical Futures — strategic forecasts'),
  -- Cybersecurity
  ('krebsonsecurity.com',    'Krebs on Security — investigative'),
  ('therecord.media',        'The Record (Recorded Future) — attribution'),
  ('bleepingcomputer.com',   'Bleeping Computer — breaking vulns'),
  ('darkreading.com',        'Dark Reading — industry trade'),
  -- Energy & Climate
  ('carbonbrief.org',        'Carbon Brief — climate science'),
  ('oilprice.com',           'OilPrice.com — oil, gas, energy markets'),
  ('eia.gov',                'EIA (US Gov) — official energy data'),
  ('energymonitor.ai',       'Energy Monitor — energy transition coverage'),
  -- Reddit (community-curated RSS)
  ('reddit.com',             'Reddit subreddit RSS feeds'),
  -- Wave 2 additions
  ('openai.com',             'OpenAI — official blog and research'),
  ('cnbc.com',               'CNBC — business and technology news'),
  ('sciencedaily.com',       'ScienceDaily — science research summaries'),
  ('news.google.com',        'Google News — RSS meta-aggregator feeds'),
  ('cleantechnica.com',      'CleanTechnica — clean energy and EVs')
ON CONFLICT (domain) DO NOTHING;

-- ─── 3. RSS SOURCES (66 total: 43 original + 14 wave 2 + 9 codified) ────────

-- Technology (6 + 6 sources)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://feeds.arstechnica.com/arstechnica/index',
    'Ars Technica', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 15, 3),
  ('https://www.theverge.com/rss/index.xml',
    'The Verge', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 30, 3),
  ('https://techcrunch.com/feed/',
    'TechCrunch', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 30, 3),
  ('https://www.wired.com/feed/rss',
    'Wired', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 60, 3),
  ('https://www.technologyreview.com/feed/',
    'MIT Technology Review', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 60, 3),
  ('https://feeds.bbci.co.uk/news/technology/rss.xml',
    'BBC Technology', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 30, 3)
ON CONFLICT (url) DO NOTHING;

-- Technology — Wave 2 (CNBC, OpenAI, Google News meta-feeds)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://openai.com/blog/rss.xml',
    'OpenAI Blog', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 240, 3),
  ('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
    'CNBC Top News', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 60, 3),
  ('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910',
    'CNBC Technology', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 60, 3),
  ('https://news.google.com/rss/search?q=Apple+OR+Google+OR+Microsoft+OR+Amazon+OR+Meta&hl=en-US&gl=US&ceid=US:en',
    'GN: Big Tech', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 120, 3),
  ('https://news.google.com/rss/search?q=semiconductor+OR+TSMC+OR+NVIDIA+chip&hl=en-US&gl=US&ceid=US:en',
    'GN: Semiconductors', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 120, 3),
  ('https://news.google.com/rss/search?q=AI+startup+funding+OR+AI+venture+capital&hl=en-US&gl=US&ceid=US:en',
    'GN: AI Startup Funding', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 240, 3),
  -- Codified from manual UI additions (legacy URL formats)
  ('https://www.cnbc.com/id/19854910/device/rss/rss.html',
    'CNBC Technology (legacy)', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 60, 3),
  ('https://news.google.com/rss/search?q=AI%20startup%20funding&hl=en-US&gl=US&ceid=US:en',
    'GN: AI Startup Funding (legacy)', true,
    (SELECT id FROM sectors WHERE slug = 'technology'), 240, 3)
ON CONFLICT (url) DO NOTHING;

-- Space & Astronomy (6 sources)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://www.nasa.gov/rss/dyn/breaking_news.rss',
    'NASA Breaking News', true,
    (SELECT id FROM sectors WHERE slug = 'space-astronomy'), 30, 5),
  ('https://www.esa.int/rssfeed/TopNews',
    'ESA Top News', true,
    (SELECT id FROM sectors WHERE slug = 'space-astronomy'), 60, 5),
  ('https://spacenews.com/feed/',
    'SpaceNews', true,
    (SELECT id FROM sectors WHERE slug = 'space-astronomy'), 30, 5),
  ('https://www.space.com/feeds.xml',
    'Space.com', true,
    (SELECT id FROM sectors WHERE slug = 'space-astronomy'), 60, 5),
  ('https://spaceflightnow.com/feed/',
    'Spaceflight Now', true,
    (SELECT id FROM sectors WHERE slug = 'space-astronomy'), 60, 5),
  ('https://www.universetoday.com/feed/',
    'Universe Today', true,
    (SELECT id FROM sectors WHERE slug = 'space-astronomy'), 120, 5)
ON CONFLICT (url) DO NOTHING;

-- Robotics & AI (4 + 6 sources — MIT Tech Review already in Technology, dedup handles cross-sector)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://spectrum.ieee.org/feeds/topic/robotics.rss',
    'IEEE Spectrum Robotics', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 60, 3),
  ('https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss',
    'IEEE Spectrum AI', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 60, 3),
  ('https://www.therobotreport.com/feed/',
    'The Robot Report', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 120, 3),
  ('https://venturebeat.com/category/ai/feed/',
    'VentureBeat AI', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 60, 3)
ON CONFLICT (url) DO NOTHING;

-- Robotics & AI — Wave 2 (cross-pub AI feeds + Google News meta-feeds)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://techcrunch.com/category/artificial-intelligence/feed/',
    'TechCrunch AI', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 60, 3),
  ('https://www.wired.com/feed/tag/ai/latest/rss',
    'Wired AI', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 120, 3),
  ('https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml',
    'ScienceDaily AI', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 240, 3),
  ('https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en',
    'GN: Artificial Intelligence', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 120, 3),
  ('https://news.google.com/rss/search?q=OpenAI+OR+Anthropic+OR+Google+DeepMind&hl=en-US&gl=US&ceid=US:en',
    'GN: AI Labs', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 120, 3),
  ('https://news.google.com/rss/search?q=humanoid+robot+OR+Boston+Dynamics+OR+Tesla+Bot+OR+Figure+robot&hl=en-US&gl=US&ceid=US:en',
    'GN: Humanoid Robots', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 120, 3),
  -- Codified from manual UI additions
  ('https://www.technologyreview.com/topic/artificial-intelligence/feed/',
    'MIT Technology Review AI', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 60, 3),
  ('https://news.google.com/rss/search?q=robotics&hl=en-US&gl=US&ceid=US:en',
    'GN: Robotics', true,
    (SELECT id FROM sectors WHERE slug = 'robotics-ai'), 120, 3)
ON CONFLICT (url) DO NOTHING;

-- Biotech & Life Sciences (6 + 1 sources)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://www.statnews.com/feed/',
    'STAT News', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 15, 5),
  ('https://www.statnews.com/category/biotech/feed/',
    'STAT News Biotech', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 30, 5),
  ('https://www.biopharmadive.com/feeds/news/',
    'BioPharma Dive', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 60, 5),
  ('http://feeds.nature.com/nbt/rss/aop',
    'Nature Biotechnology', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 240, 5),
  ('http://feeds.nature.com/nm/rss/aop',
    'Nature Medicine', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 240, 5),
  ('https://www.fiercebiotech.com/rss/xml',
    'FierceBiotech', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 60, 5)
ON CONFLICT (url) DO NOTHING;

-- Biotech — Wave 2 (Nature main journal for broader science coverage)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('http://feeds.nature.com/nature/rss/current',
    'Nature', true,
    (SELECT id FROM sectors WHERE slug = 'biotech'), 240, 5)
ON CONFLICT (url) DO NOTHING;

-- Military & Defense (5 sources) — all verified 2026-03-02
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://www.defenseone.com/rss/all/',
    'Defense One', true,
    (SELECT id FROM sectors WHERE slug = 'military-defense'), 15, 5),
  ('https://breakingdefense.com/feed/',
    'Breaking Defense', true,
    (SELECT id FROM sectors WHERE slug = 'military-defense'), 15, 5),
  ('https://www.twz.com/feed',
    'The War Zone', true,
    (SELECT id FROM sectors WHERE slug = 'military-defense'), 15, 5),
  ('https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml',
    'Defense News', true,
    (SELECT id FROM sectors WHERE slug = 'military-defense'), 30, 5),
  ('https://www.realcleardefense.com/index.xml',
    'RealClearDefense', true,
    (SELECT id FROM sectors WHERE slug = 'military-defense'), 120, 5),
  -- Codified from manual UI addition
  ('https://news.google.com/rss/search?q=AI%20warfare%20OR%20military%20AI&hl=en-US&gl=US&ceid=US:en',
    'GN: Military AI', true,
    (SELECT id FROM sectors WHERE slug = 'military-defense'), 120, 5)
ON CONFLICT (url) DO NOTHING;

-- World Politics (7 sources)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://feeds.bbci.co.uk/news/world/rss.xml',
    'BBC World', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 15, 3),
  ('https://www.aljazeera.com/xml/rss/all.xml',
    'Al Jazeera English', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 30, 3),
  ('https://foreignpolicy.com/feed/',
    'Foreign Policy', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 60, 3),
  ('https://thediplomat.com/feed/',
    'The Diplomat', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 120, 3),
  ('https://www.foreignaffairs.com/rss.xml',
    'Foreign Affairs', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 240, 3),
  ('https://ecfr.eu/feed/',
    'ECFR', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 240, 3),
  ('https://geopoliticalfutures.com/feed/',
    'Geopolitical Futures', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 240, 3),
  ('https://www.reddit.com/r/worldnews/.rss',
    'Reddit r/worldnews', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 120, 2),
  ('https://www.reddit.com/r/geopolitics/.rss',
    'Reddit r/geopolitics', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 120, 2),
  -- Codified from manual UI addition
  ('https://news.google.com/rss/search?q=AI%20war%20cybersecurity%20US%20China&hl=en-US&gl=US&ceid=US:en',
    'GN: Geopolitics', true,
    (SELECT id FROM sectors WHERE slug = 'world-politics'), 120, 2)
ON CONFLICT (url) DO NOTHING;

-- Cybersecurity (4 sources)
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://krebsonsecurity.com/feed/',
    'Krebs on Security', true,
    (SELECT id FROM sectors WHERE slug = 'cybersecurity'), 60, 3),
  ('https://therecord.media/feed/',
    'The Record', true,
    (SELECT id FROM sectors WHERE slug = 'cybersecurity'), 30, 3),
  ('https://www.bleepingcomputer.com/feed/',
    'Bleeping Computer', true,
    (SELECT id FROM sectors WHERE slug = 'cybersecurity'), 30, 3),
  ('https://www.darkreading.com/rss.xml',
    'Dark Reading', true,
    (SELECT id FROM sectors WHERE slug = 'cybersecurity'), 60, 3),
  ('https://www.reddit.com/r/cybersecurity/.rss',
    'Reddit r/cybersecurity', true,
    (SELECT id FROM sectors WHERE slug = 'cybersecurity'), 120, 2),
  -- Codified from manual UI addition
  ('https://news.google.com/rss/search?q=cybersecurity&hl=en-US&gl=US&ceid=US:en',
    'GN: Cybersecurity', true,
    (SELECT id FROM sectors WHERE slug = 'cybersecurity'), 120, 2)
ON CONFLICT (url) DO NOTHING;

-- Energy & Climate (4 + 1 sources) — all verified 2026-03-02
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://www.carbonbrief.org/feed/',
    'Carbon Brief', true,
    (SELECT id FROM sectors WHERE slug = 'energy-climate'), 120, 5),
  ('https://oilprice.com/rss/main',
    'OilPrice.com', true,
    (SELECT id FROM sectors WHERE slug = 'energy-climate'), 60, 5),
  ('https://www.eia.gov/rss/todayinenergy.xml',
    'EIA Today in Energy', true,
    (SELECT id FROM sectors WHERE slug = 'energy-climate'), 240, 5),
  ('https://www.energymonitor.ai/feed/',
    'Energy Monitor', true,
    (SELECT id FROM sectors WHERE slug = 'energy-climate'), 60, 5)
ON CONFLICT (url) DO NOTHING;

-- Energy & Climate — Wave 2
INSERT INTO rss_sources (url, name, active, sector_id, ingest_interval_minutes, max_age_days) VALUES
  ('https://cleantechnica.com/feed/',
    'CleanTechnica', true,
    (SELECT id FROM sectors WHERE slug = 'energy-climate'), 120, 5)
ON CONFLICT (url) DO NOTHING;

-- ─── 4. SCORING RULES (per-sector score_criteria JSONB) ──────────────────────
-- Uses ON CONFLICT DO UPDATE so re-running updates the config

-- Technology
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'Major regulatory actions (antitrust, bans, fines >$1B)',
    'Infrastructure outages affecting >10M users',
    'Semiconductor supply chain disruptions or export controls (TSMC, ASML, NVIDIA)',
    'AI governance legislation or executive orders',
    'Platform policy changes affecting millions',
    'Breakthrough announcements from major labs or companies',
    'Big Tech earnings surprises or major strategic pivots'
  ),
  'ignore', jsonb_build_array(
    'Startup funding rounds under $100M',
    'Minor app updates or version releases',
    'PR-driven product announcements',
    'Conference attendance or speaking engagements',
    'Stock price movements without structural industry change',
    'Analyst ratings and price target changes'
  ),
  'rejectKeywords', jsonb_build_array(
    'app update', 'firmware', 'how to', 'best of', 'deal', 'sale',
    'review:', 'unboxing', 'gift guide', 'sponsored', 'tutorial',
    'coupon', 'discount', 'promo code',
    'stock pick', 'buy rating', 'sell rating', 'market wrap',
    'premarket', 'mad money', 'cramer'
  ),
  'score1', 'Noise — press releases, product listings, SEO articles, minor app updates, promotional content with no news value',
  'score2', 'Routine — scheduled earnings meeting expectations, minor feature launches, incremental updates to known stories',
  'score3', 'Noteworthy — new development in ongoing story, notable product launch, regulatory filing, meaningful partnership',
  'score4', 'Significant — unexpected M&A, major policy shift, security breach affecting millions, leadership change at FAANG-tier company',
  'score5', 'Breaking/Urgent — platform outage affecting >100M users, antitrust breakup order, major company collapse, critical infrastructure failure',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'professional',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include company or person name when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'technology'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- Space & Astronomy
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'New mission launches (crewed or high-profile)',
    'Exoplanet discoveries in habitable zones',
    'ISS or space station emergencies',
    'Asteroid or comet threat assessments',
    'Space militarization developments',
    'Commercial space milestones (SpaceX, Blue Origin firsts)'
  ),
  'ignore', jsonb_build_array(
    'Routine ISS resupply missions',
    'Amateur astronomy tips',
    'Stargazing event announcements',
    'Merchandise or gift guides'
  ),
  'rejectKeywords', jsonb_build_array(
    'tonight''s sky', 'stargazing', 'horoscope', 'best telescope',
    'gift guide', 'astrophotography tips', 'beginner guide'
  ),
  'score1', 'Noise — stargazing tips, telescope reviews, astrology content, promotional material',
  'score2', 'Routine — scheduled satellite launches, routine ISS operations, minor mission updates',
  'score3', 'Noteworthy — successful mission milestone, new space company funding, notable astronomical observation',
  'score4', 'Significant — major discovery (new exoplanet, gravitational wave event), failed mission with consequences, space policy shift',
  'score5', 'Breaking/Urgent — crewed mission emergency, confirmed asteroid threat, first contact scenario, historic Mars/Moon landing',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'professional',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include mission name or celestial body when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'space-astronomy'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- Robotics & AI
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'AGI claims or frontier model releases by major labs',
    'AI regulation: EU AI Act enforcement, US executive orders, international treaties',
    'Autonomous weapons policy decisions or deployments',
    'AI safety incidents or alignment breakthroughs',
    'Humanoid robot milestones (Boston Dynamics, Tesla Bot, Figure)',
    'Robotics in warfare — confirmed deployments or doctrine changes',
    'AI lab funding rounds exceeding $1B (OpenAI, Anthropic, xAI)'
  ),
  'ignore', jsonb_build_array(
    'Minor chatbot feature updates',
    'AI-generated art controversies (unless policy-level)',
    'Startup demo videos without deployment',
    'Conference paper summaries (unless Nature/Science-tier)',
    'AI-powered product marketing with no technical substance'
  ),
  'rejectKeywords', jsonb_build_array(
    'tutorial', 'how to build', 'course', 'webinar', 'podcast',
    'hiring', 'job opening', 'internship', 'bootcamp',
    'top 10', 'best tools', 'free trial', 'vs comparison'
  ),
  'score1', 'Noise — tutorials, course announcements, minor chatbot updates, promotional AI tool launches',
  'score2', 'Routine — incremental model improvements, routine benchmark results, minor robotics demos',
  'score3', 'Noteworthy — new model release from established lab, notable robotics deployment, AI policy proposal',
  'score4', 'Significant — frontier model with major capability jump, AI regulation enacted, autonomous weapons policy shift, major safety incident',
  'score5', 'Breaking/Urgent — credible AGI claim by major lab, autonomous weapon deployment confirmed, AI causes mass casualties, global AI moratorium',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'professional',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include lab/company name and model name when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'robotics-ai'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- Biotech & Life Sciences
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'FDA approvals or rejections of major drugs',
    'Pandemic-level outbreak declarations',
    'Gene therapy or CRISPR breakthroughs',
    'Clinical trial failures for blockbuster drugs',
    'Bioweapon or biosecurity concerns',
    'Drug pricing policy changes affecting millions',
    'Nobel Prize in Physiology/Medicine or Chemistry'
  ),
  'ignore', jsonb_build_array(
    'Minor licensing deals under $50M',
    'Conference attendance announcements',
    'Routine quarterly earnings for small biotechs',
    'PR-driven partnership announcements',
    'Book reviews and commentary (Nature non-research content)'
  ),
  'rejectKeywords', jsonb_build_array(
    'partnership', 'licensing deal', 'conference recap', 'webinar',
    'podcast', 'sponsored', 'career', 'job opening',
    'book review', 'obituary', 'retraction watch'
  ),
  'score1', 'Noise — press releases, minor licensing deals, promotional content, career postings',
  'score2', 'Routine — scheduled FDA meetings, minor clinical updates, small biotech earnings',
  'score3', 'Noteworthy — promising Phase 2/3 trial results, notable FDA filing, emerging disease cluster',
  'score4', 'Significant — major FDA approval/rejection, CRISPR milestone, large clinical trial failure, biosecurity warning',
  'score5', 'Breaking/Urgent — WHO pandemic declaration, gene therapy cures major disease, confirmed bioweapon incident, public health emergency',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'professional',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include drug name, company, and disease area when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'biotech'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- Military & Defense
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'Active conflict escalation or de-escalation',
    'PLA military exercises near Taiwan or South China Sea',
    'US-China military confrontation or close calls',
    'AUKUS or Quad developments',
    'Autonomous weapons or AI-enabled warfare deployments',
    'Nuclear posture changes or weapons tests',
    'Arms deals exceeding $1B',
    'Hypersonic or space weapons tests'
  ),
  'ignore', jsonb_build_array(
    'Routine military exercises (unless near flashpoints)',
    'Minor procurement contracts under $100M',
    'Military history articles',
    'Veterans affairs news'
  ),
  'rejectKeywords', jsonb_build_array(
    'opinion:', 'editorial', 'book review', 'podcast', 'job fair',
    'veteran', 'memorial', 'museum', 'history of'
  ),
  'score1', 'Noise — opinion pieces, book reviews, military history, memorial events, minor base announcements',
  'score2', 'Routine — small procurement contracts, routine exercises, minor personnel changes',
  'score3', 'Noteworthy — weapons system test (non-nuclear), notable arms deal, military exercise near flashpoint',
  'score4', 'Significant — conflict escalation, carrier group deployment to flashpoint, major arms deal (>$1B), new weapons system operational',
  'score5', 'Breaking/Urgent — war declared between nations, nuclear weapon used or tested, direct US-China military confrontation, invasion launched',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'urgent',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include country names, weapons systems, and conflict zones when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'military-defense'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- World Politics
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'War or conflict escalation/de-escalation',
    'Taiwan Strait tensions or diplomatic shifts',
    'US-China bilateral relations, summits, or sanctions',
    'AI governance at UN, G7, or multilateral level',
    'Sanctions, embargoes, or trade war escalation',
    'Regime changes or coups',
    'UN Security Council actions',
    'Election results in major powers'
  ),
  'ignore', jsonb_build_array(
    'Routine diplomatic meetings with no outcomes',
    'Local elections in small countries',
    'Cultural exchange events',
    'Tourism and travel news'
  ),
  'rejectKeywords', jsonb_build_array(
    'opinion:', 'photo essay', 'in pictures', 'quiz', 'travel',
    'food', 'lifestyle', 'sport', 'entertainment', 'celebrity',
    'recipe', 'fashion'
  ),
  'score1', 'Noise — lifestyle, travel, entertainment, sports, cultural fluff with no political substance',
  'score2', 'Routine — scheduled summits with no surprises, minor diplomatic statements, local politics',
  'score3', 'Noteworthy — new sanctions package, election in medium power, diplomatic incident, trade negotiation shift',
  'score4', 'Significant — major election result, conflict escalation, sanctions on major economy, treaty signed or violated',
  'score5', 'Breaking/Urgent — coup in major power, UN sanctions on P5 member, leader assassination, war declared, treaty collapse',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'professional',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include country names and leaders when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'world-politics'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- Cybersecurity
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'State-sponsored attacks (APT groups)',
    'Critical infrastructure breaches (power, water, banking)',
    'Zero-day exploits with CVSS 9+',
    'Ransomware on hospitals or government systems',
    'Election interference or disinformation operations',
    'Cyber warfare operations linked to geopolitical conflict'
  ),
  'ignore', jsonb_build_array(
    'Minor software patches',
    'Routine vulnerability disclosures (CVSS < 7)',
    'Cybersecurity product launches',
    'Career advice and hiring posts'
  ),
  'rejectKeywords', jsonb_build_array(
    'tutorial', 'how to', 'best practices', 'webinar', 'sponsored',
    'hiring', 'career', 'certification', 'training course'
  ),
  'score1', 'Noise — tutorials, product launches, career advice, certification news, minor patches',
  'score2', 'Routine — standard vulnerability patches, small-scale phishing campaigns, minor malware variants',
  'score3', 'Noteworthy — notable data breach (>100K records), new APT campaign identified, significant vulnerability (CVSS 7-8)',
  'score4', 'Significant — state-sponsored attack attributed, major ransomware on critical sector, zero-day actively exploited (CVSS 9+)',
  'score5', 'Breaking/Urgent — critical infrastructure down (power grid, banking system), state-sponsored attack on NATO member, election systems compromised',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'urgent',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with what was attacked and by whom. Include threat actor name and affected systems when known.'
), 5, 2
FROM sectors s WHERE s.slug = 'cybersecurity'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- Energy & Climate
INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
SELECT s.id, '', jsonb_build_object(
  'priorities', jsonb_build_array(
    'OPEC production decisions or emergency meetings',
    'Pipeline attacks or sabotage',
    'Sanctions on energy exports (Russia, Iran, Venezuela)',
    'Nuclear plant incidents',
    'Major climate policy changes (Paris Agreement, COP)',
    'Energy supply disruptions or grid failures',
    'Battery or energy storage technology breakthrough'
  ),
  'ignore', jsonb_build_array(
    'Minor quarterly earnings for energy companies',
    'Routine weather reports',
    'EV model announcements (unless policy-shifting)',
    'Green energy startup funding',
    'Individual EV owner stories or testimonials'
  ),
  'rejectKeywords', jsonb_build_array(
    'sponsored', 'webinar', 'conference', 'podcast', 'job opening',
    'internship', 'recipe', 'lifestyle',
    'test drive', 'car review', 'best EV', 'buying guide'
  ),
  'score1', 'Noise — promotional content, minor company news, sponsored articles, career postings',
  'score2', 'Routine — incremental policy updates, minor production adjustments, routine EIA data releases',
  'score3', 'Noteworthy — OPEC production change, new sanctions proposed, notable renewable energy milestone',
  'score4', 'Significant — major sanctions enacted on energy exporter, pipeline incident, grid stress event, landmark climate legislation',
  'score5', 'Breaking/Urgent — OPEC production halt, pipeline sabotage (Nord Stream-level), nuclear plant meltdown, global energy supply crisis',
  'examples', '[]'::jsonb,
  'summaryMaxChars', 200,
  'summaryTone', 'professional',
  'summaryLanguage', 'English',
  'summaryStyle', 'Start with the key fact. Include affected regions and commodity prices when relevant.'
), 5, 2
FROM sectors s WHERE s.slug = 'energy-climate'
ON CONFLICT (sector_id) DO UPDATE SET
  score_criteria = EXCLUDED.score_criteria,
  auto_approve_threshold = EXCLUDED.auto_approve_threshold,
  auto_reject_threshold = EXCLUDED.auto_reject_threshold;

-- ─── 5. FIX UNASSIGNED SOURCES ──────────────────────────────────────────────
-- Sources added manually via UI that ended up with NULL sector_id.
-- Also normalizes names for manually-added Google News feeds.

-- CNBC feed → Technology
UPDATE rss_sources SET
  sector_id = (SELECT id FROM sectors WHERE slug = 'technology'),
  name = 'CNBC Technology (legacy)',
  active = true
WHERE url LIKE '%cnbc.com%' AND sector_id IS NULL;

-- "fundings" Google News → Technology
UPDATE rss_sources SET
  sector_id = (SELECT id FROM sectors WHERE slug = 'technology'),
  name = 'GN: AI Startup Funding (legacy)',
  active = true
WHERE url LIKE '%news.google.com%startup%funding%' AND sector_id IS NULL;

-- Normalize existing Google News feed names for consistency
UPDATE rss_sources SET name = 'GN: Cybersecurity'
WHERE url LIKE '%news.google.com%cybersecurity%' AND name = 'GNews';

UPDATE rss_sources SET name = 'GN: Military AI'
WHERE url LIKE '%news.google.com%warfare%military%' AND name = 'Defence';

UPDATE rss_sources SET name = 'GN: Robotics'
WHERE url LIKE '%news.google.com%robotics%' AND name = 'Robotics';

UPDATE rss_sources SET name = 'GN: Geopolitics'
WHERE url LIKE '%news.google.com%' AND name = 'Politics'
AND sector_id = (SELECT id FROM sectors WHERE slug = 'world-politics');

-- ─── Done ────────────────────────────────────────────────────────────────────
-- Verify: SELECT s.name, COUNT(r.id) FROM sectors s LEFT JOIN rss_sources r ON r.sector_id = s.id GROUP BY s.name ORDER BY s.name;
