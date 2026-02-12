import type { Redis } from "ioredis";

export type RateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterMs?: number;
};

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Tracks timestamps of recent posts and checks against limit.
 */
export const createRateLimiter = (redis: Redis) => {
  return {
    /**
     * Check if posting is allowed and record the attempt if so.
     * @param platform - Platform name (telegram, facebook, linkedin)
     * @param limitPerHour - Max posts allowed per hour
     * @returns Whether posting is allowed and current usage
     */
    async checkAndRecord(platform: string, limitPerHour: number): Promise<RateLimitResult> {
      const key = `rate_limit:${platform}`;
      const now = Date.now();
      const windowStart = now - 60 * 60 * 1000; // 1 hour ago

      // Remove old entries outside the window
      await redis.zremrangebyscore(key, 0, windowStart);

      // Count current entries in window
      const current = await redis.zcard(key);

      if (current >= limitPerHour) {
        // Get oldest entry to calculate retry time
        const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
        const oldestTime = oldest.length >= 2 ? parseInt(oldest[1]) : now;
        const retryAfterMs = oldestTime + 60 * 60 * 1000 - now;

        return {
          allowed: false,
          current,
          limit: limitPerHour,
          retryAfterMs: Math.max(0, retryAfterMs),
        };
      }

      // Record this attempt
      await redis.zadd(key, now, `${now}`);
      // Set expiry on the key (cleanup)
      await redis.expire(key, 3600);

      return {
        allowed: true,
        current: current + 1,
        limit: limitPerHour,
      };
    },

    /**
     * Get current usage without recording.
     */
    async getUsage(platform: string): Promise<{ current: number }> {
      const key = `rate_limit:${platform}`;
      const now = Date.now();
      const windowStart = now - 60 * 60 * 1000;

      await redis.zremrangebyscore(key, 0, windowStart);
      const current = await redis.zcard(key);

      return { current };
    },

    /**
     * Check rate limit without recording an attempt.
     * Use for pre-flight checks before committing to a state change.
     */
    async peek(platform: string, limitPerHour: number): Promise<RateLimitResult> {
      const key = `rate_limit:${platform}`;
      const now = Date.now();
      const windowStart = now - 60 * 60 * 1000;

      await redis.zremrangebyscore(key, 0, windowStart);
      const current = await redis.zcard(key);

      if (current >= limitPerHour) {
        const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
        const oldestTime = oldest.length >= 2 ? parseInt(oldest[1]) : now;
        const retryAfterMs = oldestTime + 60 * 60 * 1000 - now;

        return {
          allowed: false,
          current,
          limit: limitPerHour,
          retryAfterMs: Math.max(0, retryAfterMs),
        };
      }

      return {
        allowed: true,
        current,
        limit: limitPerHour,
      };
    },
  };
};

export type RateLimiter = ReturnType<typeof createRateLimiter>;
