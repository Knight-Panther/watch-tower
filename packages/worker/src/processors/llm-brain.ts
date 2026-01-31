import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { QUEUE_LLM_BRAIN, JOB_LLM_SCORE_BATCH, logger } from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import type { LLMProvider, ScoringRequest, ScoringResult } from "@watch-tower/llm";
import type { EventPublisher } from "../events.js";

type LLMBrainDeps = {
  connection: { host: string; port: number };
  db: Database;
  llmProvider: LLMProvider;
  eventPublisher: EventPublisher;
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  batchSize?: number;
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
  promptTemplate: string;
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
      const sectorMap = new Map<string, string>();
      if (sectorIds.length > 0) {
        const sectorsResult = await db.execute(sql`
          SELECT id, name FROM sectors WHERE id = ANY(${sectorIds}::uuid[])
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
            auto_approve_threshold as "autoApprove",
            auto_reject_threshold as "autoReject"
          FROM scoring_rules
          WHERE sector_id = ANY(${sectorIds}::uuid[])
        `);

        for (const row of rulesResult.rows as {
          sectorId: string;
          promptTemplate: string;
          autoApprove: number;
          autoReject: number;
        }[]) {
          sectorRules.set(row.sectorId, {
            promptTemplate: row.promptTemplate,
            autoApprove: row.autoApprove,
            autoReject: row.autoReject,
          });
        }
      }

      // Enrich articles with sector names
      const articles: ClaimedArticle[] = claimedArticles.map((a) => ({
        ...a,
        sectorName: a.sectorId ? sectorMap.get(a.sectorId) ?? null : null,
      }));

      logger.info(`[llm-brain] claimed ${articles.length} articles for scoring`);

      // 2. Build scoring requests with sector-specific prompts
      const requests: ScoringRequest[] = articles.map((a) => {
        const rules = a.sectorId ? sectorRules.get(a.sectorId) : undefined;
        return {
          articleId: a.id,
          title: a.title,
          contentSnippet: a.contentSnippet,
          sectorName: a.sectorName ?? undefined,
          promptTemplate: rules?.promptTemplate, // Use custom prompt if available
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
        // Build VALUES for bulk update with per-article threshold logic
        const values = successes
          .map((r) => {
            const thresholds = getThresholds(r.articleId);
            let stage: string;
            let approvedAt: string | null = null;

            if (r.score >= thresholds.approve) {
              stage = "approved";
              approvedAt = `'${now.toISOString()}'::timestamptz`;
            } else if (r.score <= thresholds.reject) {
              stage = "rejected";
            } else {
              stage = "scored"; // Manual review needed
            }

            // Escape single quotes in summary
            const escapedSummary = r.summary ? r.summary.replace(/'/g, "''") : null;

            return `('${r.articleId}'::uuid, ${r.score}, ${escapedSummary ? `'${escapedSummary}'` : "NULL"}, '${scoringModel}', '${now.toISOString()}'::timestamptz, ${approvedAt ?? "NULL"}, '${stage}')`;
          })
          .join(", ");

        await db.execute(sql`
          UPDATE articles AS a
          SET
            importance_score = v.score,
            llm_summary = v.summary,
            scoring_model = v.model,
            scored_at = v.scored_at,
            approved_at = v.approved_at,
            pipeline_stage = v.stage
          FROM (VALUES ${sql.raw(values)}) AS v(id, score, summary, model, scored_at, approved_at, stage)
          WHERE a.id = v.id
        `);

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
