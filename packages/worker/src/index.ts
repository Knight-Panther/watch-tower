import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Queue } from "bullmq";
import {
  baseEnvSchema,
  createSupabaseClient,
  JOB_INGEST_POLL,
  JOB_MAINTENANCE_CLEANUP,
  QUEUE_FEED,
  QUEUE_INGEST,
  QUEUE_MAINTENANCE,
} from "@watch-tower/shared";
import { createIngestWorker } from "./processors/ingest";
import { createFeedWorker } from "./processors/feed";
import { createMaintenanceWorker } from "./processors/maintenance";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const env = baseEnvSchema.parse(process.env);
const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
};

const supabase = createSupabaseClient({
  url: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const ingestQueue = new Queue(QUEUE_INGEST, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
const feedQueue = new Queue(QUEUE_FEED, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
const maintenanceQueue = new Queue(QUEUE_MAINTENANCE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

const ingestWorker = createIngestWorker({
  connection,
  supabase,
  feedQueue,
});
const feedWorker = createFeedWorker({ connection, supabase });
const maintenanceWorker = createMaintenanceWorker({ connection, supabase });

ingestWorker.on("failed", (job, err) => {
  console.error(`[ingest] job ${job?.id ?? "unknown"} failed`, err);
});

feedWorker.on("failed", (job, err) => {
  console.error(`[feed-processing] job ${job?.id ?? "unknown"} failed`, err);
});

maintenanceWorker.on("failed", (job, err) => {
  console.error(`[maintenance] job ${job?.id ?? "unknown"} failed`, err);
});

await ingestQueue.add(
  JOB_INGEST_POLL,
  {},
  { repeat: { every: 15 * 60 * 1000 }, jobId: JOB_INGEST_POLL }
);

await maintenanceQueue.add(
  JOB_MAINTENANCE_CLEANUP,
  {},
  { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: JOB_MAINTENANCE_CLEANUP }
);
