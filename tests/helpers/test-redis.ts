/**
 * Test Redis helpers — connects to real Redis, provides cleanup utilities.
 */

import Redis from "ioredis";

// Module-level singleton — reused across all tests in a suite.
let _redis: Redis | null = null;

/**
 * Get or create a Redis connection for integration tests.
 * The connection is created lazily on first access and reused for the lifetime
 * of the test suite.
 */
export const getTestRedis = (): Redis => {
  if (!_redis) {
    _redis = new Redis({
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      // Required by BullMQ: prevents ioredis from retrying commands that block
      // BullMQ's internal connection from processing queue jobs.
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }
  return _redis;
};

/**
 * Return a plain connection config object suitable for passing to BullMQ
 * Queue / Worker constructors as the `connection` option.
 */
export const getTestRedisConnection = (): { host: string; port: number } => ({
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
});

/**
 * Delete Watch Tower-specific Redis keys that integration tests may have written.
 * Matches alert cooldowns, advisory volume counters, and all BullMQ queue keys.
 * Does NOT flush the entire Redis database — other keys are left untouched.
 */
export const cleanTestRedisKeys = async (redis: Redis): Promise<void> => {
  const patterns = [
    "alert:cooldown:*",
    "alert_volume:*",
    "bull:pipeline-*",
    "bull:maintenance*",
  ];

  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
};

/**
 * Close the shared test Redis connection.
 * Call in afterAll() to allow the process to exit cleanly.
 */
export const closeTestRedis = async (): Promise<void> => {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
};
