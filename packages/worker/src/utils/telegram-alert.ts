import { logger } from "@watch-tower/shared";

const DEFAULT_TIMEOUT_MS = 15_000;
const BOT_TOKEN_REGEX = /\d+:[A-Za-z0-9_-]{35,}/g;
const sanitizeError = (s: string) => s.replace(BOT_TOKEN_REGEX, "***:***REDACTED***");

export type TelegramSendResult = { ok: boolean; error?: string };

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

/**
 * Send a photo to a Telegram chat via multipart/form-data (direct buffer upload).
 * Used for digest cover images — no public URL needed.
 */
export const sendTelegramPhoto = async (
  botToken: string,
  chatId: string,
  imageBuffer: Buffer,
  filename = "digest-cover.webp",
): Promise<TelegramSendResult> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", new Blob([new Uint8Array(imageBuffer)], { type: "image/webp" }), filename);

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendPhoto`,
      { method: "POST", body: form, signal: controller.signal },
    );

    const data = (await response.json()) as { ok: boolean; description?: string };

    if (!data.ok) {
      const error = sanitizeError(data.description ?? "Unknown error");
      logger.warn({ chatId, error }, "[alert] telegram sendPhoto failed");
      return { ok: false, error };
    }

    return { ok: true };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
          : sanitizeError(err.message)
        : "Unknown error";
    logger.warn({ chatId, error }, "[alert] telegram sendPhoto error");
    return { ok: false, error };
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Send a plain-text Telegram message directly to a chat.
 * Used for alert notifications — bypasses the SocialProvider abstraction
 * because alerts are not "posts" and don't need templates, rate limits, or health checks.
 */
export const sendTelegramAlert = async (
  botToken: string,
  chatId: string,
  text: string,
): Promise<TelegramSendResult> => {
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
      const error = sanitizeError(data.description ?? "Unknown error");
      logger.warn(
        { chatId, error, textLen: text.length },
        "[alert] telegram send failed",
      );
      return { ok: false, error };
    }

    return { ok: true };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
          : sanitizeError(err.message)
        : "Unknown error";
    logger.warn({ chatId, error }, "[alert] telegram send error");
    return { ok: false, error };
  } finally {
    clearTimeout(timeoutId);
  }
};
