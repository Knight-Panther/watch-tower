import { Worker } from "bullmq";
import { eq, and, lt, gte, desc, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  JOB_INGEST_FETCH,
  JOB_DISTRIBUTION_IMMEDIATE,
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  JOB_PLATFORM_HEALTH_CHECK,
  JOB_DAILY_DIGEST,
  QUEUE_MAINTENANCE,
  logger,
  getDefaultTemplate,
  type PostTemplateConfig,
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
  digestRuns,
  digestSlots,
  digestDrafts,
  alertDeliveries,
} from "@watch-tower/db";
import {
  createTelegramProvider,
  createFacebookProvider,
  createLinkedInProvider,
  type TelegramConfig,
  type FacebookConfig,
  type LinkedInConfig,
  type SocialProvider,
} from "@watch-tower/social";
import type { Queue } from "bullmq";
import { ensureRepeatableJobs } from "../job-registry.js";
import type { RateLimiter } from "../utils/rate-limiter.js";
import type { EventPublisher } from "../events.js";
import type { R2Storage } from "../services/r2-storage.js";
import {
  hashToken,
  upsertPlatformHealth,
  isPlatformHealthy,
  updateLastPostAt,
} from "../utils/platform-health.js";
import { compileAndSendDigest } from "./digest.js";

type MaintenanceDeps = {
  connection: { host: string; port: number };
  db: Database;
  ingestQueue: Queue;
  distributionQueue?: Queue;
  telegramConfig?: TelegramConfig;
  facebookConfig?: FacebookConfig;
  linkedinConfig?: LinkedInConfig;
  // Queues for self-healing job registration
  maintenanceQueue: Queue;
  semanticDedupQueue?: Queue;
  llmQueue?: Queue;
  rateLimiter: RateLimiter;
  eventPublisher?: EventPublisher;
  r2Storage?: R2Storage;
  apiKeys: { anthropic?: string; openai?: string; deepseek?: string; googleAi?: string };
};

const getConfigBoolean = async (db: Database, key: string, fallback: boolean) => {
  const [row] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  if (!row) return fallback;
  return row.value === true || row.value === "true";
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

/**
 * Check which digest slots are due to fire right now.
 * Returns array of slot IDs that should trigger a digest.
 * Uses Intl.DateTimeFormat for timezone handling (supports DST automatically).
 */
const checkDigestSlotsDue = async (db: Database): Promise<string[]> => {
  const slots = await db.select().from(digestSlots).where(eq(digestSlots.enabled, true));

  if (slots.length === 0) return [];

  const now = new Date();
  const dueSlotIds: string[] = [];
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  for (const slot of slots) {
    const timezone = slot.timezone || "UTC";
    const days: number[] = Array.isArray(slot.days)
      ? (slot.days as number[])
      : [1, 2, 3, 4, 5, 6, 7];

    // Get current time in slot's timezone
    let currentTime: string;
    try {
      currentTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
    } catch {
      logger.warn({ timezone, slotId: slot.id }, "[digest] invalid timezone, using UTC");
      currentTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
    }

    // Get day-of-week in slot's timezone (ISO: 1=Mon...7=Sun)
    const dayStr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    }).format(now);
    const isoDay = dayMap[dayStr] ?? 0;
    if (!days.includes(isoDay)) continue;

    // Check time match: fire at target or up to 2 minutes AFTER (forward-only)
    const [targetH, targetM] = slot.time.split(":").map(Number);
    const [currentH, currentM] = currentTime.split(":").map(Number);
    const targetMinutes = targetH * 60 + targetM;
    const currentMinutes = currentH * 60 + currentM;
    const forwardDiff = (currentMinutes - targetMinutes + 1440) % 1440;
    if (forwardDiff > 2) continue;

    // Per-slot idempotency: skip if last run for this slot was within 5 minutes
    // (prevents 30s scheduler loop from triple-firing, but allows re-scheduling)
    const [lastRun] = await db
      .select({ sentAt: digestRuns.sentAt })
      .from(digestRuns)
      .where(and(eq(digestRuns.slotId, slot.id), eq(digestRuns.isTest, false)))
      .orderBy(desc(digestRuns.sentAt))
      .limit(1);

    if (lastRun?.sentAt) {
      const elapsed = Date.now() - lastRun.sentAt.getTime();
      if (elapsed < 5 * 60 * 1000) continue;
    }

    // For manual slots: skip if there's already a pending draft
    if (!slot.autoPost) {
      const [pendingDraft] = await db
        .select({ id: digestDrafts.id })
        .from(digestDrafts)
        .where(and(eq(digestDrafts.slotId, slot.id), eq(digestDrafts.status, "draft")))
        .limit(1);
      if (pendingDraft) continue;
    }

    dueSlotIds.push(slot.id);
  }

  return dueSlotIds;
};

const runScheduledIngests = async (db: Database, ingestQueue: Queue, force = false) => {
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
    const isDue = force || !lastRun || elapsed >= intervalMs - TOLERANCE_MS;

    logger.debug(
      `[scheduler] ${source.id.slice(0, 8)}: interval=${intervalMinutes}m, elapsed=${Math.round(elapsed / 1000)}s, due=${isDue}`,
    );

    if (!isDue) continue;

    const maxAgeDays = Math.min(
      15,
      Math.max(1, source.maxAgeDays ?? source.sectorDefaultMaxAge ?? 5),
    );

    // Time bucket prevents duplicate jobs within same interval window.
    // Force runs use timestamp-based ID to bypass dedup.
    const jobId = force
      ? `ingest-${source.id}-force-${now}`
      : `ingest-${source.id}-${Math.floor(now / intervalMs)}`;
    await ingestQueue.add(
      JOB_INGEST_FETCH,
      {
        sourceId: source.id,
        url: source.url,
        sectorId: source.sectorId,
        maxAgeDays,
      },
      { jobId },
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
 * Reset articles stuck in 'translating' state (translation_status only).
 * Does NOT touch pipeline_stage — translation is decoupled.
 * Uses 10 min threshold for stuck translations.
 */
const resetZombieTranslations = async (db: Database) => {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);

  // Reset stuck 'translating' → NULL (allows re-claim)
  // Uses translated_at (set to NOW() during claim) instead of created_at,
  // so old articles that were just claimed are not incorrectly reset.
  const translatingResult = await db.execute(sql`
    UPDATE articles
    SET translation_status = NULL
    WHERE translation_status = 'translating'
      AND (translated_at < ${staleThreshold} OR translated_at IS NULL)
    RETURNING id
  `);
  if (translatingResult.rows.length > 0) {
    logger.warn(`[maintenance] reset ${translatingResult.rows.length} zombie translating articles`);
  }

  // Reset 'failed' → NULL after 10 minutes (allows retry)
  // Safe because translation_attempts cap prevents infinite retries
  // NOTE: 'exhausted' translations are NOT reset — they hit max attempts
  const translationRetryMinutes = await getConfigNumber(db, "translation_retry_minutes", 10);
  const failedThreshold = new Date(Date.now() - translationRetryMinutes * 60 * 1000);
  const failedResult = await db.execute(sql`
    UPDATE articles
    SET translation_status = NULL
    WHERE translation_status = 'failed'
      AND (translated_at < ${failedThreshold} OR translated_at IS NULL)
    RETURNING id
  `);
  if (failedResult.rows.length > 0) {
    logger.warn(`[maintenance] reset ${failedResult.rows.length} failed translations for retry`);
  }
};

/**
 * Reset articles stuck in 'posting' stage (from crashed distribution workers).
 * Uses 5 min threshold. Rolls back to 'approved' so they can be re-queued.
 */
const resetZombiePostingArticles = async (db: Database) => {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const resetResult = await db.execute(sql`
    UPDATE articles
    SET pipeline_stage = 'approved'
    WHERE pipeline_stage = 'posting'
      AND created_at < ${staleThreshold}
    RETURNING id
  `);
  if (resetResult.rows.length > 0) {
    logger.warn(
      `[maintenance] reset ${resetResult.rows.length} zombie posting articles back to approved`,
    );
  }
  return resetResult.rows.length;
};

/**
 * Reset all zombie articles (embedding + scoring + translation + posting stages)
 */
const resetZombieArticles = async (db: Database) => {
  await resetZombieEmbeddingArticles(db);
  await resetZombieScoringArticles(db);
  await resetZombieTranslations(db);
  await resetZombiePostingArticles(db);
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

  // Check posting language once
  const [langRow] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "posting_language"));
  const postingLanguage = (langRow?.value as string) ?? "en";

  // Find approved articles that haven't progressed in 10 minutes
  // These are likely orphaned due to Redis queue failure
  // In Georgian mode, only rescue articles that have been translated
  // Skip articles that have ANY recent delivery (scheduled, posting, posted, failed)
  // — only truly orphaned articles have ZERO deliveries
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
  const orphanedResult =
    postingLanguage === "ka"
      ? await db.execute(sql`
          SELECT id FROM articles
          WHERE pipeline_stage = 'approved'
            AND approved_at IS NOT NULL
            AND approved_at < ${staleThreshold}
            AND title_ka IS NOT NULL
            AND llm_summary_ka IS NOT NULL
            AND id NOT IN (
              SELECT article_id FROM post_deliveries
              WHERE status NOT IN ('cancelled')
            )
          LIMIT 20
        `)
      : await db.execute(sql`
          SELECT id FROM articles
          WHERE pipeline_stage = 'approved'
            AND approved_at IS NOT NULL
            AND approved_at < ${staleThreshold}
            AND id NOT IN (
              SELECT article_id FROM post_deliveries
              WHERE status NOT IN ('cancelled')
            )
          LIMIT 20
        `);

  const orphaned = orphanedResult.rows as { id: string }[];
  if (orphaned.length === 0) return 0;

  // Skip rescue if no platforms have auto-posting enabled — avoids infinite loop
  // where maintenance rescues → distribution skips → maintenance rescues again
  const enabledPlatforms = await db.execute(sql`
    SELECT key FROM app_config
    WHERE key IN ('auto_post_telegram', 'auto_post_facebook', 'auto_post_linkedin')
      AND value = 'true'::jsonb
    LIMIT 1
  `);
  if (enabledPlatforms.rows.length === 0) return 0;

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

/**
 * Retry articles stuck in 'posting_failed' state.
 * Resets to 'approved' after 30 minutes, up to 3 attempts.
 * After 3 attempts, leaves as 'posting_failed' (permanent — needs manual intervention).
 */
const retryPostingFailed = async (db: Database, distributionQueue?: Queue) => {
  if (!distributionQueue) return 0;

  const retryThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
  const maxAttempts = 3;

  const result = await db.execute(sql`
    UPDATE articles
    SET pipeline_stage = 'approved'
    WHERE pipeline_stage = 'posting_failed'
      AND approved_at < ${retryThreshold}
      AND posting_attempts < ${maxAttempts}
    RETURNING id
  `);

  const retried = result.rows as { id: string }[];
  if (retried.length === 0) return 0;

  // Re-queue for distribution
  for (const article of retried) {
    try {
      await distributionQueue.add(
        JOB_DISTRIBUTION_IMMEDIATE,
        { articleId: article.id },
        { jobId: `retry-failed-${article.id}-${Date.now()}` },
      );
    } catch (err) {
      logger.error(`[maintenance] failed to re-queue posting_failed article ${article.id}`, err);
    }
  }

  logger.warn(`[maintenance] retried ${retried.length} posting_failed articles`);
  return retried.length;
};

type ArticleForPost = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  sectorName: string | null;
  titleKa: string | null;
  llmSummaryKa: string | null;
};

type ClaimedDelivery = {
  id: string;
  articleId: string;
  platform: string;
  scheduledAt: Date;
};

// Helper: Get template for platform from social_accounts
// Merges saved template with defaults so new fields (e.g. showImage) are never undefined.
async function getTemplateForPlatform(db: Database, platform: string): Promise<PostTemplateConfig> {
  const result = await db.execute(sql`
    SELECT post_template as "postTemplate"
    FROM social_accounts
    WHERE platform = ${platform} AND is_active = true
    LIMIT 1
  `);
  const saved = (result.rows[0] as { postTemplate: PostTemplateConfig | null } | undefined)
    ?.postTemplate;
  const defaults = getDefaultTemplate(platform);
  return saved ? { ...defaults, ...saved } : defaults;
}

// Helper: Get rate limit for platform from social_accounts
async function getRateLimitForPlatform(db: Database, platform: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT rate_limit_per_hour as "limit"
    FROM social_accounts
    WHERE platform = ${platform} AND is_active = true
    LIMIT 1
  `);
  // Default rate limits per platform if not configured
  const defaults: Record<string, number> = { telegram: 20, facebook: 1, linkedin: 4 };
  return (result.rows[0] as { limit: number } | undefined)?.limit ?? defaults[platform] ?? 4;
}

type PlatformProviders = {
  telegram?: SocialProvider;
  facebook?: SocialProvider;
  linkedin?: SocialProvider;
};

/**
 * Process scheduled posts that are due.
 * Claims posts atomically and posts to configured platforms.
 */
const processScheduledPosts = async (
  db: Database,
  providers: PlatformProviders,
  rateLimiter: RateLimiter,
  eventPublisher?: EventPublisher,
) => {
  // Layer 8: Kill switch check - stop all posting if emergency_stop is true
  const [emergencyStop] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "emergency_stop"));

  if (emergencyStop?.value === "true") {
    logger.warn("[post-scheduler] emergency stop active, skipping scheduled posts");
    return;
  }

  const hasAnyProvider = providers.telegram || providers.facebook || providers.linkedin;
  if (!hasAnyProvider) {
    return; // No platforms configured, skip
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
    RETURNING id, article_id as "articleId", platform, scheduled_at as "scheduledAt"
  `);

  const claimed = claimResult.rows as ClaimedDelivery[];
  if (claimed.length === 0) {
    return;
  }

  logger.info(`[post-scheduler] claimed ${claimed.length} due posts`);

  // 2. Process each claimed delivery
  for (const delivery of claimed) {
    try {
      // Get provider for this platform
      const provider = providers[delivery.platform as keyof PlatformProviders];
      if (!provider) {
        logger.warn(`[post-scheduler] platform not configured: ${delivery.platform}`);
        await db
          .update(postDeliveries)
          .set({ status: "failed", errorMessage: `Platform not configured: ${delivery.platform}` })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Emergency brake: check platform health before posting
      const isHealthy = await isPlatformHealthy(db, delivery.platform);
      if (!isHealthy) {
        logger.warn(
          { deliveryId: delivery.id, platform: delivery.platform },
          "[post-scheduler] platform unhealthy, rescheduling",
        );
        // Reschedule for 1 hour later
        const retryAt = new Date(Date.now() + 60 * 60 * 1000);
        await db
          .update(postDeliveries)
          .set({
            status: "scheduled",
            scheduledAt: retryAt,
            errorMessage: "Platform unhealthy, retrying in 1 hour",
          })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Check rate limit before posting
      const limit = await getRateLimitForPlatform(db, delivery.platform);
      const rateCheck = await rateLimiter.checkAndRecord(delivery.platform, limit);
      if (!rateCheck.allowed) {
        // Re-schedule for later when rate limit window resets
        const retryAt = new Date(Date.now() + (rateCheck.retryAfterMs ?? 60000));
        logger.warn(
          {
            deliveryId: delivery.id,
            platform: delivery.platform,
            current: rateCheck.current,
            limit: rateCheck.limit,
            retryAt,
          },
          "[post-scheduler] rate limit reached, rescheduling",
        );
        await db
          .update(postDeliveries)
          .set({
            status: "scheduled",
            scheduledAt: retryAt,
            errorMessage: `Rate limited (${rateCheck.current}/${rateCheck.limit}/hr), retrying in ${Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000)} minutes`,
          })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Fetch article data (including Georgian translation fields)
      const articleResult = await db.execute(sql`
        SELECT
          a.id,
          a.title,
          a.url,
          a.llm_summary as "llmSummary",
          a.importance_score as "importanceScore",
          a.title_ka as "titleKa",
          a.llm_summary_ka as "llmSummaryKa",
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

      // Read posting language
      const [langRow] = await db
        .select({ value: appConfig.value })
        .from(appConfig)
        .where(eq(appConfig.key, "posting_language"));
      const postingLanguage = (langRow?.value as string) ?? "en";

      // Georgian mode: cancel delivery for untranslated articles.
      // Article will be re-queued for distribution automatically after translation completes.
      if (postingLanguage === "ka" && (!article.titleKa || !article.llmSummaryKa)) {
        logger.warn(
          { deliveryId: delivery.id, articleId: delivery.articleId },
          "[post-scheduler] Georgian mode: article not yet translated — cancelling delivery. " +
            "Will auto-post after translation completes.",
        );
        await db
          .update(postDeliveries)
          .set({
            status: "cancelled",
            errorMessage:
              "Cancelled: Georgian translation required. Will auto-post after translation.",
          })
          .where(eq(postDeliveries.id, delivery.id));
        continue;
      }

      // Resolve content based on language
      const postTitle =
        postingLanguage === "ka" && article.titleKa ? article.titleKa : article.title;
      const postSummary =
        postingLanguage === "ka" && article.llmSummaryKa
          ? article.llmSummaryKa
          : article.llmSummary || article.title;

      // Get template for this platform
      const template = await getTemplateForPlatform(db, delivery.platform);

      // Fetch ready image for this article (if any)
      let imageUrl: string | undefined;
      if (template.showImage) {
        const [articleImage] = await db
          .select({
            imageUrl: articleImages.imageUrl,
            status: articleImages.status,
            createdAt: articleImages.createdAt,
          })
          .from(articleImages)
          .where(eq(articleImages.articleId, delivery.articleId))
          .limit(1);

        if (articleImage?.status === "ready") {
          imageUrl = articleImage.imageUrl ?? undefined;
        } else if (articleImage?.status === "generating" || articleImage?.status === "pending") {
          // Check if stuck (> 5 min) — post without image rather than waiting forever
          const ageMs = Date.now() - new Date(articleImage.createdAt).getTime();
          if (ageMs < 5 * 60 * 1000) {
            // Release claim back to scheduled so next tick retries
            await db
              .update(postDeliveries)
              .set({ status: "scheduled" })
              .where(eq(postDeliveries.id, delivery.id));
            logger.info(
              { deliveryId: delivery.id, articleId: delivery.articleId },
              "[post-scheduler] image still generating, deferring delivery",
            );
            continue;
          }
          logger.warn(
            { deliveryId: delivery.id, articleId: delivery.articleId, ageMs },
            "[post-scheduler] image generation stuck > 5min, posting without image",
          );
          // Fall through — post without image
        } else if (articleImage?.status === "failed") {
          // Image generation failed after retries — post without image
          logger.info(
            { deliveryId: delivery.id, articleId: delivery.articleId },
            "[post-scheduler] image generation failed, posting without image",
          );
          // Fall through — post without image
        } else if (!articleImage) {
          // No image row at all — check if we should wait for the 30s sweep to generate one
          const imgEnabled = await getConfigBoolean(db, "image_generation_enabled", false);
          const imgMinScore = await getConfigNumber(db, "image_generation_min_score", 4);
          if (imgEnabled && (article.importanceScore ?? 0) >= imgMinScore) {
            // Wait up to 3 min from scheduled time for image to be generated
            const deliveryAge = Date.now() - new Date(delivery.scheduledAt).getTime();
            if (deliveryAge < 3 * 60 * 1000) {
              await db
                .update(postDeliveries)
                .set({ status: "scheduled" })
                .where(eq(postDeliveries.id, delivery.id));
              logger.info(
                { deliveryId: delivery.id, articleId: delivery.articleId },
                "[post-scheduler] waiting for image generation, deferring delivery",
              );
              continue;
            }
            logger.warn(
              { deliveryId: delivery.id, articleId: delivery.articleId },
              "[post-scheduler] waited > 3min for image, posting without image",
            );
          }
          // Fall through — post without image
        }
      }

      // Format and post using template (uses resolved language content)
      const text = provider.formatPost(
        {
          title: postTitle,
          summary: postSummary,
          url: article.url,
          sector: article.sectorName || "News",
        },
        template,
      );

      const sourceUrl = template.autoCommentUrl ? article.url : undefined;
      const postResult = await provider.post({ text, imageUrl, sourceUrl });

      if (!postResult.success) {
        logger.error(
          { deliveryId: delivery.id, platform: delivery.platform, error: postResult.error },
          "[post-scheduler] post failed",
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

      // Update platform health lastPostAt (successful post proves platform works)
      await updateLastPostAt(db, delivery.platform);

      // Publish SSE event for real-time UI updates
      await eventPublisher?.publish({
        type: "article:posted",
        data: {
          id: delivery.articleId,
          platform: delivery.platform,
          postId: postResult.postId,
        },
      });

      logger.info(
        {
          deliveryId: delivery.id,
          articleId: delivery.articleId,
          platform: delivery.platform,
          postId: postResult.postId,
        },
        "[post-scheduler] posted successfully",
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
  facebookConfig,
  linkedinConfig,
  maintenanceQueue,
  semanticDedupQueue,
  llmQueue,
  rateLimiter,
  eventPublisher,
  r2Storage,
  apiKeys,
}: MaintenanceDeps) => {
  // Create providers at startup (only for configured platforms)
  const providers: PlatformProviders = {
    telegram: telegramConfig ? createTelegramProvider(telegramConfig) : undefined,
    facebook: facebookConfig ? createFacebookProvider(facebookConfig) : undefined,
    linkedin: linkedinConfig ? createLinkedInProvider(linkedinConfig) : undefined,
  };

  // Compute LinkedIn token hash once at startup for rotation detection
  const linkedinTokenHash = linkedinConfig?.accessToken
    ? hashToken(linkedinConfig.accessToken)
    : undefined;

  return new Worker(
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

        // Article images cleanup (delete R2 objects first, then DB rows)
        try {
          const articleImagesTtlDays = await getConfigNumber(db, "article_images_ttl_days", 30);
          const imagesCutoff = new Date(Date.now() - articleImagesTtlDays * 24 * 60 * 60 * 1000);

          // Fetch r2Keys before deleting DB rows so we can clean up R2 storage
          if (r2Storage) {
            const expiredImages = await db
              .select({ id: articleImages.id, r2Key: articleImages.r2Key })
              .from(articleImages)
              .where(lt(articleImages.createdAt, imagesCutoff));

            const r2Keys = expiredImages
              .map((img) => img.r2Key)
              .filter((k): k is string => k !== null);

            if (r2Keys.length > 0) {
              await r2Storage.deleteImages(r2Keys);
              logger.info({ count: r2Keys.length }, "[maintenance] deleted R2 image objects");
            }
          }

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

        // Digest runs cleanup
        try {
          const digestRunsTtlDays = await getConfigNumber(db, "digest_runs_ttl_days", 30);
          const digestRunsCutoff = new Date(Date.now() - digestRunsTtlDays * 24 * 60 * 60 * 1000);
          await db.delete(digestRuns).where(lt(digestRuns.createdAt, digestRunsCutoff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] digest_runs cleanup failed: ${msg}`);
          errors.push("digest_runs");
        }

        // Alert deliveries cleanup
        try {
          const alertDeliveriesTtlDays = await getConfigNumber(db, "alert_deliveries_ttl_days", 30);
          const alertDeliveriesCutoff = new Date(Date.now() - alertDeliveriesTtlDays * 86_400_000);
          await db.delete(alertDeliveries).where(lt(alertDeliveries.sentAt, alertDeliveriesCutoff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[maintenance] alert_deliveries cleanup failed: ${msg}`);
          errors.push("alert_deliveries");
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
        await retryPostingFailed(db, distributionQueue);
        await runScheduledIngests(db, ingestQueue, job.data?.force === true);
        // Process any scheduled posts that are due
        await processScheduledPosts(db, providers, rateLimiter, eventPublisher);

        // Expire old digest drafts (24h TTL)
        try {
          const expired = await db
            .update(digestDrafts)
            .set({ status: "expired" })
            .where(and(eq(digestDrafts.status, "draft"), lt(digestDrafts.expiresAt, new Date())))
            .returning({ id: digestDrafts.id });
          if (expired.length > 0) {
            logger.info({ count: expired.length }, "[scheduler] expired digest drafts");
          }
        } catch (err) {
          logger.error("[scheduler] draft expiry check failed", err);
        }

        // Deliver scheduled digest drafts that are due
        try {
          const dueDrafts = await db
            .select({ id: digestDrafts.id, slotId: digestDrafts.slotId })
            .from(digestDrafts)
            .where(
              and(eq(digestDrafts.status, "approved"), lt(digestDrafts.scheduledAt, new Date())),
            );
          for (const draft of dueDrafts) {
            await maintenanceQueue.add(
              JOB_DAILY_DIGEST,
              { draftId: draft.id, slotId: draft.slotId },
              { jobId: `digest-draft-${draft.id}` },
            );
            logger.info(
              { draftId: draft.id, slotId: draft.slotId },
              "[scheduler] queued scheduled draft delivery",
            );
          }
        } catch (err) {
          logger.error("[scheduler] scheduled draft delivery check failed", err);
        }

        // Check which digest slots are due
        try {
          const dueSlotIds = await checkDigestSlotsDue(db);
          for (const slotId of dueSlotIds) {
            await maintenanceQueue.add(
              JOB_DAILY_DIGEST,
              { isTest: false, slotId },
              { jobId: `digest-${slotId}-${Date.now()}` },
            );
            logger.info({ slotId }, "[scheduler] queued digest for slot");
          }
        } catch (err) {
          logger.error("[scheduler] digest check failed", err);
        }

        return;
      }

      if (job.name === JOB_DAILY_DIGEST) {
        const isTest = job.data?.isTest === true;
        const slotId = job.data?.slotId as string | undefined;
        const draftId = job.data?.draftId as string | undefined;
        logger.info(
          { isTest, slotId, draftId },
          `[digest] starting ${draftId ? "draft delivery" : isTest ? "test" : "scheduled"} digest`,
        );
        const result = await compileAndSendDigest(
          { db, telegramConfig, facebookConfig, linkedinConfig, apiKeys },
          { isTest, slotId, draftId },
        );
        if (result.sent) {
          logger.info(
            { articles: result.articleCount, messages: result.messageCount, slotId, draftId },
            `[digest] ${draftId ? "draft" : isTest ? "test" : "scheduled"} digest sent`,
          );
          // Notify frontend via SSE
          if (slotId && eventPublisher) {
            const [slot] = await db
              .select({
                name: digestSlots.name,
                telegramEnabled: digestSlots.telegramEnabled,
                facebookEnabled: digestSlots.facebookEnabled,
                linkedinEnabled: digestSlots.linkedinEnabled,
              })
              .from(digestSlots)
              .where(eq(digestSlots.id, slotId))
              .limit(1);
            const channels: string[] = [];
            if (slot?.telegramEnabled) channels.push("telegram");
            if (slot?.facebookEnabled) channels.push("facebook");
            if (slot?.linkedinEnabled) channels.push("linkedin");
            await eventPublisher.publish({
              type: "digest:sent",
              data: {
                slotId,
                slotName: slot?.name ?? "Unknown",
                articleCount: result.articleCount,
                isTest,
                channels,
              },
            });
          }
        } else if (result.draftId) {
          logger.info(
            { slotId, draftId: result.draftId },
            "[digest] saved as draft for manual approval",
          );
          // Notify frontend via SSE
          if (slotId && eventPublisher) {
            const [slot] = await db
              .select({ name: digestSlots.name })
              .from(digestSlots)
              .where(eq(digestSlots.id, slotId))
              .limit(1);
            await eventPublisher.publish({
              type: "digest:draft-ready",
              data: {
                draftId: result.draftId,
                slotId,
                slotName: slot?.name ?? "Unknown",
                articleCount: result.articleCount,
              },
            });
          }
        } else {
          logger.info({ slotId }, "[digest] skipped (no qualifying articles or disabled)");
        }
        return;
      }

      if (job.name === JOB_PLATFORM_HEALTH_CHECK) {
        logger.debug("[maintenance] running platform health checks");

        for (const [name, provider] of Object.entries(providers)) {
          if (!provider) continue;

          try {
            const result = await provider.healthCheck();
            // Pass token hash for LinkedIn rotation detection
            const tokenHash = name === "linkedin" ? linkedinTokenHash : undefined;
            await upsertPlatformHealth(db, result, tokenHash);

            if (result.healthy) {
              logger.info({ platform: name }, "[health-check] passed");
            } else {
              logger.warn({ platform: name, error: result.error }, "[health-check] failed");
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            logger.error({ platform: name, error: errorMsg }, "[health-check] error");
          }
        }
        return;
      }
    },
    { connection },
  );
};
