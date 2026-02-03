import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { scoringRules, sectors } from "@watch-tower/db";
import {
  scoringConfigSchema,
  defaultScoringConfig,
  buildScoringPrompt,
  type ScoringConfig,
} from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export const registerScoringRulesRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /scoring-rules - List all rules with sector info
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/scoring-rules", { preHandler: deps.requireApiKey }, async () => {
    const rows = await deps.db
      .select({
        id: scoringRules.id,
        sectorId: scoringRules.sectorId,
        sectorName: sectors.name,
        sectorSlug: sectors.slug,
        config: scoringRules.scoreCriteria,
        promptTemplate: scoringRules.promptTemplate,
        autoApproveThreshold: scoringRules.autoApproveThreshold,
        autoRejectThreshold: scoringRules.autoRejectThreshold,
        updatedAt: scoringRules.updatedAt,
      })
      .from(scoringRules)
      .innerJoin(sectors, eq(scoringRules.sectorId, sectors.id));

    return rows.map((r) => {
      // Determine if using structured config or legacy prompt
      const hasStructuredConfig =
        r.config && typeof r.config === "object" && Object.keys(r.config).length > 0;

      return {
        id: r.id,
        sector_id: r.sectorId,
        sector_name: r.sectorName,
        sector_slug: r.sectorSlug,
        config: hasStructuredConfig ? r.config : defaultScoringConfig,
        is_legacy: !hasStructuredConfig && !!r.promptTemplate,
        auto_approve_threshold: r.autoApproveThreshold,
        auto_reject_threshold: r.autoRejectThreshold,
        updated_at: r.updatedAt,
      };
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /scoring-rules/:sectorId - Get single rule with preview
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { sectorId: string } }>(
    "/scoring-rules/:sectorId",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { sectorId } = request.params;

      // Get sector info
      const [sector] = await deps.db
        .select({ id: sectors.id, name: sectors.name })
        .from(sectors)
        .where(eq(sectors.id, sectorId));

      if (!sector) {
        return reply.code(404).send({ error: "Sector not found" });
      }

      // Get rule if exists
      const [rule] = await deps.db
        .select()
        .from(scoringRules)
        .where(eq(scoringRules.sectorId, sectorId));

      const hasStructuredConfig =
        rule?.scoreCriteria &&
        typeof rule.scoreCriteria === "object" &&
        Object.keys(rule.scoreCriteria).length > 0;

      const config = hasStructuredConfig
        ? (rule.scoreCriteria as ScoringConfig)
        : defaultScoringConfig;

      // Generate preview of what prompt the worker will use
      const promptPreview = buildScoringPrompt(config, sector.name);

      return {
        sector_id: sectorId,
        sector_name: sector.name,
        config,
        is_legacy: !hasStructuredConfig && !!rule?.promptTemplate,
        legacy_prompt: rule?.promptTemplate ?? null,
        auto_approve_threshold: rule?.autoApproveThreshold ?? 5,
        auto_reject_threshold: rule?.autoRejectThreshold ?? 2,
        prompt_preview: promptPreview,
        updated_at: rule?.updatedAt ?? null,
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /scoring-rules/:sectorId - Save structured config
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { sectorId: string };
    Body: {
      config: unknown;
      auto_approve_threshold?: number;
      auto_reject_threshold?: number;
    };
  }>("/scoring-rules/:sectorId", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { sectorId } = request.params;
    const { config, auto_approve_threshold = 5, auto_reject_threshold = 2 } = request.body ?? {};

    // Validate config against schema
    const parsed = scoringConfigSchema.safeParse(config);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid configuration",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Validate thresholds
    if (
      !Number.isInteger(auto_approve_threshold) ||
      auto_approve_threshold < 1 ||
      auto_approve_threshold > 5
    ) {
      return reply.code(400).send({
        error: "auto_approve_threshold must be integer 1-5",
      });
    }
    if (
      !Number.isInteger(auto_reject_threshold) ||
      auto_reject_threshold < 1 ||
      auto_reject_threshold > 5
    ) {
      return reply.code(400).send({
        error: "auto_reject_threshold must be integer 1-5",
      });
    }
    if (auto_reject_threshold >= auto_approve_threshold) {
      return reply.code(400).send({
        error: "auto_reject_threshold must be less than auto_approve_threshold",
      });
    }

    // Verify sector exists
    const [sector] = await deps.db
      .select({ id: sectors.id, name: sectors.name })
      .from(sectors)
      .where(eq(sectors.id, sectorId));

    if (!sector) {
      return reply.code(404).send({ error: "Sector not found" });
    }

    // Upsert rule (only saves structured config, prompt_template left empty)
    await deps.db
      .insert(scoringRules)
      .values({
        sectorId,
        scoreCriteria: parsed.data,
        promptTemplate: "", // Empty - worker will build from config at runtime
        autoApproveThreshold: auto_approve_threshold,
        autoRejectThreshold: auto_reject_threshold,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: scoringRules.sectorId,
        set: {
          scoreCriteria: parsed.data,
          autoApproveThreshold: auto_approve_threshold,
          autoRejectThreshold: auto_reject_threshold,
          updatedAt: new Date(),
        },
      });

    // Return preview of compiled prompt
    const promptPreview = buildScoringPrompt(parsed.data, sector.name);

    return {
      success: true,
      prompt_preview: promptPreview,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /scoring-rules/:sectorId - Remove custom rule (use defaults)
  // ─────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { sectorId: string } }>(
    "/scoring-rules/:sectorId",
    { preHandler: deps.requireApiKey },
    async (request) => {
      const { sectorId } = request.params;
      await deps.db.delete(scoringRules).where(eq(scoringRules.sectorId, sectorId));
      return { success: true, message: "Rule deleted, sector will use default settings" };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /scoring-rules/preview - Preview prompt without saving
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Body: { config: unknown; sector_name: string };
  }>("/scoring-rules/preview", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { config, sector_name } = request.body ?? {};

    if (!sector_name || typeof sector_name !== "string") {
      return reply.code(400).send({ error: "sector_name is required" });
    }

    const parsed = scoringConfigSchema.safeParse(config);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid configuration",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const prompt = buildScoringPrompt(parsed.data, sector_name);
    return { prompt };
  });
};
