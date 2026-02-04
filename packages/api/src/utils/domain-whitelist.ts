import { eq } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { allowedDomains } from "@watch-tower/db";
import { logger } from "@watch-tower/shared";

/**
 * Extract root domain from URL.
 * "https://feeds.reuters.com/news" → "reuters.com"
 * "https://feeds.bbci.co.uk/tech" → "bbc.co.uk"
 *
 * Handles common TLDs like .co.uk, .com.au, etc.
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
        // Return last 3 parts (e.g., "bbc.co.uk")
        return parts.slice(-3).join(".");
      }
    }

    // Standard case: return last 2 parts (e.g., "reuters.com")
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
};

/**
 * Check if URL's domain is in the whitelist.
 */
export const isDomainAllowed = async (
  db: Database,
  url: string,
): Promise<DomainCheckResult> => {
  const domain = extractRootDomain(url);

  if (!domain) {
    return { allowed: false, domain: null, reason: "Invalid URL format" };
  }

  const [found] = await db
    .select()
    .from(allowedDomains)
    .where(eq(allowedDomains.domain, domain))
    .limit(1);

  if (!found) {
    logger.debug({ domain, url }, "[whitelist] domain not in whitelist");
    return { allowed: false, domain, reason: `Domain "${domain}" not in whitelist` };
  }

  if (!found.isActive) {
    return { allowed: false, domain, reason: `Domain "${domain}" is disabled` };
  }

  return { allowed: true, domain };
};
