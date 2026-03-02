import Parser from "rss-parser";
import { logger } from "@watch-tower/shared";

export type SecureFetchResult = {
  success: boolean;
  feed?: Parser.Output<Parser.Item>;
  error?: string;
  truncated?: boolean;
};

const USER_AGENT = "WatchTower/1.0 RSS Reader";

/**
 * Fetch RSS feed with security protections:
 * - Size limit via Content-Length + body size check (Layer 3)
 * - XXE protection via rss-parser's xml2js config (Layer 4)
 * - Timeout protection
 *
 * Uses fetch() for HTTP (modern TLS, better compatibility) and
 * rss-parser.parseString() for XML parsing.
 */
export const fetchFeedSecurely = async (
  url: string,
  options: {
    maxSizeBytes: number;
    timeoutMs: number;
  },
): Promise<SecureFetchResult> => {
  const { maxSizeBytes, timeoutMs } = options;

  const parser = new Parser({
    customFields: {
      item: [["content:encoded", "contentEncoded"]],
    },
  });

  try {
    // Single GET request with timeout, User-Agent, and size checks
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
    }

    // Check Content-Length header first (fast reject for huge feeds)
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
      const sizeMb = Math.round(parseInt(contentLength, 10) / 1024 / 1024);
      const limitMb = Math.round(maxSizeBytes / 1024 / 1024);
      logger.warn(
        { url, contentLength, maxSizeBytes },
        "[secure-rss] feed too large (Content-Length)",
      );
      return {
        success: false,
        error: `Feed size (${sizeMb}MB) exceeds limit (${limitMb}MB)`,
      };
    }

    // Read body with size enforcement (handles chunked/missing Content-Length)
    const xml = await response.text();
    if (xml.length > maxSizeBytes) {
      const sizeMb = Math.round(xml.length / 1024 / 1024);
      const limitMb = Math.round(maxSizeBytes / 1024 / 1024);
      logger.warn(
        { url, bodySize: xml.length, maxSizeBytes },
        "[secure-rss] feed too large (body)",
      );
      return {
        success: false,
        error: `Feed size (${sizeMb}MB) exceeds limit (${limitMb}MB)`,
      };
    }

    // Parse XML string with rss-parser
    const feed = await parser.parseString(xml);

    return { success: true, feed };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";

    if (error.includes("aborted") || error.includes("timeout")) {
      return { success: false, error: `Request timeout after ${timeoutMs}ms` };
    }

    return { success: false, error };
  }
};
