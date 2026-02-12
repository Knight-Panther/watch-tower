import { Worker, Queue } from "bullmq";
import { inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  QUEUE_TRANSLATION,
  JOB_TRANSLATION_BATCH,
  JOB_DISTRIBUTION_IMMEDIATE,
  AUTO_POST_STAGGER_MS,
  logger,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { appConfig, llmTelemetry } from "@watch-tower/db";
import {
  translateWithGemini,
  translateWithOpenAI,
  calculateTranslationCost,
} from "@watch-tower/translation";

type TranslationDeps = {
  connection: { host: string; port: number };
  db: Database;
  distributionQueue?: Queue;
};

type TranslationConfig = {
  postingLanguage: string;
  scores: number[];
  provider: string; // "gemini" | "openai"
  model: string;
  instructions: string;
  enabledSince: string | null; // ISO timestamp
};

/**
 * Read all translation config from app_config in one query.
 */
async function getTranslationConfig(db: Database): Promise<TranslationConfig> {
  const keys = [
    "posting_language",
    "translation_scores",
    "translation_provider",
    "translation_model",
    "translation_instructions",
    "translation_enabled_since",
  ];

  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const m = new Map(rows.map((r) => [r.key, r.value]));

  return {
    postingLanguage: (m.get("posting_language") as string) ?? "en",
    scores: (m.get("translation_scores") as number[]) ?? [3, 4, 5],
    provider: (m.get("translation_provider") as string) ?? "gemini",
    model: (m.get("translation_model") as string) ?? "gemini-2.5-flash",
    instructions: (m.get("translation_instructions") as string) ?? "",
    enabledSince: (m.get("translation_enabled_since") as string) ?? null,
  };
}

/**
 * Resolve API key for the configured provider.
 */
function getTranslationApiKey(provider: string): string | undefined {
  switch (provider) {
    case "gemini":
      return process.env.GOOGLE_AI_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    default:
      return undefined;
  }
}

const MAX_TRANSLATION_ATTEMPTS = 5;
const MAX_IN_WORKER_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 5_000; // 5s, 10s

type ClaimedArticle = {
  id: string;
  title: string;
  llmSummary: string;
  importanceScore: number;
  pipelineStage: string;
  translationAttempts: number;
};

export const createTranslationWorker = ({ connection, db, distributionQueue }: TranslationDeps) => {
  return new Worker(
    QUEUE_TRANSLATION,
    async (job) => {
      if (job.name !== JOB_TRANSLATION_BATCH) {
        return { skipped: true, reason: "unknown_job_type" };
      }

      // 1. Read config
      const config = await getTranslationConfig(db);

      // Only run if Georgian mode is active
      if (config.postingLanguage !== "ka") {
        return { skipped: true, reason: "english_mode" };
      }

      // Check API key for configured provider
      const apiKey = getTranslationApiKey(config.provider);
      if (!apiKey) {
        logger.warn(`[translation] no API key for provider: ${config.provider}`);
        return { skipped: true, reason: "no_api_key" };
      }

      // 2. ATOMIC CLAIM: Get articles needing translation
      // Queries by importance_score + translation_status (NOT pipeline_stage)
      // This catches both 'scored' (3-4) and 'approved' (5) articles
      const scoreList = config.scores.length > 0 ? config.scores : [3, 4, 5];

      // Backfill guard: only translate articles created after translation was enabled
      const enabledSince = config.enabledSince ? new Date(config.enabledSince) : new Date();

      const claimResult = await db.execute(sql`
        UPDATE articles
        SET
          translation_status = 'translating',
          translation_attempts = translation_attempts + 1
        WHERE id IN (
          SELECT id FROM articles
          WHERE importance_score = ANY(${`{${scoreList.join(",")}}`}::smallint[])
            AND translation_status IS NULL
            AND llm_summary IS NOT NULL
            AND title_ka IS NULL
            AND scored_at IS NOT NULL
            AND created_at > ${enabledSince}
            AND translation_attempts < ${MAX_TRANSLATION_ATTEMPTS}
          ORDER BY created_at ASC
          LIMIT 10
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id,
          title,
          llm_summary as "llmSummary",
          importance_score as "importanceScore",
          pipeline_stage as "pipelineStage",
          translation_attempts as "translationAttempts"
      `);

      const claimed = claimResult.rows as ClaimedArticle[];

      if (claimed.length === 0) {
        return { processed: 0 };
      }

      logger.info(`[translation] claimed ${claimed.length} articles`);

      // 3. Translate each article
      let translated = 0;
      let failed = 0;
      let autoPostIndex = 0;
      const telemetryRows: {
        articleId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costMicrodollars: number;
        latencyMs: number;
        status: string;
        errorMessage: string | null;
      }[] = [];

      for (const article of claimed) {
        // Call the configured provider with in-worker retry for transient errors
        const translateFn =
          config.provider === "openai" ? translateWithOpenAI : translateWithGemini;

        let result: Awaited<ReturnType<typeof translateFn>> | null = null;

        for (let attempt = 0; attempt <= MAX_IN_WORKER_RETRIES; attempt++) {
          if (attempt > 0) {
            const delayMs = RETRY_BASE_DELAY_MS * attempt;
            logger.info(
              { articleId: article.id, attempt, delayMs },
              "[translation] retrying after transient error",
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }

          result = await translateFn(
            apiKey,
            config.model,
            article.title,
            article.llmSummary,
            config.instructions || undefined,
          );

          // Success — break out of retry loop
          if (!result.error && result.titleKa && result.summaryKa) break;

          // Permanent error — don't retry
          if (result.error && !result.isTransient) break;

          // Transient error — continue retry loop
        }

        // result is guaranteed non-null (at least one attempt ran)
        if (result!.error || !result!.titleKa || !result!.summaryKa) {
          // Determine if exhausted (hit max attempts across all maintenance resets)
          const isExhausted = article.translationAttempts >= MAX_TRANSLATION_ATTEMPTS;

          await db.execute(sql`
            UPDATE articles
            SET
              translation_status = ${isExhausted ? "exhausted" : "failed"},
              translation_error = ${result!.error ?? "Unknown error"}
            WHERE id = ${article.id}::uuid
          `);
          failed++;

          if (isExhausted) {
            logger.error(
              { articleId: article.id, attempts: article.translationAttempts },
              "[translation] max attempts reached, marking exhausted (permanent)",
            );
          } else {
            logger.warn(
              { articleId: article.id, attempt: article.translationAttempts, error: result!.error },
              "[translation] failed",
            );
          }
        } else {
          // Save translation + clear any previous error
          await db.execute(sql`
            UPDATE articles
            SET
              title_ka = ${result!.titleKa},
              llm_summary_ka = ${result!.summaryKa},
              translation_model = ${config.model},
              translation_status = 'translated',
              translation_error = NULL,
              translated_at = NOW()
            WHERE id = ${article.id}::uuid
          `);
          translated++;
          logger.info({ articleId: article.id }, "[translation] completed");

          // Collect telemetry
          if (result!.usage) {
            telemetryRows.push({
              articleId: article.id,
              model: config.model,
              inputTokens: result!.usage.inputTokens,
              outputTokens: result!.usage.outputTokens,
              totalTokens: result!.usage.totalTokens,
              costMicrodollars: calculateTranslationCost(
                config.model,
                result!.usage.inputTokens,
                result!.usage.outputTokens,
              ),
              latencyMs: result!.latencyMs,
              status: "success" as const,
              errorMessage: null as string | null,
            });
          }

          // 4. Auto-post: If article is already 'approved' (score 5 auto-approve),
          // queue it for distribution now that translation is ready
          if (article.pipelineStage === "approved" && distributionQueue) {
            // Check if ANY platform has auto-post enabled
            const autoPostRows = await db
              .select({ key: appConfig.key, value: appConfig.value })
              .from(appConfig)
              .where(
                inArray(appConfig.key, [
                  "auto_post_telegram",
                  "auto_post_facebook",
                  "auto_post_linkedin",
                ]),
              );
            const autoPostEnabled = autoPostRows.some(
              (r) => r.value === true || r.value === "true",
            );

            if (autoPostEnabled) {
              const delay = autoPostIndex * AUTO_POST_STAGGER_MS;
              await distributionQueue.add(
                JOB_DISTRIBUTION_IMMEDIATE,
                { articleId: article.id },
                { jobId: `dist-ka-${article.id}`, delay },
              );
              autoPostIndex++;
              logger.info(
                { articleId: article.id, delayMs: delay },
                "[translation] queued approved article for distribution (staggered)",
              );
            }
          }
          // If pipeline_stage is 'scored' (3-4), do nothing — user will schedule manually
        }
      }

      // 5. Batch insert telemetry
      if (telemetryRows.length > 0) {
        try {
          await db.insert(llmTelemetry).values(
            telemetryRows.map((t) => ({
              articleId: t.articleId,
              operation: "translate" as const,
              provider: config.provider,
              model: t.model,
              isFallback: false,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              totalTokens: t.totalTokens,
              costMicrodollars: t.costMicrodollars,
              latencyMs: t.latencyMs,
              status: t.status,
              errorMessage: t.errorMessage,
            })),
          );
        } catch (err) {
          logger.error("[translation] telemetry insert failed", err);
        }
      }

      logger.info(`[translation] batch: ${translated} translated, ${failed} failed`);
      return { processed: claimed.length, translated, failed };
    },
    { connection, concurrency: 1 },
  );
};
