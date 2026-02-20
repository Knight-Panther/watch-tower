import type { FastifyInstance } from "fastify";
import { eq, and, gte, lte, inArray, desc, asc, sql, count } from "drizzle-orm";
import { articles, rssSources, sectors, postDeliveries, appConfig } from "@watch-tower/db";
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
    const primaryOrder = sort_dir === "asc" ? asc(sortColumn) : desc(sortColumn);
    // Secondary sort ensures deterministic ordering when primary column has ties
    const secondaryOrder = sortColumn === articles.publishedAt
      ? desc(articles.createdAt)
      : desc(articles.publishedAt);

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
          // Translation fields
          title_ka: articles.titleKa,
          llm_summary_ka: articles.llmSummaryKa,
          translation_status: articles.translationStatus,
          translation_error: articles.translationError,
        })
        .from(articles)
        .leftJoin(rssSources, eq(articles.sourceId, rssSources.id))
        .leftJoin(sectors, eq(articles.sectorId, sectors.id))
        .where(whereClause)
        .orderBy(primaryOrder, secondaryOrder)
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
          // Translation fields
          title_ka: articles.titleKa,
          llm_summary_ka: articles.llmSummaryKa,
          translation_status: articles.translationStatus,
          translation_error: articles.translationError,
          translation_model: articles.translationModel,
          translated_at: articles.translatedAt,
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

  // PATCH /articles/:id - Update article (edit title, summary, translations, approve/reject)
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      llm_summary?: string;
      title_ka?: string;
      llm_summary_ka?: string;
      pipeline_stage?: "approved" | "rejected" | "posted";
    };
  }>("/articles/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { title, llm_summary, title_ka, llm_summary_ka, pipeline_stage } = request.body ?? {};

    const updates: Record<string, unknown> = {};

    if (title !== undefined) {
      updates.title = title;
    }

    if (llm_summary !== undefined) {
      updates.llmSummary = llm_summary;
    }

    if (title_ka !== undefined) {
      updates.titleKa = title_ka;
    }

    if (llm_summary_ka !== undefined) {
      updates.llmSummaryKa = llm_summary_ka;
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
      title: updated.title,
      llm_summary: updated.llmSummary,
      title_ka: updated.titleKa,
      llm_summary_ka: updated.llmSummaryKa,
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

  // POST /articles/:id/schedule - Approve article and schedule delivery to one or more platforms
  app.post<{
    Params: { id: string };
    Body: {
      platforms: string[]; // Array of platforms
      scheduled_at?: string; // ISO string, null = immediate
      title?: string;
      title_ka?: string;
      llm_summary?: string;
      llm_summary_ka?: string;
    };
  }>("/articles/:id/schedule", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { platforms, scheduled_at, title: reqTitle, title_ka, llm_summary, llm_summary_ka } = request.body ?? {};

    if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return reply.code(400).send({ error: "platforms array is required and must not be empty" });
    }

    const validPlatforms = ["telegram", "facebook", "linkedin"];
    const invalidPlatforms = platforms.filter((p) => !validPlatforms.includes(p));
    if (invalidPlatforms.length > 0) {
      return reply.code(400).send({
        error: `Invalid platform(s): ${invalidPlatforms.join(", ")}. Must be one of: ${validPlatforms.join(", ")}`,
      });
    }

    // Check article exists and is in valid state for scheduling
    const [article] = await deps.db
      .select({ id: articles.id, pipelineStage: articles.pipelineStage })
      .from(articles)
      .where(eq(articles.id, id));

    if (!article) {
      return reply.code(404).send({ error: "Article not found" });
    }

    const allowedStages = ["scored", "approved", "posted"];
    if (!allowedStages.includes(article.pipelineStage)) {
      return reply.code(400).send({
        error: `Article must be in 'scored', 'approved', or 'posted' stage to schedule (current: ${article.pipelineStage})`,
      });
    }

    // Check for existing scheduled deliveries for same article on requested platforms
    const existingDeliveries = await deps.db
      .select({ id: postDeliveries.id, platform: postDeliveries.platform })
      .from(postDeliveries)
      .where(
        and(
          eq(postDeliveries.articleId, id),
          inArray(postDeliveries.platform, platforms),
          inArray(postDeliveries.status, ["scheduled", "posting"]),
        ),
      );

    if (existingDeliveries.length > 0) {
      const existingPlatforms = existingDeliveries.map((d) => d.platform).join(", ");
      return reply.code(409).send({
        error: `Article already has pending delivery for: ${existingPlatforms}`,
        existingDeliveries: existingDeliveries.map((d) => ({
          id: d.id,
          platform: d.platform,
        })),
      });
    }

    // Parse scheduled_at or default to now for immediate
    const scheduledAt = scheduled_at ? new Date(scheduled_at) : new Date();

    // Update article — skip stage change for repost (already posted)
    const articleUpdates: Record<string, unknown> = {};
    if (article.pipelineStage !== "posted") {
      articleUpdates.pipelineStage = "approved";
      articleUpdates.approvedAt = new Date();
    }
    if (reqTitle !== undefined) {
      articleUpdates.title = reqTitle;
    }
    if (title_ka !== undefined) {
      articleUpdates.titleKa = title_ka;
    }
    if (llm_summary !== undefined) {
      articleUpdates.llmSummary = llm_summary;
    }
    if (llm_summary_ka !== undefined) {
      articleUpdates.llmSummaryKa = llm_summary_ka;
    }

    if (Object.keys(articleUpdates).length > 0) {
      await deps.db.update(articles).set(articleUpdates).where(eq(articles.id, id));
    }

    // Create delivery records for all requested platforms
    const deliveryValues = platforms.map((platform) => ({
      articleId: id,
      platform,
      scheduledAt,
      status: "scheduled" as const,
    }));

    const deliveries = await deps.db.insert(postDeliveries).values(deliveryValues).returning();

    return {
      deliveries: deliveries.map((d) => ({
        delivery_id: d.id,
        platform: d.platform,
        scheduled_at: d.scheduledAt?.toISOString(),
        status: d.status,
      })),
      article_id: id,
      platforms,
    };
  });

  // POST /articles/:id/translate - Queue manual Georgian translation
  app.post<{ Params: { id: string } }>(
    "/articles/:id/translate",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;

      // Check Georgian mode is active
      const [langRow] = await deps.db
        .select({ value: appConfig.value })
        .from(appConfig)
        .where(eq(appConfig.key, "posting_language"));
      const postingLanguage = (langRow?.value as string) ?? "en";

      if (postingLanguage !== "ka") {
        return reply.code(400).send({ error: "Georgian mode is not active" });
      }

      // Fetch article
      const [article] = await deps.db
        .select({
          id: articles.id,
          llmSummary: articles.llmSummary,
          pipelineStage: articles.pipelineStage,
          translationStatus: articles.translationStatus,
        })
        .from(articles)
        .where(eq(articles.id, id));

      if (!article) {
        return reply.code(404).send({ error: "Article not found" });
      }

      if (!article.llmSummary) {
        return reply.code(400).send({ error: "Article has not been scored yet" });
      }

      const validStages = ["scored", "approved", "posted"];
      if (!validStages.includes(article.pipelineStage)) {
        return reply.code(400).send({
          error: `Article must be in scored, approved, or posted stage (current: ${article.pipelineStage})`,
        });
      }

      if (article.translationStatus === "queued") {
        return reply.code(409).send({ error: "Translation already queued" });
      }
      if (article.translationStatus === "translating") {
        return reply.code(409).send({ error: "Translation already in progress" });
      }
      if (article.translationStatus === "translated") {
        return reply.code(409).send({ error: "Article already translated" });
      }

      // Atomic update: set queued + reset attempts for fresh start
      // Status guard in WHERE prevents TOCTOU race — if worker already claimed
      // or completed between the SELECT and this UPDATE, 0 rows match → 409
      const [updated] = await deps.db
        .update(articles)
        .set({
          translationStatus: "queued",
          translationAttempts: 0,
          translationError: null,
          titleKa: null,
          llmSummaryKa: null,
        })
        .where(
          and(
            eq(articles.id, id),
            sql`llm_summary IS NOT NULL`,
            sql`(translation_status IS NULL OR translation_status IN ('failed', 'exhausted'))`,
          ),
        )
        .returning({ id: articles.id, translationStatus: articles.translationStatus });

      if (!updated) {
        return reply.code(409).send({ error: "Translation status changed, please refresh" });
      }

      return {
        id: updated.id,
        translation_status: updated.translationStatus,
      };
    },
  );

  // DELETE /articles/:id/schedule - Cancel scheduled delivery
  app.delete<{
    Params: { id: string };
    Querystring: { platform?: string };
  }>("/articles/:id/schedule", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { platform } = request.query;

    // Build condition
    const conditions = [eq(postDeliveries.articleId, id), eq(postDeliveries.status, "scheduled")];
    if (platform) {
      conditions.push(eq(postDeliveries.platform, platform));
    }

    const updated = await deps.db
      .update(postDeliveries)
      .set({ status: "cancelled" })
      .where(and(...conditions))
      .returning({ id: postDeliveries.id, platform: postDeliveries.platform });

    if (updated.length === 0) {
      return reply.code(404).send({ error: "No scheduled deliveries found" });
    }

    // If no active deliveries remain for this article, reset it back to "scored"
    // so the user can re-schedule. Only reset "approved" articles (not "posted").
    const [remaining] = await deps.db
      .select({ count: count() })
      .from(postDeliveries)
      .where(
        and(
          eq(postDeliveries.articleId, id),
          inArray(postDeliveries.status, ["scheduled", "pending"]),
        ),
      );

    if (Number(remaining.count) === 0) {
      await deps.db
        .update(articles)
        .set({ pipelineStage: "scored", approvedAt: null })
        .where(and(eq(articles.id, id), eq(articles.pipelineStage, "approved")));
    }

    return { cancelled: updated.length, deliveries: updated };
  });
};
