import type { FastifyInstance } from "fastify";
import {
  articles,
  feedFetchRuns,
  llmTelemetry,
  postDeliveries,
  articleImages,
} from "@watch-tower/db";
import { logger } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export type ResetResult = {
  success: boolean;
  cleared: {
    articles: number;
    feed_fetch_runs: number;
    llm_telemetry: number;
    post_deliveries: number;
    article_images: number;
    redis_keys: number;
  };
};

export const registerResetRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  /**
   * POST /reset
   *
   * Clears all transient data to start fresh:
   * - articles
   * - feed_fetch_runs
   * - llm_telemetry
   * - post_deliveries
   * - article_images
   * - Redis BullMQ keys (bull:*)
   *
   * Preserves configuration:
   * - sectors
   * - rss_sources
   * - scoring_rules
   * - social_accounts
   * - app_config
   */
  app.post<{ Body: { confirm: boolean } }>(
    "/reset",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { confirm } = request.body ?? {};

      if (confirm !== true) {
        return reply.code(400).send({
          error: "Reset requires confirmation. Send { confirm: true } to proceed.",
        });
      }

      logger.warn("[reset] starting full data reset...");

      const cleared = {
        articles: 0,
        feed_fetch_runs: 0,
        llm_telemetry: 0,
        post_deliveries: 0,
        article_images: 0,
        redis_keys: 0,
      };

      // 1. Clear database tables (order matters due to foreign keys)
      try {
        // post_deliveries references articles
        const postDeliveriesResult = await deps.db.delete(postDeliveries).returning({ id: postDeliveries.id });
        cleared.post_deliveries = postDeliveriesResult.length;

        // article_images references articles
        const articleImagesResult = await deps.db.delete(articleImages).returning({ id: articleImages.id });
        cleared.article_images = articleImagesResult.length;

        // llm_telemetry references articles
        const llmTelemetryResult = await deps.db.delete(llmTelemetry).returning({ id: llmTelemetry.id });
        cleared.llm_telemetry = llmTelemetryResult.length;

        // articles (now safe to delete)
        const articlesResult = await deps.db.delete(articles).returning({ id: articles.id });
        cleared.articles = articlesResult.length;

        // feed_fetch_runs (independent)
        const feedFetchRunsResult = await deps.db.delete(feedFetchRuns).returning({ id: feedFetchRuns.id });
        cleared.feed_fetch_runs = feedFetchRunsResult.length;

        logger.info("[reset] database tables cleared", cleared);
      } catch (err) {
        logger.error("[reset] database clear failed", err);
        return reply.code(500).send({
          error: "Failed to clear database tables",
          details: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Clear Redis BullMQ keys
      try {
        const keys = await deps.redis.keys("bull:*");
        if (keys.length > 0) {
          await deps.redis.del(...keys);
        }
        cleared.redis_keys = keys.length;
        logger.info(`[reset] cleared ${keys.length} Redis keys`);
      } catch (err) {
        logger.error("[reset] Redis clear failed", err);
        return reply.code(500).send({
          error: "Database cleared but failed to clear Redis queues",
          details: err instanceof Error ? err.message : String(err),
          partial_cleared: cleared,
        });
      }

      logger.warn("[reset] full data reset completed", cleared);

      return {
        success: true,
        cleared,
      } satisfies ResetResult;
    },
  );
};
