import { Worker, Queue } from "bullmq";
import { sql, eq } from "drizzle-orm";
import {
  QUEUE_LLM_BRAIN,
  JOB_LLM_SCORE_BATCH,
  JOB_DISTRIBUTION_IMMEDIATE,
  logger,
  buildScoringPrompt,
  defaultScoringConfig,
  type ScoringConfig,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { llmTelemetry, appConfig } from "@watch-tower/db";
import type { LLMProvider, ScoringRequest, ScoringResult } from "@watch-tower/llm";
import { calculateLLMCost } from "@watch-tower/llm";
import type { EventPublisher } from "../events.js";

/**
 * Check if auto-posting for score 5 is enabled in app_config.
 * Defaults to true if not set.
 */
const isAutoPostEnabled = async (db: Database): Promise<boolean> => {
  const [row] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "auto_post_score5"));
  if (!row) return true; // Default to enabled
  return row.value === true || row.value === "true";
};

type LLMBrainDeps = {
  connection: { host: string; port: number };
  db: Database;
  llmProvider: LLMProvider;
  eventPublisher: EventPublisher;
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  batchSize?: number;
  distributionQueue?: Queue;
};

const DEFAULT_BATCH_SIZE = 10;

type ClaimedArticle = {
  id: string;
  title: string;
  contentSnippet: string | null;
  sectorId: string | null;
  sectorName: string | null;
};

type SectorRule = {
  promptTemplate: string | null;
  config: ScoringConfig | null;
  autoApprove: number;
  autoReject: number;
};

export const createLLMBrainWorker = ({
  connection,
  db,
  llmProvider,
  eventPublisher,
  autoApproveThreshold,
  autoRejectThreshold,
  batchSize = DEFAULT_BATCH_SIZE,
  distributionQueue,
}: LLMBrainDeps) => {
  return new Worker(
    QUEUE_LLM_BRAIN,
    async (job) => {
      if (job.name !== JOB_LLM_SCORE_BATCH) return;

      // 1. CLAIM articles atomically using FOR UPDATE SKIP LOCKED
      // Scanner pattern: ignores job.data, scans for 'embedded' articles
      const claimResult = await db.execute(sql`
        UPDATE articles
        SET pipeline_stage = 'scoring'
        WHERE id IN (
          SELECT id FROM articles
          WHERE pipeline_stage = 'embedded'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        RETURNING
          id,
          title,
          content_snippet as "contentSnippet",
          sector_id as "sectorId"
      `);

      const claimedArticles = claimResult.rows as ClaimedArticle[];

      if (claimedArticles.length === 0) {
        logger.debug("[llm-brain] no pending articles");
        return;
      }

      // Collect unique sector IDs
      const sectorIds = [
        ...new Set(claimedArticles.map((a) => a.sectorId).filter((id): id is string => id !== null)),
      ];

      // Fetch sector names in one query (avoid N+1)
      // Format as PostgreSQL array literal: {uuid1,uuid2,...}
      const sectorIdsLiteral = `{${sectorIds.join(",")}}`;

      const sectorMap = new Map<string, string>();
      if (sectorIds.length > 0) {
        const sectorsResult = await db.execute(sql`
          SELECT id, name FROM sectors WHERE id = ANY(${sectorIdsLiteral}::uuid[])
        `);
        for (const row of sectorsResult.rows as { id: string; name: string }[]) {
          sectorMap.set(row.id, row.name);
        }
      }

      // Fetch scoring rules for sectors (per-sector custom prompts + thresholds)
      const sectorRules = new Map<string, SectorRule>();
      if (sectorIds.length > 0) {
        const rulesResult = await db.execute(sql`
          SELECT
            sector_id as "sectorId",
            prompt_template as "promptTemplate",
            score_criteria as "config",
            auto_approve_threshold as "autoApprove",
            auto_reject_threshold as "autoReject"
          FROM scoring_rules
          WHERE sector_id = ANY(${sectorIdsLiteral}::uuid[])
        `);

        for (const row of rulesResult.rows as {
          sectorId: string;
          promptTemplate: string | null;
          config: ScoringConfig | null;
          autoApprove: number;
          autoReject: number;
        }[]) {
          sectorRules.set(row.sectorId, {
            promptTemplate: row.promptTemplate,
            config: row.config,
            autoApprove: row.autoApprove,
            autoReject: row.autoReject,
          });
        }
      }

      /**
       * Resolves the scoring prompt for an article.
       * Priority: structured config > legacy prompt_template > default config
       */
      const resolvePrompt = (sectorId: string | null, sectorName: string | null): string | undefined => {
        if (!sectorId) return undefined;

        const rules = sectorRules.get(sectorId);
        if (!rules) return undefined;

        // Priority 1: Structured config (new system)
        if (rules.config && Object.keys(rules.config).length > 0) {
          return buildScoringPrompt(rules.config, sectorName ?? "General");
        }

        // Priority 2: Legacy prompt_template (backward compat)
        if (rules.promptTemplate) {
          return rules.promptTemplate;
        }

        // Priority 3: Default config
        return buildScoringPrompt(defaultScoringConfig, sectorName ?? "General");
      };

      // Enrich articles with sector names
      const articles: ClaimedArticle[] = claimedArticles.map((a) => ({
        ...a,
        sectorName: a.sectorId ? sectorMap.get(a.sectorId) ?? null : null,
      }));

      logger.info(`[llm-brain] claimed ${articles.length} articles for scoring`);

      // 2. Build scoring requests with sector-specific prompts
      // Uses compile-on-read: structured config > legacy prompt > default
      const requests: ScoringRequest[] = articles.map((a) => {
        return {
          articleId: a.id,
          title: a.title,
          contentSnippet: a.contentSnippet,
          sectorName: a.sectorName ?? undefined,
          promptTemplate: resolvePrompt(a.sectorId, a.sectorName),
        };
      });

      // 3. Score each article with Promise.allSettled for partial failure handling
      const settledResults = await Promise.allSettled(requests.map((req) => llmProvider.score(req)));

      // 4. Separate successes and failures
      const successes: ScoringResult[] = [];
      const failures: { articleId: string; error: string }[] = [];

      for (let i = 0; i < settledResults.length; i++) {
        const result = settledResults[i];
        const articleId = requests[i].articleId;

        if (result.status === "fulfilled") {
          successes.push(result.value);
        } else {
          failures.push({
            articleId,
            error: result.reason instanceof Error ? result.reason.message : "Unknown error",
          });
        }
      }

      // Helper to get thresholds for an article (sector-specific or default)
      const getThresholds = (articleId: string) => {
        const article = articles.find((a) => a.id === articleId)!;
        const rules = article.sectorId ? sectorRules.get(article.sectorId) : undefined;
        return {
          approve: rules?.autoApprove ?? autoApproveThreshold,
          reject: rules?.autoReject ?? autoRejectThreshold,
        };
      };

      // 5. Bulk update successes
      const scoringModel = llmProvider.model;
      const now = new Date();

      if (successes.length > 0) {
        // Update articles one by one to avoid SQL escaping issues with raw VALUES
        for (const r of successes) {
          const thresholds = getThresholds(r.articleId);
          let stage: string;
          let approvedAt: Date | null = null;

          if (r.score >= thresholds.approve) {
            stage = "approved";
            approvedAt = now;
          } else if (r.score <= thresholds.reject) {
            stage = "rejected";
          } else {
            stage = "scored"; // Manual review needed
          }

          await db.execute(sql`
            UPDATE articles
            SET
              importance_score = ${r.score},
              llm_summary = ${r.summary ?? null},
              scoring_model = ${scoringModel},
              scored_at = ${now},
              approved_at = ${approvedAt},
              pipeline_stage = ${stage}
            WHERE id = ${r.articleId}::uuid
          `);

          // Log telemetry for cost tracking
          if (r.usage) {
            // Determine actual provider/model used (fallback or primary)
            // Extract primary provider name from combined "deepseek→openai" format
            const primaryProvider = llmProvider.name.split("→")[0];
            const actualProvider = r.isFallback
              ? (llmProvider.fallbackName ?? primaryProvider)
              : primaryProvider;
            const actualModel = r.isFallback
              ? (llmProvider.fallbackModel ?? llmProvider.model)
              : llmProvider.model;

            // Wrap telemetry insert in try/catch - telemetry failure should not abort pipeline
            try {
              await db.insert(llmTelemetry).values({
                articleId: r.articleId,
                operation: "score_and_summarize",
                provider: actualProvider,
                model: actualModel,
                isFallback: r.isFallback ?? false,
                inputTokens: r.usage.inputTokens,
                outputTokens: r.usage.outputTokens,
                totalTokens: r.usage.totalTokens,
                costMicrodollars: calculateLLMCost(
                  actualProvider,
                  actualModel,
                  r.usage.inputTokens,
                  r.usage.outputTokens,
                ),
                latencyMs: r.latencyMs,
              });
            } catch (telemetryErr) {
              logger.error(
                `[llm-brain] failed to log telemetry for ${r.articleId}, continuing`,
                telemetryErr,
              );
            }
          }
        }

        // Publish events for real-time dashboard
        for (const result of successes) {
          const thresholds = getThresholds(result.articleId);
          let eventType: "article:scored" | "article:approved" | "article:rejected";

          if (result.score >= thresholds.approve) {
            eventType = "article:approved";
          } else if (result.score <= thresholds.reject) {
            eventType = "article:rejected";
          } else {
            eventType = "article:scored";
          }

          if (eventType === "article:scored") {
            await eventPublisher.publish({
              type: "article:scored",
              data: {
                id: result.articleId,
                score: result.score,
                summary: result.summary,
              },
            });
          } else if (eventType === "article:approved") {
            await eventPublisher.publish({
              type: "article:approved",
              data: { id: result.articleId },
            });

            // Queue for immediate distribution (score 5 auto-approved)
            // Only if auto_post_score5 is enabled in app_config
            if (distributionQueue) {
              const autoPostEnabled = await isAutoPostEnabled(db);
              if (autoPostEnabled) {
                await distributionQueue.add(
                  JOB_DISTRIBUTION_IMMEDIATE,
                  { articleId: result.articleId },
                  { jobId: `immediate-${result.articleId}` },
                );
                logger.info(
                  { articleId: result.articleId, score: result.score },
                  "[llm-brain] queued for immediate distribution",
                );
              } else {
                logger.debug(
                  { articleId: result.articleId, score: result.score },
                  "[llm-brain] auto-post disabled, skipping distribution",
                );
              }
            }
          } else {
            await eventPublisher.publish({
              type: "article:rejected",
              data: { id: result.articleId },
            });
          }
        }
      }

      // 6. Mark failures with 'scoring_failed' stage (don't reset to embedded — prevents infinite loop)
      if (failures.length > 0) {
        const failedIds = failures.map((f) => f.articleId);
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'scoring_failed'
          WHERE id = ANY(${failedIds}::uuid[])
        `);

        for (const failure of failures) {
          logger.error(`[llm-brain] scoring failed for ${failure.articleId}: ${failure.error}`);
        }
      }

      // Log stats using per-article thresholds
      let approved = 0;
      let rejected = 0;
      for (const r of successes) {
        const thresholds = getThresholds(r.articleId);
        if (r.score >= thresholds.approve) approved++;
        else if (r.score <= thresholds.reject) rejected++;
      }
      const review = successes.length - approved - rejected;

      logger.info(
        `[llm-brain] batch: ${approved} approved, ${rejected} rejected, ${review} for review, ${failures.length} failed`,
      );
    },
    { connection, concurrency: 1 }, // Low concurrency to respect rate limits
  );
};
