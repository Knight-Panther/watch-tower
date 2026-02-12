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
import type { Database } from "@watch-tower/db";
import { appConfig, postDeliveries } from "@watch-tower/db";
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

// Helper: Get template for platform from social_accounts
async function getTemplateForPlatform(
  db: Database,
  platform: string,
): Promise<PostTemplateConfig> {
  const result = await db.execute(sql`
    SELECT post_template as "postTemplate"
    FROM social_accounts
    WHERE platform = ${platform} AND is_active = true
    LIMIT 1
  `);
  return (
    (result.rows[0] as { postTemplate: PostTemplateConfig | null } | undefined)?.postTemplate ??
    getDefaultTemplate(platform)
  );
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

        // Georgian mode: check translation is available
        if (postingLanguage === "ka" && (!article.titleKa || !article.llmSummaryKa)) {
          // Roll back to approved — translation worker hasn't finished yet
          await db.execute(sql`
            UPDATE articles SET pipeline_stage = 'approved' WHERE id = ${articleId}::uuid
          `);
          logger.warn(
            { articleId },
            "[distribution] Georgian mode but no translation — rolled back to approved",
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

        for (const { name, provider } of platforms) {
          // Check if platform is enabled in app_config
          const enabled = await isPlatformEnabled(db, name);
          if (!enabled) {
            logger.debug({ articleId, platform: name }, "[distribution] platform disabled, skipping");
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

            // Atomic upsert: update existing scheduled delivery or create new one
            // Uses single CTE to prevent duplicate rows from race conditions
            await db.execute(sql`
              WITH existing AS (
                UPDATE post_deliveries
                SET scheduled_at = ${retryAt},
                    error_message = 'Platform unhealthy, auto-scheduled retry in 1 hour'
                WHERE id = (
                  SELECT id FROM post_deliveries
                  WHERE article_id = ${articleId}::uuid AND platform = ${name}
                    AND status IN ('scheduled', 'posting')
                  LIMIT 1
                )
                RETURNING id
              )
              INSERT INTO post_deliveries (article_id, platform, scheduled_at, status, error_message)
              SELECT ${articleId}::uuid, ${name}, ${retryAt}, 'scheduled', 'Platform unhealthy, auto-scheduled retry in 1 hour'
              WHERE NOT EXISTS (SELECT 1 FROM existing)
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
              { articleId, platform: name, current: rateCheck.current, limit: rateCheck.limit, retryAt },
              "[distribution] rate limit reached, scheduling retry via post_deliveries",
            );

            // Atomic upsert: update existing scheduled delivery or create new one
            // Uses single CTE to prevent duplicate rows from race conditions
            const rateLimitMsg = `Rate limited (${rateCheck.current}/${rateCheck.limit}/hr), auto-scheduled retry`;
            await db.execute(sql`
              WITH existing AS (
                UPDATE post_deliveries
                SET scheduled_at = ${retryAt},
                    error_message = ${rateLimitMsg}
                WHERE id = (
                  SELECT id FROM post_deliveries
                  WHERE article_id = ${articleId}::uuid AND platform = ${name}
                    AND status IN ('scheduled', 'posting')
                  LIMIT 1
                )
                RETURNING id
              )
              INSERT INTO post_deliveries (article_id, platform, scheduled_at, status, error_message)
              SELECT ${articleId}::uuid, ${name}, ${retryAt}, 'scheduled', ${rateLimitMsg}
              WHERE NOT EXISTS (SELECT 1 FROM existing)
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

          // Fetch template for this platform
          const template = await getTemplateForPlatform(db, name);

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

          // Post to platform
          const postResult = await provider!.post({ text });
          results.push({
            platform: name,
            success: postResult.success,
            postId: postResult.postId,
            error: postResult.error,
            rateLimited: false,
          });

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
          logger.info({ articleId }, "[distribution] all platforms rate-limited/unhealthy, kept as approved");
        } else if (results.length > 0) {
          // Hard failures on all platforms
          await db.execute(sql`
            UPDATE articles
            SET
              pipeline_stage = 'posting_failed',
              posting_attempts = posting_attempts + 1
            WHERE id = ${articleId}::uuid
          `);
        }
        // If no platforms were enabled, leave as 'posting' (will be picked up when enabled)

        return { success: anySuccess, results };
      }

      logger.warn({ jobName: job.name }, "[distribution] unknown job type");
      return { skipped: true, reason: "unknown_job_type" };
    },
    { connection, concurrency: 1 }, // Low concurrency for rate limiting
  );
};
