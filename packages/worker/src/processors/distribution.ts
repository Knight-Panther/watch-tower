/**
 * Distribution Worker
 *
 * Handles immediate posting to social platforms for auto-approved articles.
 * Currently supports Telegram. Facebook and LinkedIn are planned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO: To add Facebook support:
 * 1. Create packages/social/src/facebook.ts implementing SocialProvider interface
 * 2. Add FB_PAGE_ID, FB_ACCESS_TOKEN to .env and env schema
 * 3. Add facebookConfig to DistributionDeps below
 * 4. Create FacebookProvider instance in createDistributionWorker
 * 5. Check isFacebookAutoPostEnabled() in llm-brain.ts
 * 6. Add Facebook posting logic after Telegram in JOB_DISTRIBUTION_IMMEDIATE
 * 7. Enable the Facebook toggle in ScoringRules.tsx (remove disabled/opacity)
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO: To add LinkedIn support:
 * 1. Create packages/social/src/linkedin.ts implementing SocialProvider interface
 * 2. Add LINKEDIN_ORG_ID, LINKEDIN_ACCESS_TOKEN to .env and env schema
 * 3. Add linkedinConfig to DistributionDeps below
 * 4. Create LinkedInProvider instance in createDistributionWorker
 * 5. Check isLinkedinAutoPostEnabled() in llm-brain.ts
 * 6. Add LinkedIn posting logic after Telegram in JOB_DISTRIBUTION_IMMEDIATE
 * 7. Enable the LinkedIn toggle in ScoringRules.tsx (remove disabled/opacity)
 * ─────────────────────────────────────────────────────────────────────────────
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
import { createTelegramProvider, type TelegramConfig } from "@watch-tower/social";
// TODO: Uncomment when Facebook/LinkedIn providers are implemented:
// import { createFacebookProvider, type FacebookConfig } from "@watch-tower/social";
// import { createLinkedinProvider, type LinkedinConfig } from "@watch-tower/social";
import type { EventPublisher } from "../events.js";

type DistributionDeps = {
  connection: { host: string; port: number };
  db: Database;
  telegramConfig: TelegramConfig;
  // TODO: Add when Facebook is integrated:
  // facebookConfig?: FacebookConfig;
  // TODO: Add when LinkedIn is integrated:
  // linkedinConfig?: LinkedinConfig;
  eventPublisher: EventPublisher;
};

type ArticleForDistribution = {
  id: string;
  title: string;
  url: string;
  llmSummary: string | null;
  importanceScore: number | null;
  sectorName: string | null;
};

export const createDistributionWorker = ({
  connection,
  db,
  telegramConfig,
  eventPublisher,
}: DistributionDeps) => {
  const telegram = createTelegramProvider(telegramConfig);

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

        // Fetch template for Telegram account (if customized)
        const telegramTemplateResult = await db.execute(sql`
          SELECT post_template as "postTemplate"
          FROM social_accounts
          WHERE platform = 'telegram' AND is_active = true
          LIMIT 1
        `);
        const telegramTemplate: PostTemplateConfig =
          (telegramTemplateResult.rows[0] as { postTemplate: PostTemplateConfig | null } | undefined)
            ?.postTemplate ?? getDefaultTemplate("telegram");

        // Format and post to Telegram using template
        const text = telegram.formatPost(
          {
            title: article.title,
            summary: article.llmSummary || article.title,
            url: article.url,
            sector: article.sectorName || "News",
          },
          telegramTemplate,
        );

        const postResult = await telegram.post({ text });

        if (!postResult.success) {
          logger.error(
            { articleId, error: postResult.error },
            "[distribution] telegram post failed",
          );

          // Mark as posting_failed (not approved, so it won't be retried automatically)
          await db.execute(sql`
            UPDATE articles
            SET pipeline_stage = 'posting_failed'
            WHERE id = ${articleId}::uuid
          `);

          return { success: false, error: postResult.error };
        }

        // Update article to posted
        await db.execute(sql`
          UPDATE articles
          SET
            pipeline_stage = 'posted',
            approved_at = COALESCE(approved_at, NOW())
          WHERE id = ${articleId}::uuid
        `);

        // Publish event for real-time dashboard
        await eventPublisher.publish({
          type: "article:posted",
          data: {
            id: articleId,
            platform: "telegram",
            postId: postResult.postId,
          },
        });

        logger.info(
          { articleId, messageId: postResult.postId },
          "[distribution] posted to telegram",
        );

        // ─────────────────────────────────────────────────────────────────────
        // TODO: Add Facebook posting here when integrated:
        // if (facebookConfig && await isFacebookAutoPostEnabled(db)) {
        //   const fbText = facebook.formatSinglePost({ ... });
        //   const fbResult = await facebook.post({ text: fbText });
        //   if (fbResult.success) {
        //     await eventPublisher.publish({
        //       type: "article:posted",
        //       data: { id: articleId, platform: "facebook", postId: fbResult.postId },
        //     });
        //   }
        // }
        // ─────────────────────────────────────────────────────────────────────
        // TODO: Add LinkedIn posting here when integrated:
        // if (linkedinConfig && await isLinkedinAutoPostEnabled(db)) {
        //   const liText = linkedin.formatSinglePost({ ... });
        //   const liResult = await linkedin.post({ text: liText });
        //   if (liResult.success) {
        //     await eventPublisher.publish({
        //       type: "article:posted",
        //       data: { id: articleId, platform: "linkedin", postId: liResult.postId },
        //     });
        //   }
        // }
        // ─────────────────────────────────────────────────────────────────────

        return {
          success: true,
          platform: "telegram",
          postId: postResult.postId,
        };
      }

      logger.warn({ jobName: job.name }, "[distribution] unknown job type");
      return { skipped: true, reason: "unknown_job_type" };
    },
    { connection, concurrency: 1 }, // Low concurrency for rate limiting
  );
};
