/**
 * SmartHub Stats Collector — Pure SQL aggregation of pipeline metrics.
 * Produces an AdvisorStatsSnapshot JSON with 13 data sections.
 * No LLM involved; all intelligence comes from SQL queries.
 */

import { eq, and, gte, isNotNull, sql, count } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import {
  articles,
  rssSources,
  sectors,
  scoringRules,
  appConfig,
} from "@watch-tower/db";
import { scoringConfigSchema } from "@watch-tower/shared";
import type {
  AdvisorStatsSnapshot,
  SourceStats,
  SectorStats,
  RejectionStats,
  ScoreTrend,
  KeywordStats,
  CategoryCorrelation,
  DedupStats,
  CostStats,
  OperatorOverrideStats,
  FetchEfficiencyStats,
  PlatformDeliveryStats,
  AlertEffectivenessStats,
} from "@watch-tower/shared";
import { logger } from "@watch-tower/shared";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RowResult = { rows: Record<string, unknown>[] };

/** Extract rows from either raw or wrapped result */
const rows = (result: unknown): Record<string, unknown>[] =>
  ((result as RowResult).rows ?? result) as Record<string, unknown>[];

/** Build source + sector lookup maps */
const buildLookupMaps = async (
  db: Database,
): Promise<{
  sourceMap: Map<string, { name: string; url: string; sectorId: string | null; active: boolean; interval: number }>;
  sectorMap: Map<string, string>;
}> => {
  const allSources = await db
    .select({
      id: rssSources.id,
      name: rssSources.name,
      url: rssSources.url,
      sectorId: rssSources.sectorId,
      active: rssSources.active,
      interval: rssSources.ingestIntervalMinutes,
    })
    .from(rssSources);

  const sourceMap = new Map(
    allSources.map((s) => [
      s.id,
      {
        name: s.name ?? s.url,
        url: s.url,
        sectorId: s.sectorId,
        active: s.active,
        interval: s.interval,
      },
    ]),
  );

  const allSectors = await db.select({ id: sectors.id, name: sectors.name }).from(sectors);
  const sectorMap = new Map(allSectors.map((s) => [s.id, s.name]));

  return { sourceMap, sectorMap };
};

// ─── Query 3a: Per-Source Score Distribution ─────────────────────────────────

const querySourceScores = async (
  db: Database,
  cutoff: Date,
): Promise<Map<string, { scores: Record<string, number>; total: number }>> => {
  const result = await db.execute(sql`
    SELECT source_id, importance_score, COUNT(*)::int AS cnt
    FROM articles
    WHERE scored_at >= ${cutoff}
      AND importance_score IS NOT NULL
      AND source_id IS NOT NULL
    GROUP BY source_id, importance_score
  `);

  const map = new Map<string, { scores: Record<string, number>; total: number }>();
  for (const row of rows(result)) {
    const sid = row.source_id as string;
    const score = Number(row.importance_score);
    const cnt = Number(row.cnt);
    if (!map.has(sid)) map.set(sid, { scores: {}, total: 0 });
    const entry = map.get(sid)!;
    entry.scores[String(score)] = cnt;
    entry.total += cnt;
  }
  return map;
};

// ─── Query: Per-Source 7d vs previous 7d signal ratio ────────────────────────

const querySourceTrend = async (
  db: Database,
): Promise<Map<string, { current: number; previous: number }>> => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000);

  const result = await db.execute(sql`
    SELECT source_id,
      COUNT(*) FILTER (WHERE scored_at >= ${sevenDaysAgo} AND importance_score >= 4)::int AS current_high,
      COUNT(*) FILTER (WHERE scored_at >= ${sevenDaysAgo})::int AS current_total,
      COUNT(*) FILTER (WHERE scored_at < ${sevenDaysAgo} AND scored_at >= ${fourteenDaysAgo} AND importance_score >= 4)::int AS prev_high,
      COUNT(*) FILTER (WHERE scored_at < ${sevenDaysAgo} AND scored_at >= ${fourteenDaysAgo})::int AS prev_total
    FROM articles
    WHERE scored_at >= ${fourteenDaysAgo}
      AND importance_score IS NOT NULL
      AND source_id IS NOT NULL
    GROUP BY source_id
  `);

  const map = new Map<string, { current: number; previous: number }>();
  for (const row of rows(result)) {
    const sid = row.source_id as string;
    const curTotal = Number(row.current_total);
    const prevTotal = Number(row.prev_total);
    map.set(sid, {
      current: curTotal > 0 ? Number(row.current_high) / curTotal : 0,
      previous: prevTotal > 0 ? Number(row.prev_high) / prevTotal : 0,
    });
  }
  return map;
};

// ─── Query 3b: Per-Source Rejection Rate ─────────────────────────────────────

const querySourceRejections = async (
  db: Database,
  cutoff: Date,
): Promise<Map<string, { rejected: number; total: number }>> => {
  const result = await db.execute(sql`
    SELECT source_id,
      COUNT(*) FILTER (WHERE pipeline_stage = 'rejected')::int AS rejected,
      COUNT(*)::int AS total
    FROM articles
    WHERE created_at >= ${cutoff}
      AND source_id IS NOT NULL
    GROUP BY source_id
  `);

  const map = new Map<string, { rejected: number; total: number }>();
  for (const row of rows(result)) {
    map.set(row.source_id as string, {
      rejected: Number(row.rejected),
      total: Number(row.total),
    });
  }
  return map;
};

// ─── Query 3c: Per-Source Dedup Rate ─────────────────────────────────────────

const querySourceDedup = async (
  db: Database,
  cutoff: Date,
): Promise<Map<string, { duplicates: number; total: number }>> => {
  const result = await db.execute(sql`
    SELECT source_id,
      COUNT(*) FILTER (WHERE is_semantic_duplicate = true)::int AS duplicates,
      COUNT(*)::int AS total
    FROM articles
    WHERE created_at >= ${cutoff}
      AND source_id IS NOT NULL
    GROUP BY source_id
  `);

  const map = new Map<string, { duplicates: number; total: number }>();
  for (const row of rows(result)) {
    map.set(row.source_id as string, {
      duplicates: Number(row.duplicates),
      total: Number(row.total),
    });
  }
  return map;
};

// ─── Query 3d: Pre-Filter Keyword Hits ───────────────────────────────────────

const queryKeywordHits = async (
  db: Database,
  cutoff: Date,
): Promise<{ keyword: string; field: string; count: number }[]> => {
  const result = await db.execute(sql`
    SELECT rejection_reason, COUNT(*)::int AS hits
    FROM articles
    WHERE pipeline_stage = 'rejected'
      AND rejection_reason LIKE 'pre-filter:%'
      AND created_at >= ${cutoff}
    GROUP BY rejection_reason
    ORDER BY hits DESC
  `);

  const hits: { keyword: string; field: string; count: number }[] = [];
  // Parse "pre-filter: keyword 'X' matched in Y" pattern
  const re = /pre-filter:\s*keyword\s+'([^']+)'\s+matched\s+in\s+(\w+)/i;
  for (const row of rows(result)) {
    const match = re.exec(row.rejection_reason as string);
    if (match) {
      hits.push({ keyword: match[1], field: match[2], count: Number(row.hits) });
    }
  }
  return hits;
};

// ─── Query 3e: Score Distribution + 7-Day Trend ─────────────────────────────

const queryScoreTrend = async (db: Database): Promise<ScoreTrend> => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000);

  const [currentResult, previousResult] = await Promise.all([
    db.execute(sql`
      SELECT importance_score, COUNT(*)::int AS cnt
      FROM articles
      WHERE scored_at >= ${sevenDaysAgo} AND importance_score IS NOT NULL
      GROUP BY importance_score
    `),
    db.execute(sql`
      SELECT importance_score, COUNT(*)::int AS cnt
      FROM articles
      WHERE scored_at >= ${fourteenDaysAgo} AND scored_at < ${sevenDaysAgo}
        AND importance_score IS NOT NULL
      GROUP BY importance_score
    `),
  ]);

  const current: Record<string, number> = {};
  for (const row of rows(currentResult)) {
    current[String(row.importance_score)] = Number(row.cnt);
  }

  const previous: Record<string, number> = {};
  for (const row of rows(previousResult)) {
    previous[String(row.importance_score)] = Number(row.cnt);
  }

  const curHigh = (current["4"] ?? 0) + (current["5"] ?? 0);
  const prevHigh = (previous["4"] ?? 0) + (previous["5"] ?? 0);
  const highScoreChangePct = prevHigh > 0 ? ((curHigh - prevHigh) / prevHigh) * 100 : 0;

  return {
    current_week: current,
    previous_week: previous,
    high_score_change_pct: Math.round(highScoreChangePct * 10) / 10,
  };
};

// ─── Query 3f: Category-to-Score Correlation ─────────────────────────────────

const queryCategoryCorrelations = async (
  db: Database,
  cutoff: Date,
  sectorMap: Map<string, string>,
): Promise<CategoryCorrelation[]> => {
  const result = await db.execute(sql`
    SELECT unnest(article_categories) AS category, sector_id, importance_score, COUNT(*)::int AS cnt
    FROM articles
    WHERE scored_at >= ${cutoff}
      AND article_categories IS NOT NULL
      AND importance_score IS NOT NULL
    GROUP BY category, sector_id, importance_score
    ORDER BY category, sector_id, importance_score
  `);

  // Aggregate per (category, sector_id) — preserves sector context
  const key = (cat: string, sid: string | null) => `${cat}\0${sid ?? ""}`;
  const catMap = new Map<string, { category: string; sectorId: string | null; total: number; sum: number; high: number; low: number }>();
  for (const row of rows(result)) {
    const cat = row.category as string;
    const sectorId = (row.sector_id as string) ?? null;
    const score = Number(row.importance_score);
    const cnt = Number(row.cnt);
    const k = key(cat, sectorId);
    if (!catMap.has(k)) catMap.set(k, { category: cat, sectorId, total: 0, sum: 0, high: 0, low: 0 });
    const entry = catMap.get(k)!;
    entry.total += cnt;
    entry.sum += score * cnt;
    if (score >= 4) entry.high += cnt;
    if (score <= 2) entry.low += cnt;
  }

  // Return top 50 by frequency
  return Array.from(catMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 50)
    .map((stats) => ({
      category: stats.category,
      sector_id: stats.sectorId,
      sector_name: stats.sectorId ? sectorMap.get(stats.sectorId) ?? null : null,
      total: stats.total,
      avg_score: Math.round((stats.sum / stats.total) * 100) / 100,
      high_score_pct: Math.round((stats.high / stats.total) * 100 * 10) / 10,
      low_score_pct: Math.round((stats.low / stats.total) * 100 * 10) / 10,
    }));
};

// ─── Query 3g: Operator Override Detection ───────────────────────────────────

const queryOperatorOverrides = async (
  db: Database,
  cutoff: Date,
  autoApproveThreshold: number,
): Promise<OperatorOverrideStats> => {
  // Score < auto_approve_threshold AND stage = approved/posted → was manual
  const result = await db.execute(sql`
    SELECT source_id, sector_id, COUNT(*)::int AS override_count
    FROM articles
    WHERE importance_score < ${autoApproveThreshold}
      AND importance_score IS NOT NULL
      AND pipeline_stage IN ('approved', 'posted')
      AND approved_at IS NOT NULL
      AND created_at >= ${cutoff}
    GROUP BY source_id, sector_id
  `);

  const bySector = new Map<string, number>();
  const bySource = new Map<string, number>();
  let total = 0;

  for (const row of rows(result)) {
    const cnt = Number(row.override_count);
    total += cnt;
    const secId = row.sector_id as string | null;
    if (secId) bySector.set(secId, (bySector.get(secId) ?? 0) + cnt);
    const srcId = row.source_id as string | null;
    if (srcId) bySource.set(srcId, (bySource.get(srcId) ?? 0) + cnt);
  }

  return {
    total_overrides: total,
    by_sector: Array.from(bySector.entries()).map(([id, count]) => ({
      sector_id: id,
      sector_name: "", // filled later
      count,
    })),
    by_source: Array.from(bySource.entries()).map(([id, count]) => ({
      source_id: id,
      source_name: "", // filled later
      count,
    })),
  };
};

// ─── Query 3h: Feed Fetch Efficiency (14-day window) ─────────────────────────

const queryFetchEfficiency = async (db: Database): Promise<FetchEfficiencyStats[]> => {
  const cutoff14d = new Date(Date.now() - 14 * 86_400_000);
  const result = await db.execute(sql`
    SELECT source_id,
      COUNT(*)::int AS total_fetches,
      COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
      COUNT(*) FILTER (WHERE item_added = 0 AND status = 'success')::int AS empty_fetches,
      ROUND(AVG(duration_ms) FILTER (WHERE status = 'success'))::int AS avg_duration_ms
    FROM feed_fetch_runs
    WHERE created_at >= ${cutoff14d}
      AND source_id IS NOT NULL
    GROUP BY source_id
  `);

  return rows(result).map((row) => {
    const total = Number(row.total_fetches);
    const successes = Number(row.successes);
    const empty = Number(row.empty_fetches);
    return {
      source_id: row.source_id as string,
      source_name: "", // filled later
      total_fetches: total,
      success_rate: total > 0 ? Math.round((successes / total) * 100 * 10) / 10 : 0,
      empty_fetch_rate: successes > 0 ? Math.round((empty / successes) * 100 * 10) / 10 : 0,
      avg_duration_ms: Number(row.avg_duration_ms) || 0,
    };
  });
};

// ─── Query 3i: Duplicate Chain Analysis ──────────────────────────────────────

const queryDedupChains = async (db: Database, cutoff: Date): Promise<DedupStats> => {
  const [totalResult, chainResult] = await Promise.all([
    db
      .select({ cnt: count() })
      .from(articles)
      .where(and(eq(articles.isSemanticDuplicate, true), gte(articles.createdAt, cutoff))),
    db.execute(sql`
      SELECT
        dup.source_id AS follower_source_id,
        orig.source_id AS original_source_id,
        COUNT(*)::int AS dupe_count,
        ROUND(AVG(dup.similarity_score)::numeric, 3)::float AS avg_similarity
      FROM articles dup
      JOIN articles orig ON dup.duplicate_of_id = orig.id
      WHERE dup.is_semantic_duplicate = true
        AND dup.created_at >= ${cutoff}
      GROUP BY dup.source_id, orig.source_id
      ORDER BY dupe_count DESC
      LIMIT 30
    `),
  ]);

  return {
    total_duplicates: totalResult[0]?.cnt ?? 0,
    chains: rows(chainResult).map((row) => ({
      follower_source: row.follower_source_id as string,
      original_source: row.original_source_id as string,
      count: Number(row.dupe_count),
      avg_similarity: Number(row.avg_similarity),
    })),
  };
};

// ─── Query 3j: Cost Per Sector ───────────────────────────────────────────────

const queryCostStats = async (db: Database, cutoff: Date): Promise<CostStats> => {
  const [totalResult, byOpResult, bySectorResult] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(cost_microdollars), 0)::int AS total
      FROM llm_telemetry
      WHERE created_at >= ${cutoff}
    `),
    db.execute(sql`
      SELECT operation, COALESCE(SUM(cost_microdollars), 0)::int AS cost
      FROM llm_telemetry
      WHERE created_at >= ${cutoff}
      GROUP BY operation
    `),
    db.execute(sql`
      SELECT a.sector_id,
        COALESCE(SUM(t.cost_microdollars), 0)::int AS total_cost,
        COUNT(DISTINCT a.id)::int AS articles_scored,
        COUNT(DISTINCT a.id) FILTER (WHERE a.importance_score >= 4)::int AS useful_articles
      FROM llm_telemetry t
      JOIN articles a ON t.article_id = a.id
      WHERE t.operation = 'score_and_summarize'
        AND t.created_at >= ${cutoff}
        AND a.sector_id IS NOT NULL
      GROUP BY a.sector_id
    `),
  ]);

  const costByOp: Record<string, number> = {};
  for (const row of rows(byOpResult)) {
    costByOp[row.operation as string] = Number(row.cost);
  }

  return {
    total_cost_microdollars: Number(rows(totalResult)[0]?.total ?? 0),
    cost_by_operation: costByOp,
    cost_by_sector: rows(bySectorResult).map((row) => ({
      sector_id: row.sector_id as string,
      sector_name: "", // filled later
      cost: Number(row.total_cost),
      useful_articles: Number(row.useful_articles),
    })),
  };
};

// ─── Query 3k: Platform Delivery Stats ───────────────────────────────────────

const queryPlatformDelivery = async (
  db: Database,
  cutoff: Date,
): Promise<PlatformDeliveryStats> => {
  const result = await db.execute(sql`
    SELECT platform,
      COUNT(*) FILTER (WHERE status = 'posted')::int AS success,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*)::int AS total
    FROM post_deliveries
    WHERE created_at >= ${cutoff}
    GROUP BY platform
  `);

  return {
    by_platform: rows(result).map((row) => ({
      platform: row.platform as string,
      success: Number(row.success),
      failed: Number(row.failed),
      total: Number(row.total),
    })),
  };
};

// ─── Query 3l: Alert Rule Effectiveness ──────────────────────────────────────

const queryAlertEffectiveness = async (
  db: Database,
  cutoff: Date,
): Promise<AlertEffectivenessStats[]> => {
  const result = await db.execute(sql`
    SELECT ad.rule_id, ar.name AS rule_name, ar.keywords,
      COUNT(*)::int AS fires,
      COUNT(DISTINCT ad.matched_keyword)::int AS unique_keywords_matched
    FROM alert_deliveries ad
    JOIN alert_rules ar ON ad.rule_id = ar.id
    WHERE ad.sent_at >= ${cutoff}
    GROUP BY ad.rule_id, ar.name, ar.keywords
  `);

  return rows(result).map((row) => ({
    rule_id: row.rule_id as string,
    rule_name: row.rule_name as string,
    keywords: (row.keywords as string[]) ?? [],
    fires: Number(row.fires),
    unique_keywords_matched: Number(row.unique_keywords_matched),
  }));
};

// ─── Query 3m: Stale Priority/Ignore Detection ──────────────────────────────

const queryKeywordEffectiveness = async (
  db: Database,
  cutoff: Date,
  sectorMap: Map<string, string>,
): Promise<KeywordStats[]> => {
  // Fetch all scoring rules
  const rules = await db
    .select({
      sectorId: scoringRules.sectorId,
      scoreCriteria: scoringRules.scoreCriteria,
    })
    .from(scoringRules);

  // Collect all keyword checks to batch per sector
  type KeywordCheck = {
    sectorId: string;
    sectorName: string;
    keyword: string;
    type: "priority" | "ignore" | "reject";
  };
  const checks: KeywordCheck[] = [];

  for (const rule of rules) {
    const parsed = scoringConfigSchema.safeParse(rule.scoreCriteria);
    if (!parsed.success) continue;

    const sectorName = sectorMap.get(rule.sectorId) ?? "Unknown";
    const config = parsed.data;

    for (const kw of config.priorities.slice(0, 10)) {
      checks.push({ sectorId: rule.sectorId, sectorName, keyword: kw, type: "priority" });
    }
    for (const kw of config.ignore.slice(0, 10)) {
      checks.push({ sectorId: rule.sectorId, sectorName, keyword: kw, type: "ignore" });
    }
    for (const kw of config.rejectKeywords.slice(0, 10)) {
      checks.push({ sectorId: rule.sectorId, sectorName, keyword: kw, type: "reject" });
    }
  }

  if (checks.length === 0) return [];

  // Cap total keyword checks to prevent runaway queries in large configs
  const cappedChecks = checks.slice(0, 100);

  // Batch: run up to 10 keyword checks concurrently (not 300 sequentially)
  const BATCH_SIZE = 10;
  const stats: KeywordStats[] = [];

  for (let i = 0; i < cappedChecks.length; i += BATCH_SIZE) {
    const batch = cappedChecks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (check) => {
        const [result] =
          check.type === "reject"
            ? await db
                .select({ cnt: count() })
                .from(articles)
                .where(
                  and(
                    eq(articles.sectorId, check.sectorId),
                    gte(articles.createdAt, cutoff),
                    sql`rejection_reason ILIKE ${"%" + check.keyword + "%"}`,
                  ),
                )
            : await db
                .select({ cnt: count() })
                .from(articles)
                .where(
                  and(
                    eq(articles.sectorId, check.sectorId),
                    gte(articles.createdAt, cutoff),
                    isNotNull(articles.importanceScore),
                    sql`(title ILIKE ${"%" + check.keyword + "%"} OR array_to_string(article_categories, ',') ILIKE ${"%" + check.keyword + "%"})`,
                  ),
                );
        return {
          sector_id: check.sectorId,
          sector_name: check.sectorName,
          keyword: check.keyword,
          type: check.type,
          match_count: result?.cnt ?? 0,
        };
      }),
    );
    stats.push(...results);
  }

  return stats;
};

// ─── Main: Collect All Stats ─────────────────────────────────────────────────

export const collectAdvisorStats = async (
  db: Database,
  windowDays: number = 30,
): Promise<AdvisorStatsSnapshot> => {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  logger.info({ windowDays }, "[advisor-stats] collecting pipeline stats");

  // Build lookup maps
  const { sourceMap, sectorMap } = await buildLookupMaps(db);

  // Read auto-approve threshold from app_config
  let autoApproveThreshold = 5;
  try {
    const [row] = await db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "auto_approve_threshold"));
    if (row) {
      const num = Number(row.value);
      if (!Number.isNaN(num) && num >= 1 && num <= 5) autoApproveThreshold = num;
    }
  } catch {
    // use default
  }

  // Run all independent queries in parallel with individual error isolation
  const safeQuery = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query: name, error: msg }, "[advisor-stats] query failed, using fallback");
      return fallback;
    }
  };

  const emptyScoreTrend: ScoreTrend = {
    current_week: {},
    previous_week: {},
    high_score_change_pct: 0,
  };
  const emptyDedupStats: DedupStats = { total_duplicates: 0, chains: [] };
  const emptyCostStats: CostStats = {
    total_cost_microdollars: 0,
    cost_by_operation: {},
    cost_by_sector: [],
  };
  const emptyPlatformDelivery: PlatformDeliveryStats = { by_platform: [] };
  const emptyOverrides: OperatorOverrideStats = {
    total_overrides: 0,
    by_sector: [],
    by_source: [],
  };

  const [
    sourceScores,
    sourceTrend,
    sourceRejections,
    sourceDedup,
    keywordHits,
    scoreTrend,
    categoryCorrelations,
    operatorOverrides,
    fetchEfficiency,
    dedupPatterns,
    costStats,
    platformDelivery,
    alertEffectiveness,
    keywordEffectiveness,
  ] = await Promise.all([
    safeQuery("sourceScores", () => querySourceScores(db, cutoff), new Map<string, { scores: Record<string, number>; total: number }>()),
    safeQuery("sourceTrend", () => querySourceTrend(db), new Map<string, { current: number; previous: number }>()),
    safeQuery("sourceRejections", () => querySourceRejections(db, cutoff), new Map<string, { rejected: number; total: number }>()),
    safeQuery("sourceDedup", () => querySourceDedup(db, cutoff), new Map<string, { duplicates: number; total: number }>()),
    safeQuery("keywordHits", () => queryKeywordHits(db, cutoff), []),
    safeQuery("scoreTrend", () => queryScoreTrend(db), emptyScoreTrend),
    safeQuery("categoryCorrelations", () => queryCategoryCorrelations(db, cutoff, sectorMap), []),
    safeQuery("operatorOverrides", () => queryOperatorOverrides(db, cutoff, autoApproveThreshold), emptyOverrides),
    safeQuery("fetchEfficiency", () => queryFetchEfficiency(db), []),
    safeQuery("dedupChains", () => queryDedupChains(db, cutoff), emptyDedupStats),
    safeQuery("costStats", () => queryCostStats(db, cutoff), emptyCostStats),
    safeQuery("platformDelivery", () => queryPlatformDelivery(db, cutoff), emptyPlatformDelivery),
    safeQuery("alertEffectiveness", () => queryAlertEffectiveness(db, cutoff), []),
    safeQuery("keywordEffectiveness", () => queryKeywordEffectiveness(db, cutoff, sectorMap), []),
  ]);

  // ─── Assemble per-source stats ───────────────────────────────────────────

  const sources: SourceStats[] = [];
  let totalArticles = 0;
  let totalScored = 0;
  let totalRejected = 0;
  let totalDuplicates = 0;

  for (const [sourceId, info] of sourceMap) {
    const scores = sourceScores.get(sourceId);
    const rejections = sourceRejections.get(sourceId);
    const dedup = sourceDedup.get(sourceId);
    const trend = sourceTrend.get(sourceId);

    const scored = scores?.total ?? 0;
    const dist = scores?.scores ?? {};
    const highScoreCount = (dist["4"] ?? 0) + (dist["5"] ?? 0);
    const signalRatio = scored > 0 ? highScoreCount / scored : 0;
    const avgScore =
      scored > 0
        ? Object.entries(dist).reduce((sum, [s, c]) => sum + Number(s) * c, 0) / scored
        : 0;

    const rejectCount = rejections?.rejected ?? 0;
    const rejectTotal = rejections?.total ?? 0;
    const dedupCount = dedup?.duplicates ?? 0;
    const dedupTotal = dedup?.total ?? 0;

    totalArticles += dedupTotal;
    totalScored += scored;
    totalRejected += rejectCount;
    totalDuplicates += dedupCount;

    sources.push({
      source_id: sourceId,
      source_name: info.name,
      source_url: info.url,
      sector_id: info.sectorId,
      sector_name: info.sectorId ? sectorMap.get(info.sectorId) ?? null : null,
      active: info.active,
      ingest_interval_minutes: info.interval,
      total_articles: dedupTotal,
      total_scored: scored,
      signal_ratio: Math.round(signalRatio * 1000) / 10,
      avg_score: Math.round(avgScore * 100) / 100,
      score_distribution: dist,
      rejection_rate: rejectTotal > 0 ? Math.round((rejectCount / rejectTotal) * 1000) / 10 : 0,
      dedup_rate: dedupTotal > 0 ? Math.round((dedupCount / dedupTotal) * 1000) / 10 : 0,
      signal_ratio_current: Math.round((trend?.current ?? 0) * 1000) / 10,
      signal_ratio_previous: Math.round((trend?.previous ?? 0) * 1000) / 10,
    });
  }

  // ─── Assemble per-sector stats ───────────────────────────────────────────

  const sectorAgg = new Map<
    string,
    { total: number; scored: number; sum: number; high: number }
  >();
  for (const src of sources) {
    if (!src.sector_id) continue;
    if (!sectorAgg.has(src.sector_id)) {
      sectorAgg.set(src.sector_id, { total: 0, scored: 0, sum: 0, high: 0 });
    }
    const agg = sectorAgg.get(src.sector_id)!;
    agg.total += src.total_articles;
    agg.scored += src.total_scored;
    agg.sum += src.avg_score * src.total_scored;
    agg.high += Object.entries(src.score_distribution)
      .filter(([s]) => Number(s) >= 4)
      .reduce((sum, [, c]) => sum + c, 0);
  }

  const sectorStats: SectorStats[] = [];
  for (const [sectorId, agg] of sectorAgg) {
    const costEntry = costStats.cost_by_sector.find((c) => c.sector_id === sectorId);
    sectorStats.push({
      sector_id: sectorId,
      sector_name: sectorMap.get(sectorId) ?? "Unknown",
      total_articles: agg.total,
      total_scored: agg.scored,
      avg_score: agg.scored > 0 ? Math.round((agg.sum / agg.scored) * 100) / 100 : 0,
      signal_ratio:
        agg.scored > 0 ? Math.round((agg.high / agg.scored) * 1000) / 10 : 0,
      cost_microdollars: costEntry?.cost ?? 0,
      cost_per_useful_article:
        costEntry && costEntry.useful_articles > 0
          ? Math.round(costEntry.cost / costEntry.useful_articles)
          : 0,
    });
  }

  // ─── Assemble score distribution ─────────────────────────────────────────

  const globalScoreDist: Record<string, number> = {};
  for (const src of sources) {
    for (const [score, cnt] of Object.entries(src.score_distribution)) {
      globalScoreDist[score] = (globalScoreDist[score] ?? 0) + cnt;
    }
  }

  // ─── Assemble rejection breakdown ────────────────────────────────────────

  const [totalRejectedResult, preFilterResult, llmRejectResult] = await Promise.all([
    db
      .select({ cnt: count() })
      .from(articles)
      .where(and(eq(articles.pipelineStage, "rejected"), gte(articles.createdAt, cutoff))),
    db
      .select({ cnt: count() })
      .from(articles)
      .where(
        and(
          eq(articles.pipelineStage, "rejected"),
          gte(articles.createdAt, cutoff),
          sql`rejection_reason LIKE 'pre-filter:%'`,
        ),
      ),
    db
      .select({ cnt: count() })
      .from(articles)
      .where(
        and(
          eq(articles.pipelineStage, "rejected"),
          gte(articles.createdAt, cutoff),
          sql`rejection_reason LIKE 'llm-score:%'`,
        ),
      ),
  ]);

  const totalRej = totalRejectedResult[0]?.cnt ?? 0;
  const preFilter = preFilterResult[0]?.cnt ?? 0;
  const llmReject = llmRejectResult[0]?.cnt ?? 0;
  const manualReject = totalRej - preFilter - llmReject;

  const rejectionBreakdown: RejectionStats = {
    total_rejected: totalRej,
    pre_filter_count: preFilter,
    llm_reject_count: llmReject,
    manual_reject_count: manualReject > 0 ? manualReject : 0,
    keyword_hits: keywordHits,
  };

  // ─── Fill in names for operator overrides ────────────────────────────────

  for (const entry of operatorOverrides.by_sector) {
    entry.sector_name = sectorMap.get(entry.sector_id) ?? "Unknown";
  }
  for (const entry of operatorOverrides.by_source) {
    entry.source_name = sourceMap.get(entry.source_id)?.name ?? "Unknown";
  }

  // ─── Fill in names for fetch efficiency ──────────────────────────────────

  for (const entry of fetchEfficiency) {
    entry.source_name = sourceMap.get(entry.source_id)?.name ?? "Unknown";
  }

  // ─── Fill in names for cost stats ────────────────────────────────────────

  for (const entry of costStats.cost_by_sector) {
    entry.sector_name = sectorMap.get(entry.sector_id) ?? "Unknown";
  }

  // ─── Fill in names for dedup chains ──────────────────────────────────────

  for (const chain of dedupPatterns.chains) {
    chain.follower_source = sourceMap.get(chain.follower_source)?.name ?? chain.follower_source;
    chain.original_source = sourceMap.get(chain.original_source)?.name ?? chain.original_source;
  }

  const snapshot: AdvisorStatsSnapshot = {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    total_articles: totalArticles,
    total_scored: totalScored,
    total_rejected: totalRejected,
    total_duplicates: totalDuplicates,
    sources,
    sectors: sectorStats,
    rejection_breakdown: rejectionBreakdown,
    score_distribution: globalScoreDist,
    score_trend: scoreTrend,
    keyword_effectiveness: keywordEffectiveness,
    category_correlations: categoryCorrelations,
    dedup_patterns: dedupPatterns,
    cost_summary: costStats,
    operator_overrides: operatorOverrides,
    fetch_efficiency: fetchEfficiency,
    platform_delivery: platformDelivery,
    alert_effectiveness: alertEffectiveness,
  };

  logger.info(
    {
      totalArticles,
      totalScored,
      totalRejected,
      totalDuplicates,
      sourceCount: sources.length,
      sectorCount: sectorStats.length,
    },
    "[advisor-stats] stats collection complete",
  );

  return snapshot;
};
