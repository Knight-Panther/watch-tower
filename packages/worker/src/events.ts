/**
 * Event publisher for real-time UI updates via Redis pub/sub
 *
 * Workers call publishEvent() after key operations to notify the API,
 * which then streams events to connected browser clients via SSE.
 */

import type { Redis } from "ioredis";
import { REDIS_CHANNEL_EVENTS, type ServerEvent, logger } from "@watch-tower/shared";

export type EventPublisher = {
  publish: (event: ServerEvent) => Promise<void>;
};

/**
 * Create an event publisher that sends events to Redis pub/sub channel
 */
export const createEventPublisher = (redis: Redis): EventPublisher => ({
  publish: async (event: ServerEvent) => {
    try {
      await redis.publish(REDIS_CHANNEL_EVENTS, JSON.stringify(event));
      logger.debug(`[events] published ${event.type}`);
    } catch (err) {
      // Don't fail operations if event publishing fails
      logger.warn(`[events] failed to publish ${event.type}:`, err);
    }
  },
});

/**
 * No-op publisher for when events are disabled
 */
export const createNoopPublisher = (): EventPublisher => ({
  publish: async () => {
    // Do nothing - events disabled
  },
});
