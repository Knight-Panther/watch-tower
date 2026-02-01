import type { FastifyInstance } from "fastify";
import { eq, and, gte, lte, inArray, desc, asc, sql, count } from "drizzle-orm";
import { articles, rssSources, sectors } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

export const registerArticlesRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // GET /articles - Paginated list with filters and sorting
  app.get<{
    Querystring: {
      page?: number;
      limit?: number;
      sector_id?: string;
      source_id?: string;
      status?: string;
      min_score?: number;
      max_score?: number;
      date_from?: string;
      date_to?: string;
      search?: string;
      sort_by?: "published_at" | "importance_score" | "created_at";
      sort_dir?: "asc" | "desc";
    };
  }>("/articles", { preHandler: deps.requireApiKey }, async (request) => {
    const {
      page = 1,
      limit = 50,
      sector_id,
      source_id,
      status,
      min_score,
      max_score,
      date_from,
      date_to,
      search,
      sort_by = "published_at",
      sort_dir = "desc",
    } = request.query;

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * safeLimit;

    // Build WHERE conditions
    const conditions = [];

    if (sector_id) {
      const ids = sector_id.split(",");
      conditions.push(inArray(articles.sectorId, ids));
    }

    if (source_id) {
      const ids = source_id.split(",");
      conditions.push(inArray(articles.sourceId, ids));
    }

    if (status) {
      const statuses = status.split(",");
      conditions.push(inArray(articles.pipelineStage, statuses));
    }

    if (min_score !== undefined) {
      conditions.push(gte(articles.importanceScore, min_score));
    }

    if (max_score !== undefined) {
      conditions.push(lte(articles.importanceScore, max_score));
    }

    if (date_from) {
      conditions.push(gte(articles.publishedAt, new Date(date_from)));
    }

    if (date_to) {
      conditions.push(lte(articles.publishedAt, new Date(date_to)));
    }

    if (search) {
      conditions.push(
        sql`(${articles.title} ILIKE ${`%${search}%`} OR ${articles.llmSummary} ILIKE ${`%${search}%`})`,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Sort mapping
    const getSortColumn = () => {
      switch (sort_by) {
        case "importance_score":
          return articles.importanceScore;
        case "created_at":
          return articles.createdAt;
        case "published_at":
        default:
          return articles.publishedAt;
      }
    };
    const sortColumn = getSortColumn();
    const orderBy = sort_dir === "asc" ? asc(sortColumn) : desc(sortColumn);

    // Execute queries in parallel
    const [rows, totalResult] = await Promise.all([
      deps.db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          content_snippet: articles.contentSnippet,
          llm_summary: articles.llmSummary,
          importance_score: articles.importanceScore,
          pipeline_stage: articles.pipelineStage,
          published_at: articles.publishedAt,
          created_at: articles.createdAt,
          scored_at: articles.scoredAt,
          approved_at: articles.approvedAt,
          // Joined fields
          source_id: articles.sourceId,
          source_name: rssSources.name,
          source_url: rssSources.url,
          sector_id: articles.sectorId,
          sector_name: sectors.name,
        })
        .from(articles)
        .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(whereClause)
        .orderBy(orderBy)
        .limit(safeLimit)
        .offset(offset),

      deps.db.select({ count: count() }).from(articles).where(whereClause),
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

  // GET /articles/:id - Single article detail
  app.get<{ Params: { id: string } }>(
    "/articles/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;

      const [article] = await deps.db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          content_snippet: articles.contentSnippet,
          llm_summary: articles.llmSummary,
          importance_score: articles.importanceScore,
          scoring_model: articles.scoringModel,
          pipeline_stage: articles.pipelineStage,
          is_semantic_duplicate: articles.isSemanticDuplicate,
          duplicate_of_id: articles.duplicateOfId,
          similarity_score: articles.similarityScore,
          published_at: articles.publishedAt,
          created_at: articles.createdAt,
          scored_at: articles.scoredAt,
          approved_at: articles.approvedAt,
          source_name: rssSources.name,
          source_url: rssSources.url,
          sector_name: sectors.name,
        })
        .from(articles)
        .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(eq(articles.id, id));

      if (!article) {
        return reply.code(404).send({ error: "Article not found" });
      }

      return article;
    },
  );

  // PATCH /articles/:id - Update article (edit summary, approve/reject)
  app.patch<{
    Params: { id: string };
    Body: {
      llm_summary?: string;
      pipeline_stage?: "approved" | "rejected" | "posted";
    };
  }>("/articles/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { llm_summary, pipeline_stage } = request.body ?? {};

    const updates: Record<string, unknown> = {};

    if (llm_summary !== undefined) {
      updates.llmSummary = llm_summary;
    }

    if (pipeline_stage !== undefined) {
      updates.pipelineStage = pipeline_stage;
      if (pipeline_stage === "approved") {
        updates.approvedAt = new Date();
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "No updates provided" });
    }

    const [updated] = await deps.db
      .update(articles)
      .set(updates)
      .where(eq(articles.id, id))
      .returning();

    if (!updated) {
      return reply.code(404).send({ error: "Article not found" });
    }

    return {
      id: updated.id,
      llm_summary: updated.llmSummary,
      pipeline_stage: updated.pipelineStage,
      approved_at: updated.approvedAt,
    };
  });

  // POST /articles/:id/approve - Approve with optional summary edit
  app.post<{
    Params: { id: string };
    Body: { llm_summary?: string };
  }>("/articles/:id/approve", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { llm_summary } = request.body ?? {};

    const updates: Record<string, unknown> = {
      pipelineStage: "approved",
      approvedAt: new Date(),
    };

    if (llm_summary !== undefined) {
      updates.llmSummary = llm_summary;
    }

    const [updated] = await deps.db
      .update(articles)
      .set(updates)
      .where(eq(articles.id, id))
      .returning();

    if (!updated) {
      return reply.code(404).send({ error: "Article not found" });
    }

    return {
      id: updated.id,
      llm_summary: updated.llmSummary,
      pipeline_stage: updated.pipelineStage,
      approved_at: updated.approvedAt,
    };
  });

  // POST /articles/:id/reject - Reject article
  app.post<{ Params: { id: string } }>(
    "/articles/:id/reject",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;

      const [updated] = await deps.db
        .update(articles)
        .set({ pipelineStage: "rejected" })
        .where(eq(articles.id, id))
        .returning();

      if (!updated) {
        return reply.code(404).send({ error: "Article not found" });
      }

      return {
        id: updated.id,
        pipeline_stage: updated.pipelineStage,
      };
    },
  );

  // GET /articles/filters/options - Get available filter options for dropdowns
  app.get("/articles/filters/options", { preHandler: deps.requireApiKey }, async () => {
    const [sectorsList, sourcesList, statusCounts] = await Promise.all([
      deps.db.select({ id: sectors.id, name: sectors.name }).from(sectors).orderBy(sectors.name),
      deps.db
        .select({ id: rssSources.id, name: rssSources.name })
        .from(rssSources)
        .where(eq(rssSources.active, true))
        .orderBy(rssSources.name),
      deps.db
        .select({
          status: articles.pipelineStage,
          count: count(),
        })
        .from(articles)
        .groupBy(articles.pipelineStage),
    ]);

    return {
      sectors: sectorsList,
      sources: sourcesList,
      statuses: statusCounts.map((s) => ({
        status: s.status,
        count: Number(s.count),
      })),
    };
  });

  // POST /articles/batch/approve - Batch approve multiple articles
  app.post<{
    Body: { ids: string[] };
  }>("/articles/batch/approve", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { ids } = request.body ?? {};

    if (!ids?.length) {
      return reply.code(400).send({ error: "ids are required" });
    }

    const updated = await deps.db
      .update(articles)
      .set({
        pipelineStage: "approved",
        approvedAt: new Date(),
      })
      .where(inArray(articles.id, ids))
      .returning({ id: articles.id });

    return { updated: updated.length, ids: updated.map((u) => u.id) };
  });

  // POST /articles/batch/reject - Batch reject multiple articles
  app.post<{
    Body: { ids: string[] };
  }>("/articles/batch/reject", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { ids } = request.body ?? {};

    if (!ids?.length) {
      return reply.code(400).send({ error: "ids are required" });
    }

    const updated = await deps.db
      .update(articles)
      .set({ pipelineStage: "rejected" })
      .where(inArray(articles.id, ids))
      .returning({ id: articles.id });

    return { updated: updated.length, ids: updated.map((u) => u.id) };
  });
};
