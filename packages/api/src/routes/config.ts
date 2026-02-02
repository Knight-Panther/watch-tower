import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { appConfig } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

const CONSTRAINTS = {
  feedItemsTtl: { min: 30, max: 60, unit: "days" },
  fetchRunsTtl: { min: 1, max: 2160, unit: "hours" },
  interval: { min: 1, max: 4320, unit: "minutes" },
  maxAge: { min: 1, max: 15, unit: "days" },
  llmTelemetryTtl: { min: 1, max: 60, unit: "days" },
  articleImagesTtl: { min: 1, max: 60, unit: "days" },
  postDeliveriesTtl: { min: 1, max: 60, unit: "days" },
} as const;

const getConfigValue = async (deps: ApiDeps, key: string, fallback: number) => {
  const [row] = await deps.db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  return row ? Number(row.value) : fallback;
};

const upsertConfig = async (deps: ApiDeps, key: string, value: number) => {
  const [row] = await deps.db
    .insert(appConfig)
    .values({ key, value: String(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value: String(value), updatedAt: new Date() },
    })
    .returning();
  return row;
};

export const registerConfigRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/config/constraints", { preHandler: deps.requireApiKey }, async () => {
    return CONSTRAINTS;
  });

  app.get("/config/feed-items-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "feed_items_ttl_days", 60);
    return { days };
  });

  app.get("/config/feed-fetch-runs-ttl", { preHandler: deps.requireApiKey }, async () => {
    const hours = await getConfigValue(deps, "feed_fetch_runs_ttl_hours", 336);
    return { hours };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/feed-items-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.feedItemsTtl.min ||
        days > CONSTRAINTS.feedItemsTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.feedItemsTtl.min} and ${CONSTRAINTS.feedItemsTtl.max}`,
        });
      }
      await upsertConfig(deps, "feed_items_ttl_days", days);
      return { days };
    },
  );

  app.patch<{ Body: { hours: number } }>(
    "/config/feed-fetch-runs-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { hours } = request.body ?? {};
      if (
        !Number.isFinite(hours) ||
        hours < CONSTRAINTS.fetchRunsTtl.min ||
        hours > CONSTRAINTS.fetchRunsTtl.max
      ) {
        return reply.code(400).send({
          error: `hours must be a number between ${CONSTRAINTS.fetchRunsTtl.min} and ${CONSTRAINTS.fetchRunsTtl.max}`,
        });
      }
      await upsertConfig(deps, "feed_fetch_runs_ttl_hours", hours);
      return { hours };
    },
  );

  // LLM Telemetry TTL
  app.get("/config/llm-telemetry-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "llm_telemetry_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/llm-telemetry-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.llmTelemetryTtl.min ||
        days > CONSTRAINTS.llmTelemetryTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.llmTelemetryTtl.min} and ${CONSTRAINTS.llmTelemetryTtl.max}`,
        });
      }
      await upsertConfig(deps, "llm_telemetry_ttl_days", days);
      return { days };
    },
  );

  // Article Images TTL
  app.get("/config/article-images-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "article_images_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/article-images-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.articleImagesTtl.min ||
        days > CONSTRAINTS.articleImagesTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.articleImagesTtl.min} and ${CONSTRAINTS.articleImagesTtl.max}`,
        });
      }
      await upsertConfig(deps, "article_images_ttl_days", days);
      return { days };
    },
  );

  // Post Deliveries TTL
  app.get("/config/post-deliveries-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "post_deliveries_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/post-deliveries-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.postDeliveriesTtl.min ||
        days > CONSTRAINTS.postDeliveriesTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.postDeliveriesTtl.min} and ${CONSTRAINTS.postDeliveriesTtl.max}`,
        });
      }
      await upsertConfig(deps, "post_deliveries_ttl_days", days);
      return { days };
    },
  );
};
