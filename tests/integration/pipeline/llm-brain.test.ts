/**
 * Integration tests for the LLM Brain pipeline processor.
 *
 * Uses real PostgreSQL and Redis, with a mocked LLM provider to avoid
 * hitting real APIs. Tests verify end-to-end article scoring behaviour:
 * stage transitions, auto-approve/reject, pre-filter, telemetry, events,
 * per-sector thresholds, and the no-op empty-batch path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { QUEUE_LLM_BRAIN, JOB_LLM_SCORE_BATCH } from "@watch-tower/shared";
import { createLLMBrainWorker, matchesKeyword } from "@watch-tower/worker/processors/llm-brain";
import {
  getTestDb,
  closeTestDb,
  cleanArticleTables,
  seedTestSector,
  seedTestArticle,
  getArticle,
} from "../../helpers/test-db.js";
import {
  getTestRedis,
  getTestRedisConnection,
  closeTestRedis,
  cleanTestRedisKeys,
} from "../../helpers/test-redis.js";
import { createMockLLMProvider, createMockEventPublisher } from "../../helpers/mock-providers.js";

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Run one llm-score-batch job through the worker and wait for it to finish.
 * Uses polling to detect when the queue drains (same proven approach as
 * semantic-dedup tests). More reliable than worker events on Windows.
 */
const runBrainJob = async (
  deps: Parameters<typeof createLLMBrainWorker>[0],
): Promise<void> => {
  const connection = getTestRedisConnection();
  const queue = new Queue(QUEUE_LLM_BRAIN, { connection });
  const worker = createLLMBrainWorker(deps);

  try {
    await worker.waitUntilReady();
    await queue.add(JOB_LLM_SCORE_BATCH, {});

    // Poll until the queue drains — same pattern as semantic-dedup.test.ts.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("runBrainJob timed out after 12 s")),
        12_000,
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
  } finally {
    await worker.close();
    await queue.close();
  }
};

/**
 * Upsert app_config threshold keys so the worker uses predictable values
 * regardless of what the seed data contains.
 * Values are passed as jsonb-compatible strings (e.g. "5" stores as json number 5).
 */
const setAppConfigThresholds = async (
  db: ReturnType<typeof getTestDb>["db"],
  approveAt: number,
  rejectAt: number,
): Promise<void> => {
  // Use sql.raw for the numeric literal so PostgreSQL treats it as a jsonb number, not a string.
  await db.execute(
    sql.raw(
      `INSERT INTO app_config (key, value) VALUES ('auto_approve_threshold', '${approveAt}'), ('auto_reject_threshold', '${rejectAt}')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ),
  );
};

/**
 * Remove any scoring_rules rows to avoid cross-test contamination.
 * cleanArticleTables() does not touch scoring_rules.
 */
const cleanScoringRules = async (db: ReturnType<typeof getTestDb>["db"]): Promise<void> => {
  await db.execute(sql`DELETE FROM scoring_rules`);
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("LLM Brain processor — integration", () => {
  const { db } = getTestDb();

  beforeAll(async () => {
    const redis = getTestRedis();
    await redis.connect();
    await cleanArticleTables(db);
    await cleanScoringRules(db);
    await cleanTestRedisKeys(redis);

    // Obliterate the LLM brain queue to remove ALL state: repeatable schedules,
    // delayed jobs, completed/failed history, etc. This prevents dev scheduler
    // artifacts from interfering with tests.
    const connection = getTestRedisConnection();
    const cleanupQueue = new Queue(QUEUE_LLM_BRAIN, { connection });
    await cleanupQueue.obliterate({ force: true });
    await cleanupQueue.close();
  }, 30_000);

  afterAll(async () => {
    await closeTestDb();
    await closeTestRedis();
  });

  beforeEach(async () => {
    const redis = getTestRedis();
    await cleanArticleTables(db);
    await cleanScoringRules(db);
    await cleanTestRedisKeys(redis);

    // Restore predictable global thresholds before every test.
    await setAppConfigThresholds(db, 5, 2);
  });

  // ─── matchesKeyword unit check ─────────────────────────────────────────────

  describe("matchesKeyword()", () => {
    it("should match a whole word, case-insensitively", () => {
      expect(matchesKeyword("Sponsored Post About Tech", "sponsored")).toBe(true);
      expect(matchesKeyword("SPONSORED POST", "sponsored")).toBe(true);
    });

    it("should not match when keyword is only a substring of another word", () => {
      // "AI" must not match inside "FAIRY" — the canonical word-boundary guard
      expect(matchesKeyword("The FAIRY tale model", "AI")).toBe(false);
    });

    it("should match standalone occurrence of keyword even when similar words exist", () => {
      expect(matchesKeyword("The FAIRY tale AI model", "AI")).toBe(true);
    });

    it("should match special regex characters as literals", () => {
      // A dot in the keyword must be treated as a literal dot, not a regex wildcard
      expect(matchesKeyword("v1.0 release", "v1.0")).toBe(true);
      expect(matchesKeyword("v100 release", "v1.0")).toBe(false);
    });
  });

  // ─── 1. Scores articles and sets pipeline_stage ───────────────────────────

  it("should score 3 articles and set pipeline_stage to scored with importance_score, llm_summary, and score_reasoning", async () => {
    const sectorId = await seedTestSector(db, "Finance", "finance");
    const ids = await Promise.all([
      seedTestArticle(db, { pipelineStage: "embedded", sectorId, title: "Article Alpha" }),
      seedTestArticle(db, { pipelineStage: "embedded", sectorId, title: "Article Beta" }),
      seedTestArticle(db, { pipelineStage: "embedded", sectorId, title: "Article Gamma" }),
    ]);

    const mockLlm = createMockLLMProvider(3, "Test summary from mock LLM.");
    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    for (const id of ids) {
      const row = await getArticle(db, id);
      expect(row, `article ${id} should exist`).not.toBeNull();
      expect(row!.pipeline_stage, "stage").toBe("scored");
      expect(row!.importance_score, "score").toBe(3);
      expect(row!.llm_summary, "summary").toBeTruthy();
      expect(row!.score_reasoning, "reasoning").toBeTruthy();
    }

    // All 3 articles should have been sent to the LLM
    expect(mockLlm.scoreCalls).toHaveLength(3);
  });

  // ─── 2. Auto-approves high scores ─────────────────────────────────────────

  it("should auto-approve an article when LLM returns score >= autoApproveThreshold and set approved_at", async () => {
    const sectorId = await seedTestSector(db, "Tech", "tech");
    const id = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Breakthrough in Quantum Computing",
    });

    const mockLlm = createMockLLMProvider(5);
    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    const row = await getArticle(db, id);
    expect(row!.pipeline_stage).toBe("approved");
    expect(row!.importance_score).toBe(5);
    expect(row!.approved_at).not.toBeNull();

    const approvedEvent = eventPublisher.events.find(
      (e) => e.type === "article:approved" && (e.data as { id: string }).id === id,
    );
    expect(approvedEvent, "article:approved event should be published").toBeDefined();
  });

  // ─── 3. Auto-rejects low scores ───────────────────────────────────────────

  it("should auto-reject an article when LLM returns score <= autoRejectThreshold and set rejection_reason", async () => {
    const sectorId = await seedTestSector(db, "Sports", "sports");
    const id = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Local Team Loses Again",
    });

    const mockLlm = createMockLLMProvider(1);
    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    const row = await getArticle(db, id);
    expect(row!.pipeline_stage).toBe("rejected");
    expect(row!.importance_score).toBe(1);
    expect(row!.rejection_reason).toBe("llm-score: 1");

    const rejectedEvent = eventPublisher.events.find(
      (e) => e.type === "article:rejected" && (e.data as { id: string }).id === id,
    );
    expect(rejectedEvent, "article:rejected event should be published").toBeDefined();
  });

  // ─── 4. Pre-filter rejects articles matching reject_keywords ──────────────

  it("should hard-reject an article whose title matches a sector reject_keyword before calling LLM", async () => {
    const sectorId = await seedTestSector(db, "Media", "media");

    // Insert a scoring rule with rejectKeywords — the pre-filter reads this before scoring.
    await db.execute(sql`
      INSERT INTO scoring_rules (
        sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold
      )
      VALUES (
        ${sectorId}::uuid,
        'Test prompt template',
        '{"rejectKeywords": ["sponsored"]}'::jsonb,
        5,
        2
      )
    `);

    const id = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Sponsored Post About New Tech Gadgets",
    });

    const mockLlm = createMockLLMProvider(3);
    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    const row = await getArticle(db, id);
    expect(row!.pipeline_stage).toBe("rejected");
    expect(String(row!.rejection_reason)).toMatch(/pre-filter/);
    expect(String(row!.rejection_reason)).toMatch(/sponsored/i);

    // LLM must NOT have been called — pre-filter is a cost gate
    expect(mockLlm.scoreCalls).toHaveLength(0);

    // A rejection event should still be published (for the SSE dashboard)
    const rejectedEvent = eventPublisher.events.find(
      (e) => e.type === "article:rejected" && (e.data as { id: string }).id === id,
    );
    expect(rejectedEvent, "article:rejected event should be published for pre-filtered article").toBeDefined();
  });

  // ─── 5. Records LLM telemetry ─────────────────────────────────────────────

  it("should write a row to llm_telemetry with provider, model, and token counts after scoring", async () => {
    const sectorId = await seedTestSector(db, "Crypto", "crypto");
    await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Bitcoin Hits New All-Time High",
    });

    const mockLlm = createMockLLMProvider(4);
    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    const telemetry = await db.execute(sql`
      SELECT * FROM llm_telemetry WHERE operation = 'score_and_summarize'
    `);
    expect(telemetry.rows.length).toBeGreaterThanOrEqual(1);

    const row = telemetry.rows[0] as Record<string, unknown>;
    expect(row.provider).toBe("mock");
    expect(row.model).toBe("mock-model-v1");
    expect(row.status).toBe("success");
    expect(Number(row.input_tokens)).toBeGreaterThan(0);
    expect(Number(row.output_tokens)).toBeGreaterThan(0);
  });

  // ─── 6. Publishes correct events ──────────────────────────────────────────

  it("should publish article:approved, article:scored, and article:rejected events for different scores in one batch", async () => {
    const sectorId = await seedTestSector(db, "Politics", "politics");

    // Seed 3 articles with distinct score overrides
    const highId = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Major Policy Announcement",
    });
    const midId = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Minor Policy Update",
    });
    const lowId = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "Routine Committee Meeting",
    });

    const mockLlm = createMockLLMProvider(3);
    mockLlm.setScoreMap({
      [highId]: 5, // auto-approve threshold (5)
      [midId]: 3,  // manual review zone
      [lowId]: 1,  // auto-reject threshold (2)
    });

    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    const eventTypesFor = (id: string) =>
      eventPublisher.events
        .filter((e) => (e.data as { id: string }).id === id)
        .map((e) => e.type);

    expect(eventTypesFor(highId)).toContain("article:approved");
    expect(eventTypesFor(midId)).toContain("article:scored");
    expect(eventTypesFor(lowId)).toContain("article:rejected");
  });

  // ─── 7. Per-sector thresholds ─────────────────────────────────────────────

  it("should auto-approve a score-4 article when the sector scoring_rule overrides autoApproveThreshold to 4", async () => {
    const sectorId = await seedTestSector(db, "Biotech", "biotech");

    // Sector rule lowers the approval bar from the global 5 to 4.
    await db.execute(sql`
      INSERT INTO scoring_rules (
        sector_id, prompt_template, score_criteria, auto_approve_threshold, auto_reject_threshold
      )
      VALUES (
        ${sectorId}::uuid,
        'Biotech scoring prompt',
        '{}'::jsonb,
        4,
        2
      )
    `);

    const id = await seedTestArticle(db, {
      pipelineStage: "embedded",
      sectorId,
      title: "CRISPR Gene Editing Breakthrough Published in Nature",
    });

    const mockLlm = createMockLLMProvider(4);
    const eventPublisher = createMockEventPublisher();

    // Global threshold is 5 — without the sector override, score 4 would only reach 'scored'.
    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    const row = await getArticle(db, id);
    expect(row!.pipeline_stage).toBe("approved");
    expect(row!.approved_at).not.toBeNull();

    const approvedEvent = eventPublisher.events.find(
      (e) => e.type === "article:approved" && (e.data as { id: string }).id === id,
    );
    expect(approvedEvent, "article:approved event should be published").toBeDefined();
  });

  // ─── 8. No-op when no embedded articles ───────────────────────────────────

  it("should complete cleanly without scoring anything when no articles are in embedded stage", async () => {
    // Seed articles in non-embedded stages — the worker must ignore them all.
    const sectorId = await seedTestSector(db, "Energy", "energy");
    const ingestedId = await seedTestArticle(db, {
      pipelineStage: "ingested",
      sectorId,
      title: "Article still at ingested stage",
    });
    const alreadyScoredId = await seedTestArticle(db, {
      pipelineStage: "scored",
      sectorId,
      title: "Article already scored",
    });

    const mockLlm = createMockLLMProvider(3);
    const eventPublisher = createMockEventPublisher();

    await runBrainJob({
      connection: getTestRedisConnection(),
      db,
      llmProvider: mockLlm,
      eventPublisher,
      autoApproveThreshold: 5,
      autoRejectThreshold: 2,
    });

    // No LLM calls were made
    expect(mockLlm.scoreCalls).toHaveLength(0);

    // No events were published
    expect(eventPublisher.events).toHaveLength(0);

    // Pipeline stages are unchanged
    const ingested = await getArticle(db, ingestedId);
    const scored = await getArticle(db, alreadyScoredId);
    expect(ingested!.pipeline_stage).toBe("ingested");
    expect(scored!.pipeline_stage).toBe("scored");
  });
});
