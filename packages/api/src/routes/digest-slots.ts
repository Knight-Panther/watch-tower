import type { FastifyInstance } from "fastify";
import { eq, and, or, desc, sql, isNull } from "drizzle-orm";
import { digestSlots, digestRuns, digestDrafts } from "@watch-tower/db";
import { logger, JOB_DAILY_DIGEST, DIGEST_SLOT_DEFAULTS } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_PROVIDERS = ["claude", "openai", "deepseek", "gemini"] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

const VALID_MODELS: Record<Provider, string[]> = {
  claude: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-20250514"],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^\d{2}:\d{2}$/;

// ─── Mapper ───────────────────────────────────────────────────────────────────

const mapSlot = (s: typeof digestSlots.$inferSelect) => ({
  id: s.id,
  name: s.name,
  enabled: s.enabled,
  time: s.time,
  timezone: s.timezone,
  days: s.days,
  min_score: s.minScore,
  max_articles: s.maxArticles,
  sector_ids: s.sectorIds,
  language: s.language,
  system_prompt: s.systemPrompt,
  translation_prompt: s.translationPrompt,
  provider: s.provider,
  model: s.model,
  translation_provider: s.translationProvider,
  translation_model: s.translationModel,
  auto_post: s.autoPost,
  telegram_chat_id: s.telegramChatId,
  telegram_enabled: s.telegramEnabled,
  facebook_enabled: s.facebookEnabled,
  linkedin_enabled: s.linkedinEnabled,
  telegram_language: s.telegramLanguage,
  facebook_language: s.facebookLanguage,
  linkedin_language: s.linkedinLanguage,
  image_telegram: s.imageTelegram,
  image_facebook: s.imageFacebook,
  image_linkedin: s.imageLinkedin,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
});

const mapDraft = (d: typeof digestDrafts.$inferSelect) => ({
  id: d.id,
  slot_id: d.slotId,
  status: d.status,
  generated_text: d.generatedText,
  translated_text: d.translatedText,
  edited: d.edited,
  article_count: d.articleCount,
  article_ids: d.articleIds,
  provider: d.provider,
  model: d.model,
  llm_tokens_in: d.llmTokensIn,
  llm_tokens_out: d.llmTokensOut,
  llm_cost_microdollars: d.llmCostMicrodollars,
  translation_provider: d.translationProvider,
  translation_model: d.translationModel,
  translation_cost_microdollars: d.translationCostMicrodollars,
  stats_scanned: d.statsScanned,
  stats_scored: d.statsScored,
  stats_above_threshold: d.statsAboveThreshold,
  max_articles: d.maxArticles,
  score_distribution: d.scoreDistribution,
  channels: d.channels,
  channel_results: d.channelResults,
  generated_at: d.generatedAt,
  approved_at: d.approvedAt,
  scheduled_at: d.scheduledAt,
  sent_at: d.sentAt,
  expires_at: d.expiresAt,
  created_at: d.createdAt,
});

const mapRun = (r: typeof digestRuns.$inferSelect) => ({
  id: r.id,
  slot_id: r.slotId,
  sent_at: r.sentAt,
  is_test: r.isTest,
  language: r.language,
  article_count: r.articleCount,
  channels: r.channels,
  channel_results: r.channelResults,
  provider: r.provider,
  model: r.model,
  min_score: r.minScore,
  stats_scanned: r.statsScanned,
  stats_scored: r.statsScored,
  stats_above_threshold: r.statsAboveThreshold,
  max_articles: r.maxArticles,
  score_distribution: r.scoreDistribution,
  created_at: r.createdAt,
});

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateProvider(provider: unknown): provider is Provider {
  return typeof provider === "string" && (VALID_PROVIDERS as readonly string[]).includes(provider);
}

// ─── Route module ─────────────────────────────────────────────────────────────

export const registerDigestSlotsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots/defaults — single source of truth for new-slot form defaults
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/digest-slots/defaults", { preHandler: deps.requireApiKey }, async () => {
    return DIGEST_SLOT_DEFAULTS;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots — list all slots with last-run enrichment
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/digest-slots", { preHandler: deps.requireApiKey }, async () => {
    const rows = await deps.db.select().from(digestSlots).orderBy(digestSlots.createdAt);

    const runStats = await deps.db.execute(sql`
      SELECT
        slot_id,
        COUNT(*)::int AS total_runs,
        MAX(sent_at) AS last_run_at
      FROM digest_runs
      WHERE slot_id IS NOT NULL
      GROUP BY slot_id
    `);

    const statsMap = new Map(
      (
        runStats.rows as {
          slot_id: string;
          total_runs: number;
          last_run_at: string | null;
        }[]
      ).map((s) => [s.slot_id, s]),
    );

    return rows.map((s) => {
      const stats = statsMap.get(s.id);
      return {
        ...mapSlot(s),
        total_runs: stats?.total_runs ?? 0,
        last_run_at: stats?.last_run_at ?? null,
      };
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots/:id — single slot + recent runs (last 10)
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/digest-slots/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [slot] = await deps.db.select().from(digestSlots).where(eq(digestSlots.id, id));

      if (!slot) return reply.code(404).send({ error: "Digest slot not found" });

      const runs = await deps.db
        .select()
        .from(digestRuns)
        .where(eq(digestRuns.slotId, id))
        .orderBy(desc(digestRuns.sentAt))
        .limit(10);

      return {
        ...mapSlot(slot),
        recent_runs: runs.map(mapRun),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /digest-slots — create slot
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      name: string;
      enabled?: boolean;
      time?: string;
      timezone?: string;
      days?: number[];
      min_score?: number;
      max_articles?: number;
      sector_ids?: string[] | null;
      language?: "en" | "ka";
      system_prompt?: string | null;
      translation_prompt?: string | null;
      provider?: string;
      model?: string;
      translation_provider?: string;
      translation_model?: string;
      auto_post?: boolean;
      telegram_chat_id?: string | null;
      telegram_enabled?: boolean;
      facebook_enabled?: boolean;
      linkedin_enabled?: boolean;
      telegram_language?: "en" | "ka";
      facebook_language?: "en" | "ka";
      linkedin_language?: "en" | "ka";
      image_telegram?: boolean;
      image_facebook?: boolean;
      image_linkedin?: boolean;
    };
  }>("/digest-slots", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const body = request.body ?? {};

    // name — required
    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (body.name.trim().length > 100) {
      return reply.code(400).send({ error: "name must be 100 characters or fewer" });
    }

    // time
    const time = body.time ?? "08:00";
    if (!TIME_RE.test(time)) {
      return reply.code(400).send({ error: "time must be in HH:MM format" });
    }

    // timezone
    const timezone = body.timezone ?? "UTC";
    if (!validateTimezone(timezone)) {
      return reply.code(400).send({ error: `Invalid timezone: ${timezone}` });
    }

    // days
    const days = body.days ?? [1, 2, 3, 4, 5, 6, 7];
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
    ) {
      return reply.code(400).send({ error: "days must be a non-empty array of integers 1-7" });
    }

    // min_score
    const minScore = body.min_score ?? 3;
    if (!Number.isInteger(minScore) || minScore < 1 || minScore > 5) {
      return reply.code(400).send({ error: "min_score must be 1-5" });
    }

    // max_articles
    const maxArticles = body.max_articles ?? 50;
    if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 100) {
      return reply.code(400).send({ error: "max_articles must be 1-100" });
    }

    // sector_ids
    const sectorIds = body.sector_ids ?? null;
    if (sectorIds !== null) {
      if (
        !Array.isArray(sectorIds) ||
        sectorIds.some((s) => typeof s !== "string" || !UUID_RE.test(s))
      ) {
        return reply
          .code(400)
          .send({ error: "sector_ids must be an array of UUID strings or null" });
      }
    }

    // language
    const language = body.language ?? "en";
    if (language !== "en" && language !== "ka") {
      return reply.code(400).send({ error: "language must be 'en' or 'ka'" });
    }

    // system_prompt
    const systemPrompt = body.system_prompt ?? null;
    if (systemPrompt !== null && systemPrompt.length > 2000) {
      return reply.code(400).send({ error: "system_prompt must be 2000 characters or fewer" });
    }

    // translation_prompt
    const translationPrompt = body.translation_prompt ?? null;
    if (translationPrompt !== null && translationPrompt.length > 1000) {
      return reply.code(400).send({ error: "translation_prompt must be 1000 characters or fewer" });
    }

    // provider
    const provider = body.provider ?? "claude";
    if (!validateProvider(provider)) {
      return reply
        .code(400)
        .send({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    }

    // model — validate against provider
    const model = body.model ?? VALID_MODELS[provider][0];
    if (!VALID_MODELS[provider].includes(model)) {
      return reply.code(400).send({
        error: `Invalid model '${model}' for provider '${provider}'. Valid models: ${VALID_MODELS[provider].join(", ")}`,
      });
    }

    // translation_provider
    const translationProvider = body.translation_provider ?? "gemini";
    if (!validateProvider(translationProvider)) {
      return reply
        .code(400)
        .send({ error: `translation_provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    }

    // translation_model — validate against translation_provider
    const translationModel = body.translation_model ?? VALID_MODELS[translationProvider][0];
    if (!VALID_MODELS[translationProvider].includes(translationModel)) {
      return reply.code(400).send({
        error: `Invalid translation_model '${translationModel}' for translation_provider '${translationProvider}'. Valid models: ${VALID_MODELS[translationProvider].join(", ")}`,
      });
    }

    // platform enabled — at least one required
    const telegramEnabled = body.telegram_enabled ?? true;
    const facebookEnabled = body.facebook_enabled ?? false;
    const linkedinEnabled = body.linkedin_enabled ?? false;
    if (!telegramEnabled && !facebookEnabled && !linkedinEnabled) {
      return reply.code(400).send({ error: "At least one platform must be enabled" });
    }

    const [inserted] = await deps.db
      .insert(digestSlots)
      .values({
        name: body.name.trim(),
        enabled: body.enabled ?? true,
        time,
        timezone,
        days,
        minScore,
        maxArticles,
        sectorIds,
        language,
        systemPrompt,
        translationPrompt,
        provider,
        model,
        translationProvider,
        translationModel,
        autoPost: body.auto_post ?? true,
        telegramChatId: body.telegram_chat_id ?? null,
        telegramEnabled,
        facebookEnabled,
        linkedinEnabled,
        telegramLanguage: body.telegram_language ?? language,
        facebookLanguage: body.facebook_language ?? language,
        linkedinLanguage: body.linkedin_language ?? language,
        imageTelegram: body.image_telegram ?? false,
        imageFacebook: body.image_facebook ?? false,
        imageLinkedin: body.image_linkedin ?? false,
      })
      .returning();

    logger.info({ slotId: inserted.id, name: inserted.name }, "[digest-slots] slot created");
    return mapSlot(inserted);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /digest-slots/:id — update slot (partial update)
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      enabled?: boolean;
      time?: string;
      timezone?: string;
      days?: number[];
      min_score?: number;
      max_articles?: number;
      sector_ids?: string[] | null;
      language?: "en" | "ka";
      system_prompt?: string | null;
      translation_prompt?: string | null;
      provider?: string;
      model?: string;
      translation_provider?: string;
      translation_model?: string;
      auto_post?: boolean;
      telegram_chat_id?: string | null;
      telegram_enabled?: boolean;
      facebook_enabled?: boolean;
      linkedin_enabled?: boolean;
      telegram_language?: "en" | "ka";
      facebook_language?: "en" | "ka";
      linkedin_language?: "en" | "ka";
      image_telegram?: boolean;
      image_facebook?: boolean;
      image_linkedin?: boolean;
    };
  }>("/digest-slots/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};

    // Fetch current slot so we can validate cross-field constraints (e.g. provider/model)
    // without requiring the client to send both every time.
    const [current] = await deps.db.select().from(digestSlots).where(eq(digestSlots.id, id));
    if (!current) return reply.code(404).send({ error: "Digest slot not found" });

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return reply.code(400).send({ error: "name cannot be empty" });
      }
      if (body.name.trim().length > 100) {
        return reply.code(400).send({ error: "name must be 100 characters or fewer" });
      }
      updates.name = body.name.trim();
    }

    if (typeof body.enabled === "boolean") {
      updates.enabled = body.enabled;
    }

    if (body.time !== undefined) {
      if (!TIME_RE.test(body.time)) {
        return reply.code(400).send({ error: "time must be in HH:MM format" });
      }
      updates.time = body.time;
    }

    if (body.timezone !== undefined) {
      if (!validateTimezone(body.timezone)) {
        return reply.code(400).send({ error: `Invalid timezone: ${body.timezone}` });
      }
      updates.timezone = body.timezone;
    }

    if (body.days !== undefined) {
      if (
        !Array.isArray(body.days) ||
        body.days.length === 0 ||
        body.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
      ) {
        return reply.code(400).send({ error: "days must be a non-empty array of integers 1-7" });
      }
      updates.days = body.days;
    }

    if (body.min_score !== undefined) {
      if (!Number.isInteger(body.min_score) || body.min_score < 1 || body.min_score > 5) {
        return reply.code(400).send({ error: "min_score must be 1-5" });
      }
      updates.minScore = body.min_score;
    }

    if (body.max_articles !== undefined) {
      if (
        !Number.isInteger(body.max_articles) ||
        body.max_articles < 1 ||
        body.max_articles > 100
      ) {
        return reply.code(400).send({ error: "max_articles must be 1-100" });
      }
      updates.maxArticles = body.max_articles;
    }

    if (body.sector_ids !== undefined) {
      if (body.sector_ids !== null) {
        if (
          !Array.isArray(body.sector_ids) ||
          body.sector_ids.some((s) => typeof s !== "string" || !UUID_RE.test(s))
        ) {
          return reply
            .code(400)
            .send({ error: "sector_ids must be an array of UUID strings or null" });
        }
      }
      updates.sectorIds = body.sector_ids;
    }

    if (body.language !== undefined) {
      if (body.language !== "en" && body.language !== "ka") {
        return reply.code(400).send({ error: "language must be 'en' or 'ka'" });
      }
      updates.language = body.language;
    }

    if (body.system_prompt !== undefined) {
      if (body.system_prompt !== null && body.system_prompt.length > 2000) {
        return reply.code(400).send({ error: "system_prompt must be 2000 characters or fewer" });
      }
      updates.systemPrompt = body.system_prompt;
    }

    if (body.translation_prompt !== undefined) {
      if (body.translation_prompt !== null && body.translation_prompt.length > 1000) {
        return reply
          .code(400)
          .send({ error: "translation_prompt must be 1000 characters or fewer" });
      }
      updates.translationPrompt = body.translation_prompt;
    }

    // provider + model — resolve together so partial updates still cross-validate
    const effectiveProvider = body.provider !== undefined ? body.provider : current.provider;
    const effectiveModel = body.model !== undefined ? body.model : current.model;

    if (body.provider !== undefined) {
      if (!validateProvider(body.provider)) {
        return reply
          .code(400)
          .send({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }
      updates.provider = body.provider;
    }

    if (body.model !== undefined || body.provider !== undefined) {
      if (!validateProvider(effectiveProvider)) {
        return reply
          .code(400)
          .send({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }
      if (!VALID_MODELS[effectiveProvider].includes(effectiveModel)) {
        return reply.code(400).send({
          error: `Invalid model '${effectiveModel}' for provider '${effectiveProvider}'. Valid models: ${VALID_MODELS[effectiveProvider].join(", ")}`,
        });
      }
      updates.model = effectiveModel;
    }

    // translation_provider + translation_model — same cross-validation
    const effectiveTranslationProvider =
      body.translation_provider !== undefined
        ? body.translation_provider
        : current.translationProvider;
    const effectiveTranslationModel =
      body.translation_model !== undefined ? body.translation_model : current.translationModel;

    if (body.translation_provider !== undefined) {
      if (!validateProvider(body.translation_provider)) {
        return reply
          .code(400)
          .send({ error: `translation_provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }
      updates.translationProvider = body.translation_provider;
    }

    if (body.translation_model !== undefined || body.translation_provider !== undefined) {
      if (!validateProvider(effectiveTranslationProvider)) {
        return reply
          .code(400)
          .send({ error: `translation_provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }
      if (!VALID_MODELS[effectiveTranslationProvider].includes(effectiveTranslationModel)) {
        return reply.code(400).send({
          error: `Invalid translation_model '${effectiveTranslationModel}' for translation_provider '${effectiveTranslationProvider}'. Valid models: ${VALID_MODELS[effectiveTranslationProvider].join(", ")}`,
        });
      }
      updates.translationModel = effectiveTranslationModel;
    }

    if (typeof body.auto_post === "boolean") {
      updates.autoPost = body.auto_post;
    }

    if (body.telegram_chat_id !== undefined) {
      updates.telegramChatId = body.telegram_chat_id;
    }

    // Collect platform flags — validate at least one enabled after applying updates
    const newTelegramEnabled =
      body.telegram_enabled !== undefined ? body.telegram_enabled : current.telegramEnabled;
    const newFacebookEnabled =
      body.facebook_enabled !== undefined ? body.facebook_enabled : current.facebookEnabled;
    const newLinkedinEnabled =
      body.linkedin_enabled !== undefined ? body.linkedin_enabled : current.linkedinEnabled;

    if (
      body.telegram_enabled !== undefined ||
      body.facebook_enabled !== undefined ||
      body.linkedin_enabled !== undefined
    ) {
      if (!newTelegramEnabled && !newFacebookEnabled && !newLinkedinEnabled) {
        return reply.code(400).send({ error: "At least one platform must be enabled" });
      }
      if (body.telegram_enabled !== undefined) updates.telegramEnabled = body.telegram_enabled;
      if (body.facebook_enabled !== undefined) updates.facebookEnabled = body.facebook_enabled;
      if (body.linkedin_enabled !== undefined) updates.linkedinEnabled = body.linkedin_enabled;
    }

    if (body.telegram_language === "en" || body.telegram_language === "ka") {
      updates.telegramLanguage = body.telegram_language;
    }
    if (body.facebook_language === "en" || body.facebook_language === "ka") {
      updates.facebookLanguage = body.facebook_language;
    }
    if (body.linkedin_language === "en" || body.linkedin_language === "ka") {
      updates.linkedinLanguage = body.linkedin_language;
    }

    if (typeof body.image_telegram === "boolean") {
      updates.imageTelegram = body.image_telegram;
    }
    if (typeof body.image_facebook === "boolean") {
      updates.imageFacebook = body.image_facebook;
    }
    if (typeof body.image_linkedin === "boolean") {
      updates.imageLinkedin = body.image_linkedin;
    }

    const [updated] = await deps.db
      .update(digestSlots)
      .set(updates)
      .where(eq(digestSlots.id, id))
      .returning();

    if (!updated) return reply.code(404).send({ error: "Digest slot not found" });

    logger.info({ slotId: id }, "[digest-slots] slot updated");
    return mapSlot(updated);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /digest-slots/:id — delete slot (runs preserved via SET NULL FK)
  // ─────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/digest-slots/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [deleted] = await deps.db.delete(digestSlots).where(eq(digestSlots.id, id)).returning();

      if (!deleted) return reply.code(404).send({ error: "Digest slot not found" });

      logger.info({ slotId: id, name: deleted.name }, "[digest-slots] slot deleted");
      return { success: true };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /digest-slots/:id/test — queue test digest for this slot
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/digest-slots/:id/test",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [slot] = await deps.db.select().from(digestSlots).where(eq(digestSlots.id, id));

      if (!slot) return reply.code(404).send({ error: "Digest slot not found" });

      await deps.maintenanceQueue.add(
        JOB_DAILY_DIGEST,
        { isTest: true, slotId: id },
        { jobId: `digest-test-${id}-${Date.now()}` },
      );

      logger.info({ slotId: id, name: slot.name }, "[digest-slots] test digest queued");
      return { queued: true, slot_id: id };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots/:id/history — run history for slot
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/digest-slots/:id/history",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const limitParam = parseInt(request.query.limit ?? "20", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 20;

      const [slot] = await deps.db
        .select({ id: digestSlots.id })
        .from(digestSlots)
        .where(eq(digestSlots.id, id));

      if (!slot) return reply.code(404).send({ error: "Digest slot not found" });

      const runs = await deps.db
        .select()
        .from(digestRuns)
        .where(eq(digestRuns.slotId, id))
        .orderBy(desc(digestRuns.sentAt))
        .limit(limit);

      return {
        slot_id: id,
        total_returned: runs.length,
        runs: runs.map(mapRun),
      };
    },
  );

  // DELETE /digest-slots/:id/history — clear run history for a slot
  app.delete<{ Params: { id: string } }>(
    "/digest-slots/:id/history",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;

      const [slot] = await deps.db
        .select({ id: digestSlots.id, name: digestSlots.name })
        .from(digestSlots)
        .where(eq(digestSlots.id, id));

      if (!slot) return reply.code(404).send({ error: "Digest slot not found" });

      const deleted = await deps.db
        .delete(digestRuns)
        .where(eq(digestRuns.slotId, id))
        .returning({ id: digestRuns.id });

      logger.info(
        { slotId: id, slotName: slot.name, count: deleted.length },
        "[digest-slots] history cleared",
      );

      return { cleared: deleted.length };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAFT MANAGEMENT ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots/drafts/pending — all pending drafts across all slots
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/digest-slots/drafts/pending", { preHandler: deps.requireApiKey }, async () => {
    const drafts = await deps.db
      .select({
        draft: digestDrafts,
        slotName: digestSlots.name,
      })
      .from(digestDrafts)
      .innerJoin(digestSlots, eq(digestDrafts.slotId, digestSlots.id))
      .where(
        or(
          eq(digestDrafts.status, "draft"),
          and(eq(digestDrafts.status, "approved"), isNull(digestDrafts.sentAt)),
        ),
      )
      .orderBy(desc(digestDrafts.generatedAt));

    return drafts.map((r) => ({
      ...mapDraft(r.draft),
      slot_name: r.slotName,
    }));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots/:id/drafts — list drafts for slot (newest first)
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/digest-slots/:id/drafts",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const limitParam = parseInt(request.query.limit ?? "20", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;

      const [slot] = await deps.db
        .select({ id: digestSlots.id })
        .from(digestSlots)
        .where(eq(digestSlots.id, id));

      if (!slot) return reply.code(404).send({ error: "Digest slot not found" });

      const drafts = await deps.db
        .select()
        .from(digestDrafts)
        .where(eq(digestDrafts.slotId, id))
        .orderBy(desc(digestDrafts.generatedAt))
        .limit(limit);

      return drafts.map(mapDraft);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /digest-slots/:id/drafts/:draftId — full draft detail
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string; draftId: string } }>(
    "/digest-slots/:id/drafts/:draftId",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id, draftId } = request.params;

      const [draft] = await deps.db
        .select()
        .from(digestDrafts)
        .where(and(eq(digestDrafts.id, draftId), eq(digestDrafts.slotId, id)));

      if (!draft) return reply.code(404).send({ error: "Draft not found" });

      return mapDraft(draft);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /digest-slots/:id/drafts/:draftId — edit draft text
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string; draftId: string };
    Body: { generated_text?: string; translated_text?: string | null };
  }>(
    "/digest-slots/:id/drafts/:draftId",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id, draftId } = request.params;
      const body = request.body ?? {};

      const [draft] = await deps.db
        .select()
        .from(digestDrafts)
        .where(and(eq(digestDrafts.id, draftId), eq(digestDrafts.slotId, id)));

      if (!draft) return reply.code(404).send({ error: "Draft not found" });

      if (draft.status !== "draft") {
        return reply.code(400).send({ error: `Cannot edit draft with status '${draft.status}'` });
      }
      if (draft.expiresAt < new Date()) {
        return reply.code(400).send({ error: "Draft has expired" });
      }

      const updates: Record<string, unknown> = { edited: true };
      if (body.generated_text !== undefined) {
        if (typeof body.generated_text !== "string" || body.generated_text.trim().length === 0) {
          return reply.code(400).send({ error: "generated_text cannot be empty" });
        }
        updates.generatedText = body.generated_text;
      }
      if (body.translated_text !== undefined) {
        updates.translatedText = body.translated_text;
      }

      const [updated] = await deps.db
        .update(digestDrafts)
        .set(updates)
        .where(eq(digestDrafts.id, draftId))
        .returning();

      logger.info({ draftId }, "[digest-slots] draft edited");
      return mapDraft(updated);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /digest-slots/:id/drafts/:draftId/approve — approve & post immediately
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string; draftId: string } }>(
    "/digest-slots/:id/drafts/:draftId/approve",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id, draftId } = request.params;

      const [draft] = await deps.db
        .select()
        .from(digestDrafts)
        .where(and(eq(digestDrafts.id, draftId), eq(digestDrafts.slotId, id)));

      if (!draft) return reply.code(404).send({ error: "Draft not found" });

      if (draft.status !== "draft") {
        return reply
          .code(400)
          .send({ error: `Cannot approve draft with status '${draft.status}'` });
      }
      if (draft.expiresAt < new Date()) {
        return reply.code(400).send({ error: "Draft has expired" });
      }

      // Atomically set status to approved
      await deps.db
        .update(digestDrafts)
        .set({ status: "approved", approvedAt: new Date() })
        .where(and(eq(digestDrafts.id, draftId), eq(digestDrafts.status, "draft")));

      // Queue delivery job
      await deps.maintenanceQueue.add(
        JOB_DAILY_DIGEST,
        { draftId, slotId: id },
        { jobId: `digest-draft-${draftId}` },
      );

      logger.info({ draftId, slotId: id }, "[digest-slots] draft approved & delivery queued");
      return { queued: true, draft_id: draftId };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /digest-slots/:id/drafts/:draftId/schedule — approve & schedule
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string; draftId: string };
    Body: { scheduled_at: string };
  }>(
    "/digest-slots/:id/drafts/:draftId/schedule",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id, draftId } = request.params;
      const body = request.body ?? {};

      if (!body.scheduled_at || typeof body.scheduled_at !== "string") {
        return reply.code(400).send({ error: "scheduled_at is required (ISO 8601 date string)" });
      }

      const scheduledAt = new Date(body.scheduled_at);
      if (isNaN(scheduledAt.getTime())) {
        return reply.code(400).send({ error: "scheduled_at must be a valid ISO 8601 date string" });
      }

      // Allow 2 min tolerance for "right now"
      const minTime = new Date(Date.now() - 2 * 60 * 1000);
      if (scheduledAt < minTime) {
        return reply.code(400).send({ error: "scheduled_at must be in the future" });
      }

      const [draft] = await deps.db
        .select()
        .from(digestDrafts)
        .where(and(eq(digestDrafts.id, draftId), eq(digestDrafts.slotId, id)));

      if (!draft) return reply.code(404).send({ error: "Draft not found" });

      if (draft.status !== "draft" && draft.status !== "approved") {
        return reply
          .code(400)
          .send({ error: `Cannot schedule draft with status '${draft.status}'` });
      }
      if (draft.expiresAt < new Date()) {
        return reply.code(400).send({ error: "Draft has expired" });
      }

      const isReschedule = draft.status === "approved";
      await deps.db
        .update(digestDrafts)
        .set({
          status: "approved",
          ...(!isReschedule && { approvedAt: new Date() }),
          scheduledAt,
        })
        .where(eq(digestDrafts.id, draftId));

      logger.info(
        { draftId, slotId: id, scheduledAt: scheduledAt.toISOString(), isReschedule },
        "[digest-slots] draft scheduled",
      );
      return { scheduled: true, draft_id: draftId, scheduled_at: scheduledAt.toISOString() };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /digest-slots/:id/drafts/:draftId/discard — discard draft
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string; draftId: string } }>(
    "/digest-slots/:id/drafts/:draftId/discard",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id, draftId } = request.params;

      const [draft] = await deps.db
        .select()
        .from(digestDrafts)
        .where(and(eq(digestDrafts.id, draftId), eq(digestDrafts.slotId, id)));

      if (!draft) return reply.code(404).send({ error: "Draft not found" });

      if (!["draft", "approved"].includes(draft.status)) {
        return reply
          .code(400)
          .send({ error: `Cannot discard draft with status '${draft.status}'` });
      }

      await deps.db
        .update(digestDrafts)
        .set({ status: "discarded" })
        .where(eq(digestDrafts.id, draftId));

      logger.info({ draftId, slotId: id }, "[digest-slots] draft discarded");
      return { success: true, draft_id: draftId };
    },
  );
};
