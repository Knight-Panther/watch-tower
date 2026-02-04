import { eq, sql } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { allowedDomains } from "@watch-tower/db";
import { logger } from "@watch-tower/shared";

/**
 * Extract root domain from URL.
 * "https://feeds.bbci.co.uk/news" → "bbci.co.uk"
 * "https://www.reuters.com/rss" → "reuters.com"
 */
export const extractRootDomain = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const parts = hostname.split(".");

    // Common two-part TLDs that need special handling
    const twoPartTlds = new Set([
      "co.uk",
      "com.au",
      "co.nz",
      "co.jp",
      "com.br",
      "co.in",
      "org.uk",
      "net.au",
    ]);

    // Check if last two parts form a known two-part TLD
    if (parts.length >= 3) {
      const lastTwo = parts.slice(-2).join(".");
      if (twoPartTlds.has(lastTwo)) {
        return parts.slice(-3).join(".");
      }
    }

    // Standard case: return last 2 parts
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }

    return hostname;
  } catch {
    return null;
  }
};

export type DomainCheckResult = {
  allowed: boolean;
  domain: string | null;
  reason?: string;
  whitelistEmpty?: boolean;
};

/**
 * Check if URL's domain is in the whitelist.
 * Returns detailed result for proper error messaging in UI.
 */
export const isDomainAllowed = async (
  db: Database,
  url: string,
): Promise<DomainCheckResult> => {
  const domain = extractRootDomain(url);

  if (!domain) {
    return { allowed: false, domain: null, reason: "Invalid URL format" };
  }

  // First check if whitelist has ANY active domains
  const [{ count: whitelistCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(allowedDomains)
    .where(eq(allowedDomains.isActive, true));

  if (whitelistCount === 0) {
    logger.warn({ domain, url }, "[whitelist] whitelist is empty - blocking all domains");
    return {
      allowed: false,
      domain,
      reason: "Whitelist is empty - add domains to Site Rules to enable ingestion",
      whitelistEmpty: true,
    };
  }

  // Check if this specific domain is whitelisted
  const [found] = await db
    .select()
    .from(allowedDomains)
    .where(eq(allowedDomains.domain, domain))
    .limit(1);

  if (!found) {
    logger.debug({ domain, url }, "[whitelist] domain not in whitelist");
    return {
      allowed: false,
      domain,
      reason: `Domain "${domain}" not in whitelist`,
    };
  }

  if (!found.isActive) {
    return {
      allowed: false,
      domain,
      reason: `Domain "${domain}" is disabled in whitelist`,
    };
  }

  return { allowed: true, domain };
};
