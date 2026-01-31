import type { FastifyInstance } from "fastify";
import { sql, gte, desc, count, sum } from "drizzle-orm";
import { llmTelemetry } from "@watch-tower/db";
import { microdollarsToNumber } from "@watch-tower/llm";
import type { ApiDeps } from "../server.js";

const CACHE_KEY_SUMMARY = "telemetry:summary";
const CACHE_TTL_SECONDS = 30;

/**
 * Get start of day for a given date (UTC to match database timestamps)
 */
const startOfDay = (date: Date): Date => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Get date N days ago from now (UTC)
 */
const daysAgo = (days: number): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return startOfDay(d);
};

export const registerTelemetryRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  /**
   * GET /telemetry/summary
   * Returns cost and usage summary for different time periods
   */
  app.get("/telemetry/summary", { preHandler: deps.requireApiKey }, async () => {
    // Check cache first
    const cached = await deps.redis.get(CACHE_KEY_SUMMARY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Corrupt cache entry - ignore and regenerate
      }
    }

    const today = startOfDay(new Date());
    const sevenDaysAgo = daysAgo(7);
    const thirtyDaysAgo = daysAgo(30);

    // Query for each time period in parallel
    const [todayStats, weekStats, monthStats, allTimeStats] = await Promise.all([
      // Today
      deps.db
        .select({
          total_requests: count(),
          total_tokens: sum(llmTelemetry.totalTokens),
          total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
          avg_latency_ms: sql<number>`avg(${llmTelemetry.latencyMs})::integer`,
        })
        .from(llmTelemetry)
        .where(gte(llmTelemetry.createdAt, today)),
      // Last 7 days
      deps.db
        .select({
          total_requests: count(),
          total_tokens: sum(llmTelemetry.totalTokens),
          total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
          avg_latency_ms: sql<number>`avg(${llmTelemetry.latencyMs})::integer`,
        })
        .from(llmTelemetry)
        .where(gte(llmTelemetry.createdAt, sevenDaysAgo)),
      // Last 30 days
      deps.db
        .select({
          total_requests: count(),
          total_tokens: sum(llmTelemetry.totalTokens),
          total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
          avg_latency_ms: sql<number>`avg(${llmTelemetry.latencyMs})::integer`,
        })
        .from(llmTelemetry)
        .where(gte(llmTelemetry.createdAt, thirtyDaysAgo)),
      // All time
      deps.db
        .select({
          total_requests: count(),
          total_tokens: sum(llmTelemetry.totalTokens),
          total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
          avg_latency_ms: sql<number>`avg(${llmTelemetry.latencyMs})::integer`,
        })
        .from(llmTelemetry),
    ]);

    const formatPeriod = (stats: typeof todayStats) => {
      const row = stats[0];
      const costMicro = Number(row?.total_cost_microdollars ?? 0);
      return {
        requests: row?.total_requests ?? 0,
        tokens: Number(row?.total_tokens ?? 0),
        cost_usd: microdollarsToNumber(costMicro),
        cost_microdollars: costMicro,
        avg_latency_ms: row?.avg_latency_ms ?? 0,
      };
    };

    const result = {
      today: formatPeriod(todayStats),
      last_7_days: formatPeriod(weekStats),
      last_30_days: formatPeriod(monthStats),
      all_time: formatPeriod(allTimeStats),
      generated_at: new Date().toISOString(),
    };

    // Cache result
    await deps.redis.setex(CACHE_KEY_SUMMARY, CACHE_TTL_SECONDS, JSON.stringify(result));
    return result;
  });

  /**
   * GET /telemetry/by-provider
   * Returns breakdown by provider for last 30 days
   */
  app.get("/telemetry/by-provider", { preHandler: deps.requireApiKey }, async (request) => {
    const { days = "30" } = request.query as { days?: string };
    const daysNum = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const since = daysAgo(daysNum);

    const rows = await deps.db
      .select({
        provider: llmTelemetry.provider,
        model: llmTelemetry.model,
        total_requests: count(),
        input_tokens: sum(llmTelemetry.inputTokens),
        output_tokens: sum(llmTelemetry.outputTokens),
        total_tokens: sum(llmTelemetry.totalTokens),
        total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
        avg_latency_ms: sql<number>`avg(${llmTelemetry.latencyMs})::integer`,
        fallback_count: sql<number>`count(*) filter (where ${llmTelemetry.isFallback})`,
      })
      .from(llmTelemetry)
      .where(gte(llmTelemetry.createdAt, since))
      .groupBy(llmTelemetry.provider, llmTelemetry.model)
      .orderBy(desc(sum(llmTelemetry.costMicrodollars)));

    return {
      period_days: daysNum,
      since: since.toISOString(),
      providers: rows.map((row) => {
        const costMicro = Number(row.total_cost_microdollars ?? 0);
        return {
          provider: row.provider,
          model: row.model,
          requests: row.total_requests,
          input_tokens: Number(row.input_tokens ?? 0),
          output_tokens: Number(row.output_tokens ?? 0),
          total_tokens: Number(row.total_tokens ?? 0),
          cost_usd: microdollarsToNumber(costMicro),
          cost_microdollars: costMicro,
          avg_latency_ms: row.avg_latency_ms ?? 0,
          fallback_count: row.fallback_count ?? 0,
        };
      }),
    };
  });

  /**
   * GET /telemetry/by-operation
   * Returns breakdown by operation type for last 30 days
   */
  app.get("/telemetry/by-operation", { preHandler: deps.requireApiKey }, async (request) => {
    const { days = "30" } = request.query as { days?: string };
    const daysNum = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const since = daysAgo(daysNum);

    const rows = await deps.db
      .select({
        operation: llmTelemetry.operation,
        total_requests: count(),
        total_tokens: sum(llmTelemetry.totalTokens),
        total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
        avg_latency_ms: sql<number>`avg(${llmTelemetry.latencyMs})::integer`,
      })
      .from(llmTelemetry)
      .where(gte(llmTelemetry.createdAt, since))
      .groupBy(llmTelemetry.operation)
      .orderBy(desc(sum(llmTelemetry.costMicrodollars)));

    return {
      period_days: daysNum,
      since: since.toISOString(),
      operations: rows.map((row) => {
        const costMicro = Number(row.total_cost_microdollars ?? 0);
        return {
          operation: row.operation,
          requests: row.total_requests,
          total_tokens: Number(row.total_tokens ?? 0),
          cost_usd: microdollarsToNumber(costMicro),
          cost_microdollars: costMicro,
          avg_latency_ms: row.avg_latency_ms ?? 0,
        };
      }),
    };
  });

  /**
   * GET /telemetry/recent
   * Returns recent telemetry entries with pagination
   */
  app.get("/telemetry/recent", { preHandler: deps.requireApiKey }, async (request) => {
    const { limit = "50", offset = "0" } = request.query as { limit?: string; offset?: string };
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    const rows = await deps.db
      .select({
        id: llmTelemetry.id,
        article_id: llmTelemetry.articleId,
        operation: llmTelemetry.operation,
        provider: llmTelemetry.provider,
        model: llmTelemetry.model,
        is_fallback: llmTelemetry.isFallback,
        input_tokens: llmTelemetry.inputTokens,
        output_tokens: llmTelemetry.outputTokens,
        total_tokens: llmTelemetry.totalTokens,
        cost_microdollars: llmTelemetry.costMicrodollars,
        latency_ms: llmTelemetry.latencyMs,
        created_at: llmTelemetry.createdAt,
      })
      .from(llmTelemetry)
      .orderBy(desc(llmTelemetry.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    return {
      entries: rows.map((row) => ({
        ...row,
        cost_usd: microdollarsToNumber(row.cost_microdollars ?? 0),
        created_at: row.created_at.toISOString(),
      })),
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        has_more: rows.length === limitNum,
      },
    };
  });

  /**
   * GET /telemetry/daily
   * Returns daily cost breakdown for charting
   */
  app.get("/telemetry/daily", { preHandler: deps.requireApiKey }, async (request) => {
    const { days = "30" } = request.query as { days?: string };
    const daysNum = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const since = daysAgo(daysNum);

    const rows = await deps.db
      .select({
        date: sql<string>`date_trunc('day', ${llmTelemetry.createdAt})::date`,
        total_requests: count(),
        total_tokens: sum(llmTelemetry.totalTokens),
        total_cost_microdollars: sum(llmTelemetry.costMicrodollars),
      })
      .from(llmTelemetry)
      .where(gte(llmTelemetry.createdAt, since))
      .groupBy(sql`date_trunc('day', ${llmTelemetry.createdAt})`)
      .orderBy(sql`date_trunc('day', ${llmTelemetry.createdAt})`);

    return {
      period_days: daysNum,
      since: since.toISOString(),
      daily: rows.map((row) => {
        const costMicro = Number(row.total_cost_microdollars ?? 0);
        return {
          date: row.date,
          requests: row.total_requests,
          tokens: Number(row.total_tokens ?? 0),
          cost_usd: microdollarsToNumber(costMicro),
          cost_microdollars: costMicro,
        };
      }),
    };
  });
};
