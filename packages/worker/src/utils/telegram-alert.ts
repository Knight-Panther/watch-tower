import { logger } from "@watch-tower/shared";

const DEFAULT_TIMEOUT_MS = 15_000;
const BOT_TOKEN_REGEX = /\d+:[A-Za-z0-9_-]{35,}/g;
const sanitizeError = (s: string) => s.replace(BOT_TOKEN_REGEX, "***:***REDACTED***");

/**
 * Send a plain-text Telegram message directly to a chat.
 * Used for alert notifications — bypasses the SocialProvider abstraction
 * because alerts are not "posts" and don't need templates, rate limits, or health checks.
 *
 * Returns true on success, false on failure (failure is logged but not thrown).
 */
/** Decode common HTML entities from RSS feeds, then escape for Telegram HTML */
export const cleanForTelegram = (text: string): string =>
  text
    // Decode numeric entities: &#8217; → ', &#8211; → –, etc.
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    // Decode named entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Now escape for Telegram HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const sendTelegramAlert = async (
  botToken: string,
  chatId: string,
  text: string,
): Promise<boolean> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    );

    const data = (await response.json()) as { ok: boolean; description?: string };

    if (!data.ok) {
      logger.warn(
        { chatId, error: sanitizeError(data.description ?? "Unknown error"), textLen: text.length },
        "[alert] telegram send failed",
      );
      return false;
    }

    return true;
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
          : sanitizeError(err.message)
        : "Unknown error";
    logger.warn({ chatId, error: msg }, "[alert] telegram send error");
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
};
