/**
 * E2E Pipeline Flow Tests
 *
 * Tests the full article lifecycle: ingest → dedup → score → approve/reject.
 * Runs against real PostgreSQL + Redis with mock RSS server and mock providers.
 *
 * Prerequisites: `npm run infra:up` (PostgreSQL + Redis running)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Queue, QueueEvents } from "bullmq";
import { createIngestWorker } from "@watch-tower/worker/processors/feed";
import { createSemanticDedupWorker } from "@watch-tower/worker/processors/semantic-dedup";
import { createLLMBrainWorker } from "@watch-tower/worker/processors/llm-brain";
import {
  QUEUE_INGEST,
  QUEUE_SEMANTIC_DEDUP,
  QUEUE_LLM_BRAIN,
  JOB_INGEST_FETCH,
  JOB_SEMANTIC_BATCH,
  JOB_LLM_SCORE_BATCH,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { sql } from "@watch-tower/db";
import type { Worker } from "bullmq";
import {
  getTestDb,
  cleanAllTables,
  seedTestSector,
  seedTestSource,
  seedAllowedDomain,
  seedTestArticle,
  getArticle,
  closeTestDb,
} from "../helpers/test-db.js";
import {
  getTestRedis,
  getTestRedisConnection,
  cleanTestRedisKeys,
  closeTestRedis,
} from "../helpers/test-redis.js";
import {
  createMockLLMProvider,
  createMockEmbeddingProvider,
  createMockEventPublisher,
} from "../helpers/mock-providers.js";
import { startMockServer, stopMockServer, mockFeedUrl } from "../mock-server/index.js";

// ─── Shared state ────────────────────────────────────────────────────────────

let db: Database;
let sectorId: string;
let sourceId: string;

const connection = getTestRedisConnection();
const redis = getTestRedis();
const mockLlm = createMockLLMProvider(4); // Default score 4 (manual review range)
const mockEmbeddings = createMockEmbeddingProvider();
const mockEvents = createMockEventPublisher();

// Queues
let ingestQueue: Queue;
let dedupQueue: Queue;
let llmQueue: Queue;
let ingestQueueEvents: QueueEvents;
let dedupQueueEvents: QueueEvents;
let llmQueueEvents: QueueEvents;

// Workers
let ingestWorker: Worker;
let dedupWorker: Worker;
let llmWorker: Worker;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wait for all articles to reach a given pipeline_stage (or timeout). */
const waitForStage = async (
  dbConn: Database,
  stage: string,
  expectedCount: number,
  timeoutMs = 15000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await dbConn.execute(
      sql`SELECT COUNT(*) as count FROM articles WHERE pipeline_stage = ${stage}`,
    );
    const count = Number((result.rows[0] as { count: string }).count);
    if (count >= expectedCount) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${expectedCount} articles at stage '${stage}'`);
};

/** Count articles at a given stage. */
const countAtStage = async (dbConn: Database, stage: string): Promise<number> => {
  const result = await dbConn.execute(
    sql`SELECT COUNT(*) as count FROM articles WHERE pipeline_stage = ${stage}`,
  );
  return Number((result.rows[0] as { count: string }).count);
};

// ─── Setup & Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Connect to real infrastructure
  await redis.connect();
  const { db: testDb } = getTestDb();
  db = testDb;

  // Clean slate
  await cleanAllTables(db);
  await cleanTestRedisKeys(redis);

  // Start mock RSS server
  await startMockServer();

  // Set predictable app_config values so workers don't use stale dev settings
  await db.execute(sql`
    INSERT INTO app_config (key, value)
    VALUES ('similarity_threshold', '0.85'),
           ('auto_approve_threshold', '5'),
           ('auto_reject_threshold', '2')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);

  // Seed test data
  sectorId = await seedTestSector(db, "E2E Test Sector", "e2e-test");
  sourceId = await seedTestSource(
    db,
    mockFeedUrl("basic-feed"),
    sectorId,
    "E2E Test Source",
  );
  await seedAllowedDomain(db, "127.0.0.1");

  // Create queues
  ingestQueue = new Queue(QUEUE_INGEST, { connection });
  dedupQueue = new Queue(QUEUE_SEMANTIC_DEDUP, { connection });
  llmQueue = new Queue(QUEUE_LLM_BRAIN, { connection });
  ingestQueueEvents = new QueueEvents(QUEUE_INGEST, { connection });
  dedupQueueEvents = new QueueEvents(QUEUE_SEMANTIC_DEDUP, { connection });
  llmQueueEvents = new QueueEvents(QUEUE_LLM_BRAIN, { connection });

  // Create workers
  ingestWorker = createIngestWorker({
    connection,
    db,
    eventPublisher: mockEvents,
  });

  dedupWorker = createSemanticDedupWorker({
    connection,
    db,
    embeddingProvider: mockEmbeddings,
    llmQueue,
    similarityThreshold: 0.85,
    eventPublisher: mockEvents,
  });

  llmWorker = createLLMBrainWorker({
    connection,
    db,
    llmProvider: mockLlm,
    eventPublisher: mockEvents,
    autoApproveThreshold: 5,
    autoRejectThreshold: 2,
  });
}, 30000);

afterEach(async () => {
  // Only clear LLM score calls — events are intentionally accumulated across
  // tests so the "publishes events throughout the pipeline" test can verify
  // that all pipeline stages emitted the correct events.
  mockLlm.scoreCalls.length = 0;
});

afterAll(async () => {
  // Close workers
  await ingestWorker?.close();
  await dedupWorker?.close();
  await llmWorker?.close();

  // Close queue events
  await ingestQueueEvents?.close();
  await dedupQueueEvents?.close();
  await llmQueueEvents?.close();

  // Drain and close queues
  await ingestQueue?.obliterate({ force: true }).catch(() => {});
  await dedupQueue?.obliterate({ force: true }).catch(() => {});
  await llmQueue?.obliterate({ force: true }).catch(() => {});
  await ingestQueue?.close();
  await dedupQueue?.close();
  await llmQueue?.close();

  // Clean up
  await cleanAllTables(db);
  await cleanTestRedisKeys(redis);
  await stopMockServer();
  await closeTestRedis();
  await closeTestDb();
}, 15000);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("E2E Pipeline Flow", () => {
  it("ingests articles from mock RSS feed into database", async () => {
    // Queue an ingest job
    const job = await ingestQueue.add(JOB_INGEST_FETCH, {
      url: mockFeedUrl("basic-feed"),
      sourceId,
      maxAgeDays: 7,
      sectorId,
    });

    await job.waitUntilFinished(ingestQueueEvents, 15000);

    // Verify articles are in the database
    const ingested = await countAtStage(db, "ingested");
    expect(ingested).toBeGreaterThanOrEqual(3); // basic-feed has 5 articles

    // Verify article fields
    const result = await db.execute(
      sql`SELECT title, content_snippet, pipeline_stage, sector_id FROM articles LIMIT 1`,
    );
    const article = result.rows[0] as Record<string, unknown>;
    expect(article.title).toBeTruthy();
    expect(article.content_snippet).toBeTruthy();
    expect(article.pipeline_stage).toBe("ingested");
    expect(article.sector_id).toBe(sectorId);
  }, 20000);

  it("deduplicates articles via semantic embeddings", async () => {
    // Ensure we have ingested articles from previous test
    const ingested = await countAtStage(db, "ingested");
    if (ingested === 0) {
      // Seed some if needed
      for (let i = 0; i < 3; i++) {
        await seedTestArticle(db, {
          title: `Dedup Test Article ${i}`,
          contentSnippet: `Unique content for article number ${i} about technology trends.`,
          sectorId,
          pipelineStage: "ingested",
        });
      }
    }

    // Queue dedup job
    const job = await dedupQueue.add(JOB_SEMANTIC_BATCH, {});
    await job.waitUntilFinished(dedupQueueEvents, 15000);

    // Verify at least one article progressed past 'ingested' with an embedding.
    // Note: The LLM brain worker (also running in E2E) may advance articles
    // from 'embedded' to 'scored' before we check, so we verify embeddings
    // are stored rather than checking for the 'embedded' stage specifically.
    const result = await db.execute(
      sql`SELECT id, embedding_model, pipeline_stage FROM articles WHERE embedding IS NOT NULL LIMIT 1`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect((result.rows[0] as Record<string, unknown>).embedding_model).toBe(
      "text-embedding-3-small",
    );
  }, 20000);

  it("scores articles via mock LLM and sets pipeline_stage", async () => {
    // Ensure we have embedded articles
    const embedded = await countAtStage(db, "embedded");
    if (embedded === 0) {
      // Seed embedded articles manually
      for (let i = 0; i < 3; i++) {
        await seedTestArticle(db, {
          title: `Score Test Article ${i}`,
          contentSnippet: `Content for scoring test article ${i}.`,
          sectorId,
          pipelineStage: "embedded",
        });
      }
    }

    // Set LLM to return score 3 (manual review range)
    mockLlm.setScoreMap({}); // Reset
    // Default score is 4, which is in the scored (manual review) range

    // Queue scoring job
    const job = await llmQueue.add(JOB_LLM_SCORE_BATCH, {});
    await job.waitUntilFinished(llmQueueEvents, 15000);

    // Verify articles were scored
    const result = await db.execute(sql`
      SELECT importance_score, llm_summary, score_reasoning, pipeline_stage
      FROM articles
      WHERE importance_score IS NOT NULL
      LIMIT 3
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    const scored = result.rows[0] as Record<string, unknown>;
    expect(scored.importance_score).toBe(4);
    expect(scored.llm_summary).toBeTruthy();
    expect(scored.score_reasoning).toBeTruthy();
    expect(scored.pipeline_stage).toBe("scored"); // Score 4 with threshold 5 → manual review
  }, 20000);

  it("auto-approves articles scoring at or above threshold", async () => {
    // Seed a fresh article
    const articleId = await seedTestArticle(db, {
      title: "Breaking: Major Tech Acquisition Worth $50B",
      contentSnippet: "A landmark deal that reshapes the industry.",
      sectorId,
      pipelineStage: "embedded",
    });

    // Mock LLM returns score 5 (auto-approve threshold)
    mockLlm.setScoreMap({ [articleId]: 5 });

    const job = await llmQueue.add(JOB_LLM_SCORE_BATCH, {});
    await job.waitUntilFinished(llmQueueEvents, 15000);

    const article = await getArticle(db, articleId);
    expect(article).not.toBeNull();
    expect(article!.pipeline_stage).toBe("approved");
    expect(article!.importance_score).toBe(5);
    expect(article!.approved_at).toBeTruthy();
  }, 20000);

  it("auto-rejects articles scoring at or below reject threshold", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Minor Blog Post About Nothing Important",
      contentSnippet: "Just a random blog post with no significance.",
      sectorId,
      pipelineStage: "embedded",
    });

    mockLlm.setScoreMap({ [articleId]: 1 });

    const job = await llmQueue.add(JOB_LLM_SCORE_BATCH, {});
    await job.waitUntilFinished(llmQueueEvents, 15000);

    const article = await getArticle(db, articleId);
    expect(article).not.toBeNull();
    expect(article!.pipeline_stage).toBe("rejected");
    expect(article!.importance_score).toBe(1);
    expect(article!.rejection_reason).toBe("llm-score: 1");
  }, 20000);

  it("records LLM telemetry for scored articles", async () => {
    const result = await db.execute(sql`
      SELECT operation, provider, model, status, input_tokens, output_tokens
      FROM llm_telemetry
      WHERE operation = 'score_and_summarize'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.operation).toBe("score_and_summarize");
    expect(row.provider).toBe("mock");
    expect(row.model).toBe("mock-model-v1");
    expect(row.status).toBe("success");
    expect(Number(row.input_tokens)).toBeGreaterThan(0);
  });

  it("publishes events throughout the pipeline", () => {
    // After running the previous tests, events should have been published
    const eventTypes = mockEvents.events.map((e) => e.type);

    // Should have at least source:fetched and article:embedded events
    expect(eventTypes).toContain("source:fetched");
    expect(eventTypes).toContain("article:embedded");

    // Should have scoring events (article:scored, article:approved, or article:rejected)
    const scoringEvents = eventTypes.filter(
      (t) => t === "article:scored" || t === "article:approved" || t === "article:rejected",
    );
    expect(scoringEvents.length).toBeGreaterThan(0);
  });

  it("records feed fetch telemetry", async () => {
    const result = await db.execute(sql`
      SELECT source_id, status, item_count, item_added, duration_ms
      FROM feed_fetch_runs
      WHERE source_id = ${sourceId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const run = result.rows[0] as Record<string, unknown>;
    expect(run.status).toBe("success");
    expect(Number(run.item_count)).toBeGreaterThan(0);
    expect(Number(run.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("pre-filter rejects articles matching reject keywords", async () => {
    // Add scoring rule with reject keywords for the sector
    await db.execute(sql`
      INSERT INTO scoring_rules (sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold)
      VALUES (${sectorId}::uuid, 'Test', '{"rejectKeywords": ["sponsored"]}', 5, 2)
      ON CONFLICT (sector_id) DO UPDATE SET score_criteria = '{"rejectKeywords": ["sponsored"]}'
    `);

    const articleId = await seedTestArticle(db, {
      title: "Sponsored Content: Buy Our Product",
      contentSnippet: "This is a promotional article.",
      sectorId,
      pipelineStage: "embedded",
    });

    const job = await llmQueue.add(JOB_LLM_SCORE_BATCH, {});
    await job.waitUntilFinished(llmQueueEvents, 15000);

    const article = await getArticle(db, articleId);
    expect(article).not.toBeNull();
    expect(article!.pipeline_stage).toBe("rejected");
    expect(article!.rejection_reason).toContain("pre-filter");
    expect(article!.rejection_reason).toContain("sponsored");

    // Clean up scoring rule
    await db.execute(sql`DELETE FROM scoring_rules WHERE sector_id = ${sectorId}::uuid`);
  }, 20000);

  it("handles full pipeline: ingest → dedup → score flow", async () => {
    // Clean articles for a fresh run
    await db.execute(sql`TRUNCATE TABLE articles, llm_telemetry, feed_fetch_runs CASCADE`);
    mockEvents.events.length = 0;

    // Step 1: Ingest from mock RSS
    const ingestJob = await ingestQueue.add(JOB_INGEST_FETCH, {
      url: mockFeedUrl("basic-feed"),
      sourceId,
      maxAgeDays: 7,
      sectorId,
    });
    await ingestJob.waitUntilFinished(ingestQueueEvents, 15000);

    const ingestedCount = await countAtStage(db, "ingested");
    expect(ingestedCount).toBeGreaterThan(0);

    // Step 2: Dedup
    const dedupJob = await dedupQueue.add(JOB_SEMANTIC_BATCH, {});
    await dedupJob.waitUntilFinished(dedupQueueEvents, 15000);

    const embeddedCount = await countAtStage(db, "embedded");
    expect(embeddedCount).toBeGreaterThan(0);

    // Step 3: Score
    mockLlm.setScoreMap({}); // Use default score (4)
    const scoreJob = await llmQueue.add(JOB_LLM_SCORE_BATCH, {});
    await scoreJob.waitUntilFinished(llmQueueEvents, 15000);

    // Verify final state — all articles should be scored (score 4 = manual review)
    const scoredCount = await countAtStage(db, "scored");
    expect(scoredCount).toBeGreaterThan(0);

    // Verify data integrity across the pipeline
    const articles = await db.execute(sql`
      SELECT title, content_snippet, embedding_model, importance_score,
             llm_summary, score_reasoning, pipeline_stage
      FROM articles
      WHERE pipeline_stage = 'scored'
      LIMIT 3
    `);

    for (const row of articles.rows as Record<string, unknown>[]) {
      expect(row.title).toBeTruthy();
      expect(row.content_snippet).toBeTruthy();
      expect(row.embedding_model).toBe("text-embedding-3-small");
      expect(row.importance_score).toBe(4);
      expect(row.llm_summary).toBeTruthy();
      expect(row.score_reasoning).toBeTruthy();
      expect(row.pipeline_stage).toBe("scored");
    }
  }, 30000);
});
