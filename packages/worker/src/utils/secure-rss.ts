import Parser from "rss-parser";
import { logger } from "@watch-tower/shared";

export type SecureFetchResult = {
  success: boolean;
  feed?: Parser.Output<Parser.Item>;
  error?: string;
  truncated?: boolean;
};

/**
 * Fetch RSS feed with security protections:
 * - Size limit via Content-Length check (Layer 3)
 * - XXE protection via rss-parser's xml2js config (Layer 4)
 * - Timeout protection
 */
export const fetchFeedSecurely = async (
  url: string,
  options: {
    maxSizeBytes: number;
    timeoutMs: number;
  },
): Promise<SecureFetchResult> => {
  const { maxSizeBytes, timeoutMs } = options;

  // Create parser with XXE protection
  // rss-parser uses xml2js internally which is safe by default (no external entities)
  const parser = new Parser({
    timeout: timeoutMs,
    maxRedirects: 5,
    headers: {
      "User-Agent": "WatchTower/1.0 RSS Reader",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    customFields: {
      item: [],
    },
  });

  try {
    // First, do a HEAD request to check content-length
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headResponse = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const contentLength = headResponse.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
        const sizeMb = Math.round(parseInt(contentLength, 10) / 1024 / 1024);
        const limitMb = Math.round(maxSizeBytes / 1024 / 1024);
        logger.warn({ url, contentLength, maxSizeBytes }, "[secure-rss] feed too large (HEAD check)");
        return {
          success: false,
          error: `Feed size (${sizeMb}MB) exceeds limit (${limitMb}MB)`,
        };
      }
    } catch {
      // HEAD failed - continue with GET (some servers don't support HEAD)
      clearTimeout(timeoutId);
    }

    // Fetch and parse with rss-parser
    // Note: rss-parser doesn't support streaming/size limits during fetch,
    // but the HEAD check above catches most cases
    const feed = await parser.parseURL(url);

    return { success: true, feed };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";

    if (error.includes("aborted") || error.includes("timeout")) {
      return { success: false, error: `Request timeout after ${timeoutMs}ms` };
    }

    return { success: false, error };
  }
};
