/**
 * Integration tests for the semantic deduplication pipeline processor.
 *
 * Runs against REAL PostgreSQL and Redis with a MOCKED embedding provider.
 * Each test adds a BullMQ job, waits for the worker to process it, then
 * asserts against the database and event log.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { createSemanticDedupWorker } from "@watch-tower/worker/processors/semantic-dedup";
import {
  QUEUE_SEMANTIC_DEDUP,
  JOB_SEMANTIC_BATCH,
  QUEUE_LLM_BRAIN,
} from "@watch-tower/shared";
import {
  getTestDb,
  closeTestDb,
  cleanArticleTables,
  seedTestSector,
  seedTestSource,
  seedTestArticle,
  getArticle,
} from "../../helpers/test-db.js";
import {
  getTestRedis,
  getTestRedisConnection,
  closeTestRedis,
  cleanTestRedisKeys,
} from "../../helpers/test-redis.js";
import { createMockEmbeddingProvider, createMockEventPublisher } from "../../helpers/mock-providers.js";

// ─── Shared Test Fixtures ─────────────────────────────────────────────────────

const { db } = getTestDb();
const embeddingProvider = createMockEmbeddingProvider();

/** How long (ms) to wait for a BullMQ job to reach 'completed' state. */
const JOB_TIMEOUT_MS = 15_000;

/**
 * Create a dedup worker, run one job through it, wait for completion, then
 * close both the worker and the queue. Returns the event publisher so tests
 * can assert on published events after the fact.
 */
const runDedupJob = async () => {
  const connection = getTestRedisConnection();
  const llmQueue = new Queue(QUEUE_LLM_BRAIN, { connection });
  const queue = new Queue(QUEUE_SEMANTIC_DEDUP, { connection });
  const eventPublisher = createMockEventPublisher();

  const worker = createSemanticDedupWorker({
    connection,
    db,
    embeddingProvider,
    llmQueue,
    similarityThreshold: 0.85,
    batchSize: 50,
    eventPublisher,
  });

  try {
    await queue.add(JOB_SEMANTIC_BATCH, {});

    // Poll until the queue drains — same pattern as llm-brain.test.ts.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("runDedupJob timed out after " + JOB_TIMEOUT_MS + "ms")),
        JOB_TIMEOUT_MS,
      );

      const poll = setInterval(async () => {
        try {
          const waiting = await queue.getWaitingCount();
          const active = await queue.getActiveCount();
          if (waiting === 0 && active === 0) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve();
          }
        } catch (err) {
          clearInterval(poll);
          clearTimeout(timeout);
          reject(err);
        }
      }, 100);
    });

    // Return the captured LLM queue so callers can inspect it.
    const llmJobCounts = await llmQueue.getJobCounts("wait", "active", "delayed");
    return { eventPublisher, llmJobCounts };
  } finally {
    await worker.close();
    await queue.close();
    await llmQueue.close();
  }
};

// ─── Suite Setup / Teardown ───────────────────────────────────────────────────

let sectorId: string;
let sourceId: string;

beforeAll(async () => {
  const redis = getTestRedis();
  await redis.connect();
  await cleanArticleTables(db);
  await cleanTestRedisKeys(redis);

  // Seed stable reference data once for the whole suite.
  sectorId = await seedTestSector(db, "Dedup Integration", "dedup-integration");
  sourceId = await seedTestSource(db, "https://dedup-test.example.com/rss", sectorId);
}, 30_000);

afterAll(async () => {
  await closeTestDb();
  await closeTestRedis();
}, 20_000);

beforeEach(async () => {
  const redis = getTestRedis();
  await cleanArticleTables(db);
  await cleanTestRedisKeys(redis);

  // Re-seed the sector and source after each truncation.
  sectorId = await seedTestSector(db, "Dedup Integration", "dedup-integration");
  sourceId = await seedTestSource(db, "https://dedup-test.example.com/rss", sectorId);

  // Set a known similarity_threshold in app_config so the DB value doesn't
  // override the worker's env parameter unpredictably.
  await db.execute(sql`
    INSERT INTO app_config (key, value)
    VALUES ('similarity_threshold', '0.85')
    ON CONFLICT (key) DO UPDATE SET value = '0.85'
  `);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("semantic-dedup processor — integration", () => {
  // ─── 1. Embeds unique articles ─────────────────────────────────────────────

  it("should process ingested articles and store embeddings during dedup", async () => {
    // Use maximally diverse content to avoid false-positive similarity matches
    // even at aggressive similarity thresholds (DB may have 0.65 instead of 0.85).
    // The mock embedding is character-hash based, so character diversity matters.
    const id1 = await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "AAAA Federal Reserve Monetary Policy Rate Decision",
      contentSnippet:
        "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMM NNNN OOOO PPPP QQQQ RRRR",
      pipelineStage: "ingested",
    });
    const id2 = await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "ZZZZ Quantum Computing Qubit Milestone Research",
      contentSnippet:
        "ZZZZ YYYY XXXX WWWW VVVV UUUU TTTT SSSS RRRR QQQQ PPPP OOOO NNNN MMMM LLLL KKKK JJJJ IIII",
      pipelineStage: "ingested",
    });
    const id3 = await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "1111 Biotech Gene Therapy Clinical Trial Approval",
      contentSnippet:
        "1111 2222 3333 4444 5555 6666 7777 8888 9999 0000 aaaa bbbb cccc dddd eeee ffff gggg hhhh",
      pipelineStage: "ingested",
    });

    await runDedupJob();

    // All three articles should have left the 'ingested' and 'embedding' stages.
    // They may be 'embedded', 'duplicate', or advanced further by any running
    // downstream worker — we only verify the dedup worker processed them.
    for (const id of [id1, id2, id3]) {
      const row = await getArticle(db, id);
      expect(row, `Article ${id} not found`).not.toBeNull();
      expect(
        ["ingested", "embedding"],
        `Article ${id} should have left dedup stages`,
      ).not.toContain(row!["pipeline_stage"]);
    }

    // At least one article should have an embedding stored (those that had
    // sufficient content and were processed through phase 1).
    const withEmbeddings = await Promise.all([id1, id2, id3].map((id) => getArticle(db, id)));
    const embeddedCount = withEmbeddings.filter((r) => r!["embedding"] !== null).length;
    expect(embeddedCount).toBeGreaterThan(0);
  });

  // ─── 2. Detects duplicates ─────────────────────────────────────────────────

  it("should mark an article as 'duplicate' when an identical article already exists", async () => {
    // Article A is already embedded — acts as the canonical original.
    const sharedTitle = "Breaking: Central Bank Raises Interest Rates to 5.5%";
    const sharedContent = "The central bank announced a 25 basis point hike amid inflation fears.";

    const idA = await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: sharedTitle,
      contentSnippet: sharedContent,
      pipelineStage: "embedded",
    });

    // Pre-compute and store article A's embedding so the similarity query
    // can find it. The mock provider is deterministic — same text yields same vector.
    const text = `${sharedTitle}\n${sharedContent}`.trim();
    const embeddingA = await embeddingProvider.embed(text);
    const vectorStr = `[${embeddingA.join(",")}]`;

    await db.execute(sql`
      UPDATE articles
      SET
        embedding = ${vectorStr}::vector,
        embedding_model = 'text-embedding-3-small'
      WHERE id = ${idA}::uuid
    `);

    // Article B has identical text — the mock provider will produce the same vector.
    const idB = await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: sharedTitle,
      contentSnippet: sharedContent,
      pipelineStage: "ingested",
    });

    const { eventPublisher } = await runDedupJob();

    // Article A must remain untouched.
    const rowA = await getArticle(db, idA);
    expect(rowA!["pipeline_stage"]).toBe("embedded");

    // Article B must be flagged as a duplicate pointing to A.
    const rowB = await getArticle(db, idB);
    expect(rowB!["pipeline_stage"]).toBe("duplicate");
    expect(rowB!["is_semantic_duplicate"]).toBe(true);
    expect(rowB!["duplicate_of_id"]).toBe(idA);
    expect(rowB!["similarity_score"]).not.toBeNull();

    // The published event must carry the correct duplicate metadata.
    const dupEvent = eventPublisher.events.find(
      (e) =>
        e.type === "article:embedded" &&
        (e.data as Record<string, unknown>)["id"] === idB,
    );
    expect(dupEvent).toBeDefined();
    expect((dupEvent!.data as Record<string, unknown>)["isDuplicate"]).toBe(true);
    expect((dupEvent!.data as Record<string, unknown>)["duplicateOfId"]).toBe(idA);
  });

  // ─── 3. Skips short content ────────────────────────────────────────────────

  it("should pass articles with short content through to 'embedded' without storing an embedding", async () => {
    // Combined text "Hi\nOk" = 5 chars — below the 10-char MIN_TEXT_LENGTH threshold.
    const idShort = await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "Hi",
      contentSnippet: "Ok",
      pipelineStage: "ingested",
    });

    await runDedupJob();

    const row = await getArticle(db, idShort);
    expect(row!["pipeline_stage"]).toBe("embedded");
    // Short-content articles are skipped: no embedding written.
    expect(row!["embedding"]).toBeNull();
  });

  // ─── 4. Publishes events ───────────────────────────────────────────────────

  it("should publish an article:embedded event for each processed article", async () => {
    const ids = await Promise.all([
      seedTestArticle(db, {
        sourceId,
        sectorId,
        title: "Ethereum Proof-of-Stake Migration Complete",
        contentSnippet: "The merge was executed without incident according to core developers.",
        pipelineStage: "ingested",
      }),
      seedTestArticle(db, {
        sourceId,
        sectorId,
        title: "Climate Summit Reaches Historic Emissions Deal",
        contentSnippet: "More than 150 nations committed to new carbon-reduction targets.",
        pipelineStage: "ingested",
      }),
    ]);

    const { eventPublisher } = await runDedupJob();

    const embeddedEvents = eventPublisher.events.filter((e) => e.type === "article:embedded");
    expect(embeddedEvents).toHaveLength(ids.length);

    const publishedIds = embeddedEvents.map(
      (e) => (e.data as Record<string, unknown>)["id"] as string,
    );
    for (const id of ids) {
      expect(publishedIds).toContain(id);
    }

    // Each event must carry the required fields regardless of duplicate status.
    for (const event of embeddedEvents) {
      const data = event.data as Record<string, unknown>;
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("isDuplicate");
    }
  });

  // ─── 5. Triggers LLM queue ─────────────────────────────────────────────────

  it("should add a job to the LLM Brain queue when non-duplicate articles are processed", async () => {
    await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "Quantum Computing Achieves 1000-Qubit Milestone",
      contentSnippet: "Researchers demonstrated quantum advantage on optimization problems.",
      pipelineStage: "ingested",
    });

    const { llmJobCounts } = await runDedupJob();

    const totalLlmJobs = Object.values(llmJobCounts).reduce((sum, n) => sum + n, 0);
    expect(totalLlmJobs).toBeGreaterThan(0);
  });

  // ─── 6. No-op on empty queue ───────────────────────────────────────────────

  it("should complete cleanly without publishing events when no ingested articles exist", async () => {
    // Seed articles in non-ingested stages — the worker must skip them all.
    await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "Already Embedded Article",
      pipelineStage: "embedded",
    });
    await seedTestArticle(db, {
      sourceId,
      sectorId,
      title: "Already Scored Article",
      pipelineStage: "scored",
    });

    const { eventPublisher } = await runDedupJob();

    // No events should have been emitted.
    expect(eventPublisher.events).toHaveLength(0);
  });
});
