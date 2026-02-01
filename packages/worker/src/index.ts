import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import {
  baseEnvSchema,
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  JOB_SEMANTIC_BATCH,
  JOB_LLM_SCORE_BATCH,
  QUEUE_INGEST,
  QUEUE_MAINTENANCE,
  QUEUE_SEMANTIC_DEDUP,
  QUEUE_LLM_BRAIN,
  QUEUE_DISTRIBUTION,
  setLogLevel,
  logger,
} from "@watch-tower/shared";
import { createDb } from "@watch-tower/db";
import { createEmbeddingProvider } from "@watch-tower/embeddings";
import { createLLMProviderWithFallback } from "@watch-tower/llm";
import { createIngestWorker } from "./processors/feed.js";
import { createMaintenanceWorker } from "./processors/maintenance.js";
import { createSemanticDedupWorker } from "./processors/semantic-dedup.js";
import { createLLMBrainWorker } from "./processors/llm-brain.js";
import { createDistributionWorker } from "./processors/distribution.js";
import { createEventPublisher } from "./events.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const main = async () => {
  const env = baseEnvSchema.parse(process.env);
  setLogLevel(env.LOG_LEVEL);

  // BullMQ connection config with resilience settings
  const connection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null, // Required for BullMQ blocking operations
    retryStrategy: (times: number) => Math.min(times * 100, 3000), // Exponential backoff, max 3s
  };

  // Redis connection for pub/sub events (kept open for event publishing)
  const redis = new Redis(connection);

  redis.on("error", (err) => {
    logger.error("[worker] redis error", err.message);
  });
  redis.on("reconnecting", () => {
    logger.warn("[worker] redis reconnecting...");
  });

  try {
    await redis.ping();
    logger.info("[worker] redis connected");
  } catch (err) {
    logger.error("[worker] redis unreachable, exiting", err);
    process.exit(1);
  }

  // Event publisher for real-time UI updates
  const eventPublisher = createEventPublisher(redis);

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

  // Semantic dedup queue
  const semanticDedupQueue = new Queue(QUEUE_SEMANTIC_DEDUP, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  // LLM queue (placeholder for Stage 3)
  const llmQueue = new Queue(QUEUE_LLM_BRAIN, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 10000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  // Distribution queue for posting to social platforms
  const distributionQueue = new Queue(QUEUE_DISTRIBUTION, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30000 }, // Longer backoff for rate limits
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  // Embedding provider (skip if no API key)
  const embeddingProvider = env.OPENAI_API_KEY
    ? createEmbeddingProvider({
        provider: "openai",
        apiKey: env.OPENAI_API_KEY,
        model: env.EMBEDDING_MODEL,
      })
    : null;

  const ingestWorker = createIngestWorker({ connection, db, eventPublisher });
  const maintenanceWorker = createMaintenanceWorker({
    connection,
    db,
    ingestQueue,
  });

  // Semantic dedup worker (only if embeddings enabled)
  const semanticDedupWorker = embeddingProvider
    ? createSemanticDedupWorker({
        connection,
        db,
        embeddingProvider,
        llmQueue,
        similarityThreshold: env.SIMILARITY_THRESHOLD,
        eventPublisher,
      })
    : null;

  // LLM provider configuration
  // Resolve API key based on provider
  const getApiKeyForProvider = (provider: string): string | undefined => {
    switch (provider) {
      case "claude":
        return env.ANTHROPIC_API_KEY;
      case "openai":
        return env.OPENAI_API_KEY;
      case "deepseek":
        return env.DEEPSEEK_API_KEY;
      default:
        return undefined;
    }
  };

  // Resolve model based on provider (per-provider env vars)
  const getModelForProvider = (provider: string): string | undefined => {
    switch (provider) {
      case "claude":
        return env.LLM_CLAUDE_MODEL;
      case "openai":
        return env.LLM_OPENAI_MODEL;
      case "deepseek":
        return env.LLM_DEEPSEEK_MODEL;
      default:
        return undefined;
    }
  };

  const primaryApiKey = getApiKeyForProvider(env.LLM_PROVIDER);
  const fallbackApiKey = env.LLM_FALLBACK_PROVIDER
    ? getApiKeyForProvider(env.LLM_FALLBACK_PROVIDER)
    : undefined;

  // Warn if fallback is configured but API key is missing
  if (env.LLM_FALLBACK_PROVIDER && !fallbackApiKey) {
    logger.warn(
      `[worker] LLM_FALLBACK_PROVIDER set to '${env.LLM_FALLBACK_PROVIDER}' but no API key found. Fallback disabled.`,
    );
  }

  const llmProvider = primaryApiKey
    ? createLLMProviderWithFallback({
        primary: {
          provider: env.LLM_PROVIDER,
          apiKey: primaryApiKey,
          model: getModelForProvider(env.LLM_PROVIDER),
        },
        fallback:
          env.LLM_FALLBACK_PROVIDER && fallbackApiKey
            ? {
                provider: env.LLM_FALLBACK_PROVIDER,
                apiKey: fallbackApiKey,
                model: env.LLM_FALLBACK_MODEL ?? getModelForProvider(env.LLM_FALLBACK_PROVIDER),
              }
            : undefined,
      })
    : null;

  // LLM brain worker (only if provider enabled)
  const llmBrainWorker = llmProvider
    ? createLLMBrainWorker({
        connection,
        db,
        llmProvider,
        eventPublisher,
        autoApproveThreshold: env.LLM_AUTO_APPROVE_THRESHOLD,
        autoRejectThreshold: env.LLM_AUTO_REJECT_THRESHOLD,
        // Pass distribution queue only if Telegram is configured
        distributionQueue: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? distributionQueue : undefined,
      })
    : null;

  // Distribution worker (only if Telegram configured)
  const distributionWorker =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? createDistributionWorker({
          connection,
          db,
          telegramConfig: {
            botToken: env.TELEGRAM_BOT_TOKEN,
            defaultChatId: env.TELEGRAM_CHAT_ID,
          },
          eventPublisher,
        })
      : null;

  // Worker error handlers
  ingestWorker.on("failed", (job, err) => {
    logger.error(`[ingest] job ${job?.id ?? "unknown"} failed`, err.message);
  });
  ingestWorker.on("error", (err) => {
    logger.error("[ingest] worker error", err.message);
  });
  ingestWorker.on("stalled", (jobId) => {
    logger.warn(`[ingest] job ${jobId} stalled - will be retried`);
  });

  maintenanceWorker.on("failed", (job, err) => {
    logger.error(`[maintenance] job ${job?.id ?? "unknown"} failed`, err.message);
  });
  maintenanceWorker.on("error", (err) => {
    logger.error("[maintenance] worker error", err.message);
  });
  maintenanceWorker.on("stalled", (jobId) => {
    logger.warn(`[maintenance] job ${jobId} stalled - will be retried`);
  });

  if (semanticDedupWorker) {
    semanticDedupWorker.on("failed", (job, err) => {
      logger.error(`[semantic-dedup] job ${job?.id ?? "unknown"} failed`, err.message);
    });
    semanticDedupWorker.on("error", (err) => {
      logger.error("[semantic-dedup] worker error", err.message);
    });
    semanticDedupWorker.on("stalled", (jobId) => {
      logger.warn(`[semantic-dedup] job ${jobId} stalled - will be retried`);
    });
  }

  if (llmBrainWorker) {
    llmBrainWorker.on("failed", (job, err) => {
      logger.error(`[llm-brain] job ${job?.id ?? "unknown"} failed`, err.message);
    });
    llmBrainWorker.on("error", (err) => {
      logger.error("[llm-brain] worker error", err.message);
    });
    llmBrainWorker.on("stalled", (jobId) => {
      logger.warn(`[llm-brain] job ${jobId} stalled - will be retried`);
    });
  }

  if (distributionWorker) {
    distributionWorker.on("failed", (job, err) => {
      logger.error(`[distribution] job ${job?.id ?? "unknown"} failed`, err.message);
    });
    distributionWorker.on("error", (err) => {
      logger.error("[distribution] worker error", err.message);
    });
    distributionWorker.on("stalled", (jobId) => {
      logger.warn(`[distribution] job ${jobId} stalled - will be retried`);
    });
  }

  // Clean failed jobs from previous runs (waiting jobs are preserved)
  await ingestQueue.clean(0, 0, "failed");
  await maintenanceQueue.clean(0, 0, "failed");
  await semanticDedupQueue.clean(0, 0, "failed");
  await llmQueue.clean(0, 0, "failed");
  await distributionQueue.clean(0, 0, "failed");
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

  // Set up semantic dedup recurring job (every 60 seconds)
  if (semanticDedupWorker) {
    await semanticDedupQueue.add(
      JOB_SEMANTIC_BATCH,
      {},
      { repeat: { every: 60 * 1000 }, jobId: JOB_SEMANTIC_BATCH },
    );
    logger.info("[worker] semantic dedup enabled");
  } else {
    logger.info("[worker] semantic dedup disabled (no OPENAI_API_KEY)");
  }

  // Set up LLM brain recurring job (every 10 seconds for faster processing)
  if (llmBrainWorker) {
    await llmQueue.add(
      JOB_LLM_SCORE_BATCH,
      {},
      { repeat: { every: 10 * 1000 }, jobId: "llm-score-recurring" },
    );
    logger.info(`[worker] llm brain enabled (${llmProvider!.name}/${llmProvider!.model})`);
  } else {
    logger.warn(`[worker] llm brain disabled (no API key for ${env.LLM_PROVIDER})`);
    // NOTE: If LLM is disabled, semantic-dedup still enqueues jobs.
    // Jobs will accumulate until LLM is re-enabled.
    // To drain: enable LLM, or manually delete jobs from queue.
  }

  // Distribution worker status
  if (distributionWorker) {
    logger.info("[worker] distribution enabled (telegram)");
  } else {
    logger.info("[worker] distribution disabled (no TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)");
  }

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
      await semanticDedupWorker?.close();
      await llmBrainWorker?.close();
      await distributionWorker?.close();
      await ingestQueue.close();
      await maintenanceQueue.close();
      await semanticDedupQueue.close();
      await llmQueue.close();
      await distributionQueue.close();
      await redis.quit();
      await closeDb();
    } finally {
      clearTimeout(timeoutHandle);
    }

    logger.info("[worker] shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Windows: handle Ctrl+C in terminal (SIGBREAK)
  if (process.platform === "win32") {
    process.on("SIGBREAK", shutdown);
  }
};

main().catch((err) => {
  logger.error("[worker] startup failed", err);
  process.exit(1);
});
