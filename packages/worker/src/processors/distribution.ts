/**
 * Distribution Worker
 *
 * Handles immediate posting to social platforms for auto-approved articles.
 * Supports Telegram, Facebook, and LinkedIn.
 */

import { Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import {
  QUEUE_DISTRIBUTION,
  JOB_DISTRIBUTION_IMMEDIATE,
  logger,
  getDefaultTemplate,
  type PostTemplateConfig,
} from "@watch-tower/shared";
import { and } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { appConfig, postDeliveries, articleImages } from "@watch-tower/db";
import {
  createTelegramProvider,
  createFacebookProvider,
  createLinkedInProvider,
  type TelegramConfig,
  type FacebookConfig,
  type LinkedInConfig,
} from "@watch-tower/social";
import type { EventPublisher } from "../events.js";
import type { RateLimiter } from "../utils/rate-limiter.js";
import { isPlatformHealthy, updateLastPostAt } from "../utils/platform-health.js";

type DistributionDeps = {
  connection: { host: string; port: number };
  db: Database;
  telegramConfig?: TelegramConfig;
  facebookConfig?: FacebookConfig;
  linkedinConfig?: LinkedInConfig;
  eventPublisher: EventPublisher;
  rateLimiter: RateLimiter;
};

type ArticleForDistribution = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  sectorId: string | null;
  sectorName: string | null;
  titleKa: string | null;
  llmSummaryKa: string | null;
};

// Helper: Check if platform is enabled in app_config
async function isPlatformEnabled(db: Database, platform: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT value FROM app_config WHERE key = ${`auto_post_${platform}`}
  `);
  return (result.rows[0] as { value: unknown } | undefined)?.value === true;
}

// Helper: Get template for platform, with optional sector-specific override.
// Resolution priority: sector+platform → platform → hardcoded defaults.
async function getTemplateForPlatform(
  db: Database,
  platform: string,
  sectorId?: string | null,
): Promise<PostTemplateConfig> {
  const defaults = getDefaultTemplate(platform);

  // 1. Try sector-specific template first
  if (sectorId) {
    const sectorResult = await db.execute(sql`
      SELECT post_template as "postTemplate"
      FROM sector_post_templates
      WHERE sector_id = ${sectorId}::uuid AND platform = ${platform}
      LIMIT 1
    `);
    const sectorTemplate = (
      sectorResult.rows[0] as { postTemplate: PostTemplateConfig } | undefined
    )?.postTemplate;
    if (sectorTemplate) return { ...defaults, ...sectorTemplate };
  }

  // 2. Fall back to platform-level template
  const result = await db.execute(sql`
    SELECT post_template as "postTemplate"
    FROM social_accounts
    WHERE platform = ${platform} AND is_active = true
    LIMIT 1
  `);
  const saved = (result.rows[0] as { postTemplate: PostTemplateConfig | null } | undefined)
    ?.postTemplate;
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

export const createDistributionWorker = ({
  connection,
  db,
  telegramConfig,
  facebookConfig,
  linkedinConfig,
  eventPublisher,
  rateLimiter,
}: DistributionDeps) => {
  // Create providers at startup (only for configured platforms)
  const telegram = telegramConfig ? createTelegramProvider(telegramConfig) : null;
  const facebook = facebookConfig ? createFacebookProvider(facebookConfig) : null;
  const linkedin = linkedinConfig ? createLinkedInProvider(linkedinConfig) : null;

  return new Worker(
    QUEUE_DISTRIBUTION,
    async (job) => {
      // Layer 8: Kill switch check - stop all posting if emergency_stop is true
      const [emergencyStop] = await db
        .select({ value: appConfig.value })
        .from(appConfig)
        .where(eq(appConfig.key, "emergency_stop"));

      if (emergencyStop?.value === "true") {
        logger.warn("[distribution] emergency stop active, skipping all posting");
        return { skipped: true, reason: "emergency_stop" };
      }

      // ─── Immediate Post (Score 5) ───────────────────────────────────────────
      if (job.name === JOB_DISTRIBUTION_IMMEDIATE) {
        const { articleId } = job.data as { articleId: string };
        logger.info({ articleId }, "[distribution] processing immediate post");

        // ─── Pre-flight: skip claim if ALL platforms are blocked ──────────────
        // Prevents the noisy approved → posting → approved flip when rate-limited.
        // Only peeks at rate limits (no recording) — the main loop still does checkAndRecord.
        const allPlatforms = [
          { name: "telegram", provider: telegram },
          { name: "facebook", provider: facebook },
          { name: "linkedin", provider: linkedin },
        ].filter((p) => p.provider !== null);

        let anyPlatformReady = false;
        const blockedPlatforms: { name: string; retryAt: Date; msg: string }[] = [];

        for (const { name } of allPlatforms) {
          const enabled = await isPlatformEnabled(db, name);
          if (!enabled) continue;

          const isHealthy = await isPlatformHealthy(db, name);
          if (!isHealthy) {
            blockedPlatforms.push({
              name,
              retryAt: new Date(Date.now() + 60 * 60 * 1000),
              msg: "Platform unhealthy, auto-scheduled retry in 1 hour",
            });
            continue;
          }

          const limit = await getRateLimitForPlatform(db, name);
          const peekResult = await rateLimiter.peek(name, limit);
          if (!peekResult.allowed) {
            const retryAfterMs = peekResult.retryAfterMs ?? 60_000;
            blockedPlatforms.push({
              name,
              retryAt: new Date(Date.now() + retryAfterMs),
              msg: `Rate limited (${peekResult.current}/${peekResult.limit}/hr), auto-scheduled retry`,
            });
            continue;
          }

          anyPlatformReady = true;
          break; // At least one platform has capacity, proceed to claim
        }

        if (!anyPlatformReady) {
          if (blockedPlatforms.length > 0) {
            // All enabled platforms are blocked — create scheduled deliveries WITHOUT claiming
            for (const { name, retryAt, msg } of blockedPlatforms) {
              await db.execute(sql`
                INSERT INTO post_deliveries (article_id, platform, scheduled_at, status, error_message)
                VALUES (${articleId}::uuid, ${name}, ${retryAt}, 'scheduled', ${msg})
                ON CONFLICT (article_id, platform) WHERE status IN ('scheduled', 'posting')
                DO UPDATE SET
                  scheduled_at = EXCLUDED.scheduled_at,
                  error_message = EXCLUDED.error_message
              `);
            }
            logger.info(
              { articleId, platforms: blockedPlatforms.map((p) => p.name) },
              "[distribution] all platforms blocked, article stays approved",
            );
            return { skipped: true, reason: "all_platforms_blocked" };
          }
          // No platforms enabled/configured
          logger.info({ articleId }, "[distribution] no platforms enabled, skipping");
          return { skipped: true, reason: "no_platforms_enabled" };
        }

        // ATOMIC CLAIM: Update approved -> posting and fetch in one operation
        // This prevents race conditions where multiple workers could post the same article
        // If another worker already claimed it (stage != 'approved'), we get 0 rows
        const claimResult = await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'posting'
          WHERE id = ${articleId}::uuid
            AND pipeline_stage = 'approved'
          RETURNING
            id,
            title,
            url,
            llm_summary as "llmSummary",
            importance_score as "importanceScore",
            title_ka as "titleKa",
            llm_summary_ka as "llmSummaryKa",
            sector_id as "sectorId",
            (SELECT name FROM sectors WHERE id = articles.sector_id) as "sectorName"
        `);

        const claimedArticles = claimResult.rows as ArticleForDistribution[];

        if (claimedArticles.length === 0) {
          // Article was already claimed by another worker, or not in 'approved' state
          // Check if it's already posted (idempotency - job retry after success)
          const checkResult = await db.execute(sql`
            SELECT pipeline_stage FROM articles WHERE id = ${articleId}::uuid
          `);
          const currentStage = (checkResult.rows[0] as { pipeline_stage: string } | undefined)
            ?.pipeline_stage;

          if (currentStage === "posted") {
            logger.info({ articleId }, "[distribution] article already posted (idempotent skip)");
            return { skipped: true, reason: "already_posted" };
          }

          if (currentStage === "posting") {
            logger.warn({ articleId }, "[distribution] article being posted by another worker");
            return { skipped: true, reason: "already_processing" };
          }

          logger.warn(
            { articleId, currentStage },
            "[distribution] article not found or not approved",
          );
          return { skipped: true, reason: "not_found_or_not_approved" };
        }

        const article = claimedArticles[0];

        // Read posting language
        const [langRow] = await db
          .select({ value: appConfig.value })
          .from(appConfig)
          .where(eq(appConfig.key, "posting_language"));
        const postingLanguage = (langRow?.value as string) ?? "en";

        // Georgian mode: block posting of untranslated articles.
        // Article stays approved — once translation completes, auto-post flow will re-trigger.
        if (postingLanguage === "ka" && (!article.titleKa || !article.llmSummaryKa)) {
          await db.execute(sql`
            UPDATE articles SET pipeline_stage = 'approved' WHERE id = ${articleId}::uuid
          `);
          logger.warn(
            { articleId },
            "[distribution] Georgian mode: article not yet translated, skipping. " +
              "Will auto-post after translation completes.",
          );
          return { skipped: true, reason: "awaiting_translation" };
        }

        // Resolve content based on language
        const postTitle =
          postingLanguage === "ka" && article.titleKa ? article.titleKa : article.title;
        const postSummary =
          postingLanguage === "ka" && article.llmSummaryKa
            ? article.llmSummaryKa
            : article.llmSummary || article.title;

        // Fetch ready image for this article (if any)
        const [articleImage] = await db
          .select({ imageUrl: articleImages.imageUrl })
          .from(articleImages)
          .where(and(eq(articleImages.articleId, articleId), eq(articleImages.status, "ready")))
          .limit(1);

        // Build list of platforms to post to
        const platforms = [
          { name: "telegram", provider: telegram },
          { name: "facebook", provider: facebook },
          { name: "linkedin", provider: linkedin },
        ].filter((p) => p.provider !== null);

        const results: {
          platform: string;
          success: boolean;
          postId?: string;
          error?: string;
          rateLimited?: boolean;
          retryAfterMs?: number;
        }[] = [];
        let anySuccess = false;

        try {
          for (const { name, provider } of platforms) {
            // Check if platform is enabled in app_config
            const enabled = await isPlatformEnabled(db, name);
            if (!enabled) {
              logger.debug(
                { articleId, platform: name },
                "[distribution] platform disabled, skipping",
              );
              continue;
            }

            // Emergency brake: check platform health before posting
            const isHealthy = await isPlatformHealthy(db, name);
            if (!isHealthy) {
              const retryAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
              logger.warn(
                { articleId, platform: name, retryAt },
                "[distribution] platform unhealthy, scheduling retry",
              );

              // Upsert: insert or update existing scheduled/posting delivery
              // Uses partial unique index idx_post_deliveries_active_unique
              await db.execute(sql`
                INSERT INTO post_deliveries (article_id, platform, scheduled_at, status, error_message)
                VALUES (${articleId}::uuid, ${name}, ${retryAt}, 'scheduled', 'Platform unhealthy, auto-scheduled retry in 1 hour')
                ON CONFLICT (article_id, platform) WHERE status IN ('scheduled', 'posting')
                DO UPDATE SET
                  scheduled_at = EXCLUDED.scheduled_at,
                  error_message = EXCLUDED.error_message
              `);

              results.push({
                platform: name,
                success: false,
                error: "Platform unhealthy — scheduled retry in 1 hour",
                rateLimited: true,
              });
              continue;
            }

            // Check rate limit before posting
            const limit = await getRateLimitForPlatform(db, name);
            const rateCheck = await rateLimiter.checkAndRecord(name, limit);
            if (!rateCheck.allowed) {
              const retryAfterMs = rateCheck.retryAfterMs ?? 60_000;
              const retryAt = new Date(Date.now() + retryAfterMs);

              logger.warn(
                {
                  articleId,
                  platform: name,
                  current: rateCheck.current,
                  limit: rateCheck.limit,
                  retryAt,
                },
                "[distribution] rate limit reached, scheduling retry via post_deliveries",
              );

              // Upsert: insert or update existing scheduled/posting delivery
              // Uses partial unique index idx_post_deliveries_active_unique
              const rateLimitMsg = `Rate limited (${rateCheck.current}/${rateCheck.limit}/hr), auto-scheduled retry`;
              await db.execute(sql`
                INSERT INTO post_deliveries (article_id, platform, scheduled_at, status, error_message)
                VALUES (${articleId}::uuid, ${name}, ${retryAt}, 'scheduled', ${rateLimitMsg})
                ON CONFLICT (article_id, platform) WHERE status IN ('scheduled', 'posting')
                DO UPDATE SET
                  scheduled_at = EXCLUDED.scheduled_at,
                  error_message = EXCLUDED.error_message
              `);

              results.push({
                platform: name,
                success: false,
                error: `Rate limited — scheduled retry at ${retryAt.toISOString()}`,
                rateLimited: true,
                retryAfterMs,
              });
              continue;
            }

            // Fetch template for this platform (sector-specific override if available)
            const template = await getTemplateForPlatform(db, name, article.sectorId);

            // Format post using provider (uses resolved language content)
            const text = provider!.formatPost(
              {
                title: postTitle,
                summary: postSummary,
                url: article.url,
                sector: article.sectorName || "News",
              },
              template,
            );

            // Post to platform (attach image if template allows and image exists)
            const imageUrl =
              template.showImage && articleImage?.imageUrl ? articleImage.imageUrl : undefined;
            const sourceUrl = template.autoCommentUrl ? article.url : undefined;
            const postResult = await provider!.post({ text, imageUrl, sourceUrl });
            results.push({
              platform: name,
              success: postResult.success,
              postId: postResult.postId,
              error: postResult.error,
              rateLimited: false,
            });

            // Cancel any existing scheduled/posting delivery for this article+platform
            // Prevents orphaned rows when a retry succeeds after an earlier rate-limited attempt
            await db.execute(sql`
              UPDATE post_deliveries
              SET status = 'cancelled'
              WHERE article_id = ${articleId}::uuid
                AND platform = ${name}
                AND status IN ('scheduled', 'posting')
            `);

            // Create post_deliveries record for audit trail
            await db.insert(postDeliveries).values({
              articleId,
              platform: name,
              scheduledAt: null, // immediate
              status: postResult.success ? "posted" : "failed",
              platformPostId: postResult.postId ?? null,
              errorMessage: postResult.error ?? null,
              sentAt: postResult.success ? new Date() : null,
            });

            if (postResult.success) {
              anySuccess = true;
              // Update platform health lastPostAt (successful post proves platform works)
              await updateLastPostAt(db, name);
              await eventPublisher.publish({
                type: "article:posted",
                data: { id: articleId, platform: name, postId: postResult.postId },
              });
              logger.info(
                { articleId, platform: name, postId: postResult.postId },
                "[distribution] posted successfully",
              );
            } else {
              logger.error(
                { articleId, platform: name, error: postResult.error },
                "[distribution] post failed",
              );
            }
          }
        } catch (loopError) {
          // If the platform loop throws, ensure article is rolled back to approved
          logger.error(
            { articleId, error: String(loopError) },
            "[distribution] unexpected error in platform loop, rolling back to approved",
          );
          await db.execute(sql`
            UPDATE articles SET pipeline_stage = 'approved'
            WHERE id = ${articleId}::uuid AND pipeline_stage = 'posting'
          `);
          throw loopError; // Re-throw so BullMQ marks job as failed
        }

        // Update article stage based on results
        const anyRateLimited = results.some((r) => r.rateLimited);

        if (anySuccess) {
          // At least one platform succeeded — mark posted
          // Rate-limited platforms have scheduled deliveries that will be processed independently
          await db.execute(sql`
            UPDATE articles
            SET
              pipeline_stage = 'posted',
              approved_at = COALESCE(approved_at, NOW())
            WHERE id = ${articleId}::uuid
          `);
        } else if (anyRateLimited && !results.some((r) => !r.rateLimited && !r.success)) {
          // ALL failures were rate limits or unhealthy (no hard failures) — keep approved
          // Scheduled deliveries exist, maintenance worker will post later
          await db.execute(sql`
            UPDATE articles SET pipeline_stage = 'approved'
            WHERE id = ${articleId}::uuid
          `);
          logger.info(
            { articleId },
            "[distribution] all platforms rate-limited/unhealthy, kept as approved",
          );
        } else if (results.length > 0) {
          // Hard failures on all platforms
          await db.execute(sql`
            UPDATE articles
            SET
              pipeline_stage = 'posting_failed',
              posting_attempts = posting_attempts + 1
            WHERE id = ${articleId}::uuid
          `);
        } else {
          // No platforms were enabled/configured — roll back to approved
          // (zombie detector will also catch this as a safety net)
          await db.execute(sql`
            UPDATE articles SET pipeline_stage = 'approved'
            WHERE id = ${articleId}::uuid AND pipeline_stage = 'posting'
          `);
          logger.info(
            { articleId },
            "[distribution] no platforms processed, rolled back to approved",
          );
        }

        return { success: anySuccess, results };
      }

      logger.warn({ jobName: job.name }, "[distribution] unknown job type");
      return { skipped: true, reason: "unknown_job_type" };
    },
    { connection, concurrency: 1 }, // Low concurrency for rate limiting
  );
};
