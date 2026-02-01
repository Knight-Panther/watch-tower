import { logger } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type TelegramConfig = {
  botToken: string;
  defaultChatId: string;
  timeoutMs?: number; // Default 30000ms
};

// Default timeout for Telegram API calls
const DEFAULT_TIMEOUT_MS = 30_000;

// Regex to match bot tokens in error messages (format: 123456789:ABCdefGHI...)
const BOT_TOKEN_REGEX = /\d+:[A-Za-z0-9_-]{35,}/g;

/**
 * Sanitize error messages to remove any accidentally leaked bot tokens
 */
const sanitizeError = (error: string): string => {
  return error.replace(BOT_TOKEN_REGEX, "***:***REDACTED***");
};

/**
 * Make a fetch request with timeout using AbortController
 */
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const createTelegramProvider = (config: TelegramConfig): SocialProvider => {
  const baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "telegram",

    async post(request: PostRequest): Promise<PostResult> {
      const chatId = config.defaultChatId;

      try {
        if (request.imageUrl) {
          // Send photo with caption
          const response = await fetchWithTimeout(
            `${baseUrl}/sendPhoto`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                photo: request.imageUrl,
                caption: request.text,
                parse_mode: "HTML",
              }),
            },
            timeoutMs,
          );

          const data = (await response.json()) as {
            ok: boolean;
            description?: string;
            result?: { message_id: number };
          };

          if (!data.ok) {
            const sanitizedDesc = sanitizeError(data.description || "Unknown error");
            logger.error({ error: sanitizedDesc }, "[telegram] sendPhoto failed");
            return {
              platform: "telegram",
              postId: "",
              success: false,
              error: sanitizedDesc,
            };
          }

          logger.info({ messageId: data.result?.message_id }, "[telegram] photo sent");
          return {
            platform: "telegram",
            postId: String(data.result?.message_id),
            success: true,
          };
        } else {
          // Send text message
          const response = await fetchWithTimeout(
            `${baseUrl}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: request.text,
                parse_mode: "HTML",
                disable_web_page_preview: false,
              }),
            },
            timeoutMs,
          );

          const data = (await response.json()) as {
            ok: boolean;
            description?: string;
            result?: { message_id: number };
          };

          if (!data.ok) {
            const sanitizedDesc = sanitizeError(data.description || "Unknown error");
            logger.error({ error: sanitizedDesc }, "[telegram] sendMessage failed");
            return {
              platform: "telegram",
              postId: "",
              success: false,
              error: sanitizedDesc,
            };
          }

          logger.info({ messageId: data.result?.message_id }, "[telegram] message sent");
          return {
            platform: "telegram",
            postId: String(data.result?.message_id),
            success: true,
          };
        }
      } catch (err) {
        let error: string;
        if (err instanceof Error) {
          if (err.name === "AbortError") {
            error = `Request timeout after ${timeoutMs}ms`;
          } else {
            error = sanitizeError(err.message);
          }
        } else {
          error = "Unknown error";
        }

        logger.error({ error }, "[telegram] post failed");
        return {
          platform: "telegram",
          postId: "",
          success: false,
          error,
        };
      }
    },

    formatSinglePost(article: ArticleForPost): string {
      return `<b>🔴 BREAKING: ${escapeHtml(article.sector.toUpperCase())}</b>

<b>${escapeHtml(article.title)}</b>

${escapeHtml(article.summary)}

<a href="${escapeUrl(article.url)}">Read more →</a>`;
    },

    formatDigestPost(articles: ArticleForPost[], sector: string): string {
      const items = articles
        .map(
          (a, i) =>
            `${i + 1}. <a href="${escapeUrl(a.url)}">${escapeHtml(a.title)}</a>\n   ${escapeHtml(truncate(a.summary, 100))}`,
        )
        .join("\n\n");

      return `<b>📰 ${escapeHtml(sector.toUpperCase())} DIGEST</b>

${items}`;
    },
  };
};

// Helper to escape HTML special chars for Telegram HTML mode
const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

// Helper to escape URLs for use in href attributes
const escapeUrl = (url: string): string => {
  // Basic URL validation - must start with http:// or https://
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "#invalid-url";
  }
  // Escape quotes and angle brackets that could break HTML
  return url.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
};

// Helper to truncate text
const truncate = (text: string, maxLen: number): string => {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
};
