import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { sql } from "drizzle-orm";
import type { ApiDeps } from "../server.js";

export const registerHealthRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/health", async (_request, reply) => {
    let redisStatus = "ok";
    let dbStatus = "ok";

    const redis = new Redis({ ...deps.redisConnection, lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      await redis.ping();
    } catch {
      redisStatus = "error";
    } finally {
      await redis.quit().catch(() => {});
    }

    try {
      await deps.db.execute(sql`SELECT 1`);
    } catch {
      dbStatus = "error";
    }

    const status = redisStatus === "ok" && dbStatus === "ok" ? "ok" : "degraded";
    const code = status === "ok" ? 200 : 503;
    return reply.code(code).send({ status, redis: redisStatus, database: dbStatus });
  });
};
