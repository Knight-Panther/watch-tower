/**
 * Test database helpers — connects to real PostgreSQL, provides cleanup utilities.
 * Uses the development database but truncates test-affected tables between tests.
 */

import { createDb, type Database, sql } from "@watch-tower/db";

// Module-level singleton — reused across all tests in a suite.
let _db: ReturnType<typeof createDb> | null = null;

/**
 * Get or create a database connection for integration tests.
 * Reuses the same connection pool across all tests in a suite to avoid
 * exhausting connection slots.
 */
export const getTestDb = (): ReturnType<typeof createDb> => {
  if (!_db) {
    const url =
      process.env.DATABASE_URL ?? "postgres://watchtower:watchtower@127.0.0.1:5432/watchtower";
    _db = createDb(url);
  }
  return _db;
};

/**
 * Truncate all article-related tables for a clean test slate.
 * Preserves sectors, rss_sources, app_config, and allowed_domains (seed data).
 */
export const cleanArticleTables = async (db: Database): Promise<void> => {
  await db.execute(sql`
    TRUNCATE TABLE
      alert_deliveries,
      post_deliveries,
      article_images,
      llm_telemetry,
      feed_fetch_runs,
      digest_drafts,
      digest_runs,
      articles
    CASCADE
  `);
};

/**
 * Truncate all tables that tests may have written to, except app_config.
 * Useful for a full reset between test suites.
 */
export const cleanAllTables = async (db: Database): Promise<void> => {
  await db.execute(sql`
    TRUNCATE TABLE
      alert_deliveries,
      alert_rules,
      post_deliveries,
      article_images,
      llm_telemetry,
      feed_fetch_runs,
      digest_drafts,
      digest_runs,
      digest_slots,
      articles,
      scoring_rules,
      rss_sources,
      social_accounts,
      platform_health,
      allowed_domains,
      sectors
    CASCADE
  `);
};

/**
 * Seed a test sector and return its ID.
 * Handles both `slug` and `name` unique constraints by deleting conflicting
 * rows before inserting.  This is safe in tests because cleanArticleTables()
 * already truncated referencing data (articles etc.).
 */
export const seedTestSector = async (
  db: Database,
  name = "Test Sector",
  slug = "test-sector",
): Promise<string> => {
  // Remove any sector whose name OR slug would collide with the new one.
  // This avoids "duplicate key value violates unique constraint" errors
  // when different tests use the same name with different slugs (or vice-versa).
  await db.execute(sql`
    DELETE FROM sectors
    WHERE (name = ${name} AND slug != ${slug})
       OR (slug = ${slug} AND name != ${name})
  `);

  const result = await db.execute(sql`
    INSERT INTO sectors (name, slug, default_max_age_days)
    VALUES (${name}, ${slug}, 7)
    ON CONFLICT (slug) DO UPDATE SET name = ${name}
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
};

/**
 * Seed a test RSS source and return its ID.
 * Uses ON CONFLICT DO UPDATE so duplicate URLs are handled gracefully.
 */
export const seedTestSource = async (
  db: Database,
  url: string,
  sectorId: string,
  name = "Test Source",
): Promise<string> => {
  const result = await db.execute(sql`
    INSERT INTO rss_sources (url, name, active, sector_id, max_age_days)
    VALUES (${url}, ${name}, true, ${sectorId}::uuid, 7)
    ON CONFLICT (url) DO UPDATE SET name = ${name}
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
};

/**
 * Seed an allowed domain (required for the ingest security whitelist).
 * No-ops if the domain already exists.
 */
export const seedAllowedDomain = async (db: Database, domain: string): Promise<void> => {
  await db.execute(sql`
    INSERT INTO allowed_domains (domain, is_active)
    VALUES (${domain}, true)
    ON CONFLICT (domain) DO NOTHING
  `);
};

/**
 * Article seed options — all fields are optional; sensible defaults are applied
 * for any omitted values so callers only need to specify what they care about.
 */
export type SeedArticleOptions = {
  url?: string;
  title?: string;
  contentSnippet?: string;
  sourceId?: string;
  sectorId?: string;
  pipelineStage?: string;
  importanceScore?: number | null;
  publishedAt?: Date;
  articleCategories?: string[] | null;
};

/**
 * Insert a test article directly, bypassing the ingest pipeline.
 * Returns the generated UUID of the new row.
 */
export const seedTestArticle = async (
  db: Database,
  overrides: SeedArticleOptions = {},
): Promise<string> => {
  const url =
    overrides.url ??
    `https://test.example.com/article-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const title = overrides.title ?? "Test Article";
  const snippet = overrides.contentSnippet ?? "Test content snippet for integration testing.";
  const stage = overrides.pipelineStage ?? "ingested";
  const published = overrides.publishedAt ?? new Date();
  const score = overrides.importanceScore ?? null;
  const categories = overrides.articleCategories ?? null;

  // Build the category SQL fragment: either a typed array literal or NULL.
  const categorySql =
    categories !== null && categories.length > 0
      ? sql`ARRAY[${sql.join(
          categories.map((c) => sql`${c}`),
          sql`, `,
        )}]::text[]`
      : sql`NULL`;

  const result = await db.execute(sql`
    INSERT INTO articles (
      url,
      title,
      content_snippet,
      source_id,
      sector_id,
      pipeline_stage,
      importance_score,
      published_at,
      article_categories
    )
    VALUES (
      ${url},
      ${title},
      ${snippet},
      ${overrides.sourceId ? sql`${overrides.sourceId}::uuid` : sql`NULL`},
      ${overrides.sectorId ? sql`${overrides.sectorId}::uuid` : sql`NULL`},
      ${stage},
      ${score},
      ${published},
      ${categorySql}
    )
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
};

/**
 * Fetch a single article row by ID for use in test assertions.
 * Returns null if no article with that ID exists.
 */
export const getArticle = async (
  db: Database,
  id: string,
): Promise<Record<string, unknown> | null> => {
  const result = await db.execute(sql`
    SELECT * FROM articles WHERE id = ${id}::uuid
  `);
  return (result.rows[0] as Record<string, unknown>) ?? null;
};

/**
 * Close the shared test database connection pool.
 * Call in afterAll() to cleanly release resources.
 */
export const closeTestDb = async (): Promise<void> => {
  if (_db) {
    await _db.close();
    _db = null;
  }
};
