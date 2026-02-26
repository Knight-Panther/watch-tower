import type { Redis } from "ioredis";
import { eq, sql, inArray } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { logger } from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { alertRules, alertDeliveries, appConfig, llmTelemetry } from "@watch-tower/db";
import { calculateTranslationCost } from "@watch-tower/translation";
import { sendTelegramAlert, cleanForTelegram } from "../utils/telegram-alert.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type ScoredArticle = {
  articleId: string;
  title: string;
  llmSummary: string | null;
  url: string;
  sectorName: string | null;
  score: number;
  matchedAlertKeywords: string[];
};

type TelegramConfig = {
  botToken: string;
  defaultChatId: string;
};

type AlertTemplateConfig = {
  showTitle: boolean;
  showUrl: boolean;
  showSummary: boolean;
  showScore: boolean;
  showSector: boolean;
  showKeyword: boolean;
  alertEmoji: string;
};

const DEFAULT_ALERT_TEMPLATE: AlertTemplateConfig = {
  showTitle: true,
  showUrl: true,
  showSummary: true,
  showScore: true,
  showSector: true,
  showKeyword: true,
  alertEmoji: "🔔",
};

const COOLDOWN_TTL_SECONDS = 300; // 5 minutes

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getConfigValue = async (db: Database, key: string): Promise<unknown> => {
  const [row] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key));
  return row?.value ?? null;
};

const getConfigNumber = async (db: Database, key: string, fallback: number): Promise<number> => {
  const val = await getConfigValue(db, key);
  const num = Number(val);
  return Number.isNaN(num) ? fallback : num;
};

const getConfigString = async (db: Database, key: string): Promise<string | null> => {
  const val = await getConfigValue(db, key);
  return typeof val === "string" ? val : null;
};

/**
 * Check if current time falls within quiet hours.
 * Returns true if alerts should be suppressed.
 */
const isQuietHours = async (db: Database): Promise<boolean> => {
  const start = await getConfigString(db, "alert_quiet_start");
  const end = await getConfigString(db, "alert_quiet_end");
  if (!start || !end) return false;

  const tz = (await getConfigString(db, "alert_quiet_timezone"))
    ?? (await getConfigString(db, "digest_timezone"))
    ?? "UTC";

  // Get current time in configured timezone
  const nowStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  const nowMin = toMinutes(nowStr);
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);

  // Handle overnight wrap (e.g., 23:00 – 07:00)
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  return nowMin >= startMin || nowMin < endMin;
};

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Check a batch of just-scored articles against active alert rules.
 * Uses LLM-matched keywords (semantic matching) instead of regex.
 *
 * For each matching rule+article pair:
 *   1. Check mute status
 *   2. Match LLM-flagged keywords against rule keywords
 *   3. Check Redis cooldown (5-min window per rule+article)
 *   4. Send Telegram message with template-based formatting
 *   5. Write audit row to alert_deliveries
 *   6. Track volume and warn if threshold exceeded
 *
 * Called from llm-brain.ts after scoring + event publishing.
 */
export const checkAndFireAlerts = async ({
  db,
  redis,
  telegramConfig,
  articles,
  apiKeys,
}: {
  db: Database;
  redis: Redis;
  telegramConfig: TelegramConfig;
  articles: ScoredArticle[];
  apiKeys?: { googleAi?: string; openai?: string };
}): Promise<void> => {
  if (articles.length === 0) return;

  // Emergency brake
  const emergencyStop = await getConfigValue(db, "emergency_stop");
  if (emergencyStop === true || emergencyStop === "true") {
    logger.warn("[alert] emergency_stop active, skipping all alerts");
    return;
  }

  // Quiet hours check
  try {
    if (await isQuietHours(db)) {
      logger.info("[alert] quiet hours active, skipping all alerts");
      return;
    }
  } catch (err) {
    logger.error("[alert] quiet hours check failed, continuing", err);
  }

  // Fetch all active alert rules once per batch
  const activeRules = await db.select().from(alertRules).where(eq(alertRules.active, true));
  if (activeRules.length === 0) return;

  // Read translation config once per batch (only if any rule uses Georgian)
  const hasKaRules = activeRules.some((r) => r.language === "ka");
  let transProvider = "gemini";
  let transModel = "gemini-2.5-flash";
  let transApiKey: string | undefined;

  if (hasKaRules && apiKeys) {
    const configRows = await db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(
        inArray(appConfig.key, [
          "alert_translation_provider",
          "alert_translation_model",
          "translation_provider",
          "translation_model",
        ]),
      );
    const cfg = new Map(configRows.map((r) => [r.key, r.value as string]));
    transProvider =
      (cfg.get("alert_translation_provider") as string) ??
      (cfg.get("translation_provider") as string) ??
      "gemini";
    transModel =
      (cfg.get("alert_translation_model") as string) ??
      (cfg.get("translation_model") as string) ??
      "gemini-2.5-flash";
    transApiKey =
      transProvider === "gemini" ? apiKeys.googleAi : transProvider === "openai" ? apiKeys.openai : undefined;

    if (!transApiKey) {
      logger.warn(`[alert] no API key for translation provider "${transProvider}", KA alerts will send English`);
    }
  }

  let alertsSent = 0;
  let alertsSkipped = 0;
  // Track sends per chat ID for advisory warning
  const sendsByChat = new Map<string, number>();

  for (const article of articles) {
    // Skip articles with no LLM-matched keywords
    if (article.matchedAlertKeywords.length === 0) continue;

    for (const rule of activeRules) {
      // Score gate (cheapest check first)
      if (article.score < rule.minScore) continue;

      // Mute check
      if (rule.muteUntil && new Date(rule.muteUntil) > new Date()) continue;

      // Find first keyword that both: LLM flagged AND rule contains
      const matchedKeyword = rule.keywords.find((kw) =>
        article.matchedAlertKeywords.some(
          (mk) => mk.toLowerCase() === kw.toLowerCase(),
        ),
      );
      if (!matchedKeyword) continue;

      // Redis cooldown — keyed on rule+article to prevent duplicate alerts
      const cooldownKey = `alert:cooldown:${rule.id}:${article.articleId}`;
      const alreadyCooling = (await redis.exists(cooldownKey)) > 0;

      if (alreadyCooling) {
        await db.execute(sql`
          INSERT INTO alert_deliveries (rule_id, article_id, matched_keyword, status)
          VALUES (${rule.id}::uuid, ${article.articleId}::uuid, ${matchedKeyword}, 'skipped')
          ON CONFLICT (rule_id, article_id) DO NOTHING
        `);
        alertsSkipped++;
        continue;
      }

      // Format with template
      const template = mergeTemplate(rule.template as Partial<AlertTemplateConfig> | null);
      let message = formatAlertMessage(rule.name, matchedKeyword, article, template);
      const targetChatId = rule.telegramChatId || telegramConfig.defaultChatId;

      // Translate to Georgian if rule is set to 'ka'
      if (rule.language === "ka" && transApiKey) {
        const tr = await translateAlertText(db, transProvider, transApiKey, transModel, message);
        if (tr) {
          message = tr.text;
        } else {
          logger.warn({ ruleId: rule.id }, "[alert] translation failed, sending English fallback");
        }
      }

      const result = await sendTelegramAlert(telegramConfig.botToken, targetChatId, message);

      // Set cooldown after send attempt
      await redis.set(cooldownKey, "1", "EX", COOLDOWN_TTL_SECONDS);

      // Write audit row
      const status = result.ok ? "sent" : "failed";
      await db.execute(sql`
        INSERT INTO alert_deliveries (rule_id, article_id, matched_keyword, status, error_message)
        VALUES (
          ${rule.id}::uuid,
          ${article.articleId}::uuid,
          ${matchedKeyword},
          ${status},
          ${result.ok ? null : result.error ?? "Unknown error"}
        )
        ON CONFLICT (rule_id, article_id) DO NOTHING
      `);

      if (result.ok) {
        alertsSent++;
        sendsByChat.set(targetChatId, (sendsByChat.get(targetChatId) ?? 0) + 1);
      }

      logger.info(
        { ruleId: rule.id, articleId: article.articleId, keyword: matchedKeyword, sent: result.ok },
        "[alert] alert fired",
      );
    }
  }

  // Advisory warning: check if any chat ID exceeded the hourly threshold
  if (alertsSent > 0) {
    try {
      const threshold = await getConfigNumber(db, "alert_warning_threshold", 30);
      for (const [chatId, batchCount] of sendsByChat) {
        // Increment hourly volume counter
        const volumeKey = `alert_volume:${chatId}`;
        const totalCount = await redis.incrby(volumeKey, batchCount);
        // Set 1hr expiry only on first increment (when key is new)
        if (totalCount === batchCount) {
          await redis.expire(volumeKey, 3600);
        }

        if (totalCount > threshold) {
          // Only warn once per hour per chat
          const warnedKey = `alert_warned:${chatId}`;
          const alreadyWarned = (await redis.exists(warnedKey)) > 0;
          if (!alreadyWarned) {
            const warnMsg =
              `<b>⚠️ High alert volume</b>\n` +
              `${totalCount} alerts in the last hour for this chat.\n` +
              `Consider using more specific keywords to reduce noise.`;
            await sendTelegramAlert(telegramConfig.botToken, chatId, warnMsg);
            await redis.set(warnedKey, "1", "EX", 3600);
            logger.warn({ chatId, count: totalCount, threshold }, "[alert] high volume warning sent");
          }
        }
      }
    } catch (err) {
      logger.error("[alert] advisory warning check failed", err);
    }
  }

  if (alertsSent > 0 || alertsSkipped > 0) {
    logger.info({ sent: alertsSent, skipped: alertsSkipped }, "[alert] batch complete");
  }
};

// ─── Translation ─────────────────────────────────────────────────────────────

const ALERT_TRANSLATION_PROMPT =
  "Translate the following Telegram alert message to Georgian. " +
  "Keep ALL HTML tags (<b>, <a href>, <code>, etc.) completely unchanged. " +
  "Keep URLs, numbers, and emoji unchanged. " +
  "Keep proper nouns (company names, person names) in their original form. " +
  "Only translate the human-readable text. Output the translation only.";

type TranslationResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

const translateAlertText = async (
  db: Database,
  provider: string,
  apiKey: string,
  model: string,
  htmlMessage: string,
): Promise<TranslationResult | null> => {
  const startTime = Date.now();

  try {
    let text: string;
    let inputTokens = 0;
    let outputTokens = 0;

    if (provider === "gemini") {
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({
        model,
        systemInstruction: ALERT_TRANSLATION_PROMPT,
        generationConfig: { maxOutputTokens: 2048 },
      });
      const result = await genModel.generateContent(htmlMessage);
      const response = result.response;
      text = response.text();
      const usage = response.usageMetadata;
      inputTokens = usage?.promptTokenCount ?? 0;
      outputTokens = usage?.candidatesTokenCount ?? 0;
    } else {
      // OpenAI
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model,
        max_tokens: 2048,
        temperature: 0.2,
        messages: [
          { role: "system", content: ALERT_TRANSLATION_PROMPT },
          { role: "user", content: htmlMessage },
        ],
      });
      text = response.choices[0]?.message?.content ?? htmlMessage;
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
    }

    const latencyMs = Date.now() - startTime;

    // Log telemetry
    try {
      const costMicro = calculateTranslationCost(model, inputTokens, outputTokens);
      await db.insert(llmTelemetry).values({
        operation: "alert_translation",
        provider,
        model,
        inputTokens,
        outputTokens,
        costMicrodollars: costMicro,
        latencyMs,
        status: "success",
      });
    } catch (telErr) {
      logger.warn("[alert] telemetry insert failed", telErr);
    }

    return { text, inputTokens, outputTokens, latencyMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, provider }, "[alert] translation failed");
    return null;
  }
};

// ─── Template ────────────────────────────────────────────────────────────────

const mergeTemplate = (partial: Partial<AlertTemplateConfig> | null): AlertTemplateConfig => ({
  ...DEFAULT_ALERT_TEMPLATE,
  ...(partial ?? {}),
});

const formatAlertMessage = (
  ruleName: string,
  keyword: string,
  article: ScoredArticle,
  template: AlertTemplateConfig,
): string => {
  const scoreLabels = ["", "Low", "Low", "Medium", "High", "Critical"];
  const scoreLabel = scoreLabels[article.score] ?? "Unknown";

  const lines: string[] = [
    `<b>${template.alertEmoji} Alert: ${cleanForTelegram(ruleName)}</b>`,
  ];

  // Meta line: optional keyword + optional score + optional sector
  const metaParts: string[] = [];
  if (template.showKeyword) {
    metaParts.push(`Keyword: <code>${cleanForTelegram(keyword)}</code>`);
  }
  if (template.showScore) {
    metaParts.push(`Score: ${article.score}/5 (${scoreLabel})`);
  }
  if (template.showSector && article.sectorName) {
    metaParts.push(`Sector: ${cleanForTelegram(article.sectorName)}`);
  }
  if (metaParts.length > 0) {
    lines.push(metaParts.join(" | "));
  }

  lines.push(""); // blank line
  if (template.showTitle) {
    lines.push(`<b>${cleanForTelegram(article.title)}</b>`);
  }

  if (template.showSummary && article.llmSummary) {
    lines.push(cleanForTelegram(article.llmSummary));
  }

  if (template.showUrl && article.url) {
    lines.push(`\n<a href="${article.url}">Read more →</a>`);
  }

  return lines.join("\n");
};
