import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { appConfig } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

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
      if (!days || days < 30 || days > 60) {
        return reply.code(400).send({ error: "days must be between 30 and 60" });
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
      if (!hours || hours <= 0 || hours > 2160) {
        return reply
          .code(400)
          .send({ error: "hours must be greater than 0 and at most 2160" });
      }
      await upsertConfig(deps, "feed_fetch_runs_ttl_hours", hours);
      return { hours };
    },
  );
};
