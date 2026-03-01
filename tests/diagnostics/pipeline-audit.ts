/**
 * Watch Tower — Pipeline Audit Diagnostic
 *
 * Finds articles stuck in intermediate pipeline states and reports anomalies.
 *
 * Usage:
 *   npx tsx tests/diagnostics/pipeline-audit.ts
 *
 * Exit codes:
 *   0 — no issues detected
 *   1 — one or more warnings found
 */

import * as path from "path";
import * as fs from "fs";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// .env loader (self-contained — no dotenv import required when using tsx's
// built-in --env-file flag, but we support manual loading as a fallback)
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Types for query results
// ---------------------------------------------------------------------------

interface StuckArticleRow {
  pipeline_stage: string;
  count: string;
  oldest: Date;
}

interface StuckTranslationRow {
  translation_status: string;
  count: string;
}

interface ExhaustedRow {
  exhausted_count: string;
}

interface StuckDeliveryRow {
  status: string;
  count: string;
}

interface ScoringAnomalyRow {
  source_name: string;
  source_id: string;
  rejected: string;
  total: string;
}

interface QuotaWarningRow {
  name: string;
  id: string;
  today_count: string;
  daily_limit: string;
}

interface StageDistributionRow {
  pipeline_stage: string;
  count: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAge(oldest: Date): string {
  const diffMs = Date.now() - new Date(oldest).getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function pluralise(n: number, singular: string, plural = singular + "s"): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function section(title: string): void {
  console.log(`\n${"─".repeat(3)} ${title} ${"─".repeat(3)}`);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function queryStuckArticles(client: Client): Promise<StuckArticleRow[]> {
  const { rows } = await client.query<StuckArticleRow>(`
    SELECT pipeline_stage,
           COUNT(*)    AS count,
           MIN(created_at) AS oldest
    FROM articles
    WHERE pipeline_stage IN ('ingested', 'embedded')
      AND created_at < NOW() - INTERVAL '1 hour'
    GROUP BY pipeline_stage
    ORDER BY pipeline_stage
  `);
  return rows;
}

async function queryStuckTranslations(client: Client): Promise<StuckTranslationRow[]> {
  // articles has no updated_at; created_at is used (matches the maintenance worker's
  // zombie-reset heuristic: articles.pipeline_stage IN (...) AND created_at < threshold).
  const { rows } = await client.query<StuckTranslationRow>(`
    SELECT translation_status,
           COUNT(*) AS count
    FROM articles
    WHERE translation_status = 'translating'
      AND created_at < NOW() - INTERVAL '30 minutes'
    GROUP BY translation_status
  `);
  return rows;
}

async function queryExhausted(client: Client): Promise<ExhaustedRow> {
  const { rows } = await client.query<ExhaustedRow>(`
    SELECT COUNT(*) AS exhausted_count
    FROM articles
    WHERE translation_status = 'exhausted'
  `);
  return rows[0] ?? { exhausted_count: "0" };
}

async function queryStuckDeliveries(client: Client): Promise<StuckDeliveryRow[]> {
  // post_deliveries has no updated_at; created_at is the best proxy for when
  // the delivery entered 'posting' state (it transitions quickly in normal flow).
  const { rows } = await client.query<StuckDeliveryRow>(`
    SELECT status,
           COUNT(*) AS count
    FROM post_deliveries
    WHERE status = 'posting'
      AND created_at < NOW() - INTERVAL '30 minutes'
    GROUP BY status
  `);
  return rows;
}

async function queryScoringAnomalies(client: Client): Promise<ScoringAnomalyRow[]> {
  const { rows } = await client.query<ScoringAnomalyRow>(`
    SELECT s.name    AS source_name,
           s.id      AS source_id,
           COUNT(*) FILTER (WHERE a.pipeline_stage = 'rejected') AS rejected,
           COUNT(*)  AS total
    FROM articles a
    JOIN rss_sources s ON a.source_id = s.id
    WHERE a.created_at > NOW() - INTERVAL '24 hours'
    GROUP BY s.id, s.name
    HAVING COUNT(*) > 5
    ORDER BY (COUNT(*) FILTER (WHERE a.pipeline_stage = 'rejected'))::float
             / GREATEST(COUNT(*), 1) DESC
  `);
  return rows;
}

async function queryQuotaWarnings(client: Client): Promise<QuotaWarningRow[]> {
  // rss_sources uses max_articles_per_day (NULL = fall back to env MAX_ARTICLES_PER_SOURCE_DAILY=500)
  const { rows } = await client.query<QuotaWarningRow>(`
    SELECT s.name,
           s.id,
           COUNT(*)                                  AS today_count,
           COALESCE(s.max_articles_per_day, 500)     AS daily_limit
    FROM articles a
    JOIN rss_sources s ON a.source_id = s.id
    WHERE a.created_at > CURRENT_DATE
    GROUP BY s.id, s.name, s.max_articles_per_day
    HAVING COUNT(*) > COALESCE(s.max_articles_per_day, 500) * 0.8
    ORDER BY COUNT(*) DESC
  `);
  return rows;
}

async function queryStageDistribution(client: Client): Promise<StageDistributionRow[]> {
  const { rows } = await client.query<StageDistributionRow>(`
    SELECT pipeline_stage,
           COUNT(*) AS count
    FROM articles
    GROUP BY pipeline_stage
    ORDER BY count DESC
  `);
  return rows;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function reportStuckArticles(rows: StuckArticleRow[]): number {
  section("Stuck Articles (> 1 hour)");
  if (rows.length === 0) {
    console.log("  No articles stuck in early pipeline stages.");
    return 0;
  }
  for (const row of rows) {
    const count = parseInt(row.count, 10);
    console.log(
      `  Stage '${row.pipeline_stage}': ${pluralise(count, "article")} (oldest: ${formatAge(row.oldest)})`,
    );
  }
  return rows.length;
}

function reportStuckTranslations(rows: StuckTranslationRow[], exhausted: ExhaustedRow): number {
  section("Stuck Translations (> 30 min)");
  const stuckCount = rows.reduce((acc, r) => acc + parseInt(r.count, 10), 0);
  const exhaustedCount = parseInt(exhausted.exhausted_count, 10);

  console.log(`  ${pluralise(stuckCount, "article")} stuck in 'translating'`);
  console.log(`  ${exhaustedCount} articles exhausted (max retries reached)`);

  return stuckCount > 0 || exhaustedCount > 0 ? 1 : 0;
}

function reportStuckDeliveries(rows: StuckDeliveryRow[]): number {
  section("Stuck Deliveries (> 30 min)");
  const total = rows.reduce((acc, r) => acc + parseInt(r.count, 10), 0);
  console.log(`  ${pluralise(total, "delivery", "deliveries")} stuck in 'posting'`);
  return total > 0 ? 1 : 0;
}

function reportScoringAnomalies(rows: ScoringAnomalyRow[]): number {
  section("Scoring Anomalies (last 24h)");
  if (rows.length === 0) {
    console.log("  No sources with unusual rejection rates.");
    return 0;
  }
  let warnings = 0;
  for (const row of rows) {
    const rejected = parseInt(row.rejected, 10);
    const total = parseInt(row.total, 10);
    const pct = total > 0 ? Math.round((rejected / total) * 100) : 0;
    console.log(
      `  Source "${row.source_name}" — ${pct}% rejection rate (${rejected}/${total} articles)`,
    );
    if (pct > 80) warnings++;
  }
  return warnings;
}

function reportQuotaWarnings(rows: QuotaWarningRow[]): number {
  section("Quota Warnings");
  if (rows.length === 0) {
    console.log("  No sources approaching daily quota.");
    return 0;
  }
  for (const row of rows) {
    const todayCount = parseInt(row.today_count, 10);
    const dailyLimit = parseInt(row.daily_limit, 10);
    const pct = dailyLimit > 0 ? Math.round((todayCount / dailyLimit) * 100) : 0;
    console.log(
      `  Source "${row.name}" — ${todayCount}/${dailyLimit} daily quota used (${pct}%)`,
    );
  }
  return rows.length;
}

function reportStageDistribution(rows: StageDistributionRow[]): void {
  section("Pipeline Stage Distribution");
  if (rows.length === 0) {
    console.log("  No articles in database.");
    return;
  }
  const maxLabelLen = Math.max(...rows.map((r) => r.pipeline_stage.length));
  for (const row of rows) {
    const label = row.pipeline_stage.padEnd(maxLabelLen, " ");
    console.log(`  ${label}  ${parseInt(row.count, 10).toLocaleString()} articles`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set. Add it to .env or export it before running.");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Could not connect to PostgreSQL — ${message}`);
    process.exit(1);
  }

  console.log("=== Watch Tower Pipeline Audit ===");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  let totalWarnings = 0;

  try {
    // 1. Stuck articles in early pipeline stages
    const stuckArticles = await queryStuckArticles(client);
    totalWarnings += reportStuckArticles(stuckArticles);

    // 2 + 3. Stuck and exhausted translations
    const [stuckTranslations, exhausted] = await Promise.all([
      queryStuckTranslations(client),
      queryExhausted(client),
    ]);
    totalWarnings += reportStuckTranslations(stuckTranslations, exhausted);

    // 4. Stuck deliveries
    const stuckDeliveries = await queryStuckDeliveries(client);
    totalWarnings += reportStuckDeliveries(stuckDeliveries);

    // 5. Scoring anomalies
    const scoringAnomalies = await queryScoringAnomalies(client);
    totalWarnings += reportScoringAnomalies(scoringAnomalies);

    // 6. Quota warnings
    const quotaWarnings = await queryQuotaWarnings(client);
    totalWarnings += reportQuotaWarnings(quotaWarnings);

    // 7. Full stage distribution (informational — does not increment warnings)
    const stageDistribution = await queryStageDistribution(client);
    reportStageDistribution(stageDistribution);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nERROR: Query failed — ${message}`);
    await client.end();
    process.exit(1);
  }

  await client.end();

  // Final summary
  console.log("");
  if (totalWarnings === 0) {
    console.log("Overall: No issues detected");
    process.exit(0);
  } else {
    console.log(`Overall: ${pluralise(totalWarnings, "warning")} found`);
    process.exit(1);
  }
}

main();
