import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { eq, gte, and, desc, inArray, count, isNotNull } from "drizzle-orm";
import { logger } from "@watch-tower/shared";
import { DEFAULT_MODELS, DEFAULT_BASE_URLS, calculateLLMCost } from "@watch-tower/llm";
import type { Database } from "@watch-tower/db";
import { articles, appConfig, sectors, llmTelemetry } from "@watch-tower/db";
import { sendTelegramAlert, cleanForTelegram } from "../utils/telegram-alert.js";
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
  language: "en" | "ka";
  systemPrompt: string; // full LLM system prompt (editable from UI)
  telegramChatId: string;
  telegramEnabled: boolean;
  facebookEnabled: boolean;
  linkedinEnabled: boolean;
  provider: string; // "claude" | "openai" | "deepseek"
  model: string;
  translationProvider: string; // "gemini" | "openai"
  translationModel: string;
  translationPrompt: string; // instructions for Georgian translation LLM
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

type DigestResult = {
  sent: boolean;
  articleCount: number;
  messageCount: number;
};

// ─── Default system prompt ───────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are a senior intelligence analyst. Deliver a telegraphic daily briefing.

You will receive today's scored article feed. Identify what matters, merge related stories, skip noise.

Output ONLY bullet points. Each bullet is ONE short sentence — what happened and a brief hint at why it matters. End with source [#IDs].

Example:
\u2022 Supreme Court struck down most Trump tariffs — could trigger $175B in refunds and reshape trade policy [#2, #5]

Rules:
- ONE sentence per bullet. Maximum 30 words. No filler, no elaboration.
- End each bullet with source references like [#1] or [#1, #3]
- Merge related articles into one bullet
- 5-15 bullets depending on the day
- Most impactful first
- Write in English`;

export const DEFAULT_TRANSLATION_PROMPT =
  "Translate the following intelligence briefing to Georgian. " +
  "Be concise — do not expand or elaborate, match the original length. " +
  "Keep bullet point structure exactly as-is. " +
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
  };
};

// ─── Core digest compiler ────────────────────────────────────────────────────

export const compileAndSendDigest = async (
  deps: DigestDeps,
  opts: { isTest?: boolean } = {},
): Promise<DigestResult> => {
  const { db, telegramConfig, facebookConfig, linkedinConfig, apiKeys } = deps;
  const isTest = opts.isTest ?? false;

  // 1. Read config
  const config = await readDigestConfig(db);
  if (!config.enabled && !isTest) {
    return { sent: false, articleCount: 0, messageCount: 0 };
  }

  // 2. Validate at least one delivery channel is configured
  //    Telegram: requires explicit digest chat ID — no fallback to default posting channel
  const hasTelegram = config.telegramEnabled && telegramConfig?.botToken && config.telegramChatId;
  const hasFacebook = config.facebookEnabled && facebookConfig;
  const hasLinkedin = config.linkedinEnabled && linkedinConfig;

  if (!hasTelegram && !hasFacebook && !hasLinkedin) {
    logger.warn("[digest] no delivery channels configured, skipping");
    return { sent: false, articleCount: 0, messageCount: 0 };
  }

  // 3. Determine lookback window — always capped at 24h
  const max24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let lookback: Date;
  if (isTest) {
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

  // 4. Query ALL qualifying articles (no limit)
  //    Georgian mode: same article pool as English — translation is post-processing on final output
  const whereConditions = [
    gte(articles.scoredAt, lookback),
    gte(articles.importanceScore, config.minScore),
    inArray(articles.pipelineStage, ["scored", "approved", "posted"]),
  ];

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
    .orderBy(desc(articles.importanceScore), desc(articles.publishedAt));

  // 5. Zero articles guard
  if (allArticles.length === 0) {
    logger.info("[digest] no qualifying articles, skipping");
    return { sent: false, articleCount: 0, messageCount: 0 };
  }

  // 6. Build article index for [#ID]→URL mapping
  const articleMap = new Map<number, DigestArticle>();
  allArticles.forEach((a, i) => articleMap.set(i + 1, a as DigestArticle));

  // 7. Resolve API key for digest provider
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
    } else {
      logger.warn("[digest] LLM call failed, using template-only fallback");
    }
  } else {
    logger.warn({ provider: config.provider }, "[digest] no API key for digest provider");
  }

  // 8. Build raw bullet body (no platform-specific formatting yet)
  let rawBullets: string;
  if (llmBullets) {
    rawBullets = llmBullets;
  } else {
    rawBullets = buildFallbackBulletsPlain(allArticles as DigestArticle[]);
  }

  // 9. Georgian translation of raw bullets (if needed)
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
      if (tr) {
        rawBullets = tr.text;
        translationResult = tr;
      } else {
        logger.warn("[digest] translation failed, sending English");
      }
    } else {
      logger.warn("[digest] no API key for translation provider, sending English");
    }
  }

  // 10. Pipeline stats
  const stats = await queryPipelineStats(db, lookback);
  const dateStr = formatDate(new Date(), config.timezone);

  // 11. Deliver to each enabled platform
  let anySent = false;
  let totalMessages = 0;

  // ── Telegram (HTML formatting) ──
  if (hasTelegram) {
    const bodyHtml = llmBullets
      ? mapRefsToLinks(cleanForTelegram(rawBullets), articleMap)
      : buildFallbackBullets(allArticles as DigestArticle[]);

    const sections: string[] = [
      `<b>\u{1F4CA} What Happened Today \u2014 ${cleanForTelegram(dateStr)}</b>`,
      bodyHtml,
      `<b>\u{1F4C8} Pipeline</b>\n` +
        `Scanned: ${stats.totalIngested} | Scored: ${stats.passedFilters} | ` +
        `Score 4+: ${stats.scoreFourPlus} | In digest: ${allArticles.length}`,
    ];

    const messages = splitTelegramMessages(sections);
    for (const msg of messages) {
      const sent = await sendTelegramAlert(telegramConfig!.botToken, config.telegramChatId, msg);
      if (sent) anySent = true;
      if (messages.length > 1) await new Promise((r) => setTimeout(r, 500));
    }
    totalMessages += messages.length;
    logger.info({ messages: messages.length }, "[digest] telegram sent");
  }

  // ── Facebook (plain text) ──
  if (hasFacebook) {
    try {
      const plainBody = formatPlainDigest(rawBullets, allArticles as DigestArticle[], !!llmBullets);
      const fbText = `\u{1F4CA} What Happened Today \u2014 ${dateStr}\n\n${plainBody}\n\n` +
        `\u{1F4C8} Scanned: ${stats.totalIngested} | Scored: ${stats.passedFilters} | ` +
        `Score 4+: ${stats.scoreFourPlus} | In digest: ${allArticles.length}`;

      const fb = createFacebookProvider(facebookConfig!);
      const result = await fb.post({ text: fbText });
      if (result.success) {
        anySent = true;
        totalMessages++;
        logger.info({ postId: result.postId }, "[digest] facebook sent");
      } else {
        logger.warn({ error: result.error }, "[digest] facebook post failed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, "[digest] facebook delivery failed");
    }
  }

  // ── LinkedIn (plain text) ──
  if (hasLinkedin) {
    try {
      const plainBody = formatPlainDigest(rawBullets, allArticles as DigestArticle[], !!llmBullets);
      const liText = `\u{1F4CA} What Happened Today \u2014 ${dateStr}\n\n${plainBody}\n\n` +
        `\u{1F4C8} Scanned: ${stats.totalIngested} | Scored: ${stats.passedFilters} | ` +
        `Score 4+: ${stats.scoreFourPlus} | In digest: ${allArticles.length}`;

      const li = createLinkedInProvider(linkedinConfig!);
      const result = await li.post({ text: liText });
      if (result.success) {
        anySent = true;
        totalMessages++;
        logger.info({ postId: result.postId }, "[digest] linkedin sent");
      } else {
        logger.warn({ error: result.error }, "[digest] linkedin post failed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, "[digest] linkedin delivery failed");
    }
  }

  // 12. Update last_digest_sent_at (skip for test)
  if (!isTest && anySent) {
    await db
      .insert(appConfig)
      .values({ key: "last_digest_sent_at", value: new Date().toISOString(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
  }

  // 13. Log telemetry
  if (llmResult) {
    const cost = calculateLLMCost(config.provider, config.model, llmResult.inputTokens, llmResult.outputTokens);
    await db.insert(llmTelemetry).values({
      articleId: null,
      operation: "digest_summary",
      provider: config.provider,
      model: config.model,
      isFallback: false,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      totalTokens: llmResult.inputTokens + llmResult.outputTokens,
      costMicrodollars: cost,
      latencyMs: llmResult.latencyMs,
      status: "success",
    });
  }
  if (translationResult) {
    const cost = calculateLLMCost(
      config.translationProvider,
      config.translationModel,
      translationResult.inputTokens,
      translationResult.outputTokens,
    );
    await db.insert(llmTelemetry).values({
      articleId: null,
      operation: "digest_translation",
      provider: config.translationProvider,
      model: config.translationModel,
      isFallback: false,
      inputTokens: translationResult.inputTokens,
      outputTokens: translationResult.outputTokens,
      totalTokens: translationResult.inputTokens + translationResult.outputTokens,
      costMicrodollars: cost,
      latencyMs: translationResult.latencyMs,
      status: "success",
    });
  }

  logger.info(
    {
      articles: allArticles.length,
      totalMessages,
      hasLLM: !!llmBullets,
      translated: !!translationResult,
      telegram: !!hasTelegram,
      facebook: !!hasFacebook,
      linkedin: !!hasLinkedin,
      isTest,
    },
    "[digest] complete",
  );

  return { sent: anySent, articleCount: allArticles.length, messageCount: totalMessages };
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
        max_tokens: 1200,
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

    // OpenAI / DeepSeek (compatible API)
    const client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.provider === "deepseek" ? { baseURL: DEFAULT_BASE_URLS.deepseek } : {}),
    });
    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: 1200,
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

  return lines.join("\n");
};

// ─── [#ID]→URL post-processing ────────────────────────────────────────────────

const mapRefsToLinks = (text: string, articleMap: Map<number, DigestArticle>): string => {
  // Match patterns like [#1], [#1, #3], [#1, #3, #7]
  return text.replace(/\[#(\d+(?:,\s*#\d+)*)\]/g, (match, inner: string) => {
    const ids = inner.split(/,\s*#/).map((s) => parseInt(s.replace("#", ""), 10));
    const links = ids
      .map((id) => {
        const article = articleMap.get(id);
        if (!article) return null;
        return `<a href="${escapeUrl(article.url)}">src</a>`;
      })
      .filter(Boolean);

    return links.length > 0 ? `[${links.join(", ")}]` : match;
  });
};

// ─── Template-only fallback (Telegram HTML) ──────────────────────────────────

const buildFallbackBullets = (allArticles: DigestArticle[]): string => {
  const lines: string[] = [];
  for (const a of allArticles.slice(0, 20)) {
    const title = cleanForTelegram(a.title);
    const link = `<a href="${escapeUrl(a.url)}">${title}</a>`;
    lines.push(`\u2022 Score ${a.importanceScore} \u2014 ${link}`);
  }
  return lines.join("\n");
};

// ─── Template-only fallback (plain text for FB/LinkedIn) ────────────────────

const buildFallbackBulletsPlain = (allArticles: DigestArticle[]): string => {
  const lines: string[] = [];
  for (const a of allArticles.slice(0, 20)) {
    lines.push(`\u2022 Score ${a.importanceScore} \u2014 ${a.title}`);
  }
  return lines.join("\n");
};

// ─── Plain text formatter for Facebook / LinkedIn ────────────────────────────
// Text-only: strip [#ID] source refs entirely — raw URLs clutter social posts

const formatPlainDigest = (
  rawBullets: string,
  allArticles: DigestArticle[],
  hasLLM: boolean,
): string => {
  if (!hasLLM) {
    // Fallback: plain bullet list (no URLs)
    const lines: string[] = [];
    for (const a of allArticles.slice(0, 20)) {
      lines.push(`\u2022 Score ${a.importanceScore} \u2014 ${a.title}`);
    }
    return lines.join("\n");
  }

  // Strip [#ID] refs — clean text only
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
  scoreFourPlus: number;
};

const queryPipelineStats = async (db: Database, lookback: Date): Promise<PipelineStats> => {
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
    .where(and(gte(articles.scoredAt, lookback), gte(articles.importanceScore, 4)));

  return {
    totalIngested: totalRow?.cnt ?? 0,
    passedFilters: scoredRow?.cnt ?? 0,
    scoreFourPlus: highRow?.cnt ?? 0,
  };
};

// ─── Telegram formatting helpers ──────────────────────────────────────────────

const escapeUrl = (url: string): string =>
  url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const formatDate = (date: Date, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
};

// ─── Message splitting ────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 4096;

const splitTelegramMessages = (sections: string[]): string[] => {
  const messages: string[] = [];
  let current = "";

  for (const section of sections) {
    const withSeparator = current ? `\n\n${section}` : section;

    if (current.length + withSeparator.length <= MAX_MESSAGE_LENGTH) {
      current += withSeparator;
    } else {
      if (current) messages.push(current);
      current =
        section.length > MAX_MESSAGE_LENGTH ? section.slice(0, MAX_MESSAGE_LENGTH - 3) + "..." : section;
    }
  }

  if (current) messages.push(current);
  return messages.length > 0 ? messages : [""];
};
