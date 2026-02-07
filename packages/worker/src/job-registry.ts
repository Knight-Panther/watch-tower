import type { Queue } from "bullmq";
import {
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  JOB_SEMANTIC_BATCH,
  JOB_LLM_SCORE_BATCH,
  JOB_PLATFORM_HEALTH_CHECK,
  JOB_TRANSLATION_BATCH,
  logger,
} from "@watch-tower/shared";

type RepeatableJobDef = {
  queue: Queue;
  name: string;
  jobId: string;
  every: number;
};

type JobRegistryDeps = {
  maintenanceQueue: Queue;
  semanticDedupQueue?: Queue;
  llmQueue?: Queue;
  translationQueue?: Queue;
};

/**
 * Ensures all repeatable jobs are registered.
 * Safe to call multiple times - BullMQ deduplicates by jobId.
 *
 * This provides self-healing after:
 * - Redis restart/flush
 * - Reset Data clearing bull:* keys
 * - Any external interference with queue state
 */
export const ensureRepeatableJobs = async ({
  maintenanceQueue,
  semanticDedupQueue,
  llmQueue,
  translationQueue,
}: JobRegistryDeps): Promise<{ registered: number; alreadyExisted: number }> => {
  const jobs: RepeatableJobDef[] = [
    {
      queue: maintenanceQueue,
      name: JOB_MAINTENANCE_CLEANUP,
      jobId: JOB_MAINTENANCE_CLEANUP,
      every: 24 * 60 * 60 * 1000, // 24 hours
    },
    {
      queue: maintenanceQueue,
      name: JOB_MAINTENANCE_SCHEDULE,
      jobId: JOB_MAINTENANCE_SCHEDULE,
      every: 30 * 1000, // 30 seconds
    },
    {
      queue: maintenanceQueue,
      name: JOB_PLATFORM_HEALTH_CHECK,
      jobId: JOB_PLATFORM_HEALTH_CHECK,
      every: 2 * 60 * 60 * 1000, // 2 hours
    },
  ];

  // Conditional jobs based on enabled features
  if (semanticDedupQueue) {
    jobs.push({
      queue: semanticDedupQueue,
      name: JOB_SEMANTIC_BATCH,
      jobId: JOB_SEMANTIC_BATCH,
      every: 60 * 1000, // 60 seconds
    });
  }

  if (llmQueue) {
    jobs.push({
      queue: llmQueue,
      name: JOB_LLM_SCORE_BATCH,
      jobId: "llm-score-recurring",
      every: 10 * 1000, // 10 seconds
    });
  }

  if (translationQueue) {
    jobs.push({
      queue: translationQueue,
      name: JOB_TRANSLATION_BATCH,
      jobId: "translation-batch-repeat",
      every: 15 * 1000, // 15 seconds
    });
  }

  let registered = 0;
  let alreadyExisted = 0;

  for (const job of jobs) {
    try {
      // Check if repeatable job already exists
      const existing = await job.queue.getRepeatableJobs();
      // BullMQ repeatable jobs have: key, name, id (nullable), every, etc.
      // Match by name (job type) since that's most reliable
      const found = existing.some((r) => r.name === job.name);

      if (found) {
        alreadyExisted++;
        continue;
      }

      // Register the repeatable job
      await job.queue.add(job.name, {}, { repeat: { every: job.every }, jobId: job.jobId });

      registered++;
      logger.info(`[job-registry] registered missing job: ${job.jobId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[job-registry] failed to register ${job.jobId}: ${msg}`);
    }
  }

  if (registered > 0) {
    logger.warn(`[job-registry] self-healed ${registered} missing repeatable jobs`);
  }

  return { registered, alreadyExisted };
};
