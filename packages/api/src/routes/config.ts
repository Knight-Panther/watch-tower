import type { FastifyInstance } from "fastify";
import { eq, inArray, sql, desc } from "drizzle-orm";
import { appConfig, articles, digestRuns } from "@watch-tower/db";
import { logger, imageTemplateSchema, DEFAULT_IMAGE_TEMPLATE, JOB_DAILY_DIGEST } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

const CONSTRAINTS = {
  feedItemsTtl: { min: 30, max: 60, unit: "days" },
  fetchRunsTtl: { min: 1, max: 2160, unit: "hours" },
  interval: { min: 1, max: 4320, unit: "minutes" },
  maxAge: { min: 1, max: 15, unit: "days" },
  llmTelemetryTtl: { min: 1, max: 60, unit: "days" },
  articleImagesTtl: { min: 1, max: 60, unit: "days" },
  postDeliveriesTtl: { min: 1, max: 60, unit: "days" },
  digestRunsTtl: { min: 1, max: 90, unit: "days" },
  alertDeliveriesTtl: { min: 1, max: 60, unit: "days" },
  alertWarningThreshold: { min: 10, max: 200, unit: "per hour" },
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

  // Digest Runs TTL
  app.get("/config/digest-runs-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "digest_runs_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/digest-runs-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.digestRunsTtl.min ||
        days > CONSTRAINTS.digestRunsTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be a number between ${CONSTRAINTS.digestRunsTtl.min} and ${CONSTRAINTS.digestRunsTtl.max}`,
        });
      }
      await upsertConfig(deps, "digest_runs_ttl_days", days);
      return { days };
    },
  );

  // Alert Deliveries TTL
  app.get("/config/alert-deliveries-ttl", { preHandler: deps.requireApiKey }, async () => {
    const days = await getConfigValue(deps, "alert_deliveries_ttl_days", 30);
    return { days };
  });

  app.patch<{ Body: { days: number } }>(
    "/config/alert-deliveries-ttl",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { days } = request.body ?? {};
      if (
        !Number.isFinite(days) ||
        days < CONSTRAINTS.alertDeliveriesTtl.min ||
        days > CONSTRAINTS.alertDeliveriesTtl.max
      ) {
        return reply.code(400).send({
          error: `days must be between ${CONSTRAINTS.alertDeliveriesTtl.min} and ${CONSTRAINTS.alertDeliveriesTtl.max}`,
        });
      }
      await upsertConfig(deps, "alert_deliveries_ttl_days", days);
      return { days };
    },
  );

  // Alert Warning Threshold
  app.get("/config/alert-warning-threshold", { preHandler: deps.requireApiKey }, async () => {
    const per_hour = await getConfigValue(deps, "alert_warning_threshold", 30);
    return { per_hour };
  });

  app.patch<{ Body: { per_hour: number } }>(
    "/config/alert-warning-threshold",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { per_hour } = request.body ?? {};
      if (
        !Number.isFinite(per_hour) ||
        per_hour < CONSTRAINTS.alertWarningThreshold.min ||
        per_hour > CONSTRAINTS.alertWarningThreshold.max
      ) {
        return reply.code(400).send({
          error: `per_hour must be between ${CONSTRAINTS.alertWarningThreshold.min} and ${CONSTRAINTS.alertWarningThreshold.max}`,
        });
      }
      await upsertConfig(deps, "alert_warning_threshold", per_hour);
      return { per_hour };
    },
  );

  // Alert Quiet Hours
  app.get("/config/alert-quiet-hours", { preHandler: deps.requireApiKey }, async () => {
    const [startRow] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "alert_quiet_start"));
    const [endRow] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "alert_quiet_end"));
    const [tzRow] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "alert_quiet_timezone"));
    return {
      start: (startRow?.value as string) ?? null,
      end: (endRow?.value as string) ?? null,
      timezone: (tzRow?.value as string) ?? null,
    };
  });

  app.patch<{ Body: { start: string | null; end: string | null; timezone?: string } }>(
    "/config/alert-quiet-hours",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { start, end, timezone } = request.body ?? {};
      const timeRe = /^\d{2}:\d{2}$/;

      // Both null = disable quiet hours
      if (start === null && end === null) {
        await upsertTypedConfig(deps, "alert_quiet_start", null);
        await upsertTypedConfig(deps, "alert_quiet_end", null);
        return { start: null, end: null, timezone: timezone ?? null };
      }

      if (!start || !end || !timeRe.test(start) || !timeRe.test(end)) {
        return reply.code(400).send({ error: "start and end must be HH:MM format, or both null" });
      }

      await upsertTypedConfig(deps, "alert_quiet_start", start);
      await upsertTypedConfig(deps, "alert_quiet_end", end);
      if (timezone) {
        await upsertTypedConfig(deps, "alert_quiet_timezone", timezone);
      }
      return { start, end, timezone: timezone ?? null };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Alert Translation (provider + model for KA alerts)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/config/alert-translation", { preHandler: deps.requireApiKey }, async () => {
    const keys = [
      "alert_translation_provider",
      "alert_translation_model",
      "translation_provider",
      "translation_model",
    ];
    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, keys));
    const m = new Map(rows.map((r) => [r.key, r.value]));

    return {
      provider:
        (m.get("alert_translation_provider") as string) ??
        (m.get("translation_provider") as string) ??
        "gemini",
      model:
        (m.get("alert_translation_model") as string) ??
        (m.get("translation_model") as string) ??
        "gemini-2.5-flash",
    };
  });

  app.patch<{ Body: { provider?: string; model?: string } }>(
    "/config/alert-translation",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { provider, model } = request.body ?? {};

      if (provider !== undefined && !["gemini", "openai"].includes(provider)) {
        return reply.code(400).send({ error: "provider must be 'gemini' or 'openai'" });
      }
      if (model !== undefined && model.length > 100) {
        return reply.code(400).send({ error: "model must be 100 characters or less" });
      }

      const VALID_MODELS: Record<string, string[]> = {
        gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
        openai: ["gpt-4o-mini", "gpt-4o"],
      };
      if (provider !== undefined && model !== undefined && model) {
        const allowed = VALID_MODELS[provider];
        if (allowed && !allowed.includes(model)) {
          return reply.code(400).send({
            error: `model '${model}' is not valid for provider '${provider}'`,
          });
        }
      }

      if (provider !== undefined) await upsertTypedConfig(deps, "alert_translation_provider", provider);
      if (model !== undefined) await upsertTypedConfig(deps, "alert_translation_model", model);

      logger.info("[config] alert translation settings updated");
      return { success: true };
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
  // Score Thresholds (Auto-Approve / Auto-Reject)
  // Controls which scores trigger auto-approve, auto-reject, or manual review.
  // DB values override environment variable defaults.
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/config/auto-approve-threshold", { preHandler: deps.requireApiKey }, async () => {
    const value = await getConfigValue(deps, "auto_approve_threshold", 5);
    return { value };
  });

  app.patch<{ Body: { value: number } }>(
    "/config/auto-approve-threshold",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { value } = request.body ?? {};
      if (!Number.isFinite(value) || value < 0 || value > 5) {
        return reply.code(400).send({ error: "value must be a number between 0 and 5 (0 = OFF)" });
      }
      // Validate: approve must be > reject (skip when OFF)
      if (value !== 0) {
        const rejectThreshold = await getConfigValue(deps, "auto_reject_threshold", 2);
        if (value <= rejectThreshold) {
          return reply.code(400).send({
            error: `Auto-approve threshold (${value}) must be greater than auto-reject threshold (${rejectThreshold})`,
          });
        }
      }
      await upsertConfig(deps, "auto_approve_threshold", value);
      logger.info(`[config] auto-approve threshold updated to ${value}`);
      return { value };
    },
  );

  app.get("/config/auto-reject-threshold", { preHandler: deps.requireApiKey }, async () => {
    const value = await getConfigValue(deps, "auto_reject_threshold", 2);
    return { value };
  });

  app.patch<{ Body: { value: number } }>(
    "/config/auto-reject-threshold",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { value } = request.body ?? {};
      if (!Number.isFinite(value) || value < 0 || value > 5) {
        return reply.code(400).send({ error: "value must be a number between 0 and 5 (0 = OFF)" });
      }
      // Validate: reject must be < approve (skip when either is OFF)
      const approveThreshold = await getConfigValue(deps, "auto_approve_threshold", 5);
      if (approveThreshold !== 0 && value !== 0 && value >= approveThreshold) {
        return reply.code(400).send({
          error: `Auto-reject threshold (${value}) must be less than auto-approve threshold (${approveThreshold})`,
        });
      }
      await upsertConfig(deps, "auto_reject_threshold", value);
      logger.info(`[config] auto-reject threshold updated to ${value}`);
      return { value };
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
      logger.warn(`[KILL SWITCH] Emergency stop ${action} via API`);
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
      model: (m.get("translation_model") as string) ?? "gemini-2.5-flash",
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

    // When provider or model changes, immediately reset 'failed' translations
    // so they get picked up on the next batch (15s) with the new config
    // instead of waiting for the 10-minute maintenance cooldown.
    if (provider !== undefined || model !== undefined) {
      await deps.db
        .update(articles)
        .set({ translationStatus: sql`NULL` })
        .where(sql`translation_status = 'failed'`);
    }

    logger.info("[config] translation settings updated");
    return { success: true };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Image Generation Settings
  // Controls AI image generation for news card posts.
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/config/image-generation", { preHandler: deps.requireApiKey }, async () => {
    const keys = [
      "image_generation_enabled",
      "image_generation_min_score",
      "image_generation_quality",
      "image_generation_size",
      "image_generation_prompt",
    ];

    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, keys));

    const m = new Map(rows.map((r) => [r.key, r.value]));

    return {
      enabled: (m.get("image_generation_enabled") as boolean) ?? false,
      minScore: (m.get("image_generation_min_score") as number) ?? 4,
      quality: (m.get("image_generation_quality") as string) ?? "medium",
      size: (m.get("image_generation_size") as string) ?? "1024x1536",
      prompt: (m.get("image_generation_prompt") as string) ?? "",
    };
  });

  app.patch<{
    Body: {
      enabled?: boolean;
      minScore?: number;
      quality?: string;
      size?: string;
      prompt?: string;
    };
  }>("/config/image-generation", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { enabled, minScore, quality, size, prompt } = request.body ?? {};

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 1 || minScore > 5)) {
      return reply.code(400).send({ error: "minScore must be a number between 1 and 5" });
    }
    const validQualities = ["low", "medium", "high"];
    if (quality !== undefined && !validQualities.includes(quality)) {
      return reply.code(400).send({ error: `quality must be one of: ${validQualities.join(", ")}` });
    }
    const validSizes = ["1024x1024", "1024x1536", "1536x1024"];
    if (size !== undefined && !validSizes.includes(size)) {
      return reply.code(400).send({ error: `size must be one of: ${validSizes.join(", ")}` });
    }

    const updates: { key: string; value: unknown }[] = [];
    if (enabled !== undefined) updates.push({ key: "image_generation_enabled", value: enabled });
    if (minScore !== undefined) {
      updates.push({ key: "image_generation_min_score", value: minScore });
    }
    if (quality !== undefined) updates.push({ key: "image_generation_quality", value: quality });
    if (size !== undefined) updates.push({ key: "image_generation_size", value: size });
    if (prompt !== undefined) updates.push({ key: "image_generation_prompt", value: prompt });

    for (const { key, value } of updates) {
      await upsertTypedConfig(deps, key, value);
    }

    logger.info("[config] image generation settings updated");
    return { success: true };
  });

  // ─── Image Template ─────────────────────────────────────────────────────────

  app.get("/config/image-template", { preHandler: deps.requireApiKey }, async () => {
    const [row] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "image_template"));

    return row?.value ?? DEFAULT_IMAGE_TEMPLATE;
  });

  app.patch("/config/image-template", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const parsed = imageTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid image template",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    await upsertTypedConfig(deps, "image_template", parsed.data);
    logger.info("[config] image template updated");
    return parsed.data;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Daily Digest Settings
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/config/digest", { preHandler: deps.requireApiKey }, async () => {
    const keys = [
      "digest_enabled",
      "digest_time",
      "digest_timezone",
      "digest_days",
      "digest_min_score",
      "digest_language",
      "digest_system_prompt",
      "digest_telegram_chat_id",
      "digest_telegram_enabled",
      "digest_facebook_enabled",
      "digest_linkedin_enabled",
      "digest_provider",
      "digest_model",
      "digest_translation_provider",
      "digest_translation_model",
      "digest_translation_prompt",
      "digest_image_telegram",
      "digest_image_facebook",
      "digest_image_linkedin",
      "last_digest_sent_at",
      "posting_language",
      "translation_provider",
      "translation_model",
    ];

    const rows = await deps.db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, keys));

    const m = new Map(rows.map((r) => [r.key, r.value]));
    const postingLanguage = (m.get("posting_language") as string) ?? "en";
    const globalTransProvider = (m.get("translation_provider") as string) ?? "gemini";
    const globalTransModel = (m.get("translation_model") as string) ?? "gemini-2.5-flash";

    return {
      enabled: m.get("digest_enabled") === true || m.get("digest_enabled") === "true" ? true : false,
      time: (m.get("digest_time") as string) ?? "08:00",
      timezone: (m.get("digest_timezone") as string) ?? "UTC",
      days: Array.isArray(m.get("digest_days")) ? m.get("digest_days") : [1, 2, 3, 4, 5, 6, 7],
      minScore: Number(m.get("digest_min_score")) || 3,
      language: (m.get("digest_language") as string) ?? postingLanguage,
      systemPrompt: (m.get("digest_system_prompt") as string) ?? "",
      telegramChatId: String(m.get("digest_telegram_chat_id") ?? ""),
      telegramEnabled: m.get("digest_telegram_enabled") === true || m.get("digest_telegram_enabled") === "true" || !m.has("digest_telegram_enabled"),
      facebookEnabled: m.get("digest_facebook_enabled") === true || m.get("digest_facebook_enabled") === "true" ? true : false,
      linkedinEnabled: m.get("digest_linkedin_enabled") === true || m.get("digest_linkedin_enabled") === "true" ? true : false,
      provider: (m.get("digest_provider") as string) ?? "claude",
      model: (m.get("digest_model") as string) ?? "",
      translationProvider: (m.get("digest_translation_provider") as string) ?? globalTransProvider,
      translationModel: (m.get("digest_translation_model") as string) ?? globalTransModel,
      translationPrompt: (m.get("digest_translation_prompt") as string) ?? "",
      imageTelegram: m.get("digest_image_telegram") === true || m.get("digest_image_telegram") === "true" ? true : false,
      imageFacebook: m.get("digest_image_facebook") === true || m.get("digest_image_facebook") === "true" ? true : false,
      imageLinkedin: m.get("digest_image_linkedin") === true || m.get("digest_image_linkedin") === "true" ? true : false,
      lastDigestSentAt: (m.get("last_digest_sent_at") as string) ?? null,
    };
  });

  app.patch<{
    Body: {
      enabled?: boolean;
      time?: string;
      timezone?: string;
      days?: number[];
      minScore?: number;
      language?: string;
      systemPrompt?: string;
      telegramChatId?: string;
      telegramEnabled?: boolean;
      facebookEnabled?: boolean;
      linkedinEnabled?: boolean;
      provider?: string;
      model?: string;
      translationProvider?: string;
      translationModel?: string;
      translationPrompt?: string;
      imageTelegram?: boolean;
      imageFacebook?: boolean;
      imageLinkedin?: boolean;
    };
  }>("/config/digest", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const body = request.body ?? {};

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    if (body.time !== undefined && !/^\d{2}:\d{2}$/.test(body.time)) {
      return reply.code(400).send({ error: "time must be HH:MM format" });
    }
    if (body.timezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: body.timezone });
      } catch {
        return reply.code(400).send({ error: "Invalid IANA timezone" });
      }
    }
    if (body.days !== undefined) {
      if (!Array.isArray(body.days) || body.days.some((d) => d < 1 || d > 7)) {
        return reply.code(400).send({ error: "days must be array of numbers 1-7" });
      }
    }
    if (body.minScore !== undefined && (body.minScore < 1 || body.minScore > 5)) {
      return reply.code(400).send({ error: "minScore must be 1-5" });
    }
    if (body.language !== undefined && !["en", "ka"].includes(body.language)) {
      return reply.code(400).send({ error: "language must be 'en' or 'ka'" });
    }
    if (body.systemPrompt !== undefined && body.systemPrompt.length > 2000) {
      return reply.code(400).send({ error: "systemPrompt must be 2000 characters or less" });
    }
    if (body.provider !== undefined && !["claude", "openai", "deepseek", "gemini"].includes(body.provider)) {
      return reply.code(400).send({ error: "provider must be 'claude', 'openai', 'deepseek', or 'gemini'" });
    }
    if (body.model !== undefined && body.model.length > 100) {
      return reply.code(400).send({ error: "model must be 100 characters or less" });
    }
    // Cross-validate model against provider when both are provided
    const VALID_MODELS: Record<string, string[]> = {
      claude: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-20250514"],
      openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
      deepseek: ["deepseek-chat", "deepseek-reasoner"],
      gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
    };
    if (body.provider !== undefined && body.model !== undefined && body.model) {
      const allowed = VALID_MODELS[body.provider];
      if (allowed && !allowed.includes(body.model)) {
        return reply.code(400).send({
          error: `model '${body.model}' is not valid for provider '${body.provider}'`,
        });
      }
    }
    if (body.translationProvider !== undefined && !["gemini", "openai"].includes(body.translationProvider)) {
      return reply.code(400).send({ error: "translationProvider must be 'gemini' or 'openai'" });
    }
    if (body.translationModel !== undefined && body.translationModel.length > 100) {
      return reply.code(400).send({ error: "translationModel must be 100 characters or less" });
    }
    // Cross-validate translation model against translation provider
    const VALID_TRANSLATION_MODELS: Record<string, string[]> = {
      gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
      openai: ["gpt-4o-mini", "gpt-4o"],
    };
    if (body.translationProvider !== undefined && body.translationModel !== undefined && body.translationModel) {
      const allowed = VALID_TRANSLATION_MODELS[body.translationProvider];
      if (allowed && !allowed.includes(body.translationModel)) {
        return reply.code(400).send({
          error: `translationModel '${body.translationModel}' is not valid for provider '${body.translationProvider}'`,
        });
      }
    }
    if (body.translationPrompt !== undefined && body.translationPrompt.length > 1000) {
      return reply.code(400).send({ error: "translationPrompt must be 1000 characters or less" });
    }

    const updates: { key: string; value: unknown }[] = [];
    if (body.enabled !== undefined) updates.push({ key: "digest_enabled", value: body.enabled });
    if (body.time !== undefined) updates.push({ key: "digest_time", value: body.time });
    if (body.timezone !== undefined) updates.push({ key: "digest_timezone", value: body.timezone });
    if (body.days !== undefined) updates.push({ key: "digest_days", value: body.days });
    if (body.minScore !== undefined) updates.push({ key: "digest_min_score", value: body.minScore });
    if (body.language !== undefined) updates.push({ key: "digest_language", value: body.language });
    if (body.systemPrompt !== undefined)
      updates.push({ key: "digest_system_prompt", value: body.systemPrompt });
    if (body.telegramChatId !== undefined)
      updates.push({ key: "digest_telegram_chat_id", value: body.telegramChatId });
    if (body.telegramEnabled !== undefined)
      updates.push({ key: "digest_telegram_enabled", value: body.telegramEnabled });
    if (body.facebookEnabled !== undefined)
      updates.push({ key: "digest_facebook_enabled", value: body.facebookEnabled });
    if (body.linkedinEnabled !== undefined)
      updates.push({ key: "digest_linkedin_enabled", value: body.linkedinEnabled });
    if (body.provider !== undefined) updates.push({ key: "digest_provider", value: body.provider });
    if (body.model !== undefined) updates.push({ key: "digest_model", value: body.model });
    if (body.translationProvider !== undefined)
      updates.push({ key: "digest_translation_provider", value: body.translationProvider });
    if (body.translationModel !== undefined)
      updates.push({ key: "digest_translation_model", value: body.translationModel });
    if (body.translationPrompt !== undefined)
      updates.push({ key: "digest_translation_prompt", value: body.translationPrompt });
    if (body.imageTelegram !== undefined)
      updates.push({ key: "digest_image_telegram", value: body.imageTelegram });
    if (body.imageFacebook !== undefined)
      updates.push({ key: "digest_image_facebook", value: body.imageFacebook });
    if (body.imageLinkedin !== undefined)
      updates.push({ key: "digest_image_linkedin", value: body.imageLinkedin });

    for (const { key, value } of updates) {
      await upsertTypedConfig(deps, key, value);
    }

    logger.info("[config] digest settings updated");
    return { success: true };
  });

  app.post("/config/digest/test", { preHandler: deps.requireApiKey }, async (_request, reply) => {
    try {
      await deps.maintenanceQueue.add(
        JOB_DAILY_DIGEST,
        { isTest: true },
        { jobId: `digest-test-${Date.now()}` },
      );
      return { queued: true, message: "Test digest queued. Check Telegram in ~30 seconds." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[config] failed to queue test digest: ${msg}`);
      return reply.code(500).send({ error: "Failed to queue test digest" });
    }
  });

  // ─── Digest History ────────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>(
    "/config/digest/history",
    { preHandler: deps.requireApiKey },
    async (request) => {
      const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);
      const rows = await deps.db
        .select()
        .from(digestRuns)
        .orderBy(desc(digestRuns.sentAt))
        .limit(limit);
      return rows;
    },
  );

  app.delete(
    "/config/digest/history",
    { preHandler: deps.requireApiKey },
    async () => {
      const result = await deps.db.delete(digestRuns);
      const deleted = result.rowCount ?? 0;
      logger.info({ deleted }, "[config] digest history cleared");
      return { deleted };
    },
  );

  // ─── Dedup Sensitivity ────────────────────────────────────────────────────────

  app.get("/config/similarity-threshold", { preHandler: deps.requireApiKey }, async () => {
    const [row] = await deps.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "similarity_threshold"));
    const stored = row ? Number(row.value) : null;
    return {
      value: stored ?? 0.65,
      source: stored != null ? "database" : "default",
    };
  });

  app.patch<{ Body: { value: number } }>(
    "/config/similarity-threshold",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { value } = request.body ?? {};
      if (value === undefined || !Number.isFinite(value) || value < 0.5 || value > 0.99) {
        return reply
          .code(400)
          .send({ error: "Threshold must be a number between 0.50 and 0.99" });
      }
      const rounded = Math.round(value * 100) / 100;
      await upsertConfig(deps, "similarity_threshold", rounded);
      return { value: rounded };
    },
  );
};
