import type { Redis } from "ioredis";
import { eq, sql } from "drizzle-orm";
import { logger } from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { alertRules, alertDeliveries } from "@watch-tower/db";
import { sendTelegramAlert, cleanForTelegram } from "../utils/telegram-alert.js";
import { matchesKeyword } from "./llm-brain.js";

type ScoredArticle = {
  articleId: string;
  title: string;
  llmSummary: string | null;
  articleCategories: string[] | null;
  score: number;
};

type TelegramConfig = {
  botToken: string;
  defaultChatId: string;
};

const COOLDOWN_TTL_SECONDS = 300; // 5 minutes

/**
 * Check a batch of just-scored articles against active alert rules.
 * For each matching rule+article pair:
 *   1. Check Redis cooldown (5-min window per rule+keyword)
 *   2. Send Telegram message to configured chat
 *   3. Write audit row to alert_deliveries (ON CONFLICT DO NOTHING)
 *
 * Called from llm-brain.ts after scoring + event publishing.
 */
export const checkAndFireAlerts = async ({
  db,
  redis,
  telegramConfig,
  articles,
}: {
  db: Database;
  redis: Redis;
  telegramConfig: TelegramConfig;
  articles: ScoredArticle[];
}): Promise<void> => {
  if (articles.length === 0) return;

  // Fetch all active alert rules once per batch
  const activeRules = await db.select().from(alertRules).where(eq(alertRules.active, true));

  if (activeRules.length === 0) return;

  let alertsSent = 0;
  let alertsSkipped = 0;

  for (const article of articles) {
    for (const rule of activeRules) {
      // Skip if article score is below rule's minimum
      if (article.score < rule.minScore) continue;

      // Check each keyword against title + summary + categories
      let matchedKeywordValue: string | null = null;
      for (const kw of rule.keywords) {
        if (
          matchesKeyword(article.title, kw) ||
          (article.llmSummary && matchesKeyword(article.llmSummary, kw)) ||
          (article.articleCategories ?? []).some((cat) => matchesKeyword(cat, kw))
        ) {
          matchedKeywordValue = kw;
          break;
        }
      }

      if (!matchedKeywordValue) continue;

      // Redis cooldown check — prevents alert storm within 5-minute window
      const cooldownKey = `alert:cooldown:${rule.id}:${matchedKeywordValue}`;
      const alreadyCooling = (await redis.exists(cooldownKey)) > 0;

      if (alreadyCooling) {
        // Write skipped row for audit trail
        await db.execute(sql`
          INSERT INTO alert_deliveries (rule_id, article_id, matched_keyword, status)
          VALUES (${rule.id}::uuid, ${article.articleId}::uuid, ${matchedKeywordValue}, 'skipped')
          ON CONFLICT (rule_id, article_id) DO NOTHING
        `);
        alertsSkipped++;
        continue;
      }

      // Format and send
      const message = formatAlertMessage(rule.name, matchedKeywordValue, article);
      const targetChatId = rule.telegramChatId || telegramConfig.defaultChatId;
      const sent = await sendTelegramAlert(telegramConfig.botToken, targetChatId, message);

      // Set cooldown after send attempt
      await redis.set(cooldownKey, "1", "EX", COOLDOWN_TTL_SECONDS);

      // Write audit row
      const status = sent ? "sent" : "failed";
      await db.execute(sql`
        INSERT INTO alert_deliveries (rule_id, article_id, matched_keyword, status, error_message)
        VALUES (
          ${rule.id}::uuid,
          ${article.articleId}::uuid,
          ${matchedKeywordValue},
          ${status},
          ${sent ? null : "Telegram send failed (see worker logs)"}
        )
        ON CONFLICT (rule_id, article_id) DO NOTHING
      `);

      if (sent) alertsSent++;

      logger.info(
        { ruleId: rule.id, articleId: article.articleId, keyword: matchedKeywordValue, sent },
        "[alert] alert fired",
      );
    }
  }

  if (alertsSent > 0 || alertsSkipped > 0) {
    logger.info({ sent: alertsSent, skipped: alertsSkipped }, "[alert] batch complete");
  }
};

const formatAlertMessage = (
  ruleName: string,
  keyword: string,
  article: ScoredArticle,
): string => {
  const scoreLabels = ["", "Low", "Low", "Medium", "High", "Critical"];
  const scoreLabel = scoreLabels[article.score] ?? "Unknown";
  const lines = [
    `<b>🔔 Alert: ${cleanForTelegram(ruleName)}</b>`,
    `Keyword: <code>${cleanForTelegram(keyword)}</code> | Score: ${article.score}/5 (${scoreLabel})`,
    ``,
    `<b>${cleanForTelegram(article.title)}</b>`,
  ];
  if (article.llmSummary) {
    lines.push(cleanForTelegram(article.llmSummary));
  }
  return lines.join("\n");
};

