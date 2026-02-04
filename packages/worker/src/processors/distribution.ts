/**
 * Distribution Worker
 *
 * Handles immediate posting to social platforms for auto-approved articles.
 * Supports Telegram, Facebook, and LinkedIn.
 */

import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  QUEUE_DISTRIBUTION,
  JOB_DISTRIBUTION_IMMEDIATE,
  logger,
  getDefaultTemplate,
  type PostTemplateConfig,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
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
            logger.warn({ articleId, platform: name }, "[distribution] platform unhealthy, skipping");
            results.push({
              platform: name,
              success: false,
              error: "Platform marked unhealthy - skipping",
            });
            continue;
          }

          // Check rate limit before posting
          const limit = await getRateLimitForPlatform(db, name);
          const rateCheck = await rateLimiter.checkAndRecord(name, limit);
          if (!rateCheck.allowed) {
            logger.warn(
              { articleId, platform: name, current: rateCheck.current, limit: rateCheck.limit },
              "[distribution] rate limit reached, skipping",
            );
            results.push({
              platform: name,
              success: false,
              error: `Rate limit reached (${rateCheck.current}/${rateCheck.limit}/hr)`,
              rateLimited: true,
              retryAfterMs: rateCheck.retryAfterMs,
            });
            continue;
          }

          // Fetch template for this platform
          const template = await getTemplateForPlatform(db, name);

          // Format post using provider
          const text = provider!.formatPost(
            {
              title: article.title,
              summary: article.llmSummary || article.title,
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
        if (anySuccess) {
          await db.execute(sql`
            UPDATE articles
            SET
              pipeline_stage = 'posted',
              approved_at = COALESCE(approved_at, NOW())
            WHERE id = ${articleId}::uuid
          `);
        } else if (results.length > 0) {
          // All platforms failed
          await db.execute(sql`
            UPDATE articles
            SET pipeline_stage = 'posting_failed'
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
