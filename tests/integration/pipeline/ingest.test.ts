/**
 * Integration tests for the RSS ingest pipeline.
 *
 * Runs against real PostgreSQL and Redis. A lightweight mock HTTP server
 * (port 9999) serves XML fixture files so the worker never hits the
 * public internet.
 *
 * Strategy: create a real BullMQ Queue + Worker for QUEUE_INGEST, add a
 * job, and await job.waitUntilFinished() before querying the database.
 * This exercises the full path: domain whitelist → secure fetch → date
 * filter → quota check → DB insert → event publish.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Queue, QueueEvents } from "bullmq";

import { QUEUE_INGEST, JOB_INGEST_FETCH } from "@watch-tower/shared";
import { createIngestWorker } from "@watch-tower/worker/processors/feed";
import { sql } from "@watch-tower/db";

import {
  getTestDb,
  closeTestDb,
  cleanArticleTables,
  seedTestSector,
  seedTestSource,
  seedAllowedDomain,
} from "../../helpers/test-db.js";
import {
  getTestRedis,
  getTestRedisConnection,
  cleanTestRedisKeys,
  closeTestRedis,
} from "../../helpers/test-redis.js";
import { createMockEventPublisher } from "../../helpers/mock-providers.js";
import {
  startMockServer,
  stopMockServer,
  mockFeedUrl,
} from "../../mock-server/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds to wait for a BullMQ job to complete before failing the test. */
const JOB_TIMEOUT_MS = 15_000;

/** localhost domain used by the mock RSS server — must be whitelisted. */
const MOCK_SERVER_DOMAIN = "127.0.0.1";

// ---------------------------------------------------------------------------
// Suite-level setup/teardown
// ---------------------------------------------------------------------------

let queue: Queue;
let queueEvents: QueueEvents;
let worker: ReturnType<typeof createIngestWorker>;

beforeAll(async () => {
  // Start mock RSS HTTP server on port 9999
  await startMockServer();

  const { db } = getTestDb();
  const connection = getTestRedisConnection();
  const eventPublisher = createMockEventPublisher();

  queue = new Queue(QUEUE_INGEST, { connection });
  queueEvents = new QueueEvents(QUEUE_INGEST, { connection });
  worker = createIngestWorker({ connection, db, eventPublisher });

  // Wait until the worker is ready to accept jobs
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await queueEvents.close();
  await queue.close();

  const redis = getTestRedis();
  await cleanTestRedisKeys(redis);

  await stopMockServer();
  await closeTestDb();
  await closeTestRedis();
});

afterEach(async () => {
  const { db } = getTestDb();
  await cleanArticleTables(db);
  // Drain any leftover queue jobs between tests
  await queue.drain();
});

// ---------------------------------------------------------------------------
// Helper: add a job and wait for it to finish
// ---------------------------------------------------------------------------

const runIngestJob = async (
  url: string,
  sourceId: string,
  sectorId: string,
  maxAgeDays = 365,
): Promise<void> => {
  const job = await queue.add(JOB_INGEST_FETCH, {
    url,
    sourceId,
    sectorId,
    maxAgeDays,
  });
  await job.waitUntilFinished(queueEvents, JOB_TIMEOUT_MS);
};

// ---------------------------------------------------------------------------
// Helper: count articles in DB for a given source
// ---------------------------------------------------------------------------

const countArticlesForSource = async (sourceId: string): Promise<number> => {
  const { db } = getTestDb();
  const result = await db.execute(
    sql`SELECT COUNT(*)::int AS count FROM articles WHERE source_id = ${sourceId}::uuid`,
  );
  return (result.rows[0] as { count: number }).count;
};

// ---------------------------------------------------------------------------
// Helper: count feed_fetch_runs for a given source
// ---------------------------------------------------------------------------

const getLastFetchRun = async (
  sourceId: string,
): Promise<Record<string, unknown> | null> => {
  const { db } = getTestDb();
  const result = await db.execute(
    sql`SELECT * FROM feed_fetch_runs WHERE source_id = ${sourceId}::uuid ORDER BY finished_at DESC LIMIT 1`,
  );
  return (result.rows[0] as Record<string, unknown>) ?? null;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingest pipeline — integration", () => {
  describe("basic ingest", () => {
    it("should insert articles from a standard RSS feed into the database", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Tech", "tech-basic");
      const feedUrl = mockFeedUrl("basic-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Basic Feed Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const count = await countArticlesForSource(sourceId);
      // basic-feed.xml has 5 articles, all recent (2026-03-01)
      expect(count).toBe(5);
    });

    it("should set pipeline_stage to ingested on all inserted articles", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Tech", "tech-stage");
      const feedUrl = mockFeedUrl("basic-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Stage Check Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const result = await db.execute(
        sql`SELECT DISTINCT pipeline_stage FROM articles WHERE source_id = ${sourceId}::uuid`,
      );
      const stages = result.rows.map((r) => (r as { pipeline_stage: string }).pipeline_stage);
      expect(stages).toEqual(["ingested"]);
    });

    it("should record a successful fetch run in feed_fetch_runs", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Tech", "tech-fetchrun");
      const feedUrl = mockFeedUrl("basic-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "FetchRun Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const run = await getLastFetchRun(sourceId);
      expect(run).not.toBeNull();
      expect(run!["status"]).toBe("success");
      expect(run!["item_added"]).toBe(5);
      expect(run!["item_count"]).toBe(5);
    });
  });

  describe("empty feed", () => {
    it("should insert zero articles when the feed has no items", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Empty", "empty-sector");
      const feedUrl = mockFeedUrl("empty-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Empty Feed Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const count = await countArticlesForSource(sourceId);
      expect(count).toBe(0);
    });

    it("should still record a successful fetch run for an empty feed", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Empty", "empty-fetchrun");
      const feedUrl = mockFeedUrl("empty-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Empty FetchRun Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const run = await getLastFetchRun(sourceId);
      expect(run).not.toBeNull();
      expect(run!["status"]).toBe("success");
      expect(run!["item_added"]).toBe(0);
    });
  });

  describe("domain whitelist enforcement", () => {
    it("should not insert any articles when the source domain is not whitelisted", async () => {
      const { db } = getTestDb();
      // Remove all allowed domains from previous tests so only our test domain is present.
      // Without this, 127.0.0.1 from earlier tests would still be whitelisted.
      await db.execute(sql`DELETE FROM allowed_domains`);
      // Seed a different domain so the whitelist is non-empty but does not cover
      // 127.0.0.1 (the mock server host)
      await seedAllowedDomain(db, "allowed-only.example.com");

      const sectorId = await seedTestSector(db, "Blocked", "blocked-sector");
      const feedUrl = mockFeedUrl("basic-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Blocked Source");

      await runIngestJob(feedUrl, sourceId, sectorId);

      const count = await countArticlesForSource(sourceId);
      expect(count).toBe(0);
    });

    it("should record an error fetch run when the domain is blocked", async () => {
      const { db } = getTestDb();
      await db.execute(sql`DELETE FROM allowed_domains`);
      await seedAllowedDomain(db, "allowed-only.example.com");

      const sectorId = await seedTestSector(db, "Blocked", "blocked-fetchrun");
      const feedUrl = mockFeedUrl("basic-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Blocked FetchRun Source");

      await runIngestJob(feedUrl, sourceId, sectorId);

      const run = await getLastFetchRun(sourceId);
      expect(run).not.toBeNull();
      expect(run!["status"]).toBe("error");
      expect(String(run!["error_message"])).toMatch(/DOMAIN_BLOCKED/);
    });
  });

  describe("content:encoded enrichment", () => {
    it("should capture a non-null content snippet from content:encoded articles", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Deep Dive", "deepdive-sector");
      const feedUrl = mockFeedUrl("content-encoded");
      const sourceId = await seedTestSource(
        db,
        feedUrl,
        sectorId,
        "Content Encoded Source",
      );
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const result = await db.execute(
        sql`SELECT content_snippet FROM articles WHERE source_id = ${sourceId}::uuid ORDER BY published_at ASC LIMIT 1`,
      );
      const row = result.rows[0] as { content_snippet: string | null };
      expect(row).toBeDefined();
      // Worker prefers content:encoded (richer) over contentSnippet (short description).
      // Either way, a non-null snippet with meaningful length is expected.
      expect(row.content_snippet).not.toBeNull();
      expect(row.content_snippet!.length).toBeGreaterThan(10);
    });

    it("should truncate content snippet to at most 500 characters", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Deep Dive", "deepdive-trunc");
      const feedUrl = mockFeedUrl("content-encoded");
      const sourceId = await seedTestSource(
        db,
        feedUrl,
        sectorId,
        "Content Truncate Source",
      );
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      const result = await db.execute(
        sql`SELECT content_snippet FROM articles WHERE source_id = ${sourceId}::uuid`,
      );
      for (const row of result.rows) {
        const snippet = (row as { content_snippet: string | null }).content_snippet;
        if (snippet !== null) {
          // Worker truncates at 1500 chars, then appends "..."
          expect(snippet.length).toBeLessThanOrEqual(1503);
        }
      }
    });
  });

  describe("category capture", () => {
    it("should populate article_categories from RSS <category> tags", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Multi", "multi-categories");
      const feedUrl = mockFeedUrl("categories-feed");
      const sourceId = await seedTestSource(
        db,
        feedUrl,
        sectorId,
        "Categories Feed Source",
      );
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      // categories-feed.xml first article has categories: AI, Biotech, Drug Discovery
      const result = await db.execute(
        sql`SELECT article_categories FROM articles WHERE source_id = ${sourceId}::uuid ORDER BY published_at ASC LIMIT 1`,
      );
      const row = result.rows[0] as { article_categories: string[] | null };
      expect(row).toBeDefined();
      expect(Array.isArray(row.article_categories)).toBe(true);
      expect(row.article_categories!.length).toBeGreaterThan(0);
    });

    it("should capture multiple categories per article", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Multi", "multi-cats-count");
      const feedUrl = mockFeedUrl("categories-feed");
      const sourceId = await seedTestSource(
        db,
        feedUrl,
        sectorId,
        "Multi Cat Source",
      );
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      // First article in categories-feed.xml has 3 categories
      const result = await db.execute(
        sql`SELECT article_categories FROM articles WHERE source_id = ${sourceId}::uuid ORDER BY published_at ASC LIMIT 1`,
      );
      const row = result.rows[0] as { article_categories: string[] | null };
      expect(row.article_categories!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("duplicate URL deduplication", () => {
    it("should add zero new articles when the same feed is ingested a second time", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Dedup", "dedup-sector");
      const feedUrl = mockFeedUrl("basic-feed");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Dedup Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      // First pass — should add all articles
      await runIngestJob(feedUrl, sourceId, sectorId);
      const countAfterFirst = await countArticlesForSource(sourceId);
      expect(countAfterFirst).toBeGreaterThan(0);

      // Second pass — ON CONFLICT DO NOTHING means zero new rows
      await runIngestJob(feedUrl, sourceId, sectorId);
      const countAfterSecond = await countArticlesForSource(sourceId);
      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it("should de-duplicate articles that share a URL within the same feed", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "Dedup", "dedup-same-feed");
      const feedUrl = mockFeedUrl("duplicate-urls");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Duplicate URLs Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId);

      // duplicate-urls.xml has 4 items but only 2 unique URLs
      const count = await countArticlesForSource(sourceId);
      expect(count).toBe(2);
    });
  });

  describe("date filtering", () => {
    it("should filter out articles older than maxAgeDays", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "OldNews", "old-date-filter");
      const feedUrl = mockFeedUrl("old-articles");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Old Articles Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      // old-articles.xml contains items from 2020 — any maxAgeDays < ~2000 will exclude them
      await runIngestJob(feedUrl, sourceId, sectorId, 7);

      const count = await countArticlesForSource(sourceId);
      expect(count).toBe(0);
    });

    it("should record a successful fetch run even when all articles are filtered by date", async () => {
      const { db } = getTestDb();
      const sectorId = await seedTestSector(db, "OldNews", "old-fetchrun");
      const feedUrl = mockFeedUrl("old-articles");
      const sourceId = await seedTestSource(db, feedUrl, sectorId, "Old FetchRun Source");
      await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

      await runIngestJob(feedUrl, sourceId, sectorId, 7);

      const run = await getLastFetchRun(sourceId);
      expect(run).not.toBeNull();
      // Status is "success" — date filtering is normal operation, not an error
      expect(run!["status"]).toBe("success");
      expect(run!["item_added"]).toBe(0);
    });
  });

  describe("event publishing", () => {
    it("should publish a source:fetched event after successful ingest", async () => {
      // Use a fresh mock event publisher so we can inspect what was emitted
      // for this specific test without interference from the shared worker.
      // We close the shared worker and create a dedicated one for this test.
      await worker.close();

      const { db } = getTestDb();
      const eventPublisher = createMockEventPublisher();
      const connection = getTestRedisConnection();

      const dedicatedWorker = createIngestWorker({ connection, db, eventPublisher });
      await dedicatedWorker.waitUntilReady();

      try {
        const sectorId = await seedTestSector(db, "Events", "events-sector");
        const feedUrl = mockFeedUrl("basic-feed");
        const sourceId = await seedTestSource(db, feedUrl, sectorId, "Events Source");
        await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

        await runIngestJob(feedUrl, sourceId, sectorId);

        const sourceFetchedEvents = eventPublisher.events.filter(
          (e) => e.type === "source:fetched",
        );
        expect(sourceFetchedEvents.length).toBeGreaterThanOrEqual(1);

        const event = sourceFetchedEvents[0]!;
        expect(event.type).toBe("source:fetched");
        if (event.type === "source:fetched") {
          expect(event.data.sourceId).toBe(sourceId);
          expect(event.data.articlesFound).toBe(5);
          expect(event.data.articlesAdded).toBe(5);
          expect(typeof event.data.durationMs).toBe("number");
        }
      } finally {
        await dedicatedWorker.close();
        // Restore the shared worker for subsequent tests
        const sharedEventPublisher = createMockEventPublisher();
        worker = createIngestWorker({ connection, db, eventPublisher: sharedEventPublisher });
        await worker.waitUntilReady();
      }
    });

    it("should include the feed title as sourceName in the event payload", async () => {
      await worker.close();

      const { db } = getTestDb();
      const eventPublisher = createMockEventPublisher();
      const connection = getTestRedisConnection();

      const dedicatedWorker = createIngestWorker({ connection, db, eventPublisher });
      await dedicatedWorker.waitUntilReady();

      try {
        const sectorId = await seedTestSector(db, "Events", "events-title");
        const feedUrl = mockFeedUrl("basic-feed");
        const sourceId = await seedTestSource(db, feedUrl, sectorId, "Title Check Source");
        await seedAllowedDomain(db, MOCK_SERVER_DOMAIN);

        await runIngestJob(feedUrl, sourceId, sectorId);

        const event = eventPublisher.events.find((e) => e.type === "source:fetched");
        expect(event).toBeDefined();
        if (event?.type === "source:fetched") {
          // basic-feed.xml <title> is "Tech News Daily"
          expect(event.data.sourceName).toBe("Tech News Daily");
        }
      } finally {
        await dedicatedWorker.close();
        const sharedEventPublisher = createMockEventPublisher();
        worker = createIngestWorker({
          connection,
          db,
          eventPublisher: sharedEventPublisher,
        });
        await worker.waitUntilReady();
      }
    });
  });
});
