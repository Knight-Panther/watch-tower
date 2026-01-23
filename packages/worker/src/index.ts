import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Queue } from "bullmq";
import {
  baseEnvSchema,
  createSupabaseClient,
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  QUEUE_FEED,
  QUEUE_MAINTENANCE,
} from "@watch-tower/shared";
import { createFeedWorker } from "./processors/feed";
import { createMaintenanceWorker } from "./processors/maintenance";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const env = baseEnvSchema.parse(process.env);
const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
};

const supabase = createSupabaseClient({
  url: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const feedQueue = new Queue(QUEUE_FEED, {
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

const feedWorker = createFeedWorker({ connection, supabase });
const maintenanceWorker = createMaintenanceWorker({
  connection,
  supabase,
  feedQueue,
});

feedWorker.on("failed", (job, err) => {
  console.error(`[feed] job ${job?.id ?? "unknown"} failed`, err.message);
});

maintenanceWorker.on("failed", (job, err) => {
  console.error(`[maintenance] job ${job?.id ?? "unknown"} failed`, err.message);
});

// Clean stale state from previous runs
await feedQueue.drain();
await maintenanceQueue.drain();
await feedQueue.clean(0, 0, "failed");
await maintenanceQueue.clean(0, 0, "failed");
console.info("[worker] cleaned stale jobs");

// Set up recurring jobs (BullMQ deduplicates by jobId automatically)
await maintenanceQueue.add(
  JOB_MAINTENANCE_CLEANUP,
  {},
  { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: JOB_MAINTENANCE_CLEANUP }
);

await maintenanceQueue.add(
  JOB_MAINTENANCE_SCHEDULE,
  {},
  { repeat: { every: 60 * 1000 }, jobId: JOB_MAINTENANCE_SCHEDULE }
);

// Run scheduler immediately on startup
await maintenanceQueue.add(JOB_MAINTENANCE_SCHEDULE, {}, { jobId: "schedule-startup" });
console.info("[worker] started, scheduler will run immediately");
