import { Worker } from "bullmq";
import { eq, and, lt, gte, desc, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  JOB_INGEST_FETCH,
  JOB_DISTRIBUTION_IMMEDIATE,
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
  postDeliveries,
  llmTelemetry,
  articleImages,
} from "@watch-tower/db";
import { createTelegramProvider, type TelegramConfig } from "@watch-tower/social";
import type { Queue } from "bullmq";
import { ensureRepeatableJobs } from "../job-registry.js";

type MaintenanceDeps = {
  connection: { host: string; port: number };
  db: Database;
  ingestQueue: Queue;
  distributionQueue?: Queue;
  telegramConfig?: TelegramConfig;
  // Queues for self-healing job registration
  maintenanceQueue: Queue;
  semanticDedupQueue?: Queue;
  llmQueue?: Queue;
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
const resetZombieEmbeddingArticles = async (db: Database) => {
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

/**
 * Reset articles stuck in 'scoring' stage (from crashed workers).
 * Uses 10 min threshold since LLM calls are slower than embeddings.
 * Note: 'scoring_failed' articles are NOT auto-reset — they require manual investigation.
 */
const resetZombieScoringArticles = async (db: Database) => {
  const staleScoringThreshold = new Date(Date.now() - 10 * 60 * 1000);
  const resetResult = await db.execute(sql`
    UPDATE articles
    SET pipeline_stage = 'embedded'
    WHERE pipeline_stage = 'scoring'
      AND scored_at IS NULL
      AND created_at < ${staleScoringThreshold}
    RETURNING id
  `);
  if (resetResult.rows.length > 0) {
    logger.warn(`[maintenance] reset ${resetResult.rows.length} zombie scoring articles`);
  }
  return resetResult.rows.length;
};

/**
 * Reset all zombie articles (embedding + scoring stages)
 */
const resetZombieArticles = async (db: Database) => {
  await resetZombieEmbeddingArticles(db);
  await resetZombieScoringArticles(db);
};

/**
 * Reset deliveries stuck in 'posting' state (from crashed workers).
 * Uses 5 min threshold.
 */
const resetZombieDeliveries = async (db: Database) => {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const resetResult = await db.execute(sql`
    UPDATE post_deliveries
    SET status = 'scheduled'
    WHERE status = 'posting'
      AND created_at < ${staleThreshold}
    RETURNING id
  `);
  if (resetResult.rows.length > 0) {
    logger.warn(`[maintenance] reset ${resetResult.rows.length} zombie deliveries`);
  }
  return resetResult.rows.length;
};

/**
 * Rescue orphaned articles stuck in 'approved' state.
 *
 * This handles the case where llm-brain marks article as 'approved' in DB
 * but Redis queue.add() fails, leaving the article orphaned (never posted).
 *
 * Re-queues approved articles older than 5 minutes to the distribution queue.
 * The distribution worker uses atomic claims, so duplicates are safe.
 */
const rescueOrphanedApprovedArticles = async (db: Database, distributionQueue?: Queue) => {
  if (!distributionQueue) return 0;

  // Find approved articles that haven't progressed in 5 minutes
  // These are likely orphaned due to Redis queue failure
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const orphanedResult = await db.execute(sql`
    SELECT id FROM articles
    WHERE pipeline_stage = 'approved'
      AND approved_at IS NOT NULL
      AND approved_at < ${staleThreshold}
    LIMIT 20
  `);

  const orphaned = orphanedResult.rows as { id: string }[];
  if (orphaned.length === 0) return 0;

  // Re-queue each orphaned article
  let requeued = 0;
  for (const article of orphaned) {
    try {
      await distributionQueue.add(
        JOB_DISTRIBUTION_IMMEDIATE,
        { articleId: article.id },
        { jobId: `rescue-${article.id}-${Date.now()}` }, // Unique jobId to avoid dedup
      );
      requeued++;
    } catch (err) {
      logger.error(`[maintenance] failed to re-queue orphaned article ${article.id}`, err);
    }
  }

  if (requeued > 0) {
    logger.warn(`[maintenance] rescued ${requeued} orphaned approved articles`);
  }
  return requeued;
};

type ArticleForPost = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  sectorName: string | null;
};

type ClaimedDelivery = {
  id: string;
  articleId: string;
  platform: string;
};

/**
 * Process scheduled posts that are due.
 * Claims posts atomically and posts to configured platforms.
 */
const processScheduledPosts = async (db: Database, telegramConfig?: TelegramConfig) => {
  if (!telegramConfig) {
    return; // No telegram configured, skip
  }

  // 1. ATOMIC CLAIM: Get due posts and mark as 'posting'
  const claimResult = await db.execute(sql`
    UPDATE post_deliveries
    SET status = 'posting'
    WHERE id IN (
      SELECT id FROM post_deliveries
      WHERE scheduled_at <= NOW()
        AND status = 'scheduled'
      ORDER BY scheduled_at
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, article_id as "articleId", platform
  `);

  const claimed = claimResult.rows as ClaimedDelivery[];
  if (claimed.length === 0) {
    return;
  }

  logger.info(`[post-scheduler] claimed ${claimed.length} due posts`);

  // Create telegram provider
  const telegram = createTelegramProvider(telegramConfig);

  // 2. Process each claimed delivery
  for (const delivery of claimed) {
    try {
      // Only support telegram for now
      if (delivery.platform !== "telegram") {
        logger.warn(`[post-scheduler] unsupported platform: ${delivery.platform}`);
        await db
          .update(postDeliveries)
          .set({ status: "failed", errorMessage: `Unsupported platform: ${delivery.platform}` })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Fetch article data
      const articleResult = await db.execute(sql`
        SELECT
          a.id,
          a.title,
          a.url,
          a.llm_summary as "llmSummary",
          a.importance_score as "importanceScore",
          s.name as "sectorName"
        FROM articles a
        LEFT JOIN sectors s ON a.sector_id = s.id
        WHERE a.id = ${delivery.articleId}::uuid
      `);

      const article = articleResult.rows[0] as ArticleForPost | undefined;
      if (!article) {
        logger.error(`[post-scheduler] article not found: ${delivery.articleId}`);
        await db
          .update(postDeliveries)
          .set({ status: "failed", errorMessage: "Article not found" })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Format and post
      const text = telegram.formatSinglePost({
        title: article.title,
        summary: article.llmSummary || article.title,
        url: article.url,
        sector: article.sectorName || "News",
      });

      const postResult = await telegram.post({ text });

      if (!postResult.success) {
        logger.error(
          { deliveryId: delivery.id, error: postResult.error },
          "[post-scheduler] telegram post failed",
        );
        await db
          .update(postDeliveries)
          .set({ status: "failed", errorMessage: postResult.error })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Success: update delivery and article
      await db
        .update(postDeliveries)
        .set({
          status: "posted",
          sentAt: new Date(),
          platformPostId: postResult.postId,
        })
        .where(eq(postDeliveries.id, delivery.id));

      await db
        .update(articles)
        .set({ pipelineStage: "posted" })
        .where(eq(articles.id, delivery.articleId));

      logger.info(
        { deliveryId: delivery.id, articleId: delivery.articleId, postId: postResult.postId },
        "[post-scheduler] posted to telegram",
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`[post-scheduler] error processing delivery ${delivery.id}: ${errorMsg}`);
      await db
        .update(postDeliveries)
        .set({ status: "failed", errorMessage: errorMsg })
        .where(eq(postDeliveries.id, delivery.id));
    }
  }
};

export const createMaintenanceWorker = ({
  connection,
  db,
  ingestQueue,
  distributionQueue,
  telegramConfig,
  maintenanceQueue,
  semanticDedupQueue,
  llmQueue,
}: MaintenanceDeps) =>
  new Worker(
    QUEUE_MAINTENANCE,
    async (job) => {
      if (job.name === JOB_MAINTENANCE_CLEANUP) {
        const errors: string[] = [];

        // Articles cleanup
        try {
          const ttlDays = await getConfigNumber(db, "feed_items_ttl_days", 60);
          const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
          await db.delete(articles).where(lt(articles.createdAt, cutoff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] articles cleanup failed: ${msg}`);
          errors.push("articles");
        }

        // Feed fetch runs cleanup
        try {
          const runsTtlHours = await getConfigNumber(db, "feed_fetch_runs_ttl_hours", 336);
          const runsCutoff = new Date(Date.now() - runsTtlHours * 60 * 60 * 1000);
          await db.delete(feedFetchRuns).where(lt(feedFetchRuns.createdAt, runsCutoff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] feed_fetch_runs cleanup failed: ${msg}`);
          errors.push("feed_fetch_runs");
        }

        // LLM telemetry cleanup
        try {
          const llmTelemetryTtlDays = await getConfigNumber(db, "llm_telemetry_ttl_days", 30);
          const llmCutoff = new Date(Date.now() - llmTelemetryTtlDays * 24 * 60 * 60 * 1000);
          await db.delete(llmTelemetry).where(lt(llmTelemetry.createdAt, llmCutoff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] llm_telemetry cleanup failed: ${msg}`);
          errors.push("llm_telemetry");
        }

        // Article images cleanup
        try {
          const articleImagesTtlDays = await getConfigNumber(db, "article_images_ttl_days", 30);
          const imagesCutoff = new Date(Date.now() - articleImagesTtlDays * 24 * 60 * 60 * 1000);
          await db.delete(articleImages).where(lt(articleImages.createdAt, imagesCutoff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] article_images cleanup failed: ${msg}`);
          errors.push("article_images");
        }

        // Post deliveries cleanup (only completed/failed/cancelled, NOT scheduled/posting)
        try {
          const postDeliveriesTtlDays = await getConfigNumber(db, "post_deliveries_ttl_days", 30);
          const deliveriesCutoff = new Date(
            Date.now() - postDeliveriesTtlDays * 24 * 60 * 60 * 1000,
          );
          await db
            .delete(postDeliveries)
            .where(
              and(
                lt(postDeliveries.createdAt, deliveriesCutoff),
                inArray(postDeliveries.status, ["posted", "failed", "cancelled"]),
              ),
            );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] post_deliveries cleanup failed: ${msg}`);
          errors.push("post_deliveries");
        }

        // Also run zombie cleanup during daily maintenance
        await resetZombieArticles(db);

        if (errors.length > 0) {
          logger.warn(`[maintenance] cleanup completed with errors in: ${errors.join(", ")}`);
        } else {
          logger.info("[maintenance] cleanup complete");
        }
        return;
      }

      if (job.name === JOB_MAINTENANCE_SCHEDULE) {
        // Self-heal: ensure repeatable jobs exist (survives Redis wipe/restart)
        await ensureRepeatableJobs({
          maintenanceQueue,
          semanticDedupQueue,
          llmQueue,
        });

        // Run zombie cleanup on every scheduler tick (every 30s) for fast recovery
        await resetZombieArticles(db);
        await resetZombieDeliveries(db);
        // Rescue orphaned approved articles (Redis queue failure recovery)
        await rescueOrphanedApprovedArticles(db, distributionQueue);
        await runScheduledIngests(db, ingestQueue);
        // Process any scheduled posts that are due
        await processScheduledPosts(db, telegramConfig);
        return;
      }
    },
    { connection },
  );
