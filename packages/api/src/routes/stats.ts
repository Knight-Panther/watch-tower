import type { FastifyInstance } from "fastify";
import { eq, and, gte, desc, count, inArray } from "drizzle-orm";
import { rssSources, articles, feedFetchRuns, sectors } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

const CACHE_KEY_OVERVIEW = "stats:overview";
const CACHE_KEY_SOURCES = "stats:sources";
const CACHE_TTL_SECONDS = 10;

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
      deps.db
        .select({ count: count() })
        .from(articles)
        .where(gte(articles.createdAt, cutoff)),
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
        .where(
          and(inArray(feedFetchRuns.sourceId, sourceIds), eq(feedFetchRuns.status, "success")),
        )
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
};
