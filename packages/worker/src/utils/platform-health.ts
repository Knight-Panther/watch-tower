import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { platformHealth } from "@watch-tower/db";
import type { HealthCheckResult } from "@watch-tower/social";

const LINKEDIN_TOKEN_LIFETIME_DAYS = 60;

/**
 * Compute SHA256 hash of access token for rotation detection
 */
export const hashToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};

/**
 * Upsert platform health record.
 * Handles LinkedIn token rotation via hash comparison.
 */
export const upsertPlatformHealth = async (
  db: Database,
  result: HealthCheckResult,
  currentTokenHash?: string, // Pass hash if available (LinkedIn)
): Promise<void> => {
  const existing = await db.query.platformHealth.findFirst({
    where: eq(platformHealth.platform, result.platform),
  });

  let tokenExpiresAt = result.tokenExpiresAt ?? null;
  let tokenFirstSeenAt = existing?.tokenFirstSeenAt ?? null;
  let tokenHash = currentTokenHash ?? existing?.tokenHash ?? null;

  // LinkedIn: calculate expiry from firstSeenAt, detect token rotation
  if (result.platform === "linkedin" && result.healthy) {
    const tokenChanged =
      currentTokenHash && existing?.tokenHash && currentTokenHash !== existing.tokenHash;

    if (!tokenFirstSeenAt || tokenChanged) {
      // First time seeing this token OR token was rotated - reset timer
      tokenFirstSeenAt = new Date();
      tokenHash = currentTokenHash ?? null;
    }

    // Calculate 60 days from first seen
    tokenExpiresAt = new Date(
      tokenFirstSeenAt.getTime() + LINKEDIN_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    );
  }

  const data = {
    platform: result.platform,
    healthy: result.healthy,
    error: result.error ?? null,
    tokenExpiresAt: tokenExpiresAt,
    tokenFirstSeenAt: tokenFirstSeenAt,
    tokenHash: tokenHash,
    rateLimitRemaining: result.rateLimit?.remaining ?? null,
    rateLimitMax: result.rateLimit?.limit ?? null,
    rateLimitPercent: result.rateLimit?.percent ?? null,
    rateLimitResetsAt: result.rateLimit?.resetsAt ?? null,
    lastCheckAt: result.checkedAt,
    updatedAt: new Date(),
  };

  await db
    .insert(platformHealth)
    .values({ ...data, createdAt: new Date() })
    .onConflictDoUpdate({
      target: platformHealth.platform,
      set: data,
    });
};

/**
 * Update lastPostAt timestamp after successful post.
 * Also marks platform as healthy (successful post = working).
 */
export const updateLastPostAt = async (db: Database, platform: string): Promise<void> => {
  await db
    .update(platformHealth)
    .set({
      lastPostAt: new Date(),
      healthy: true, // Successful post proves platform works
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(platformHealth.platform, platform));
};

/**
 * Check if platform is healthy before posting.
 * Returns true if healthy or no health record exists.
 */
export const isPlatformHealthy = async (db: Database, platform: string): Promise<boolean> => {
  const health = await db.query.platformHealth.findFirst({
    where: eq(platformHealth.platform, platform),
  });

  // No record = assume healthy (first run)
  if (!health) return true;

  return health.healthy;
};
