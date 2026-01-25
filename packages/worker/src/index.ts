import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import {
  baseEnvSchema,
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  QUEUE_INGEST,
  QUEUE_MAINTENANCE,
  setLogLevel,
  logger,
} from "@watch-tower/shared";
import { createDb } from "@watch-tower/db";
import { createIngestWorker } from "./processors/feed.js";
import { createMaintenanceWorker } from "./processors/maintenance.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const main = async () => {
  const env = baseEnvSchema.parse(process.env);
  setLogLevel(env.LOG_LEVEL);
  const connection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };

  // Redis pre-flight check
  const redis = new Redis(connection);
  try {
    await redis.ping();
    logger.info("[worker] redis connected");
  } catch (err) {
    logger.error("[worker] redis unreachable, exiting", err);
    process.exit(1);
  }
  await redis.quit();

  // DB init + verification
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  try {
    await db.execute(sql`SELECT 1`);
    logger.info("[worker] database connected");
  } catch (err) {
    logger.error("[worker] database unreachable, exiting", err);
    process.exit(1);
  }

  const ingestQueue = new Queue(QUEUE_INGEST, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  const maintenanceQueue = new Queue(QUEUE_MAINTENANCE, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  });

  const ingestWorker = createIngestWorker({ connection, db });
  const maintenanceWorker = createMaintenanceWorker({
    connection,
    db,
    ingestQueue,
  });

  ingestWorker.on("failed", (job, err) => {
    logger.error(`[ingest] job ${job?.id ?? "unknown"} failed`, err.message);
  });

  maintenanceWorker.on("failed", (job, err) => {
    logger.error(`[maintenance] job ${job?.id ?? "unknown"} failed`, err.message);
  });

  // Clean failed jobs from previous runs (waiting jobs are preserved)
  await ingestQueue.clean(0, 0, "failed");
  await maintenanceQueue.clean(0, 0, "failed");
  logger.info("[worker] cleaned failed jobs");

  // Set up recurring jobs (BullMQ deduplicates by jobId automatically)
  await maintenanceQueue.add(
    JOB_MAINTENANCE_CLEANUP,
    {},
    { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: JOB_MAINTENANCE_CLEANUP },
  );

  await maintenanceQueue.add(
    JOB_MAINTENANCE_SCHEDULE,
    {},
    { repeat: { every: 30 * 1000 }, jobId: JOB_MAINTENANCE_SCHEDULE },
  );

  // Run scheduler immediately on startup
  await maintenanceQueue.add(JOB_MAINTENANCE_SCHEDULE, {}, { jobId: "schedule-startup" });
  logger.info("[worker] started successfully");

  // Graceful shutdown: finish in-flight jobs, then close connections
  const shutdown = async () => {
    logger.info("[worker] shutting down...");

    // Force exit after 30s if graceful shutdown hangs
    const timeoutHandle = setTimeout(() => {
      logger.error("[worker] forced exit after timeout");
      process.exit(1);
    }, 30_000).unref();

    try {
      await ingestWorker.close();
      await maintenanceWorker.close();
      await ingestQueue.close();
      await maintenanceQueue.close();
      await closeDb();
    } finally {
      clearTimeout(timeoutHandle);
    }

    logger.info("[worker] shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main().catch((err) => {
  logger.error("[worker] startup failed", err);
  process.exit(1);
});
