import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import {
  baseEnvSchema,
  QUEUE_INGEST,
  QUEUE_MAINTENANCE,
  setLogLevel,
  logger,
} from "@watch-tower/shared";
import { createDb, type Database } from "@watch-tower/db";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSectorRoutes } from "./routes/sectors.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";
import { registerArticlesRoutes } from "./routes/articles.js";
import { registerScheduledRoutes } from "./routes/scheduled.js";
import { registerScoringRulesRoutes } from "./routes/scoring-rules.js";
import { registerResetRoutes } from "./routes/reset.js";
import { registerSocialAccountRoutes } from "./routes/social-accounts.js";
import { createRequireApiKey } from "./utils/auth.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

export type ApiDeps = {
  db: Database;
  redis: Redis;
  redisConnection: { host: string; port: number };
  maintenanceQueue: Queue;
  ingestQueue: Queue;
  requireApiKey: ReturnType<typeof createRequireApiKey>;
};

export const buildApp = async () => {
  const env = baseEnvSchema.parse(process.env);
  setLogLevel(env.LOG_LEVEL);

  // Enforce API_KEY in production - never allow auth bypass
  if (!env.API_KEY) {
    logger.error("[api] API_KEY is required - refusing to start without authentication");
    process.exit(1);
  }

  // Redis connection (kept alive for caching)
  const redisConnection = { host: env.REDIS_HOST, port: env.REDIS_PORT };
  const redis = new Redis({
    ...redisConnection,
    maxRetriesPerRequest: null, // BullMQ requirement
    retryStrategy: (times) => Math.min(times * 100, 3000), // Exponential backoff, max 3s
  });

  // Redis connection event handlers
  redis.on("error", (err) => {
    logger.error("[api] redis error", err.message);
  });
  redis.on("reconnecting", () => {
    logger.warn("[api] redis reconnecting...");
  });
  redis.on("connect", () => {
    logger.info("[api] redis connected");
  });

  try {
    await redis.ping();
    logger.info("[api] redis ready");
  } catch (err) {
    logger.error("[api] redis unreachable, exiting", err);
    process.exit(1);
  }

  // DB init + verification
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  try {
    await db.execute(sql`SELECT 1`);
    logger.info("[api] database connected");
  } catch (err) {
    logger.error("[api] database unreachable, exiting", err);
    process.exit(1);
  }

  const ingestQueue = new Queue(QUEUE_INGEST, { connection: redisConnection });
  const maintenanceQueue = new Queue(QUEUE_MAINTENANCE, { connection: redisConnection });

  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });

  // Rate limiting: disabled in dev, 200/min in production
  // Only affects API HTTP requests, not internal worker processing
  const isDev = process.env.NODE_ENV !== "production";
  if (!isDev) {
    await app.register(rateLimit, {
      max: 200,
      timeWindow: "1 minute",
      errorResponseBuilder: () => ({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Rate limit exceeded. Try again later.",
      }),
    });
  }

  const requireApiKey = createRequireApiKey(env.API_KEY ?? "");
  const deps: ApiDeps = {
    db,
    redis,
    redisConnection,
    maintenanceQueue,
    ingestQueue,
    requireApiKey,
  };

  registerHealthRoutes(app, deps);
  registerSectorRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerIngestRoutes(app, deps);
  registerStatsRoutes(app, deps);
  registerEventsRoutes(app, deps);
  registerTelemetryRoutes(app, deps);
  registerArticlesRoutes(app, deps);
  registerScheduledRoutes(app, deps);
  registerScoringRulesRoutes(app, deps);
  registerResetRoutes(app, deps);
  registerSocialAccountRoutes(app, deps);

  const closeRedis = () => redis.quit();
  return { app, port: env.PORT, closeDb, closeRedis, ingestQueue, maintenanceQueue };
};
