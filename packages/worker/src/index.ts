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
} from "@watch-tower/shared";
import { createDb } from "@watch-tower/db";
import { createIngestWorker } from "./processors/feed.js";
import { createMaintenanceWorker } from "./processors/maintenance.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const main = async () => {
  const env = baseEnvSchema.parse(process.env);
  const connection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };

  // Redis pre-flight check
  const redis = new Redis(connection);
  try {
    await redis.ping();
    console.info("[worker] redis connected");
  } catch (err) {
    console.error("[worker] redis unreachable, exiting", err);
    process.exit(1);
  }
  await redis.quit();

  // DB init + verification
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  try {
    await db.execute(sql`SELECT 1`);
    console.info("[worker] database connected");
  } catch (err) {
    console.error("[worker] database unreachable, exiting", err);
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
    console.error(`[ingest] job ${job?.id ?? "unknown"} failed`, err.message);
  });

  maintenanceWorker.on("failed", (job, err) => {
    console.error(`[maintenance] job ${job?.id ?? "unknown"} failed`, err.message);
  });

  // Clean failed jobs from previous runs (waiting jobs are preserved)
  await ingestQueue.clean(0, 0, "failed");
  await maintenanceQueue.clean(0, 0, "failed");
  console.info("[worker] cleaned failed jobs");

  // Set up recurring jobs (BullMQ deduplicates by jobId automatically)
  await maintenanceQueue.add(
    JOB_MAINTENANCE_CLEANUP,
    {},
    { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: JOB_MAINTENANCE_CLEANUP },
  );

  await maintenanceQueue.add(
    JOB_MAINTENANCE_SCHEDULE,
    {},
    { repeat: { every: 60 * 1000 }, jobId: JOB_MAINTENANCE_SCHEDULE },
  );

  // Run scheduler immediately on startup
  await maintenanceQueue.add(JOB_MAINTENANCE_SCHEDULE, {}, { jobId: "schedule-startup" });
  console.info("[worker] started successfully");

  // Graceful shutdown: finish in-flight jobs, then close connections
  const shutdown = async () => {
    console.info("[worker] shutting down...");
    await ingestWorker.close();
    await maintenanceWorker.close();
    await ingestQueue.close();
    await maintenanceQueue.close();
    await closeDb();
    console.info("[worker] shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main().catch((err) => {
  console.error("[worker] startup failed", err);
  process.exit(1);
});
