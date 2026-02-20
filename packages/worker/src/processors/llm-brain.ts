import { Worker, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { sql, eq, inArray } from "drizzle-orm";
import {
  QUEUE_LLM_BRAIN,
  JOB_LLM_SCORE_BATCH,
  JOB_DISTRIBUTION_IMMEDIATE,
  AUTO_POST_STAGGER_MS,
  logger,
  buildScoringSystemPrompt,
  defaultScoringConfig,
  scoringConfigSchema,
  type ScoringConfig,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { llmTelemetry, appConfig } from "@watch-tower/db";
import type { LLMProvider, ScoringRequest, ScoringResult } from "@watch-tower/llm";
import { calculateLLMCost } from "@watch-tower/llm";
import type { EventPublisher } from "../events.js";
import { checkAndFireAlerts } from "./alert-processor.js";

/**
 * Check if ANY platform has auto-posting enabled in app_config.
 * The distribution worker handles per-platform gating — this just decides
 * whether to queue a distribution job at all.
 */
const isAnyAutoPostEnabled = async (db: Database): Promise<boolean> => {
  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(
      inArray(appConfig.key, [
        "auto_post_telegram",
        "auto_post_facebook",
        "auto_post_linkedin",
      ]),
    );

  if (rows.length === 0) {
    // Legacy: check old key, default true
    const [legacyRow] = await db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "auto_post_score5"));
    return legacyRow ? legacyRow.value === true || legacyRow.value === "true" : true;
  }

  return rows.some((r) => r.value === true || r.value === "true");
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
  redis?: Redis;
  telegramConfig?: { botToken: string; defaultChatId: string };
};

const DEFAULT_BATCH_SIZE = 10;

/**
 * Case-insensitive word boundary match. Prevents "AI" matching "FAIRY".
 * Shared between pre-filter reject logic and alert keyword matching.
 */
export const matchesKeyword = (text: string, keyword: string): boolean => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "i");
  return regex.test(text);
};

type ClaimedArticle = {
  id: string;
  title: string;
  contentSnippet: string | null;
  articleCategories: string[] | null;
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
  redis,
  telegramConfig,
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
          article_categories as "articleCategories",
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
       * Returns either:
       *   { systemPrompt } — new split path (structured config or default)
       *   { promptTemplate } — legacy single-message path (old prompt_template strings)
       *
       * Priority: structured config > legacy prompt_template > default config
       */
      type ResolvedPrompt =
        | { systemPrompt: string; promptTemplate?: undefined }
        | { systemPrompt?: undefined; promptTemplate: string };

      const resolvePrompt = (
        sectorId: string | null,
        sectorName: string | null,
      ): ResolvedPrompt => {
        const name = sectorName ?? "General";

        if (!sectorId) {
          // No sector — use default config with system/user split
          return { systemPrompt: buildScoringSystemPrompt(defaultScoringConfig, name) };
        }

        const rules = sectorRules.get(sectorId);
        if (!rules) {
          // Sector exists but no custom rules — use default config
          return { systemPrompt: buildScoringSystemPrompt(defaultScoringConfig, name) };
        }

        // Priority 1: Structured config (new system) — system/user split
        if (rules.config && typeof rules.config === "object" && Object.keys(rules.config).length > 0) {
          const parsed = scoringConfigSchema.safeParse(rules.config);
          if (parsed.success) {
            return { systemPrompt: buildScoringSystemPrompt(parsed.data, name) };
          }
          // Invalid config in DB — log warning and fall through
          logger.warn({ sectorId }, "[llm-brain] invalid score_criteria in DB, using fallback");
        }

        // Priority 2: Legacy prompt_template (backward compat — single message)
        if (rules.promptTemplate) {
          return { promptTemplate: rules.promptTemplate };
        }

        // Priority 3: Default config — system/user split
        return { systemPrompt: buildScoringSystemPrompt(defaultScoringConfig, name) };
      };

      // Enrich articles with sector names
      const articles: ClaimedArticle[] = claimedArticles.map((a) => ({
        ...a,
        sectorName: a.sectorId ? sectorMap.get(a.sectorId) ?? null : null,
      }));

      logger.info(`[llm-brain] claimed ${articles.length} articles for scoring`);

      // 2a. PRE-FILTER: Hard reject articles matching reject_keywords before LLM (cost gate)
      const preFilterRejects: { id: string; reason: string }[] = [];
      const passedArticles: ClaimedArticle[] = [];

      for (const article of articles) {
        const rules = article.sectorId ? sectorRules.get(article.sectorId) : undefined;
        const config = rules?.config;
        const parsed = config && typeof config === "object" && Object.keys(config).length > 0
          ? scoringConfigSchema.safeParse(config)
          : null;
        const rejectKeywords = parsed?.success ? parsed.data.rejectKeywords : [];

        if (rejectKeywords.length === 0) {
          passedArticles.push(article);
          continue;
        }

        let rejected = false;
        for (const keyword of rejectKeywords) {
          // Check title
          if (matchesKeyword(article.title, keyword)) {
            preFilterRejects.push({
              id: article.id,
              reason: `pre-filter: keyword '${keyword}' matched in title`,
            });
            rejected = true;
            break;
          }
          // Check categories
          if (article.articleCategories?.some((cat) => matchesKeyword(cat, keyword))) {
            preFilterRejects.push({
              id: article.id,
              reason: `pre-filter: keyword '${keyword}' matched in categories`,
            });
            rejected = true;
            break;
          }
          // Check content snippet
          if (article.contentSnippet && matchesKeyword(article.contentSnippet, keyword)) {
            preFilterRejects.push({
              id: article.id,
              reason: `pre-filter: keyword '${keyword}' matched in content_snippet`,
            });
            rejected = true;
            break;
          }
        }

        if (!rejected) {
          passedArticles.push(article);
        }
      }

      // Bulk reject pre-filtered articles
      if (preFilterRejects.length > 0) {
        const rejectIds = preFilterRejects.map((r) => r.id);
        const rejectIdsLiteral = `{${rejectIds.join(",")}}`;
        const escapeRejectReason = (s: string) =>
          `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        const rejectReasonsLiteral = `{${preFilterRejects.map((r) => escapeRejectReason(r.reason)).join(",")}}`;

        await db.execute(sql`
          UPDATE articles AS a
          SET
            pipeline_stage = 'rejected',
            rejection_reason = bulk.reason
          FROM (
            SELECT
              UNNEST(${rejectIdsLiteral}::uuid[]) AS id,
              UNNEST(${rejectReasonsLiteral}::text[]) AS reason
          ) AS bulk
          WHERE a.id = bulk.id
        `);

        logger.info(
          `[llm-brain] pre-filter rejected ${preFilterRejects.length} articles`,
        );

        // Publish rejection events
        for (const reject of preFilterRejects) {
          await eventPublisher.publish({
            type: "article:rejected",
            data: { id: reject.id },
          });
        }
      }

      if (passedArticles.length === 0) {
        logger.debug("[llm-brain] all articles pre-filtered, no scoring needed");
        return;
      }

      // 2b. Build scoring requests with sector-specific prompts
      // Uses compile-on-read: structured config (system/user) > legacy prompt > default
      const requests: ScoringRequest[] = passedArticles.map((a) => {
        const resolved = resolvePrompt(a.sectorId, a.sectorName);
        return {
          articleId: a.id,
          title: a.title,
          contentSnippet: a.contentSnippet,
          categories: a.articleCategories ?? undefined,
          sectorName: a.sectorName ?? undefined,
          ...(resolved.systemPrompt
            ? { systemPrompt: resolved.systemPrompt }
            : { promptTemplate: resolved.promptTemplate }),
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

      // Read global thresholds from DB (overrides env defaults)
      let globalApprove = autoApproveThreshold;
      let globalReject = autoRejectThreshold;
      try {
        const thresholdRows = await db
          .select({ key: appConfig.key, value: appConfig.value })
          .from(appConfig)
          .where(
            inArray(appConfig.key, ["auto_approve_threshold", "auto_reject_threshold"]),
          );
        for (const row of thresholdRows) {
          const num = Number(row.value);
          if (!Number.isNaN(num) && num >= 0 && num <= 5) {
            if (row.key === "auto_approve_threshold") globalApprove = num;
            if (row.key === "auto_reject_threshold") globalReject = num;
          }
        }
      } catch {
        // Fall back to env defaults on DB error
      }

      // Helper to get thresholds for an article (sector-specific or global)
      const getThresholds = (articleId: string) => {
        const article = articles.find((a) => a.id === articleId)!;
        const rules = article.sectorId ? sectorRules.get(article.sectorId) : undefined;
        const rawApprove = rules?.autoApprove ?? globalApprove;
        return {
          // 0 means "OFF" — never auto-approve (6 is unreachable since scores are 1-5)
          approve: rawApprove === 0 ? 6 : rawApprove,
          reject: rules?.autoReject ?? globalReject,
        };
      };

      // 5. Bulk update successes (optimized: single UPDATE + single INSERT instead of N+1)
      const scoringModel = llmProvider.model;
      const now = new Date();

      if (successes.length > 0) {
        // Pre-compute stages for all articles
        type ArticleUpdate = {
          id: string;
          score: number;
          summary: string | null;
          reasoning: string | null;
          rejectionReason: string | null;
          stage: string;
          approvedAt: Date | null;
        };
        const updates: ArticleUpdate[] = successes.map((r) => {
          const thresholds = getThresholds(r.articleId);
          let stage: string;
          let approvedAt: Date | null = null;
          let rejectionReason: string | null = null;

          if (r.score >= thresholds.approve) {
            stage = "approved";
            approvedAt = now;
          } else if (r.score <= thresholds.reject) {
            stage = "rejected";
            rejectionReason = `llm-score: ${r.score}`;
          } else {
            stage = "scored";
          }
          return {
            id: r.articleId,
            score: r.score,
            summary: r.summary ?? null,
            reasoning: r.reasoning ?? null,
            rejectionReason,
            stage,
            approvedAt,
          };
        });

        // Bulk UPDATE using UNNEST (PostgreSQL array functions) - single query for all articles
        // Convert to PostgreSQL array literal format: {val1,val2,val3}
        const idsLiteral = `{${updates.map((u) => u.id).join(",")}}`;
        const scoresLiteral = `{${updates.map((u) => u.score).join(",")}}`;
        // Escape summaries for PostgreSQL array: double quotes, escape internal quotes
        const escapeSummary = (s: string | null) => {
          if (s === null) return "NULL";
          // Escape backslashes and double quotes, wrap in double quotes
          return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        };
        const summariesLiteral = `{${updates.map((u) => escapeSummary(u.summary)).join(",")}}`;
        // Escape reasoning for PostgreSQL text[] (same pattern as summaries)
        const escapeReasoning = escapeSummary;
        const reasoningsLiteral = `{${updates.map((u) => escapeReasoning(u.reasoning)).join(",")}}`;
        const escapeText = escapeSummary;
        const rejectionReasonsLiteral = `{${updates.map((u) => escapeText(u.rejectionReason)).join(",")}}`;
        const stagesLiteral = `{${updates.map((u) => u.stage).join(",")}}`;
        const approvedAtsLiteral = `{${updates.map((u) => u.approvedAt?.toISOString() ?? "NULL").join(",")}}`;

        await db.execute(sql`
          UPDATE articles AS a
          SET
            importance_score = bulk.score,
            llm_summary = bulk.summary,
            score_reasoning = bulk.reasoning,
            rejection_reason = bulk.rejection_reason,
            scoring_model = ${scoringModel},
            scored_at = ${now},
            approved_at = bulk.approved_at,
            pipeline_stage = bulk.stage
          FROM (
            SELECT
              UNNEST(${idsLiteral}::uuid[]) AS id,
              UNNEST(${scoresLiteral}::int[]) AS score,
              UNNEST(${summariesLiteral}::text[]) AS summary,
              UNNEST(${reasoningsLiteral}::text[]) AS reasoning,
              UNNEST(${rejectionReasonsLiteral}::text[]) AS rejection_reason,
              UNNEST(${stagesLiteral}::text[]) AS stage,
              UNNEST(${approvedAtsLiteral}::timestamptz[]) AS approved_at
          ) AS bulk
          WHERE a.id = bulk.id
        `);

        // Bulk INSERT telemetry (single query)
        const primaryProvider = llmProvider.name.split("→")[0];
        const telemetryRows = successes
          .filter((r) => r.usage)
          .map((r) => {
            const actualProvider = r.isFallback
              ? (llmProvider.fallbackName ?? primaryProvider)
              : primaryProvider;
            const actualModel = r.isFallback
              ? (llmProvider.fallbackModel ?? llmProvider.model)
              : llmProvider.model;
            return {
              articleId: r.articleId,
              operation: "score_and_summarize" as const,
              provider: actualProvider,
              model: actualModel,
              isFallback: r.isFallback ?? false,
              inputTokens: r.usage!.inputTokens,
              outputTokens: r.usage!.outputTokens,
              totalTokens: r.usage!.totalTokens,
              costMicrodollars: calculateLLMCost(
                actualProvider,
                actualModel,
                r.usage!.inputTokens,
                r.usage!.outputTokens,
              ),
              latencyMs: r.latencyMs,
              status: r.error ? ("error" as const) : ("success" as const),
              errorMessage: r.error ?? null,
            };
          });

        if (telemetryRows.length > 0) {
          try {
            await db.insert(llmTelemetry).values(telemetryRows);
          } catch (telemetryErr) {
            logger.error("[llm-brain] failed to log telemetry batch, continuing", telemetryErr);
          }
        }

        // Track auto-post stagger delay across the batch
        let autoPostIndex = 0;

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

            // Queue for immediate distribution to Telegram (auto-approved articles)
            // Only if auto_post_telegram is enabled in app_config
            if (distributionQueue) {
              // Check posting language — Georgian mode defers to translation worker
              const [langRow] = await db
                .select({ value: appConfig.value })
                .from(appConfig)
                .where(eq(appConfig.key, "posting_language"));
              const postingLanguage = (langRow?.value as string) ?? "en";

              if (postingLanguage === "ka") {
                logger.debug(
                  { articleId: result.articleId, score: result.score },
                  "[llm-brain] Georgian mode — translation worker will handle distribution",
                );
              } else {
                const telegramEnabled = await isAnyAutoPostEnabled(db);
                if (telegramEnabled) {
                  const delay = autoPostIndex * AUTO_POST_STAGGER_MS;
                  await distributionQueue.add(
                    JOB_DISTRIBUTION_IMMEDIATE,
                    { articleId: result.articleId },
                    { jobId: `immediate-${result.articleId}`, delay },
                  );
                  autoPostIndex++;
                  logger.info(
                    { articleId: result.articleId, score: result.score, delayMs: delay },
                    "[llm-brain] queued for immediate distribution (staggered)",
                  );
                } else {
                  logger.debug(
                    { articleId: result.articleId, score: result.score },
                    "[llm-brain] all auto-post platforms disabled, skipping",
                  );
                }
              }
            }
          } else {
            await eventPublisher.publish({
              type: "article:rejected",
              data: { id: result.articleId },
            });
          }
        }

        // 5b. ALERT CHECK: Check scored articles against active keyword alert rules
        if (redis && telegramConfig) {
          try {
            const alertArticles = successes.map((r) => {
              const claimed = articles.find((a) => a.id === r.articleId)!;
              return {
                articleId: r.articleId,
                title: claimed.title,
                llmSummary: r.summary ?? null,
                articleCategories: claimed.articleCategories,
                score: r.score,
              };
            });
            await checkAndFireAlerts({ db, redis, telegramConfig, articles: alertArticles });
          } catch (alertErr) {
            // Alert failures must never interrupt the scoring pipeline
            logger.error("[llm-brain] alert check failed, continuing", alertErr);
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

      const preFiltered = preFilterRejects.length;
      logger.info(
        `[llm-brain] batch: ${preFiltered} pre-filtered, ${approved} approved, ${rejected} rejected, ${review} for review, ${failures.length} failed`,
      );
    },
    { connection, concurrency: 1 }, // Low concurrency to respect rate limits
  );
};
