import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server";

export const registerConfigRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get(
    "/config/feed-items-ttl",
    { preHandler: deps.requireApiKey },
    async (_request, reply) => {
      const { data, error } = await deps.supabase
        .from("app_config")
        .select("value")
        .eq("key", "feed_items_ttl_days")
        .single();

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      return { days: Number(data?.value ?? 60) };
    },
  );

  app.get(
    "/config/feed-fetch-runs-ttl",
    { preHandler: deps.requireApiKey },
    async (_request, reply) => {
      const { data, error } = await deps.supabase
        .from("app_config")
        .select("value")
        .eq("key", "feed_fetch_runs_ttl_hours")
        .single();

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      return { hours: Number(data?.value ?? 336) };
    },
  );

  app.patch<{ Body: { days: number } }>(
    "/config/feed-items-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (!days || days < 30 || days > 60) {
        return reply.code(400).send({ error: "days must be between 30 and 60" });
      }

      const { data, error } = await deps.supabase
        .from("app_config")
        .upsert({
          key: "feed_items_ttl_days",
          value: String(days),
          updated_at: new Date().toISOString(),
        })
        .select("value")
        .single();

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      return { days: Number(data?.value ?? days) };
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

      const { data, error } = await deps.supabase
        .from("app_config")
        .upsert({
          key: "feed_fetch_runs_ttl_hours",
          value: String(hours),
          updated_at: new Date().toISOString(),
        })
        .select("value")
        .single();

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      return { hours: Number(data?.value ?? hours) };
    },
  );
};
