import { Worker } from "bullmq";
import { sql, eq } from "drizzle-orm";
import {
  QUEUE_DISTRIBUTION,
  JOB_DISTRIBUTION_IMMEDIATE,
  JOB_DISTRIBUTION_POST,
  logger,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { postBatches } from "@watch-tower/db";
import { createTelegramProvider, type TelegramConfig } from "@watch-tower/social";
import type { EventPublisher } from "../events.js";

type DistributionDeps = {
  connection: { host: string; port: number };
  db: Database;
  telegramConfig: TelegramConfig;
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

        // Format and post to Telegram
        const text = telegram.formatSinglePost({
          title: article.title,
          summary: article.llmSummary || article.title,
          url: article.url,
          sector: article.sectorName || "News",
        });

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

        return {
          success: true,
          platform: "telegram",
          postId: postResult.postId,
        };
      }

      // ─── Digest Post (Batch of Articles) ────────────────────────────────────
      if (job.name === JOB_DISTRIBUTION_POST) {
        const { batchId } = job.data as { batchId: string };
        logger.info({ batchId }, "[distribution] processing digest post");

        // ATOMIC CLAIM: Update approved -> posting and fetch in one operation
        const claimResult = await db.execute(sql`
          UPDATE post_batches
          SET status = 'posting'
          WHERE id = ${batchId}::uuid
            AND status = 'approved'
          RETURNING
            id,
            article_ids as "articleIds",
            content_text as "contentText",
            (SELECT name FROM sectors WHERE id = post_batches.sector_id) as "sectorName"
        `);

        const claimedBatches = claimResult.rows as {
          id: string;
          articleIds: string[];
          contentText: string | null;
          sectorName: string | null;
        }[];

        if (claimedBatches.length === 0) {
          // Check if already posted (idempotency)
          const checkResult = await db.execute(sql`
            SELECT status FROM post_batches WHERE id = ${batchId}::uuid
          `);
          const currentStatus = (checkResult.rows[0] as { status: string } | undefined)?.status;

          if (currentStatus === "posted") {
            logger.info({ batchId }, "[distribution] batch already posted (idempotent skip)");
            return { skipped: true, reason: "already_posted" };
          }

          logger.warn({ batchId, currentStatus }, "[distribution] batch not found or not approved");
          return { skipped: true, reason: "not_found_or_not_approved" };
        }

        const batch = claimedBatches[0];

        // If contentText is pre-generated, use it; otherwise fetch articles
        let text: string;

        if (batch.contentText) {
          text = batch.contentText;
        } else if (batch.articleIds && batch.articleIds.length > 0) {
          // Fetch articles for this batch
          const articleIdsLiteral = `{${batch.articleIds.join(",")}}`;
          const articlesResult = await db.execute(sql`
            SELECT
              a.id,
              a.title,
              a.url,
              a.llm_summary as "llmSummary"
            FROM articles a
            WHERE a.id = ANY(${articleIdsLiteral}::uuid[])
          `);

          const articles = articlesResult.rows as {
            id: string;
            title: string;
            url: string;
            llmSummary: string | null;
          }[];

          if (articles.length === 0) {
            logger.warn({ batchId }, "[distribution] batch articles not found");
            // Reset batch to failed state
            await db
              .update(postBatches)
              .set({ status: "failed" })
              .where(eq(postBatches.id, batchId));
            return { skipped: true, reason: "articles_not_found" };
          }

          text = telegram.formatDigestPost(
            articles.map((a) => ({
              title: a.title,
              summary: a.llmSummary || "",
              url: a.url,
              sector: batch.sectorName || "News",
            })),
            batch.sectorName || "News",
          );
        } else {
          logger.warn({ batchId }, "[distribution] batch has no articles");
          await db.update(postBatches).set({ status: "failed" }).where(eq(postBatches.id, batchId));
          return { skipped: true, reason: "no_articles" };
        }

        // Post to Telegram
        const postResult = await telegram.post({ text });

        if (!postResult.success) {
          logger.error({ batchId, error: postResult.error }, "[distribution] digest post failed");

          // Update batch status to failed
          await db.update(postBatches).set({ status: "failed" }).where(eq(postBatches.id, batchId));

          return { success: false, error: postResult.error };
        }

        // Update batch status to posted
        await db
          .update(postBatches)
          .set({ status: "posted" })
          .where(eq(postBatches.id, batchId));

        // Update all articles in batch to posted
        if (batch.articleIds && batch.articleIds.length > 0) {
          const articleIdsLiteral = `{${batch.articleIds.join(",")}}`;
          await db.execute(sql`
            UPDATE articles
            SET pipeline_stage = 'posted'
            WHERE id = ANY(${articleIdsLiteral}::uuid[])
          `);
        }

        logger.info(
          { batchId, messageId: postResult.postId, articleCount: batch.articleIds?.length ?? 0 },
          "[distribution] digest posted to telegram",
        );

        return {
          success: true,
          platform: "telegram",
          postId: postResult.postId,
          articleCount: batch.articleIds?.length ?? 0,
        };
      }

      logger.warn({ jobName: job.name }, "[distribution] unknown job type");
      return { skipped: true, reason: "unknown_job_type" };
    },
    { connection, concurrency: 1 }, // Low concurrency for rate limiting
  );
};
