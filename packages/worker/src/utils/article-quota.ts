import { eq, and, gte, sql } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { articles, rssSources } from "@watch-tower/db";
import { securityEnvSchema, logger } from "@watch-tower/shared";

const securityEnv = securityEnvSchema.parse(process.env);

export type QuotaResult = {
  allowed: number; // How many articles can be inserted
  perFetchLimit: number; // Per-fetch limit used
  dailyLimit: number; // Daily limit used
  dailyUsed: number; // Already used today
  dailyRemaining: number; // Remaining daily quota
};

/**
 * Calculate how many articles can be inserted for a source.
 * Respects both per-fetch and daily limits.
 * Uses source-specific overrides if set, otherwise global defaults.
 */
export const checkArticleQuota = async (db: Database, sourceId: string): Promise<QuotaResult> => {
  // Get source-specific overrides
  const [source] = await db
    .select({
      maxArticlesPerFetch: rssSources.maxArticlesPerFetch,
      maxArticlesPerDay: rssSources.maxArticlesPerDay,
    })
    .from(rssSources)
    .where(eq(rssSources.id, sourceId));

  // Use source override or global default
  const perFetchLimit = source?.maxArticlesPerFetch ?? securityEnv.MAX_ARTICLES_PER_FETCH;
  const dailyLimit = source?.maxArticlesPerDay ?? securityEnv.MAX_ARTICLES_PER_SOURCE_DAILY;

  // Count articles added today for this source
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [{ count: dailyUsed }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articles)
    .where(and(eq(articles.sourceId, sourceId), gte(articles.createdAt, todayStart)));

  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);

  // Allowed = minimum of per-fetch limit and daily remaining
  const allowed = Math.min(perFetchLimit, dailyRemaining);

  logger.debug(
    { sourceId, perFetchLimit, dailyLimit, dailyUsed, dailyRemaining, allowed },
    "[quota] article quota calculated",
  );

  return {
    allowed,
    perFetchLimit,
    dailyLimit,
    dailyUsed,
    dailyRemaining,
  };
};
