import { fetchFeedSecurely } from "@watch-tower/rss";

export type FeedVerifyResult =
  | {
      ok: true;
      title: string | null;
      itemCount: number;
      mostRecentDate: string | null;
      staleDays: number | null;
      warnings: string[];
    }
  | { ok: false; error: string; errorKind: "timeout" | "http" | "parse" | "empty" | "unknown" };

const VERIFY_TIMEOUT_MS = 8_000;
const VERIFY_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const STALE_THRESHOLD_DAYS = 7;

/**
 * Verify an RSS feed URL by fetching and parsing it.
 * Returns feed metadata on success, or a categorized error on failure.
 */
export const verifyFeedUrl = async (url: string): Promise<FeedVerifyResult> => {
  const result = await fetchFeedSecurely(url, {
    maxSizeBytes: VERIFY_MAX_SIZE_BYTES,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });

  if (!result.success) {
    const err = result.error ?? "Unknown error";
    const errorKind = classifyError(err);
    return { ok: false, error: err, errorKind };
  }

  const feed = result.feed!;
  const items = feed.items ?? [];

  if (items.length === 0) {
    return { ok: false, error: "Feed returned 0 items", errorKind: "empty" };
  }

  // Find most recent article date
  let mostRecentDate: string | null = null;
  for (const item of items) {
    const dateStr = item.isoDate ?? item.pubDate ?? null;
    if (dateStr) {
      if (!mostRecentDate || new Date(dateStr) > new Date(mostRecentDate)) {
        mostRecentDate = dateStr;
      }
    }
  }

  // Build warnings
  const warnings: string[] = [];
  let staleDays: number | null = null;

  if (mostRecentDate) {
    staleDays = Math.floor((Date.now() - new Date(mostRecentDate).getTime()) / 86_400_000);
    if (staleDays >= STALE_THRESHOLD_DAYS) {
      warnings.push(`Latest article is ${staleDays} days old — feed may be abandoned`);
    }
  } else {
    warnings.push("No article dates found — cannot determine freshness");
  }

  if (items.length < 3) {
    warnings.push(`Only ${items.length} item(s) — unusually small feed`);
  }

  return {
    ok: true,
    title: feed.title ?? null,
    itemCount: items.length,
    mostRecentDate,
    staleDays,
    warnings,
  };
};

const classifyError = (error: string): "timeout" | "http" | "parse" | "unknown" => {
  if (error.includes("timeout") || error.includes("aborted")) return "timeout";
  if (error.includes("404") || error.includes("403") || error.includes("status")) return "http";
  if (error.includes("XML") || error.includes("parse") || error.includes("Invalid")) return "parse";
  return "unknown";
};
