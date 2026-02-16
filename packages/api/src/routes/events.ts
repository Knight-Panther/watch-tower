/**
 * Server-Sent Events (SSE) endpoint for real-time UI updates
 *
 * Browser connects to GET /api/events and receives live updates
 * about pipeline activity (articles ingested, embedded, scored, etc.)
 *
 * Events flow: Worker → Redis pub/sub → This endpoint → Browser
 *
 * IMPORTANT: Uses a single shared Redis subscriber to avoid connection leaks.
 * All SSE clients share one Redis connection, with local fan-out via EventEmitter.
 */

import { EventEmitter } from "events";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { REDIS_CHANNEL_EVENTS, type ServerEvent, logger } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

// Shared subscriber state (initialized once per API instance)
let sharedSubscriber: Redis | null = null;
let sharedEmitter: EventEmitter | null = null;
let subscriberInitPromise: Promise<void> | null = null;
let activeClientCount = 0;

/**
 * Initialize or get the shared Redis subscriber.
 * Uses singleton pattern with lazy initialization.
 */
const getSharedSubscriber = async (deps: ApiDeps): Promise<EventEmitter> => {
  // If already initialized, return the emitter
  if (sharedEmitter && sharedSubscriber?.status === "ready") {
    return sharedEmitter;
  }

  // If initialization is in progress, wait for it
  if (subscriberInitPromise) {
    await subscriberInitPromise;
    return sharedEmitter!;
  }

  // Initialize new subscriber
  subscriberInitPromise = (async () => {
    logger.info("[events] initializing shared Redis subscriber");

    sharedEmitter = new EventEmitter();
    sharedEmitter.setMaxListeners(1000); // Support many concurrent SSE clients

    sharedSubscriber = new Redis({
      ...deps.redisConnection,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    await sharedSubscriber.connect();
    await sharedSubscriber.subscribe(REDIS_CHANNEL_EVENTS);

    // Forward Redis messages to local EventEmitter
    sharedSubscriber.on("message", (channel, message) => {
      if (channel === REDIS_CHANNEL_EVENTS) {
        try {
          const event = JSON.parse(message) as ServerEvent;
          sharedEmitter!.emit("event", event, message);
        } catch (err) {
          logger.warn("[events] failed to parse event:", err);
        }
      }
    });

    // Handle Redis connection errors
    sharedSubscriber.on("error", (err) => {
      logger.error("[events] shared subscriber error:", err);
    });

    // Handle unexpected disconnect
    sharedSubscriber.on("close", () => {
      logger.warn("[events] shared subscriber disconnected");
      // Will reconnect automatically due to ioredis default behavior
    });

    logger.info("[events] shared Redis subscriber ready");
  })();

  await subscriberInitPromise;
  return sharedEmitter!;
};

/**
 * Cleanup shared subscriber when no clients are connected.
 * Called when the last SSE client disconnects.
 */
const maybeCleanupSubscriber = async () => {
  if (activeClientCount <= 0 && sharedSubscriber) {
    logger.info("[events] no active clients, cleaning up shared subscriber");
    try {
      await sharedSubscriber.unsubscribe(REDIS_CHANNEL_EVENTS);
      await sharedSubscriber.quit();
    } catch {
      // Ignore cleanup errors
    }
    sharedSubscriber = null;
    sharedEmitter = null;
    subscriberInitPromise = null;
  }
};

export const registerEventsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/api/events", { preHandler: deps.requireApiKey }, async (request, reply) => {
    // Take over the response from Fastify — without this, Fastify tries to
    // call reply.send() when the async handler returns, which kills the SSE
    // connection immediately and causes a reconnection storm (~every 4s).
    reply.hijack();

    // Set SSE headers — must include CORS manually since reply.hijack()
    // bypasses Fastify's onSend hooks where the CORS plugin adds headers.
    // Without this, the browser kills the cross-origin SSE connection immediately.
    const origin = request.headers.origin;
    const sseHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (origin) {
      sseHeaders["Access-Control-Allow-Origin"] = origin;
      sseHeaders["Access-Control-Allow-Credentials"] = "true";
    }
    reply.raw.writeHead(200, sseHeaders);

    let isConnected = true;
    activeClientCount++;

    try {
      // Get or create shared subscriber
      const emitter = await getSharedSubscriber(deps);

      logger.debug(`[events] SSE client connected (${activeClientCount} total)`);

      // Handler for forwarding events to this SSE client
      const eventHandler = (event: ServerEvent, rawMessage: string) => {
        if (isConnected) {
          try {
            // SSE format: event: <type>\ndata: <json>\n\n
            reply.raw.write(`event: ${event.type}\n`);
            reply.raw.write(`data: ${rawMessage}\n\n`);
          } catch {
            // Client disconnected, ignore write errors
          }
        }
      };

      // Subscribe to local events
      emitter.on("event", eventHandler);

      // Send initial ping to confirm connection
      reply.raw.write(`event: connected\n`);
      reply.raw.write(`data: {"type":"connected","timestamp":"${new Date().toISOString()}"}\n\n`);

      // Keep-alive ping every 30 seconds
      const pingInterval = setInterval(() => {
        if (isConnected) {
          try {
            reply.raw.write(`:ping\n\n`);
          } catch {
            // Client disconnected
          }
        }
      }, 30000);

      // Clean up on client disconnect
      request.raw.on("close", async () => {
        isConnected = false;
        clearInterval(pingInterval);
        emitter.off("event", eventHandler);
        activeClientCount--;
        logger.debug(`[events] SSE client disconnected (${activeClientCount} remaining)`);

        // Cleanup shared subscriber if no clients left
        await maybeCleanupSubscriber();
      });

      // Don't end the response - keep it open for SSE
      // Fastify will handle cleanup when the connection closes
    } catch (err) {
      logger.error("[events] SSE setup failed:", err);
      isConnected = false;
      activeClientCount--;
      reply.raw.end();
    }
  });
};
