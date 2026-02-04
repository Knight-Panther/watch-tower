import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { sql } from "drizzle-orm";
import { platformHealth } from "@watch-tower/db";
import { JOB_PLATFORM_HEALTH_CHECK } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export const registerHealthRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  const { db, requireApiKey, maintenanceQueue } = deps;

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /health - System health check (no auth required)
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/health", async (_request, reply) => {
    let redisStatus = "ok";
    let dbStatus = "ok";

    const redis = new Redis({
      ...deps.redisConnection,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /health/platforms - Get health status for all social platforms
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/health/platforms", { preHandler: requireApiKey }, async (_req, reply) => {
    const rows = await db.select().from(platformHealth);

    const platforms = rows.map((row) => {
      // Calculate status
      let status: "active" | "expiring" | "expired" | "error" = "active";
      let daysRemaining: number | undefined;

      if (!row.healthy) {
        status = "error";
      } else if (row.tokenExpiresAt) {
        const now = new Date();
        const msRemaining = row.tokenExpiresAt.getTime() - now.getTime();
        daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));

        if (daysRemaining <= 0) {
          status = "expired";
        } else if (daysRemaining <= 14) {
          status = "expiring";
        }
      }

      return {
        platform: row.platform,
        healthy: row.healthy,
        status,
        error: row.error,
        expiresAt: row.tokenExpiresAt?.toISOString() ?? null,
        daysRemaining,
        lastCheck: row.lastCheckAt.toISOString(),
        lastPost: row.lastPostAt?.toISOString() ?? null,
        rateLimit: {
          remaining: row.rateLimitRemaining,
          limit: row.rateLimitMax,
          percent: row.rateLimitPercent,
          resetsAt: row.rateLimitResetsAt?.toISOString() ?? null,
        },
      };
    });

    return reply.send({ platforms });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /health/platforms/refresh - Trigger immediate health check
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/health/platforms/refresh", { preHandler: requireApiKey }, async (_req, reply) => {
    await maintenanceQueue.add(
      JOB_PLATFORM_HEALTH_CHECK,
      {},
      { priority: 1, jobId: `health-refresh-${Date.now()}` },
    );

    return reply.send({ message: "Health check queued" });
  });
};
