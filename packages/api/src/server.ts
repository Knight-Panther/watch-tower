import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { Queue } from "bullmq";
import { baseEnvSchema, QUEUE_INGEST, QUEUE_MAINTENANCE } from "@watch-tower/shared";
import { createDb, type Database } from "@watch-tower/db";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSectorRoutes } from "./routes/sectors.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { createRequireApiKey } from "./utils/auth.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

export type ApiDeps = {
  db: Database;
  maintenanceQueue: Queue;
  ingestQueue: Queue;
  requireApiKey: ReturnType<typeof createRequireApiKey>;
};

export const buildApp = async (): Promise<FastifyInstance> => {
  const env = baseEnvSchema.parse(process.env);
  const db = createDb(env.DATABASE_URL);

  const queueConnection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };
  const ingestQueue = new Queue(QUEUE_INGEST, { connection: queueConnection });
  const maintenanceQueue = new Queue(QUEUE_MAINTENANCE, { connection: queueConnection });

  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  const requireApiKey = createRequireApiKey(env.API_KEY ?? "");
  const deps: ApiDeps = { db, maintenanceQueue, ingestQueue, requireApiKey };

  registerHealthRoutes(app);
  registerSectorRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerIngestRoutes(app, deps);
  registerStatsRoutes(app, deps);

  return app;
};
