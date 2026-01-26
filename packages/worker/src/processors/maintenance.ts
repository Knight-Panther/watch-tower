import { Worker } from "bullmq";
import { eq, and, lt, gte, desc, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  JOB_INGEST_FETCH,
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  QUEUE_MAINTENANCE,
  logger,
} from "@watch-tower/shared";
import {
  type Database,
  articles,
  feedFetchRuns,
  appConfig,
  rssSources,
  sectors,
} from "@watch-tower/db";
import type { Queue } from "bullmq";

type MaintenanceDeps = {
  connection: { host: string; port: number };
  db: Database;
  ingestQueue: Queue;
};

const getConfigNumber = async (db: Database, key: string, fallback: number) => {
  const [row] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  if (!row) return fallback;
  const num = Number(row.value);
  return Number.isNaN(num) ? fallback : num;
};

const runScheduledIngests = async (db: Database, ingestQueue: Queue) => {
  const sources = await db
    .select({
      id: rssSources.id,
      url: rssSources.url,
      sectorId: rssSources.sectorId,
      ingestIntervalMinutes: rssSources.ingestIntervalMinutes,
      maxAgeDays: rssSources.maxAgeDays,
      sectorDefaultMaxAge: sectors.defaultMaxAgeDays,
    })
    .from(rssSources)
    .leftJoin(sectors, eq(rssSources.sectorId, sectors.id))
    .where(eq(rssSources.active, true));

  if (sources.length === 0) return;

  // Get latest run for each source, bounded to last 7 days
  const sourceIds = sources.map((s) => s.id);
  const lookbackCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const runs = await db
    .select({
      sourceId: feedFetchRuns.sourceId,
      finishedAt: feedFetchRuns.finishedAt,
      createdAt: feedFetchRuns.createdAt,
    })
    .from(feedFetchRuns)
    .where(
      and(inArray(feedFetchRuns.sourceId, sourceIds), gte(feedFetchRuns.createdAt, lookbackCutoff)),
    )
    .orderBy(desc(feedFetchRuns.createdAt));

  const lastRunBySource = new Map<string, number>();
  for (const run of runs) {
    if (run.sourceId && !lastRunBySource.has(run.sourceId)) {
      const ts = (run.finishedAt ?? run.createdAt).getTime();
      lastRunBySource.set(run.sourceId, ts);
    }
  }

  const now = Date.now();
  const TOLERANCE_MS = 15_000; // 15s tolerance to account for scheduler granularity
  let fired = 0;

  for (const source of sources) {
    const intervalMinutes = source.ingestIntervalMinutes;
    if (!intervalMinutes || intervalMinutes <= 0) continue;

    const intervalMs = Math.min(4320, Math.max(1, intervalMinutes)) * 60 * 1000;
    const lastRun = lastRunBySource.get(source.id);
    const elapsed = lastRun ? now - lastRun : Infinity;
    const isDue = !lastRun || elapsed >= intervalMs - TOLERANCE_MS;

    logger.debug(
      `[scheduler] ${source.id.slice(0, 8)}: interval=${intervalMinutes}m, elapsed=${Math.round(elapsed / 1000)}s, due=${isDue}`,
    );

    if (!isDue) continue;

    const maxAgeDays = Math.min(15, Math.max(1, source.maxAgeDays ?? source.sectorDefaultMaxAge ?? 5));

    // Time bucket prevents duplicate jobs within same interval window
    const timeBucket = Math.floor(now / intervalMs);
    await ingestQueue.add(
      JOB_INGEST_FETCH,
      {
        sourceId: source.id,
        url: source.url,
        sectorId: source.sectorId,
        maxAgeDays,
      },
      { jobId: `ingest-${source.id}-${timeBucket}` },
    );

    fired++;
  }

  if (fired > 0) {
    logger.info(`[scheduler] fired ${fired} ingest jobs`);
  }
};

/**
 * Reset articles stuck in 'embedding' stage (from crashed workers).
 * Uses created_at with 10 min threshold since we don't have updated_at.
 */
const resetZombieArticles = async (db: Database) => {
  const staleEmbeddingThreshold = new Date(Date.now() - 10 * 60 * 1000);
  const resetResult = await db.execute(sql`
    UPDATE articles
    SET pipeline_stage = 'ingested'
    WHERE pipeline_stage = 'embedding'
      AND created_at < ${staleEmbeddingThreshold}
    RETURNING id
  `);
  if (resetResult.rows.length > 0) {
    logger.warn(`[maintenance] reset ${resetResult.rows.length} zombie embedding articles`);
  }
  return resetResult.rows.length;
};

export const createMaintenanceWorker = ({ connection, db, ingestQueue }: MaintenanceDeps) =>
  new Worker(
    QUEUE_MAINTENANCE,
    async (job) => {
      if (job.name === JOB_MAINTENANCE_CLEANUP) {
        const ttlDays = await getConfigNumber(db, "feed_items_ttl_days", 60);
        const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
        await db.delete(articles).where(lt(articles.createdAt, cutoff));

        const runsTtlHours = await getConfigNumber(db, "feed_fetch_runs_ttl_hours", 336);
        const runsCutoff = new Date(Date.now() - runsTtlHours * 60 * 60 * 1000);
        await db.delete(feedFetchRuns).where(lt(feedFetchRuns.createdAt, runsCutoff));

        // Also run zombie cleanup during daily maintenance
        await resetZombieArticles(db);

        logger.info("[maintenance] cleanup complete");
        return;
      }

      if (job.name === JOB_MAINTENANCE_SCHEDULE) {
        // Run zombie cleanup on every scheduler tick (every 30s) for fast recovery
        await resetZombieArticles(db);
        await runScheduledIngests(db, ingestQueue);
        return;
      }
    },
    { connection },
  );
