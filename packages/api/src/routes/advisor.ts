/**
 * SmartHub Advisor API routes — CRUD for advisor reports + config.
 */

import type { FastifyInstance } from "fastify";
import { eq, desc, inArray, isNotNull, min, max, count, gte } from "drizzle-orm";
import { advisorReports, appConfig, articles } from "@watch-tower/db";
import { logger, JOB_PIPELINE_ADVISOR } from "@watch-tower/shared";
import type { AdvisorRecommendation } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

// ─── Config helpers ──────────────────────────────────────────────────────────

const upsertConfig = async (deps: ApiDeps, key: string, value: unknown) => {
  await deps.db
    .insert(appConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: new Date() },
    });
};

// ─── Provider/model validation (matches digest-slots pattern) ────────────────

const VALID_PROVIDERS = ["claude", "openai", "deepseek", "gemini"];
const VALID_MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-20250514"],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
};

// ─── Route registration ──────────────────────────────────────────────────────

export const registerAdvisorRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // GET /advisor/latest — most recent ready report
  app.get("/advisor/latest", { preHandler: deps.requireApiKey }, async (_request, reply) => {
    const [report] = await deps.db
      .select()
      .from(advisorReports)
      .where(eq(advisorReports.status, "ready"))
      .orderBy(desc(advisorReports.createdAt))
      .limit(1);

    if (!report) {
      return reply.code(404).send({ error: "No advisor reports available" });
    }

    return report;
  });

  // GET /advisor/history — recent reports
  app.get<{ Querystring: { limit?: string } }>(
    "/advisor/history",
    { preHandler: deps.requireApiKey },
    async (request) => {
      const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 10));
      const reports = await deps.db
        .select({
          id: advisorReports.id,
          status: advisorReports.status,
          summary: advisorReports.summary,
          recommendationCount: advisorReports.recommendationCount,
          appliedCount: advisorReports.appliedCount,
          llmProvider: advisorReports.llmProvider,
          llmModel: advisorReports.llmModel,
          llmCostMicrodollars: advisorReports.llmCostMicrodollars,
          triggeredBy: advisorReports.triggeredBy,
          errorMessage: advisorReports.errorMessage,
          createdAt: advisorReports.createdAt,
        })
        .from(advisorReports)
        .orderBy(desc(advisorReports.createdAt))
        .limit(limit);

      return reports;
    },
  );

  // GET /advisor/data-range — scored article data availability
  app.get("/advisor/data-range", { preHandler: deps.requireApiKey }, async () => {
    // Get oldest/newest scored_at and total scored count
    const [range] = await deps.db
      .select({
        oldestScoredAt: min(articles.scoredAt),
        newestScoredAt: max(articles.scoredAt),
        totalScored: count(),
      })
      .from(articles)
      .where(isNotNull(articles.scoredAt));

    // Get configured window
    const [windowRow] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "advisor_window_days"))
      .limit(1);
    const windowDays = Number(windowRow?.value) || 30;

    // Get article TTL
    const [ttlRow] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "feed_items_ttl_days"))
      .limit(1);
    const feedItemsTtlDays = Number(ttlRow?.value) || 60;

    // Count articles within configured window
    const windowCutoff = new Date(Date.now() - windowDays * 86_400_000);
    const [windowCount] = await deps.db
      .select({ count: count() })
      .from(articles)
      .where(gte(articles.scoredAt, windowCutoff));

    const oldest = range?.oldestScoredAt ? new Date(range.oldestScoredAt) : null;
    const newest = range?.newestScoredAt ? new Date(range.newestScoredAt) : null;
    const availableDays = oldest && newest
      ? Math.ceil((newest.getTime() - oldest.getTime()) / 86_400_000)
      : 0;

    return {
      oldest_scored_at: oldest?.toISOString() ?? null,
      newest_scored_at: newest?.toISOString() ?? null,
      available_days: availableDays,
      total_scored: range?.totalScored ?? 0,
      articles_in_window: windowCount?.count ?? 0,
      window_days: windowDays,
      feed_items_ttl_days: feedItemsTtlDays,
    };
  });

  // GET /advisor/reports/:id — full report detail
  app.get<{ Params: { id: string } }>(
    "/advisor/reports/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const [report] = await deps.db
        .select()
        .from(advisorReports)
        .where(eq(advisorReports.id, request.params.id))
        .limit(1);

      if (!report) {
        return reply.code(404).send({ error: "Report not found" });
      }

      return report;
    },
  );

  // POST /advisor/run — trigger manual analysis
  app.post("/advisor/run", { preHandler: deps.requireApiKey }, async () => {
    await deps.maintenanceQueue.add(
      JOB_PIPELINE_ADVISOR,
      { triggeredBy: "manual" },
      { jobId: `advisor-manual-${Date.now()}` },
    );
    logger.info("[advisor] manual run queued");
    return { queued: true };
  });

  // DELETE /advisor/history — clear all advisor reports
  app.delete("/advisor/history", { preHandler: deps.requireApiKey }, async () => {
    const result = await deps.db.delete(advisorReports);
    const deleted = (result as unknown as { rowCount: number }).rowCount ?? 0;
    logger.info({ deleted }, "[advisor] history cleared");
    return { cleared: deleted };
  });

  // PATCH /advisor/reports/:id/recommendations/:recId/apply — mark recommendation applied
  app.patch<{ Params: { id: string; recId: string } }>(
    "/advisor/reports/:id/recommendations/:recId/apply",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id, recId } = request.params;

      // Read full report
      const [report] = await deps.db
        .select({
          recommendations: advisorReports.recommendations,
          appliedCount: advisorReports.appliedCount,
        })
        .from(advisorReports)
        .where(eq(advisorReports.id, id))
        .limit(1);

      if (!report) {
        return reply.code(404).send({ error: "Report not found" });
      }

      const recs = (report.recommendations as AdvisorRecommendation[]) ?? [];
      const recIndex = recs.findIndex((r) => r.id === recId);
      if (recIndex === -1) {
        return reply.code(404).send({ error: "Recommendation not found" });
      }

      if (recs[recIndex].applied_at) {
        return reply.code(400).send({ error: "Recommendation already applied" });
      }

      // Update in TypeScript and write back
      recs[recIndex].applied_at = new Date().toISOString();
      await deps.db
        .update(advisorReports)
        .set({
          recommendations: recs,
          appliedCount: (report.appliedCount ?? 0) + 1,
        })
        .where(eq(advisorReports.id, id));

      logger.info({ reportId: id, recId }, "[advisor] recommendation marked as applied");
      return { success: true, applied_at: recs[recIndex].applied_at };
    },
  );

  // GET /advisor/config — advisor settings
  app.get("/advisor/config", { preHandler: deps.requireApiKey }, async () => {
    const keys = [
      "advisor_enabled",
      "advisor_time",
      "advisor_timezone",
      "advisor_provider",
      "advisor_model",
      "advisor_window_days",
    ];
    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, keys));

    const m = new Map(rows.map((r) => [r.key, r.value]));

    return {
      enabled: m.get("advisor_enabled") !== "false" && m.get("advisor_enabled") !== false,
      time: (m.get("advisor_time") as string) ?? "06:00",
      timezone: (m.get("advisor_timezone") as string) ?? "UTC",
      provider: (m.get("advisor_provider") as string) ?? "openai",
      model: (m.get("advisor_model") as string) ?? "gpt-4o",
      window_days: Number(m.get("advisor_window_days")) || 30,
    };
  });

  // PATCH /advisor/config — update advisor settings
  app.patch<{
    Body: {
      enabled?: boolean;
      time?: string;
      timezone?: string;
      provider?: string;
      model?: string;
      window_days?: number;
    };
  }>("/advisor/config", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { enabled, time, timezone, provider, model, window_days } = request.body ?? {};

    // Validate provider
    if (provider !== undefined && !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
      });
    }

    // Validate model belongs to provider
    if (model !== undefined && provider !== undefined) {
      const allowed = VALID_MODELS[provider];
      if (allowed && !allowed.includes(model)) {
        return reply.code(400).send({
          error: `model '${model}' is not valid for provider '${provider}'. Valid: ${allowed.join(", ")}`,
        });
      }
    }

    // Validate time format
    if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) {
      return reply.code(400).send({ error: "time must be HH:MM format" });
    }

    // Validate timezone
    if (timezone !== undefined) {
      try {
        Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        return reply.code(400).send({ error: `Invalid timezone: ${timezone}` });
      }
    }

    // Validate window_days
    if (window_days !== undefined && (window_days < 1 || window_days > 60)) {
      return reply.code(400).send({ error: "window_days must be between 1 and 60" });
    }

    // Apply updates
    if (enabled !== undefined) await upsertConfig(deps, "advisor_enabled", enabled ? "true" : "false");
    if (time !== undefined) await upsertConfig(deps, "advisor_time", time);
    if (timezone !== undefined) await upsertConfig(deps, "advisor_timezone", timezone);
    if (provider !== undefined) await upsertConfig(deps, "advisor_provider", provider);
    if (model !== undefined) await upsertConfig(deps, "advisor_model", model);
    if (window_days !== undefined) await upsertConfig(deps, "advisor_window_days", String(window_days));

    logger.info("[advisor] config updated");
    return { success: true };
  });
};
