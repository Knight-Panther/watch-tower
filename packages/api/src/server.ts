import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { Queue } from "bullmq";
import {
  baseEnvSchema,
  createSupabaseClient,
  QUEUE_FEED,
  QUEUE_INGEST,
} from "@watch-tower/shared";
import { registerHealthRoutes } from "./routes/health";
import { registerSectorRoutes } from "./routes/sectors";
import { registerSourceRoutes } from "./routes/sources";
import { registerConfigRoutes } from "./routes/config";
import { registerIngestRoutes } from "./routes/ingest";
import { registerStatsRoutes } from "./routes/stats";
import { createRequireApiKey } from "./utils/auth";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

export type ApiDeps = {
  supabase: ReturnType<typeof createSupabaseClient>;
  ingestQueue: Queue;
  feedQueue: Queue;
  requireApiKey: ReturnType<typeof createRequireApiKey>;
};

export const buildApp = async (): Promise<FastifyInstance> => {
  const env = baseEnvSchema.parse(process.env);
  const supabase = createSupabaseClient({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });

  const queueConnection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };
  const ingestQueue = new Queue(QUEUE_INGEST, { connection: queueConnection });
  const feedQueue = new Queue(QUEUE_FEED, { connection: queueConnection });

  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  const requireApiKey = createRequireApiKey(env.API_KEY ?? "");
  const deps: ApiDeps = { supabase, ingestQueue, feedQueue, requireApiKey };

  registerHealthRoutes(app);
  registerSectorRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerIngestRoutes(app, deps);
  registerStatsRoutes(app, deps);

  return app;
};
