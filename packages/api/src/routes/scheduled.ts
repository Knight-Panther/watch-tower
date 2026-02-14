import type { FastifyInstance } from "fastify";
import { eq, and, gte, lte, inArray, desc, asc, sql, count } from "drizzle-orm";
import { articles, postDeliveries, rssSources, sectors } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

export const registerScheduledRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // GET /scheduled - List scheduled deliveries with filters
  app.get<{
    Querystring: {
      page?: number;
      limit?: number;
      status?: string;
      platform?: string;
      sector_id?: string;
      from?: string;
      to?: string;
      sort_by?: "scheduled_at" | "created_at";
      sort_dir?: "asc" | "desc";
    };
  }>("/scheduled", { preHandler: deps.requireApiKey }, async (request) => {
    const {
      page = 1,
      limit = 50,
      status,
      platform,
      sector_id,
      from,
      to,
      sort_by = "scheduled_at",
      sort_dir = "asc",
    } = request.query;

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * safeLimit;

    // Build WHERE conditions for deliveries
    const conditions = [];

    if (status) {
      const statuses = status.split(",");
      conditions.push(inArray(postDeliveries.status, statuses));
    }

    if (platform) {
      const platforms = platform.split(",");
      conditions.push(inArray(postDeliveries.platform, platforms));
    }

    if (from) {
      conditions.push(gte(postDeliveries.scheduledAt, new Date(from)));
    }

    if (to) {
      conditions.push(lte(postDeliveries.scheduledAt, new Date(to)));
    }

    if (sector_id) {
      const sectorIds = sector_id.split(",");
      conditions.push(inArray(articles.sectorId, sectorIds));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Sort
    const getSortColumn = () => {
      switch (sort_by) {
        case "created_at":
          return postDeliveries.createdAt;
        case "scheduled_at":
        default:
          return postDeliveries.scheduledAt;
      }
    };
    const sortColumn = getSortColumn();
    const orderBy = sort_dir === "desc" ? desc(sortColumn) : asc(sortColumn);

    // Query deliveries with article data
    const [rows, totalResult] = await Promise.all([
      deps.db
        .select({
          id: postDeliveries.id,
          article_id: postDeliveries.articleId,
          platform: postDeliveries.platform,
          scheduled_at: postDeliveries.scheduledAt,
          status: postDeliveries.status,
          platform_post_id: postDeliveries.platformPostId,
          error_message: postDeliveries.errorMessage,
          sent_at: postDeliveries.sentAt,
          created_at: postDeliveries.createdAt,
          // Article fields
          article_title: articles.title,
          article_url: articles.url,
          article_summary: articles.llmSummary,
          article_score: articles.importanceScore,
          // Georgian translation fields
          article_title_ka: articles.titleKa,
          article_summary_ka: articles.llmSummaryKa,
          // Source/sector
          source_name: rssSources.name,
          sector_id: articles.sectorId,
          sector_name: sectors.name,
        })
        .from(postDeliveries)
        .innerJoin(articles, eq(postDeliveries.articleId, articles.id))
        .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(whereClause)
        .orderBy(orderBy)
        .limit(safeLimit)
        .offset(offset),

      deps.db
        .select({ count: count() })
        .from(postDeliveries)
        .innerJoin(articles, eq(postDeliveries.articleId, articles.id))
        .where(whereClause),
    ]);

    const total = Number(totalResult[0]?.count ?? 0);

    return {
      data: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        total_pages: Math.ceil(total / safeLimit),
      },
    };
  });

  // GET /scheduled/:id - Get single delivery details
  app.get<{ Params: { id: string } }>(
    "/scheduled/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;

      const [row] = await deps.db
        .select({
          id: postDeliveries.id,
          article_id: postDeliveries.articleId,
          platform: postDeliveries.platform,
          scheduled_at: postDeliveries.scheduledAt,
          status: postDeliveries.status,
          platform_post_id: postDeliveries.platformPostId,
          error_message: postDeliveries.errorMessage,
          sent_at: postDeliveries.sentAt,
          created_at: postDeliveries.createdAt,
          article_title: articles.title,
          article_url: articles.url,
          article_summary: articles.llmSummary,
          article_score: articles.importanceScore,
          source_name: rssSources.name,
          sector_id: articles.sectorId,
          sector_name: sectors.name,
        })
        .from(postDeliveries)
        .innerJoin(articles, eq(postDeliveries.articleId, articles.id))
        .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(eq(postDeliveries.id, id));

      if (!row) {
        return reply.code(404).send({ error: "Delivery not found" });
      }

      return row;
    },
  );

  // PATCH /scheduled/:id - Reschedule a delivery
  app.patch<{
    Params: { id: string };
    Body: { scheduled_at: string };
  }>("/scheduled/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { scheduled_at } = request.body ?? {};

    if (!scheduled_at) {
      return reply.code(400).send({ error: "scheduled_at is required" });
    }

    const newScheduledAt = new Date(scheduled_at);
    if (isNaN(newScheduledAt.getTime())) {
      return reply.code(400).send({ error: "Invalid date format" });
    }

    // Only allow rescheduling 'scheduled' deliveries
    const [existing] = await deps.db
      .select({ status: postDeliveries.status })
      .from(postDeliveries)
      .where(eq(postDeliveries.id, id));

    if (!existing) {
      return reply.code(404).send({ error: "Delivery not found" });
    }

    if (existing.status !== "scheduled") {
      return reply.code(400).send({
        error: `Cannot reschedule delivery with status '${existing.status}'`,
      });
    }

    const [updated] = await deps.db
      .update(postDeliveries)
      .set({ scheduledAt: newScheduledAt })
      .where(eq(postDeliveries.id, id))
      .returning({
        id: postDeliveries.id,
        scheduled_at: postDeliveries.scheduledAt,
        status: postDeliveries.status,
      });

    return updated;
  });

  // DELETE /scheduled/:id - Cancel a scheduled delivery
  app.delete<{ Params: { id: string } }>(
    "/scheduled/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;

      // Only allow cancelling 'scheduled' deliveries
      const [existing] = await deps.db
        .select({
          status: postDeliveries.status,
          articleId: postDeliveries.articleId,
        })
        .from(postDeliveries)
        .where(eq(postDeliveries.id, id));

      if (!existing) {
        return reply.code(404).send({ error: "Delivery not found" });
      }

      if (existing.status !== "scheduled") {
        return reply.code(400).send({
          error: `Cannot cancel delivery with status '${existing.status}'`,
        });
      }

      const [updated] = await deps.db
        .update(postDeliveries)
        .set({ status: "cancelled" })
        .where(eq(postDeliveries.id, id))
        .returning({
          id: postDeliveries.id,
          status: postDeliveries.status,
        });

      // If no active deliveries remain for this article, reset it back to "scored"
      // so the user can re-schedule. Only reset "approved" articles (not "posted").
      if (existing.articleId) {
        const [remaining] = await deps.db
          .select({ count: count() })
          .from(postDeliveries)
          .where(
            and(
              eq(postDeliveries.articleId, existing.articleId),
              inArray(postDeliveries.status, ["scheduled", "pending"]),
            ),
          );

        if (Number(remaining.count) === 0) {
          await deps.db
            .update(articles)
            .set({ pipelineStage: "scored", approvedAt: null })
            .where(
              and(eq(articles.id, existing.articleId), eq(articles.pipelineStage, "approved")),
            );
        }
      }

      return updated;
    },
  );

  // GET /scheduled/stats - Stats for scheduled posts
  app.get("/scheduled/stats", { preHandler: deps.requireApiKey }, async () => {
    const result = await deps.db
      .select({
        status: postDeliveries.status,
        count: count(),
      })
      .from(postDeliveries)
      .groupBy(postDeliveries.status);

    const statsByStatus: Record<string, number> = {};
    for (const row of result) {
      statsByStatus[row.status] = Number(row.count);
    }

    // Count due in next hour
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    const [dueResult] = await deps.db
      .select({ count: count() })
      .from(postDeliveries)
      .where(
        and(
          eq(postDeliveries.status, "scheduled"),
          lte(postDeliveries.scheduledAt, oneHourFromNow),
        ),
      );

    return {
      by_status: statsByStatus,
      due_in_next_hour: Number(dueResult?.count ?? 0),
    };
  });
};
