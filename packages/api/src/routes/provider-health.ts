import type { FastifyInstance } from "fastify";
import { inArray } from "drizzle-orm";
import { appConfig } from "@watch-tower/db";
import { checkAllProviders } from "@watch-tower/llm";
import type { ApiDeps } from "../server.js";

export const registerProviderHealthRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  /**
   * POST /health/providers
   * Pings all active API providers (LLM, embeddings, translation) and returns
   * health status synchronously. Used by the "Check API Health" button.
   */
  app.post("/health/providers", { preHandler: deps.requireApiKey }, async (_req, reply) => {
    // Read translation config from DB
    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, ["translation_provider", "translation_model"]));
    const configMap = new Map(rows.map((r) => [r.key, r.value]));

    const env = process.env;
    const results = await checkAllProviders({
      llmProvider: env.LLM_PROVIDER,
      llmFallbackProvider: env.LLM_FALLBACK_PROVIDER,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      deepseekApiKey: env.DEEPSEEK_API_KEY,
      googleAiApiKey: env.GOOGLE_AI_API_KEY,
      embeddingModel: env.EMBEDDING_MODEL,
      translationProvider: (configMap.get("translation_provider") as string) ?? undefined,
      translationModel: (configMap.get("translation_model") as string) ?? undefined,
    });

    return reply.send({
      results,
      checked_at: new Date().toISOString(),
    });
  });
};
