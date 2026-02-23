import type { FastifyInstance } from "fastify";
import { eq, and, gte, desc, count, inArray, isNotNull, sql } from "drizzle-orm";
import { rssSources, articles, feedFetchRuns, sectors } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

const CACHE_KEY_OVERVIEW = "stats:overview";
const CACHE_KEY_SOURCES = "stats:sources";
const CACHE_KEY_SOURCE_QUALITY = "stats:source-quality";
const CACHE_KEY_ANALYTICS = "stats:analytics";
const CACHE_TTL_SECONDS = 10;
const ANALYTICS_CACHE_TTL = 10;

export const registerStatsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/stats/overview", { preHandler: deps.requireApiKey }, async () => {
    // Check cache first
    const cached = await deps.redis.get(CACHE_KEY_OVERVIEW);
    if (cached) {
      return JSON.parse(cached);
    }

    const now = Date.now();
    const cutoff = new Date(now - 24 * 60 * 60 * 1000);

    const [totalRes, activeRes, itemsRes] = await Promise.all([
      deps.db.select({ count: count() }).from(rssSources),
      deps.db.select({ count: count() }).from(rssSources).where(eq(rssSources.active, true)),
      deps.db.select({ count: count() }).from(articles).where(gte(articles.createdAt, cutoff)),
    ]);

    // Get active sources with their intervals
    const activeSources = await deps.db
      .select({
        id: rssSources.id,
        ingestIntervalMinutes: rssSources.ingestIntervalMinutes,
      })
      .from(rssSources)
      .where(eq(rssSources.active, true));

    const sourceIds = activeSources.map((s) => s.id);

    // Get latest successful runs per source
    type RunRow = { sourceId: string | null; finishedAt: Date | null; createdAt: Date };
    const latestSuccessBySource = new Map<string, RunRow>();

    if (sourceIds.length > 0) {
      const runs = await deps.db
        .select({
          sourceId: feedFetchRuns.sourceId,
          finishedAt: feedFetchRuns.finishedAt,
          createdAt: feedFetchRuns.createdAt,
        })
        .from(feedFetchRuns)
        .where(and(inArray(feedFetchRuns.sourceId, sourceIds), eq(feedFetchRuns.status, "success")))
        .orderBy(desc(feedFetchRuns.createdAt));

      for (const run of runs) {
        if (run.sourceId && !latestSuccessBySource.has(run.sourceId)) {
          latestSuccessBySource.set(run.sourceId, run);
        }
      }
    }

    let staleSources = 0;
    for (const source of activeSources) {
      const interval = source.ingestIntervalMinutes;
      if (!interval) {
        staleSources++;
        continue;
      }
      const lastSuccess = latestSuccessBySource.get(source.id);
      if (!lastSuccess) {
        staleSources++;
        continue;
      }
      const lastAt = (lastSuccess.finishedAt ?? lastSuccess.createdAt).getTime();
      if (now > lastAt + interval * 2 * 60 * 1000) {
        staleSources++;
      }
    }

    const ingestQueueCounts = await deps.ingestQueue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
    );

    const result = {
      total_sources: totalRes[0]?.count ?? 0,
      active_sources: activeRes[0]?.count ?? 0,
      items_last_24h: itemsRes[0]?.count ?? 0,
      stale_sources: staleSources,
      queues: {
        feed: ingestQueueCounts,
      },
    };

    // Cache result
    await deps.redis.setex(CACHE_KEY_OVERVIEW, CACHE_TTL_SECONDS, JSON.stringify(result));
    return result;
  });

  app.get("/stats/sources", { preHandler: deps.requireApiKey }, async () => {
    // Check cache first
    const cached = await deps.redis.get(CACHE_KEY_SOURCES);
    if (cached) {
      return JSON.parse(cached);
    }

    const sources = await deps.db
      .select({
        id: rssSources.id,
        url: rssSources.url,
        name: rssSources.name,
        active: rssSources.active,
        sectorId: rssSources.sectorId,
        ingestIntervalMinutes: rssSources.ingestIntervalMinutes,
        sector: {
          id: sectors.id,
          name: sectors.name,
          slug: sectors.slug,
        },
      })
      .from(rssSources)
      .leftJoin(sectors, eq(rssSources.sectorId, sectors.id))
      .orderBy(desc(rssSources.createdAt));

    const sourceIds = sources.map((s) => s.id);

    type RunRow = {
      sourceId: string | null;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      durationMs: number | null;
      itemCount: number | null;
      itemAdded: number | null;
      errorMessage: string | null;
      createdAt: Date;
    };
    const latestRunBySource = new Map<string, RunRow>();
    const latestSuccessBySource = new Map<string, RunRow>();

    if (sourceIds.length > 0) {
      const runs = await deps.db
        .select({
          sourceId: feedFetchRuns.sourceId,
          status: feedFetchRuns.status,
          startedAt: feedFetchRuns.startedAt,
          finishedAt: feedFetchRuns.finishedAt,
          durationMs: feedFetchRuns.durationMs,
          itemCount: feedFetchRuns.itemCount,
          itemAdded: feedFetchRuns.itemAdded,
          errorMessage: feedFetchRuns.errorMessage,
          createdAt: feedFetchRuns.createdAt,
        })
        .from(feedFetchRuns)
        .where(inArray(feedFetchRuns.sourceId, sourceIds))
        .orderBy(desc(feedFetchRuns.createdAt));

      for (const run of runs) {
        if (!run.sourceId) continue;
        if (!latestRunBySource.has(run.sourceId)) {
          latestRunBySource.set(run.sourceId, run);
        }
        if (run.status === "success" && !latestSuccessBySource.has(run.sourceId)) {
          latestSuccessBySource.set(run.sourceId, run);
        }
      }
    }

    const now = Date.now();
    const result = sources.map((source) => {
      const latestRun = latestRunBySource.get(source.id) ?? null;
      const latestSuccess = latestSuccessBySource.get(source.id) ?? null;
      const intervalMinutes = source.ingestIntervalMinutes;
      const lastSuccessAt = latestSuccess
        ? (latestSuccess.finishedAt ?? latestSuccess.createdAt)
        : null;

      let isStale = false;
      if (source.active) {
        if (!intervalMinutes || !lastSuccessAt) {
          isStale = true;
        } else {
          isStale = now > lastSuccessAt.getTime() + intervalMinutes * 2 * 60 * 1000;
        }
      }

      return {
        id: source.id,
        name: source.name,
        url: source.url,
        active: source.active,
        sector: source.sector?.id ? source.sector : null,
        expected_interval_minutes: intervalMinutes,
        last_success_at: lastSuccessAt?.toISOString() ?? null,
        last_run: latestRun
          ? {
              status: latestRun.status,
              started_at: latestRun.startedAt.toISOString(),
              finished_at: latestRun.finishedAt?.toISOString() ?? null,
              duration_ms: latestRun.durationMs,
              item_count: latestRun.itemCount,
              item_added: latestRun.itemAdded,
              error_message: latestRun.errorMessage,
            }
          : null,
        is_stale: isStale,
      };
    });

    // Cache result
    await deps.redis.setex(CACHE_KEY_SOURCES, CACHE_TTL_SECONDS, JSON.stringify(result));
    return result;
  });

  app.get("/stats/source-quality", { preHandler: deps.requireApiKey }, async () => {
    const cached = await deps.redis.get(CACHE_KEY_SOURCE_QUALITY);
    if (cached) return JSON.parse(cached);

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Score distribution per source over last 30 days
    const rows = await deps.db
      .select({
        sourceId: articles.sourceId,
        score: articles.importanceScore,
        cnt: count(),
      })
      .from(articles)
      .where(
        and(
          isNotNull(articles.importanceScore),
          isNotNull(articles.sourceId),
          gte(articles.scoredAt, cutoff),
        ),
      )
      .groupBy(articles.sourceId, articles.importanceScore);

    // Aggregate per source
    const bySource = new Map<
      string,
      { dist: Record<number, number>; total: number; sum: number; signal: number }
    >();

    for (const row of rows) {
      if (!row.sourceId || row.score == null) continue;
      let entry = bySource.get(row.sourceId);
      if (!entry) {
        entry = { dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, total: 0, sum: 0, signal: 0 };
        bySource.set(row.sourceId, entry);
      }
      const c = Number(row.cnt);
      entry.dist[row.score] = c;
      entry.total += c;
      entry.sum += row.score * c;
      if (row.score >= 4) entry.signal += c;
    }

    const result: Record<
      string,
      {
        distribution: Record<number, number>;
        total: number;
        avg_score: number;
        signal_ratio: number;
      }
    > = {};

    for (const [sourceId, entry] of bySource) {
      result[sourceId] = {
        distribution: entry.dist,
        total: entry.total,
        avg_score: Math.round((entry.sum / entry.total) * 100) / 100,
        signal_ratio: Math.round((entry.signal / entry.total) * 100),
      };
    }

    await deps.redis.setex(
      CACHE_KEY_SOURCE_QUALITY,
      CACHE_TTL_SECONDS,
      JSON.stringify(result),
    );
    return result;
  });

  // ─── Analytics (P7 Feedback Loop) ──────────────────────────────────────────

  app.get("/stats/analytics", { preHandler: deps.requireApiKey }, async () => {
    const cached = await deps.redis.get(CACHE_KEY_ANALYTICS);
    if (cached) return JSON.parse(cached);

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // 1. Score distribution (count per score 1-5)
    const scoreDistRows = await deps.db
      .select({
        score: articles.importanceScore,
        cnt: count(),
      })
      .from(articles)
      .where(and(isNotNull(articles.importanceScore), gte(articles.scoredAt, cutoff)))
      .groupBy(articles.importanceScore);

    const scoreDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of scoreDistRows) {
      if (r.score != null) scoreDistribution[r.score] = Number(r.cnt);
    }

    // 2. Approval rate by score level
    const approvalRows = await deps.db.execute(sql`
      SELECT
        importance_score as score,
        pipeline_stage as stage,
        COUNT(*)::int as cnt
      FROM articles
      WHERE importance_score IS NOT NULL
        AND scored_at >= ${cutoff}
        AND pipeline_stage IN ('approved', 'rejected', 'posted', 'scored')
      GROUP BY importance_score, pipeline_stage
      ORDER BY importance_score
    `);

    // 3. Rejection breakdown
    const rejectionRows = await deps.db.execute(sql`
      SELECT
        CASE
          WHEN rejection_reason LIKE 'pre-filter:%' THEN 'pre-filter'
          WHEN rejection_reason LIKE 'llm-score:%' THEN 'llm-score'
          WHEN rejection_reason = 'manual' THEN 'manual'
          ELSE 'other'
        END as rejection_type,
        COUNT(*)::int as cnt
      FROM articles
      WHERE pipeline_stage = 'rejected'
        AND rejection_reason IS NOT NULL
        AND created_at >= ${cutoff}
      GROUP BY 1
    `);

    // 4. Source value ranking (min 3 articles, top 20)
    const sourceRankRows = await deps.db.execute(sql`
      SELECT
        a.source_id,
        s.name as source_name,
        COUNT(*)::int as total_scored,
        ROUND(AVG(a.importance_score)::numeric, 2)::float as avg_score,
        ROUND(
          COUNT(*) FILTER (WHERE a.pipeline_stage IN ('approved', 'posted'))::numeric /
          NULLIF(COUNT(*), 0) * 100, 0
        )::int as approved_pct,
        ROUND(
          COUNT(*) FILTER (WHERE a.importance_score >= 4)::numeric /
          NULLIF(COUNT(*), 0) * 100, 0
        )::int as signal_ratio
      FROM articles a
      LEFT JOIN rss_sources s ON a.source_id = s.id
      WHERE a.importance_score IS NOT NULL
        AND a.scored_at >= ${cutoff}
        AND a.source_id IS NOT NULL
      GROUP BY a.source_id, s.name
      HAVING COUNT(*) >= 3
      ORDER BY signal_ratio DESC
      LIMIT 20
    `);

    // 5. Sector performance
    const sectorRows = await deps.db.execute(sql`
      SELECT
        a.sector_id,
        sec.name as sector_name,
        COUNT(*)::int as total,
        ROUND(AVG(a.importance_score)::numeric, 2)::float as avg_score,
        ROUND(
          COUNT(*) FILTER (WHERE a.pipeline_stage IN ('approved', 'posted'))::numeric /
          NULLIF(COUNT(*), 0) * 100, 0
        )::int as approved_pct,
        COUNT(*) FILTER (WHERE a.importance_score >= 4)::int as signal_count
      FROM articles a
      LEFT JOIN sectors sec ON a.sector_id = sec.id
      WHERE a.importance_score IS NOT NULL
        AND a.scored_at >= ${cutoff}
        AND a.sector_id IS NOT NULL
      GROUP BY a.sector_id, sec.name
      ORDER BY avg_score DESC
    `);

    const result = {
      period_days: 30,
      score_distribution: scoreDistribution,
      approval_by_score: (approvalRows as { rows: unknown[] }).rows ?? approvalRows,
      rejection_breakdown: (rejectionRows as { rows: unknown[] }).rows ?? rejectionRows,
      source_ranking: (sourceRankRows as { rows: unknown[] }).rows ?? sourceRankRows,
      sector_performance: (sectorRows as { rows: unknown[] }).rows ?? sectorRows,
    };

    await deps.redis.setex(CACHE_KEY_ANALYTICS, ANALYTICS_CACHE_TTL, JSON.stringify(result));
    return result;
  });
};
