import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { eq, gte, and, desc, inArray, count, isNotNull, isNull, not, sql } from "drizzle-orm";
import { logger } from "@watch-tower/shared";
import { DEFAULT_MODELS, DEFAULT_BASE_URLS, calculateLLMCost } from "@watch-tower/llm";
import type { Database } from "@watch-tower/db";
import {
  articles,
  appConfig,
  sectors,
  llmTelemetry,
  digestRuns,
  digestSlots,
  digestDrafts,
} from "@watch-tower/db";
import { sendTelegramAlert, sendTelegramPhoto, cleanForTelegram } from "../utils/telegram-alert.js";
import { generateDigestCover } from "../services/digest-cover.js";
import {
  createFacebookProvider,
  createLinkedInProvider,
  type FacebookConfig,
  type LinkedInConfig,
} from "@watch-tower/social";

// ─── Types ───────────────────────────────────────────────────────────────────

type TelegramConfig = {
  botToken: string;
  defaultChatId: string;
};

type ApiKeys = {
  anthropic?: string;
  openai?: string;
  deepseek?: string;
  googleAi?: string;
};

export type DigestDeps = {
  db: Database;
  telegramConfig?: TelegramConfig;
  facebookConfig?: FacebookConfig;
  linkedinConfig?: LinkedInConfig;
  apiKeys: ApiKeys;
};

export type DigestConfig = {
  enabled: boolean;
  time: string; // "HH:MM"
  timezone: string; // IANA timezone
  days: number[]; // 1=Mon...7=Sun
  minScore: number; // 1-5
  maxArticles: number; // 1-100 (cap fed to LLM)
  sectorIds: string[] | null; // filter to specific sectors (null = all)
  language: "en" | "ka";
  systemPrompt: string; // full LLM system prompt (editable from UI)
  telegramChatId: string;
  telegramEnabled: boolean;
  facebookEnabled: boolean;
  linkedinEnabled: boolean;
  provider: string; // "claude" | "openai" | "deepseek" | "gemini"
  model: string;
  translationProvider: string; // "gemini" | "openai"
  translationModel: string;
  translationPrompt: string; // instructions for Georgian translation LLM
  telegramLanguage: "en" | "ka";
  facebookLanguage: "en" | "ka";
  linkedinLanguage: "en" | "ka";
  imageTelegram: boolean;
  imageFacebook: boolean;
  imageLinkedin: boolean;
  autoPost: boolean; // true = deliver immediately, false = save as draft
};

type DigestArticle = {
  id: string;
  title: string;
  llmSummary: string | null;
  importanceScore: number;
  url: string;
  sectorName: string | null;
  translationStatus: string | null;
};

type LLMResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type DigestResult = {
  sent: boolean;
  articleCount: number;
  messageCount: number;
  draftId?: string;
};

/** Intermediate result from generateDigestContent() */
export type GeneratedContent = {
  rawBullets: string;
  translatedBullets: string | null;
  articleIds: string[];
  articleMap: Map<number, DigestArticle>;
  allArticles: DigestArticle[];
  llmResult: LLMResult | null;
  translationResult: LLMResult | null;
  stats: PipelineStats;
  hasLLM: boolean;
  scoreDistribution: Record<string, number>; // { "5": 4, "4": 8, "3": 6 }
  maxArticles: number;
};

// ─── Default system prompt ───────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are a senior intelligence analyst. Deliver a telegraphic daily briefing.

You will receive today's scored article feed — it may contain 10 or 100+ articles. Your job is NOT to summarize every article. Your job is to FILTER ruthlessly and surface only what a decision-maker must know today.

Output ONLY bullet points. Each bullet is ONE short sentence — what happened and a brief hint at why it matters. End with source [#IDs].

Example:
\u2022 Supreme Court struck down most Trump tariffs — could trigger $175B in refunds and reshape trade policy [#2, #5]

Rules:
- ONE sentence per bullet. Maximum 30 words. No filler, no elaboration.
- End each bullet with source references like [#1] or [#1, #3]
- Merge related articles into one bullet
- TARGET 7-12 bullets. Slow news day: 5-7. Major day: up to 12. NEVER exceed 12.
- The number of bullets must NOT scale with input size — 30 articles and 100 articles should produce roughly the same number of bullets
- Skip anything routine, incremental, or already well-known. Only surface genuine developments.
- Most impactful first
- Do NOT include scores or score numbers in the output — the reader doesn't need them
- Write in English`;

export const DEFAULT_TRANSLATION_PROMPT =
  "Translate the following intelligence briefing to Georgian. " +
  "Be concise — do not expand or elaborate, match the original length. " +
  "Keep bullet point structure exactly as-is. " +
  "Keep ALL source references like [#1], [#1, #3] EXACTLY as they appear — do not translate, remove, or modify them. " +
  "Keep ALL HTML tags (<b>, <a href>, etc.) and URLs completely unchanged. " +
  "Only translate the human-readable text. Output the translation only, nothing else.";

// ─── Config reader ───────────────────────────────────────────────────────────

export const readDigestConfig = async (db: Database): Promise<DigestConfig> => {
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
    // Fallbacks from global config
    "posting_language",
    "LLM_PROVIDER",
    "translation_provider",
    "translation_model",
  ];

  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const m = new Map(rows.map((r) => [r.key, r.value]));
  const postingLanguage = (m.get("posting_language") as string) ?? "en";
  const globalLlmProvider = (m.get("LLM_PROVIDER") as string) ?? "claude";
  const globalTransProvider = (m.get("translation_provider") as string) ?? "gemini";
  const globalTransModel = (m.get("translation_model") as string) ?? "gemini-2.5-flash";

  return {
    enabled: m.get("digest_enabled") === true || m.get("digest_enabled") === "true",
    time: (m.get("digest_time") as string) ?? "08:00",
    timezone: (m.get("digest_timezone") as string) ?? "UTC",
    days: Array.isArray(m.get("digest_days"))
      ? (m.get("digest_days") as number[])
      : [1, 2, 3, 4, 5, 6, 7],
    minScore: Number(m.get("digest_min_score")) || 3,
    maxArticles: 50,
    sectorIds: null,
    language: ((m.get("digest_language") as string) ?? postingLanguage) as "en" | "ka",
    systemPrompt: (m.get("digest_system_prompt") as string) ?? DEFAULT_SYSTEM_PROMPT,
    telegramChatId: String(m.get("digest_telegram_chat_id") ?? ""),
    telegramEnabled:
      m.get("digest_telegram_enabled") === true ||
      m.get("digest_telegram_enabled") === "true" ||
      !m.has("digest_telegram_enabled"),
    facebookEnabled:
      m.get("digest_facebook_enabled") === true || m.get("digest_facebook_enabled") === "true",
    linkedinEnabled:
      m.get("digest_linkedin_enabled") === true || m.get("digest_linkedin_enabled") === "true",
    provider: (m.get("digest_provider") as string) ?? globalLlmProvider,
    model:
      (m.get("digest_model") as string) ??
      DEFAULT_MODELS[globalLlmProvider as keyof typeof DEFAULT_MODELS] ??
      "gpt-4o-mini",
    translationProvider: (m.get("digest_translation_provider") as string) ?? globalTransProvider,
    translationModel: (m.get("digest_translation_model") as string) ?? globalTransModel,
    translationPrompt: (m.get("digest_translation_prompt") as string) ?? DEFAULT_TRANSLATION_PROMPT,
    telegramLanguage: ((m.get("digest_language") as string) ?? postingLanguage ?? "en") as
      | "en"
      | "ka",
    facebookLanguage: ((m.get("digest_language") as string) ?? postingLanguage ?? "en") as
      | "en"
      | "ka",
    linkedinLanguage: ((m.get("digest_language") as string) ?? postingLanguage ?? "en") as
      | "en"
      | "ka",
    imageTelegram:
      m.get("digest_image_telegram") === true || m.get("digest_image_telegram") === "true",
    imageFacebook:
      m.get("digest_image_facebook") === true || m.get("digest_image_facebook") === "true",
    imageLinkedin:
      m.get("digest_image_linkedin") === true || m.get("digest_image_linkedin") === "true",
    autoPost: true, // Legacy config always auto-posts
  };
};

// ─── Slot config reader ─────────────────────────────────────────────────────

export const readSlotConfig = async (db: Database, slotId: string): Promise<DigestConfig> => {
  const [slot] = await db.select().from(digestSlots).where(eq(digestSlots.id, slotId));

  if (!slot) throw new Error(`[digest] slot ${slotId} not found`);

  return {
    enabled: slot.enabled,
    time: slot.time,
    timezone: slot.timezone,
    days: Array.isArray(slot.days) ? (slot.days as number[]) : [1, 2, 3, 4, 5, 6, 7],
    minScore: slot.minScore,
    maxArticles: slot.maxArticles,
    sectorIds: Array.isArray(slot.sectorIds) ? (slot.sectorIds as string[]) : null,
    language: slot.language as "en" | "ka",
    systemPrompt: slot.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    telegramChatId: slot.telegramChatId ?? "",
    telegramEnabled: slot.telegramEnabled,
    facebookEnabled: slot.facebookEnabled,
    linkedinEnabled: slot.linkedinEnabled,
    provider: slot.provider,
    model: slot.model,
    translationProvider: slot.translationProvider,
    translationModel: slot.translationModel,
    translationPrompt: slot.translationPrompt ?? DEFAULT_TRANSLATION_PROMPT,
    telegramLanguage: (slot.telegramLanguage ?? slot.language) as "en" | "ka",
    facebookLanguage: (slot.facebookLanguage ?? slot.language) as "en" | "ka",
    linkedinLanguage: (slot.linkedinLanguage ?? slot.language) as "en" | "ka",
    imageTelegram: slot.imageTelegram,
    imageFacebook: slot.imageFacebook,
    imageLinkedin: slot.imageLinkedin,
    autoPost: slot.autoPost,
  };
};

// ─── A. Generate digest content (steps 0-9) ────────────────────────────────

export const generateDigestContent = async (
  deps: DigestDeps,
  config: DigestConfig,
  opts: { isTest?: boolean; slotId?: string } = {},
): Promise<GeneratedContent | null> => {
  const { db, apiKeys } = deps;
  const isTest = opts.isTest ?? false;
  const slotId = opts.slotId;

  // 0. Emergency brake
  const [stopRow] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, "emergency_stop"));
  if (stopRow?.value === true || stopRow?.value === "true") {
    logger.warn("[digest] emergency_stop active, skipping digest");
    return null;
  }

  if (!config.enabled && !isTest) {
    return null;
  }

  // 1. Determine lookback window — always capped at 24h
  const max24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let lookback: Date;
  if (isTest) {
    lookback = max24h;
  } else if (slotId) {
    // Fixed 24h window — digestedAt column handles dedup across slots/runs,
    // so lookback only needs to cap freshness (not prevent re-inclusion)
    lookback = max24h;
  } else {
    const [lastRow] = await db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, "last_digest_sent_at"));
    if (lastRow?.value) {
      const lastSent = new Date(lastRow.value as string);
      lookback = lastSent > max24h ? lastSent : max24h;
    } else {
      lookback = max24h;
    }
  }

  // 2. Query qualifying articles with dedup exclusion
  const whereConditions = [
    gte(articles.scoredAt, lookback),
    gte(articles.importanceScore, config.minScore),
    inArray(articles.pipelineStage, ["scored", "approved", "posted"]),
    isNull(articles.digestedAt),
  ];

  // Sector filtering
  if (config.sectorIds && config.sectorIds.length > 0) {
    whereConditions.push(inArray(articles.sectorId, config.sectorIds));
  }

  // Dedup: exclude articles in pending/approved drafts (not sent — sent articles are fair game)
  const excludedRows = await db.execute<{ aid: string }>(sql`
    SELECT DISTINCT jsonb_array_elements_text(article_ids)::uuid AS aid
    FROM digest_drafts
    WHERE status IN ('draft', 'approved')
      AND generated_at > NOW() - INTERVAL '48 hours'
  `);
  const excludedIds = (excludedRows.rows ?? []).map((r) => r.aid);
  if (excludedIds.length > 0) {
    whereConditions.push(not(inArray(articles.id, excludedIds)));
  }

  const articleLimit = Math.min(Math.max(config.maxArticles ?? 50, 1), 100);

  const allArticles = await db
    .select({
      id: articles.id,
      title: articles.title,
      llmSummary: articles.llmSummary,
      importanceScore: articles.importanceScore,
      url: articles.url,
      sectorName: sectors.name,
      translationStatus: articles.translationStatus,
    })
    .from(articles)
    .leftJoin(sectors, eq(articles.sectorId, sectors.id))
    .where(and(...whereConditions))
    .orderBy(desc(articles.importanceScore), desc(articles.publishedAt))
    .limit(articleLimit);

  // Zero articles guard — record empty run to prevent triple-fire from scheduler
  if (allArticles.length === 0) {
    logger.info("[digest] no qualifying articles, skipping");
    if (slotId && !isTest) {
      await db.insert(digestRuns).values({
        slotId,
        sentAt: new Date(),
        isTest: false,
        language: config.language,
        articleCount: 0,
        channels: [],
        channelResults: {},
        provider: config.provider,
        model: config.model,
        minScore: config.minScore,
        statsScanned: 0,
        statsScored: 0,
        statsAboveThreshold: 0,
      });
    }
    return null;
  }
  logger.info(
    { count: allArticles.length, firstTitle: allArticles[0]?.title?.slice(0, 80) },
    "[digest] articles selected",
  );

  // 3. Build article index for [#ID]→URL mapping
  const articleMap = new Map<number, DigestArticle>();
  allArticles.forEach((a, i) => articleMap.set(i + 1, a as DigestArticle));

  // 4. LLM call
  const digestApiKey = resolveApiKey(config.provider, apiKeys);
  let llmBullets: string | null = null;
  let llmResult: LLMResult | null = null;

  if (digestApiKey) {
    const systemPrompt = config.systemPrompt;
    const userPrompt = buildUserPrompt(allArticles as DigestArticle[], config);

    llmResult = await callLLM(
      { provider: config.provider, apiKey: digestApiKey, model: config.model },
      systemPrompt,
      userPrompt,
    );
    if (llmResult) {
      llmBullets = llmResult.text;
      logger.info(
        { len: llmBullets.length, preview: llmBullets.slice(0, 200) },
        "[digest] LLM bullets generated",
      );
    } else {
      logger.warn("[digest] LLM call failed, using template-only fallback");
    }
  } else {
    logger.warn({ provider: config.provider }, "[digest] no API key for digest provider");
  }

  // 5. Build raw bullet body
  let rawBullets: string;
  if (llmBullets) {
    rawBullets = llmBullets;
  } else {
    rawBullets = buildFallbackBulletsPlain(allArticles as DigestArticle[]);
  }

  // 6. Georgian translation (if needed)
  let translatedBullets: string | null = null;
  let translationResult: LLMResult | null = null;
  if (config.language === "ka") {
    const transApiKey = resolveTranslationApiKey(config.translationProvider, apiKeys);
    if (transApiKey) {
      const tr = await translateDigestText(
        config.translationProvider,
        transApiKey,
        config.translationModel,
        config.translationPrompt,
        rawBullets,
      );
      if (tr && tr.text.trim().length > 0) {
        translatedBullets = tr.text;
        translationResult = tr;
        logger.info(
          { len: translatedBullets.length, preview: translatedBullets.slice(0, 200) },
          "[digest] translated to Georgian",
        );
      } else {
        logger.warn("[digest] translation returned empty or failed, sending English");
      }
    } else {
      logger.warn("[digest] no API key for translation provider, sending English");
    }
  }

  // 7. Pipeline stats
  const stats = await queryPipelineStats(db, lookback, config.minScore);

  // 8. Score distribution of articles fed to LLM
  const scoreDistribution: Record<string, number> = {};
  for (const a of allArticles) {
    const s = String(a.importanceScore ?? 0);
    scoreDistribution[s] = (scoreDistribution[s] ?? 0) + 1;
  }

  return {
    rawBullets,
    translatedBullets,
    articleIds: allArticles.map((a) => a.id),
    articleMap,
    allArticles: allArticles as DigestArticle[],
    llmResult,
    translationResult,
    stats,
    hasLLM: !!llmBullets,
    scoreDistribution,
    maxArticles: articleLimit,
  };
};

// ─── B. Deliver digest to platforms (steps 10-14) ───────────────────────────

export const deliverDigest = async (
  deps: DigestDeps,
  config: DigestConfig,
  content: GeneratedContent,
  opts: { isTest?: boolean; slotId?: string; draftId?: string } = {},
): Promise<DigestResult> => {
  const { db, telegramConfig, facebookConfig, linkedinConfig } = deps;
  const isTest = opts.isTest ?? false;

  // Per-channel language: pick translated or raw text based on channel language
  const pickText = (lang: "en" | "ka") =>
    lang === "ka" && content.translatedBullets ? content.translatedBullets : content.rawBullets;
  const pickHeader = (lang: "en" | "ka") =>
    lang === "ka" && content.translatedBullets ? "რა მოხდა დღეს" : "What Happened Today";

  const hasTelegram = config.telegramEnabled && telegramConfig?.botToken && config.telegramChatId;
  const hasFacebook = config.facebookEnabled && facebookConfig;
  const hasLinkedin = config.linkedinEnabled && linkedinConfig;

  if (!hasTelegram && !hasFacebook && !hasLinkedin) {
    logger.warn("[digest] no delivery channels configured, skipping");
    return { sent: false, articleCount: content.allArticles.length, messageCount: 0 };
  }

  const dateStr = formatDate(new Date(), config.timezone);

  // Generate cover images at DELIVERY time (correct date), one per language used.
  // Each channel may have a different language (e.g. Telegram=ka, Facebook=en).
  const coverByLang: Record<string, Buffer> = {};
  async function getCover(lang: "en" | "ka"): Promise<Buffer | null> {
    if (coverByLang[lang]) return coverByLang[lang];
    try {
      const buf = await generateDigestCover(lang, dateStr);
      coverByLang[lang] = buf;
      logger.info({ size: buf.length, language: lang }, "[digest] cover image generated");
      return buf;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg, language: lang }, "[digest] cover image generation failed");
      return null;
    }
  }

  let anySent = false;
  let totalMessages = 0;
  const channelResults: Record<string, string> = {};

  // ── Telegram (HTML formatting) ──
  if (hasTelegram) {
    const tgText = pickText(config.telegramLanguage);
    const tgHeader = pickHeader(config.telegramLanguage);
    let bodyHtml: string;
    if (!content.hasLLM) {
      bodyHtml = buildFallbackBullets(content.allArticles);
    } else {
      bodyHtml = buildTelegramHtml(tgText, content.articleMap);
    }

    if (!bodyHtml.trim()) {
      logger.warn("[digest] telegram body is empty after assembly, using fallback");
      bodyHtml = buildFallbackBullets(content.allArticles);
    }

    logger.info(
      { bodyLen: bodyHtml.length, bodyPreview: bodyHtml.slice(0, 300) },
      "[digest] telegram body assembled",
    );

    const bodyLines = bodyHtml
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const sections: string[] = [
      `<b>\u{1F4CA} ${cleanForTelegram(tgHeader)} \u2014 ${cleanForTelegram(dateStr)}</b>`,
      ...bodyLines,
    ];

    const messages = splitTelegramMessages(sections);
    let tgOk = false;

    if (config.imageTelegram) {
      const tgCover = await getCover(config.telegramLanguage);
      const photoResult = tgCover
        ? await sendTelegramPhoto(telegramConfig!.botToken, config.telegramChatId, tgCover)
        : { ok: false };
      if (photoResult.ok) {
        tgOk = true;
        totalMessages++;
      } else logger.warn("[digest] telegram cover photo failed to send");
      await new Promise((r) => setTimeout(r, 500));
    }

    for (let i = 0; i < messages.length; i++) {
      logger.debug(
        { msgIndex: i, msgLen: messages[i].length, preview: messages[i].slice(0, 300) },
        "[digest] telegram message chunk",
      );
      const msgResult = await sendTelegramAlert(
        telegramConfig!.botToken,
        config.telegramChatId,
        messages[i],
      );
      if (msgResult.ok) {
        anySent = true;
        tgOk = true;
      } else logger.warn({ msgIndex: i }, "[digest] telegram message failed to send");
      if (messages.length > 1) await new Promise((r) => setTimeout(r, 500));
    }
    totalMessages += messages.length;
    channelResults.telegram = tgOk ? "sent" : "failed";
    logger.info({ messages: messages.length }, "[digest] telegram sent");
  }

  // ── Facebook ──
  if (hasFacebook) {
    try {
      const fbBullets = pickText(config.facebookLanguage);
      const fbHeader = pickHeader(config.facebookLanguage);
      const plainBody = formatPlainDigest(fbBullets, content.allArticles, content.hasLLM);
      const fbText = `\u{1F4CA} ${fbHeader} \u2014 ${dateStr}\n\n${plainBody}`;

      const fbCover = config.imageFacebook ? await getCover(config.facebookLanguage) : null;
      if (fbCover) {
        const result = await postFacebookPhoto(facebookConfig!, fbText, fbCover);
        if (result.success) {
          anySent = true;
          totalMessages++;
          channelResults.facebook = "sent";
          logger.info({ postId: result.postId }, "[digest] facebook photo sent");
        } else {
          channelResults.facebook = "failed";
          logger.warn({ error: result.error }, "[digest] facebook photo post failed");
        }
      } else {
        const fb = createFacebookProvider(facebookConfig!);
        const result = await fb.post({ text: fbText });
        if (result.success) {
          anySent = true;
          totalMessages++;
          channelResults.facebook = "sent";
          logger.info({ postId: result.postId }, "[digest] facebook sent");
        } else {
          channelResults.facebook = "failed";
          logger.warn({ error: result.error }, "[digest] facebook post failed");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channelResults.facebook = "failed";
      logger.warn({ error: msg }, "[digest] facebook delivery failed");
    }
  }

  // ── LinkedIn (plain text, 3000 char limit) ──
  if (hasLinkedin) {
    try {
      const liBullets = pickText(config.linkedinLanguage);
      const liHeader = pickHeader(config.linkedinLanguage);
      const plainBody = formatPlainDigest(liBullets, content.allArticles, content.hasLLM);
      const header = `\u{1F4CA} ${liHeader} \u2014 ${dateStr}`;
      const maxBody = 3000 - header.length - 4;
      const truncBody =
        plainBody.length > maxBody
          ? plainBody.slice(0, plainBody.lastIndexOf("\n", maxBody)) || plainBody.slice(0, maxBody)
          : plainBody;
      const liText = `${header}\n\n${truncBody}`;

      const liCover = config.imageLinkedin ? await getCover(config.linkedinLanguage) : null;
      let result;
      if (liCover) {
        result = await postLinkedInPhoto(linkedinConfig!, liText, liCover);
      } else {
        const li = createLinkedInProvider(linkedinConfig!);
        result = await li.post({ text: liText });
      }
      if (result.success) {
        anySent = true;
        totalMessages++;
        channelResults.linkedin = "sent";
        logger.info({ postId: result.postId }, "[digest] linkedin sent");
      } else {
        channelResults.linkedin = "failed";
        logger.warn({ error: result.error }, "[digest] linkedin post failed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channelResults.linkedin = "failed";
      logger.warn({ error: msg }, "[digest] linkedin delivery failed");
    }
  }

  // Update last_digest_sent_at + mark articles as digested
  if (!isTest && anySent) {
    // Mark articles so they won't appear in other digest slots
    const digestedIds = content.allArticles.map((a) => a.id);
    if (digestedIds.length > 0) {
      await db
        .update(articles)
        .set({ digestedAt: new Date() })
        .where(inArray(articles.id, digestedIds));
    }

    await db
      .insert(appConfig)
      .values({
        key: "last_digest_sent_at",
        value: new Date().toISOString(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
  }

  // Log telemetry
  if (content.llmResult) {
    const cost = calculateLLMCost(
      config.provider,
      config.model,
      content.llmResult.inputTokens,
      content.llmResult.outputTokens,
    );
    await db.insert(llmTelemetry).values({
      articleId: null,
      operation: "digest_summary",
      provider: config.provider,
      model: config.model,
      isFallback: false,
      inputTokens: content.llmResult.inputTokens,
      outputTokens: content.llmResult.outputTokens,
      totalTokens: content.llmResult.inputTokens + content.llmResult.outputTokens,
      costMicrodollars: cost,
      latencyMs: content.llmResult.latencyMs,
      status: "success",
    });
  }
  if (content.translationResult) {
    const cost = calculateLLMCost(
      config.translationProvider,
      config.translationModel,
      content.translationResult.inputTokens,
      content.translationResult.outputTokens,
    );
    await db.insert(llmTelemetry).values({
      articleId: null,
      operation: "digest_translation",
      provider: config.translationProvider,
      model: config.translationModel,
      isFallback: false,
      inputTokens: content.translationResult.inputTokens,
      outputTokens: content.translationResult.outputTokens,
      totalTokens: content.translationResult.inputTokens + content.translationResult.outputTokens,
      costMicrodollars: cost,
      latencyMs: content.translationResult.latencyMs,
      status: "success",
    });
  }

  // Record digest run
  const sentChannels = Object.keys(channelResults);
  if (sentChannels.length > 0) {
    await db.insert(digestRuns).values({
      slotId: opts.slotId ?? null,
      draftId: opts.draftId ?? null,
      sentAt: new Date(),
      isTest,
      language: config.language,
      articleCount: content.allArticles.length,
      channels: sentChannels,
      channelResults,
      provider: config.provider,
      model: config.model,
      minScore: config.minScore,
      statsScanned: content.stats.totalIngested,
      statsScored: content.stats.passedFilters,
      statsAboveThreshold: content.stats.aboveThreshold,
      maxArticles: content.maxArticles,
      scoreDistribution: content.scoreDistribution,
    });
  }

  logger.info(
    {
      articles: content.allArticles.length,
      totalMessages,
      hasLLM: content.hasLLM,
      translated: !!content.translationResult,
      telegram: !!hasTelegram,
      facebook: !!hasFacebook,
      linkedin: !!hasLinkedin,
      isTest,
    },
    "[digest] complete",
  );

  return { sent: anySent, articleCount: content.allArticles.length, messageCount: totalMessages };
};

// ─── C. Save draft to DB ─────────────────────────────────────────────────────

export const saveDraft = async (
  db: Database,
  slotId: string,
  content: GeneratedContent,
  config: DigestConfig,
  status: "draft" | "sent" = "draft",
): Promise<string> => {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

  const [row] = await db
    .insert(digestDrafts)
    .values({
      slotId,
      status,
      generatedText: content.rawBullets,
      translatedText: content.translatedBullets,
      articleCount: content.allArticles.length,
      articleIds: content.articleIds,
      provider: config.provider,
      model: config.model,
      llmTokensIn: content.llmResult?.inputTokens ?? null,
      llmTokensOut: content.llmResult?.outputTokens ?? null,
      llmCostMicrodollars: content.llmResult
        ? calculateLLMCost(
            config.provider,
            config.model,
            content.llmResult.inputTokens,
            content.llmResult.outputTokens,
          )
        : null,
      translationProvider: content.translationResult ? config.translationProvider : null,
      translationModel: content.translationResult ? config.translationModel : null,
      translationCostMicrodollars: content.translationResult
        ? calculateLLMCost(
            config.translationProvider,
            config.translationModel,
            content.translationResult.inputTokens,
            content.translationResult.outputTokens,
          )
        : null,
      statsScanned: content.stats.totalIngested,
      statsScored: content.stats.passedFilters,
      statsAboveThreshold: content.stats.aboveThreshold,
      maxArticles: content.maxArticles,
      scoreDistribution: content.scoreDistribution,
      expiresAt,
      sentAt: status === "sent" ? new Date() : null,
    })
    .returning({ id: digestDrafts.id });

  logger.info({ draftId: row.id, slotId, status }, "[digest] draft saved");
  return row.id;
};

// ─── D. Deliver an existing draft (for manual approval) ─────────────────────

export const deliverDraft = async (deps: DigestDeps, draftId: string): Promise<DigestResult> => {
  const { db } = deps;

  // 1. Load draft
  const [draft] = await db.select().from(digestDrafts).where(eq(digestDrafts.id, draftId));

  if (!draft) throw new Error(`[digest] draft ${draftId} not found`);
  if (!["draft", "approved"].includes(draft.status)) {
    throw new Error(`[digest] draft ${draftId} has status '${draft.status}', cannot deliver`);
  }
  if (draft.expiresAt < new Date()) {
    await db.update(digestDrafts).set({ status: "expired" }).where(eq(digestDrafts.id, draftId));
    throw new Error(`[digest] draft ${draftId} has expired`);
  }

  // 2. Load slot config
  const config = await readSlotConfig(db, draft.slotId);

  // 3. Reconstruct content from draft (for delivery)
  const articleIds = draft.articleIds as string[];

  // Load articles for ref mapping
  const draftArticles =
    articleIds.length > 0
      ? await db
          .select({
            id: articles.id,
            title: articles.title,
            llmSummary: articles.llmSummary,
            importanceScore: articles.importanceScore,
            url: articles.url,
            sectorName: sectors.name,
            translationStatus: articles.translationStatus,
          })
          .from(articles)
          .leftJoin(sectors, eq(articles.sectorId, sectors.id))
          .where(inArray(articles.id, articleIds))
          .orderBy(desc(articles.importanceScore))
      : [];

  const articleMap = new Map<number, DigestArticle>();
  draftArticles.forEach((a, i) => articleMap.set(i + 1, a as DigestArticle));

  const content: GeneratedContent = {
    rawBullets: draft.generatedText,
    translatedBullets: draft.translatedText,
    articleIds,
    articleMap,
    allArticles: draftArticles as DigestArticle[],
    llmResult: null, // already logged at generation time
    translationResult: null,
    stats: {
      totalIngested: draft.statsScanned,
      passedFilters: draft.statsScored,
      aboveThreshold: draft.statsAboveThreshold,
      minScore: config.minScore,
    },
    hasLLM: true, // draft always has LLM content
    scoreDistribution: (draft.scoreDistribution as Record<string, number>) ?? {},
    maxArticles: draft.maxArticles ?? config.maxArticles,
  };

  // 4. Deliver
  try {
    const result = await deliverDigest(deps, config, content, {
      slotId: draft.slotId,
      draftId: draft.id,
    });

    // 5. Update draft status
    const sentChannels: string[] = [];
    if (config.telegramEnabled) sentChannels.push("telegram");
    if (config.facebookEnabled) sentChannels.push("facebook");
    if (config.linkedinEnabled) sentChannels.push("linkedin");

    await db
      .update(digestDrafts)
      .set({
        status: result.sent ? "sent" : "send_failed",
        sentAt: result.sent ? new Date() : null,
        channels: sentChannels,
      })
      .where(eq(digestDrafts.id, draftId));

    logger.info({ draftId, sent: result.sent }, "[digest] draft delivered");
    return { ...result, draftId };
  } catch (err) {
    await db
      .update(digestDrafts)
      .set({ status: "send_failed" })
      .where(eq(digestDrafts.id, draftId));
    throw err;
  }
};

// ─── E. Orchestrator (modified compileAndSendDigest) ────────────────────────

export const compileAndSendDigest = async (
  deps: DigestDeps,
  opts: { isTest?: boolean; slotId?: string; draftId?: string } = {},
): Promise<DigestResult> => {
  // If delivering an existing draft, use deliverDraft
  if (opts.draftId) {
    return deliverDraft(deps, opts.draftId);
  }

  const { db } = deps;
  const slotId = opts.slotId;
  const isTest = opts.isTest ?? false;

  // Read config
  const config = slotId ? await readSlotConfig(db, slotId) : await readDigestConfig(db);

  // Generate content
  const content = await generateDigestContent(deps, config, opts);
  if (!content) {
    return { sent: false, articleCount: 0, messageCount: 0 };
  }

  // Decision: auto-post or save as draft?
  if (slotId && !config.autoPost && !isTest) {
    // Save as draft for manual review
    const draftId = await saveDraft(db, slotId, content, config, "draft");

    // Still log telemetry for the generation
    if (content.llmResult) {
      const cost = calculateLLMCost(
        config.provider,
        config.model,
        content.llmResult.inputTokens,
        content.llmResult.outputTokens,
      );
      await db.insert(llmTelemetry).values({
        articleId: null,
        operation: "digest_summary",
        provider: config.provider,
        model: config.model,
        isFallback: false,
        inputTokens: content.llmResult.inputTokens,
        outputTokens: content.llmResult.outputTokens,
        totalTokens: content.llmResult.inputTokens + content.llmResult.outputTokens,
        costMicrodollars: cost,
        latencyMs: content.llmResult.latencyMs,
        status: "success",
      });
    }
    if (content.translationResult) {
      const cost = calculateLLMCost(
        config.translationProvider,
        config.translationModel,
        content.translationResult.inputTokens,
        content.translationResult.outputTokens,
      );
      await db.insert(llmTelemetry).values({
        articleId: null,
        operation: "digest_translation",
        provider: config.translationProvider,
        model: config.translationModel,
        isFallback: false,
        inputTokens: content.translationResult.inputTokens,
        outputTokens: content.translationResult.outputTokens,
        totalTokens: content.translationResult.inputTokens + content.translationResult.outputTokens,
        costMicrodollars: cost,
        latencyMs: content.translationResult.latencyMs,
        status: "success",
      });
    }

    logger.info(
      { draftId, slotId, articles: content.allArticles.length },
      "[digest] saved as draft (manual approval)",
    );
    return { sent: false, articleCount: content.allArticles.length, messageCount: 0, draftId };
  }

  // Auto-post path: save draft as 'sent' + deliver
  if (slotId) {
    const draftId = await saveDraft(db, slotId, content, config, "sent");
    const result = await deliverDigest(deps, config, content, { isTest, slotId, draftId });

    // Update draft with channel results
    const sentChannels: string[] = [];
    if (config.telegramEnabled) sentChannels.push("telegram");
    if (config.facebookEnabled) sentChannels.push("facebook");
    if (config.linkedinEnabled) sentChannels.push("linkedin");
    await db
      .update(digestDrafts)
      .set({ channels: sentChannels, sentAt: new Date() })
      .where(eq(digestDrafts.id, draftId));

    return { ...result, draftId };
  }

  // Legacy path (no slotId): deliver directly without draft
  return deliverDigest(deps, config, content, opts);
};

// ─── API key resolution ─────────────────────────────────────────────────────

const resolveApiKey = (provider: string, apiKeys: ApiKeys): string | undefined => {
  switch (provider) {
    case "claude":
      return apiKeys.anthropic;
    case "openai":
      return apiKeys.openai;
    case "deepseek":
      return apiKeys.deepseek;
    case "gemini":
      return apiKeys.googleAi;
    default:
      return undefined;
  }
};

const resolveTranslationApiKey = (provider: string, apiKeys: ApiKeys): string | undefined => {
  switch (provider) {
    case "gemini":
      return apiKeys.googleAi;
    case "openai":
      return apiKeys.openai;
    default:
      return undefined;
  }
};

// ─── LLM call helper ─────────────────────────────────────────────────────────

type LLMCallConfig = { provider: string; apiKey: string; model: string };

const callLLM = async (
  config: LLMCallConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMResult | null> => {
  const startTime = Date.now();

  try {
    if (config.provider === "claude") {
      const client = new Anthropic({ apiKey: config.apiKey });
      const response = await client.messages.create({
        model: config.model,
        max_tokens: 2500,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        text,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - startTime,
      };
    }

    if (config.provider === "gemini") {
      const client = new GoogleGenerativeAI(config.apiKey);
      const genModel = client.getGenerativeModel({
        model: config.model,
        systemInstruction: systemPrompt,
        generationConfig: { maxOutputTokens: 2500, temperature: 0.3 },
      });

      const result = await genModel.generateContent(userPrompt);
      const response = result.response;
      const text = response.text();
      const usage = response.usageMetadata;

      return {
        text,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // OpenAI / DeepSeek (compatible API)
    const client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.provider === "deepseek" ? { baseURL: DEFAULT_BASE_URLS.deepseek } : {}),
    });
    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: 2500,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, provider: config.provider }, "[digest] LLM call failed");
    return null;
  }
};

// ─── Prompt builders ──────────────────────────────────────────────────────────

const buildUserPrompt = (allArticles: DigestArticle[], config: DigestConfig): string => {
  const dateStr = formatDate(new Date(), config.timezone);
  const lines: string[] = [`Today's feed (${allArticles.length} articles, ${dateStr}):\n`];

  for (let i = 0; i < allArticles.length; i++) {
    const a = allArticles[i];
    const summary = a.llmSummary ?? a.title;
    const sector = a.sectorName ? ` | ${a.sectorName}` : "";
    lines.push(`[#${i + 1}] Score ${a.importanceScore}${sector} | ${summary}`);
  }

  lines.push(
    `\n---\nSelect ONLY the top 7-12 most significant developments from the ${allArticles.length} articles above. Merge related stories. Do NOT exceed 12 bullets.`,
  );

  return lines.join("\n");
};

// ─── Telegram HTML builder (extracted from inline) ──────────────────────────

const buildTelegramHtml = (bulletText: string, articleMap: Map<number, DigestArticle>): string => {
  // Replace [#ID] refs with <a> links BEFORE escaping
  const placeholders: string[] = [];
  const withPlaceholders = bulletText.replace(
    /\[#(\d+(?:,\s*#\d+)*)\]/g,
    (match, inner: string) => {
      const ids = inner.split(/,\s*#/).map((s) => parseInt(s.replace("#", ""), 10));
      let linkNum = 0;
      const links = ids
        .map((id) => {
          const article = articleMap.get(id);
          if (!article) return null;
          linkNum++;
          return `<a href="${escapeUrl(article.url)}">${linkNum}</a>`;
        })
        .filter(Boolean);
      if (links.length === 0) return match;
      const token = `\x00REF${placeholders.length}\x00`;
      placeholders.push(`[${links.join(", ")}]`);
      return token;
    },
  );
  let escaped = cleanForTelegram(withPlaceholders);
  for (let i = 0; i < placeholders.length; i++) {
    escaped = escaped.replace(`\x00REF${i}\x00`, placeholders[i]);
  }
  return escaped;
};

// ─── Template-only fallback (Telegram HTML) ──────────────────────────────────

const buildFallbackBullets = (allArticles: DigestArticle[]): string => {
  const lines: string[] = [];
  for (const a of allArticles.slice(0, 20)) {
    const title = cleanForTelegram(a.title);
    const link = `<a href="${escapeUrl(a.url)}">${title}</a>`;
    lines.push(`\u2022 ${link}`);
  }
  return lines.join("\n");
};

// ─── Template-only fallback (plain text for FB/LinkedIn) ────────────────────

const buildFallbackBulletsPlain = (allArticles: DigestArticle[]): string => {
  const lines: string[] = [];
  for (const a of allArticles.slice(0, 20)) {
    lines.push(`\u2022 ${a.title}`);
  }
  return lines.join("\n");
};

// ─── Plain text formatter for Facebook / LinkedIn ────────────────────────────

const formatPlainDigest = (
  rawBullets: string,
  allArticles: DigestArticle[],
  hasLLM: boolean,
): string => {
  if (!hasLLM) {
    const lines: string[] = [];
    for (const a of allArticles.slice(0, 20)) {
      lines.push(`\u2022 ${a.title}`);
    }
    return lines.join("\n");
  }

  return rawBullets.replace(/\s*\[#\d+(?:,\s*#\d+)*\]/g, "").trim();
};

// ─── Georgian translation ─────────────────────────────────────────────────────

const translateDigestText = async (
  provider: string,
  apiKey: string,
  model: string,
  prompt: string,
  text: string,
): Promise<LLMResult | null> => {
  const startTime = Date.now();

  try {
    if (provider === "gemini") {
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({
        model,
        systemInstruction: prompt,
        generationConfig: { maxOutputTokens: 4096 },
      });

      const result = await genModel.generateContent(text);
      const response = result.response;
      const translated = response.text();
      const usage = response.usageMetadata;

      return {
        text: translated,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // OpenAI fallback for translation
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
    });

    return {
      text: response.choices[0]?.message?.content ?? text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, provider }, "[digest] translation failed");
    return null;
  }
};

// ─── Pipeline stats query ─────────────────────────────────────────────────────

type PipelineStats = {
  totalIngested: number;
  passedFilters: number;
  aboveThreshold: number;
  minScore: number;
};

const queryPipelineStats = async (
  db: Database,
  lookback: Date,
  minScore: number,
): Promise<PipelineStats> => {
  const [totalRow] = await db
    .select({ cnt: count() })
    .from(articles)
    .where(gte(articles.createdAt, lookback));

  const [scoredRow] = await db
    .select({ cnt: count() })
    .from(articles)
    .where(and(gte(articles.scoredAt, lookback), isNotNull(articles.importanceScore)));

  const [highRow] = await db
    .select({ cnt: count() })
    .from(articles)
    .where(and(gte(articles.scoredAt, lookback), gte(articles.importanceScore, minScore)));

  return {
    totalIngested: totalRow?.cnt ?? 0,
    passedFilters: scoredRow?.cnt ?? 0,
    aboveThreshold: highRow?.cnt ?? 0,
    minScore,
  };
};

// ─── Telegram formatting helpers ──────────────────────────────────────────────

const escapeUrl = (url: string): string => url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const formatDate = (date: Date, timezone: string): string => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).formatToParts(date);
    const d = parts.find((p) => p.type === "day")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    const y = parts.find((p) => p.type === "year")!.value;
    return `${d}.${m}.${y}`;
  } catch {
    return date.toLocaleDateString("en-US", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }
};

// ─── Message splitting ────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 4096;

const splitTelegramMessages = (sections: string[]): string[] => {
  const messages: string[] = [];
  let current = "";

  for (const section of sections) {
    const sep = current ? (current.endsWith("</b>") ? "\n\n" : "\n") : "";
    const candidate = current + sep + section;

    if (candidate.length <= MAX_MESSAGE_LENGTH) {
      current = candidate;
    } else {
      if (current) messages.push(current);
      if (section.length > MAX_MESSAGE_LENGTH) {
        const truncated = section.slice(0, MAX_MESSAGE_LENGTH - 4);
        const lastNl = truncated.lastIndexOf("\n");
        current = lastNl > 0 ? truncated.slice(0, lastNl) + "\n..." : truncated + "...";
      } else {
        current = section;
      }
    }
  }

  if (current) messages.push(current);
  return messages.length > 0 ? messages : [""];
};

// ─── Direct photo uploads (no R2 needed) ──────────────────────────────────────

const UPLOAD_TIMEOUT_MS = 30_000;

type SimplePostResult = { success: boolean; postId: string; error?: string };

/** Facebook: multipart photo upload via Graph API /photos endpoint */
async function postFacebookPhoto(
  config: FacebookConfig,
  caption: string,
  imageBuffer: Buffer,
): Promise<SimplePostResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const form = new FormData();
    form.append(
      "source",
      new Blob([new Uint8Array(imageBuffer)], { type: "image/webp" }),
      "digest-cover.webp",
    );
    form.append("caption", caption);
    form.append("access_token", config.accessToken);

    const resp = await fetch(`https://graph.facebook.com/v18.0/${config.pageId}/photos`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    const data = (await resp.json()) as {
      id?: string;
      post_id?: string;
      error?: { message: string };
    };
    if (!resp.ok || data.error) {
      return { success: false, postId: "", error: data.error?.message || `HTTP ${resp.status}` };
    }
    return { success: true, postId: data.post_id || data.id || "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, postId: "", error: msg };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** LinkedIn: 3-step image upload (register → upload binary → create post) */
async function postLinkedInPhoto(
  config: LinkedInConfig,
  text: string,
  imageBuffer: Buffer,
): Promise<SimplePostResult> {
  const authorUrn = `urn:li:${config.authorType}:${config.authorId}`;
  const headers = { Authorization: `Bearer ${config.accessToken}` };

  try {
    // Step 1: Register upload
    const registerResp = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: authorUrn,
          serviceRelationships: [
            { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
          ],
        },
      }),
    });

    if (!registerResp.ok) {
      const err = (await registerResp.json().catch(() => ({}))) as { message?: string };
      return {
        success: false,
        postId: "",
        error: err.message || `Register failed: HTTP ${registerResp.status}`,
      };
    }

    const registerData = (await registerResp.json()) as {
      value: {
        uploadMechanism: {
          "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: string };
        };
        asset: string;
      };
    };

    const uploadUrl =
      registerData.value.uploadMechanism[
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
      ].uploadUrl;
    const assetUrn = registerData.value.asset;

    // Step 2: Upload binary directly (no R2 fetch needed)
    const uploadResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "image/webp" },
      body: new Uint8Array(imageBuffer),
    });

    if (!uploadResp.ok && uploadResp.status !== 201) {
      return { success: false, postId: "", error: `Upload failed: HTTP ${uploadResp.status}` };
    }

    // Step 3: Create post with image
    const postResp = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "IMAGE",
            media: [{ status: "READY", media: assetUrn }],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });

    if (!postResp.ok) {
      const err = (await postResp.json().catch(() => ({}))) as { message?: string };
      return {
        success: false,
        postId: "",
        error: err.message || `Post failed: HTTP ${postResp.status}`,
      };
    }

    return { success: true, postId: postResp.headers.get("x-restli-id") || "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, postId: "", error: msg };
  }
}
