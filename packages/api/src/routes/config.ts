import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { appConfig } from "@watch-tower/db";
import { logger } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

const CONSTRAINTS = {
  feedItemsTtl: { min: 30, max: 60, unit: "days" },
  fetchRunsTtl: { min: 1, max: 2160, unit: "hours" },
  interval: { min: 1, max: 4320, unit: "minutes" },
  maxAge: { min: 1, max: 15, unit: "days" },
  llmTelemetryTtl: { min: 1, max: 60, unit: "days" },
  articleImagesTtl: { min: 1, max: 60, unit: "days" },
  postDeliveriesTtl: { min: 1, max: 60, unit: "days" },
} as const;

const getConfigValue = async (deps: ApiDeps, key: string, fallback: number) => {
  const [row] = await deps.db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  return row ? Number(row.value) : fallback;
};

const getBooleanConfig = async (deps: ApiDeps, key: string, fallback: boolean) => {
  const [row] = await deps.db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  if (!row) return fallback;
  return row.value === true || row.value === "true";
};

const upsertConfig = async (deps: ApiDeps, key: string, value: number) => {
  const [row] = await deps.db
    .insert(appConfig)
    .values({ key, value: String(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value: String(value), updatedAt: new Date() },
    })
    .returning();
  return row;
};

const upsertBooleanConfig = async (deps: ApiDeps, key: string, value: boolean) => {
  const [row] = await deps.db
    .insert(appConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: new Date() },
    })
    .returning();
  return row;
};

/**
 * Write a typed value to app_config. Drizzle handles JSONB serialization.
 * Use for arrays, strings, and complex types.
 */
const upsertTypedConfig = async (deps: ApiDeps, key: string, value: unknown) => {
  const [row] = await deps.db
    .insert(appConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: new Date() },
    })
    .returning();
  return row;
};

export const registerConfigRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/config/constraints", { preHandler: deps.requireApiKey }, async () => {
    return CONSTRAINTS;
  });

  app.get("/config/feed-items-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "feed_items_ttl_days", 60);
    return { days };
  });

  app.get("/config/feed-fetch-runs-ttl", { preHandler: deps.requireApiKey }, async () => {
    const hours = await getConfigValue(deps, "feed_fetch_runs_ttl_hours", 336);
    return { hours };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/feed-items-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.feedItemsTtl.min ||
        days > CONSTRAINTS.feedItemsTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.feedItemsTtl.min} and ${CONSTRAINTS.feedItemsTtl.max}`,
        });
      }
      await upsertConfig(deps, "feed_items_ttl_days", days);
      return { days };
    },
  );

  app.patch<{ Body: { hours: number } }>(
    "/config/feed-fetch-runs-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { hours } = request.body ?? {};
      if (
        !Number.isFinite(hours) ||
        hours < CONSTRAINTS.fetchRunsTtl.min ||
        hours > CONSTRAINTS.fetchRunsTtl.max
      ) {
        return reply.code(400).send({
          error: `hours must be a number between ${CONSTRAINTS.fetchRunsTtl.min} and ${CONSTRAINTS.fetchRunsTtl.max}`,
        });
      }
      await upsertConfig(deps, "feed_fetch_runs_ttl_hours", hours);
      return { hours };
    },
  );

  // LLM Telemetry TTL
  app.get("/config/llm-telemetry-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "llm_telemetry_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/llm-telemetry-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.llmTelemetryTtl.min ||
        days > CONSTRAINTS.llmTelemetryTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.llmTelemetryTtl.min} and ${CONSTRAINTS.llmTelemetryTtl.max}`,
        });
      }
      await upsertConfig(deps, "llm_telemetry_ttl_days", days);
      return { days };
    },
  );

  // Article Images TTL
  app.get("/config/article-images-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "article_images_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/article-images-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.articleImagesTtl.min ||
        days > CONSTRAINTS.articleImagesTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.articleImagesTtl.min} and ${CONSTRAINTS.articleImagesTtl.max}`,
        });
      }
      await upsertConfig(deps, "article_images_ttl_days", days);
      return { days };
    },
  );

  // Post Deliveries TTL
  app.get("/config/post-deliveries-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "post_deliveries_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/post-deliveries-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.postDeliveriesTtl.min ||
        days > CONSTRAINTS.postDeliveriesTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.postDeliveriesTtl.min} and ${CONSTRAINTS.postDeliveriesTtl.max}`,
        });
      }
      await upsertConfig(deps, "post_deliveries_ttl_days", days);
      return { days };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Auto-Post Settings (Per-Platform)
  // When enabled, auto-approved articles are immediately posted to that platform.
  // Each platform has its own toggle for granular control.
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Telegram (Active) ──
  // Fully integrated via packages/social/src/telegram.ts
  app.get("/config/auto-post-telegram", { preHandler: deps.requireApiKey }, async () => {
    // Note: Also checks legacy key "auto_post_score5" for backward compatibility
    const enabled = await getBooleanConfig(deps, "auto_post_telegram", true);
    return { enabled };
  });

  app.patch<{ Body: { enabled: boolean } }>(
    "/config/auto-post-telegram",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      await upsertBooleanConfig(deps, "auto_post_telegram", enabled);
      return { enabled };
    },
  );

  // ── Facebook (Placeholder - Coming Soon) ──
  // TODO: To enable Facebook auto-posting:
  // 1. Implement FacebookProvider in packages/social/src/facebook.ts
  // 2. Add Facebook Graph API credentials to env (FB_PAGE_ID, FB_ACCESS_TOKEN)
  // 3. Update distribution.ts worker to check this config and post to Facebook
  // 4. Enable the UI toggle in ScoringRules.tsx
  app.get("/config/auto-post-facebook", { preHandler: deps.requireApiKey }, async () => {
    const enabled = await getBooleanConfig(deps, "auto_post_facebook", false);
    return { enabled };
  });

  app.patch<{ Body: { enabled: boolean } }>(
    "/config/auto-post-facebook",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      await upsertBooleanConfig(deps, "auto_post_facebook", enabled);
      return { enabled };
    },
  );

  // ── LinkedIn (Placeholder - Coming Soon) ──
  // TODO: To enable LinkedIn auto-posting:
  // 1. Implement LinkedInProvider in packages/social/src/linkedin.ts
  // 2. Add LinkedIn API credentials to env (LINKEDIN_ORG_ID, LINKEDIN_ACCESS_TOKEN)
  // 3. Update distribution.ts worker to check this config and post to LinkedIn
  // 4. Enable the UI toggle in ScoringRules.tsx
  app.get("/config/auto-post-linkedin", { preHandler: deps.requireApiKey }, async () => {
    const enabled = await getBooleanConfig(deps, "auto_post_linkedin", false);
    return { enabled };
  });

  app.patch<{ Body: { enabled: boolean } }>(
    "/config/auto-post-linkedin",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      await upsertBooleanConfig(deps, "auto_post_linkedin", enabled);
      return { enabled };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 8: Kill Switch (Emergency Stop)
  // When enabled, ALL social posting is halted across all platforms.
  // Pipeline continues (fetch, embed, score) but no posts go out.
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/config/emergency-stop", { preHandler: deps.requireApiKey }, async () => {
    const enabled = await getBooleanConfig(deps, "emergency_stop", false);
    return { enabled };
  });

  app.post<{ Body: { enabled: boolean } }>(
    "/config/emergency-stop",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      await upsertBooleanConfig(deps, "emergency_stop", enabled);
      // Log this critical action
      const action = enabled ? "ACTIVATED" : "DEACTIVATED";
      console.warn(`[KILL SWITCH] Emergency stop ${action} via API`);
      return { enabled };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Translation Settings
  // Controls Georgian translation and posting language.
  // ─────────────────────────────────────────────────────────────────────────────

  // GET /config/translation
  app.get("/config/translation", { preHandler: deps.requireApiKey }, async () => {
    const keys = [
      "posting_language",
      "translation_scores",
      "translation_provider",
      "translation_model",
      "translation_instructions",
    ];

    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, keys));

    const m = new Map(rows.map((r) => [r.key, r.value]));

    return {
      posting_language: (m.get("posting_language") as string) ?? "en",
      scores: (m.get("translation_scores") as number[]) ?? [3, 4, 5],
      provider: (m.get("translation_provider") as string) ?? "gemini",
      model: (m.get("translation_model") as string) ?? "gemini-2.0-flash",
      instructions: (m.get("translation_instructions") as string) ?? "",
    };
  });

  // PATCH /config/translation
  app.patch<{
    Body: {
      posting_language?: "en" | "ka";
      scores?: number[];
      provider?: "gemini" | "openai";
      model?: string;
      instructions?: string;
    };
  }>("/config/translation", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { posting_language, scores, provider, model, instructions } = request.body ?? {};

    // Validate posting_language
    if (posting_language !== undefined && !["en", "ka"].includes(posting_language)) {
      return reply.code(400).send({ error: "posting_language must be 'en' or 'ka'" });
    }

    // Validate scores
    if (scores !== undefined) {
      if (!Array.isArray(scores) || scores.some((s) => s < 1 || s > 5)) {
        return reply.code(400).send({ error: "scores must be an array of numbers 1-5" });
      }
    }

    // Validate provider
    if (provider !== undefined && !["gemini", "openai"].includes(provider)) {
      return reply.code(400).send({ error: "provider must be 'gemini' or 'openai'" });
    }

    const updates: { key: string; value: unknown }[] = [];

    if (posting_language !== undefined) {
      updates.push({ key: "posting_language", value: posting_language });

      // Backfill guard: when switching to Georgian, record when it was enabled
      if (posting_language === "ka") {
        updates.push({
          key: "translation_enabled_since",
          value: new Date().toISOString(),
        });
      }
    }
    if (scores !== undefined) updates.push({ key: "translation_scores", value: scores });
    if (provider !== undefined) updates.push({ key: "translation_provider", value: provider });
    if (model !== undefined) updates.push({ key: "translation_model", value: model });
    if (instructions !== undefined) {
      updates.push({ key: "translation_instructions", value: instructions });
    }

    for (const { key, value } of updates) {
      await upsertTypedConfig(deps, key, value);
    }

    logger.info("[config] translation settings updated");
    return { success: true };
  });
};
