/**
 * Test script for semantic deduplication validation
 *
 * This script tests the semantic dedup logic by:
 * 1. Inserting test articles with known content
 * 2. Manually triggering the semantic-dedup processor
 * 3. Verifying results match expected behavior
 *
 * Usage: npx tsx scripts/test-semantic-dedup.ts
 *
 * Requires: OPENAI_API_KEY and DATABASE_URL in .env
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { createDb } from "@watch-tower/db";
import { createEmbeddingProvider, findSimilarArticles } from "@watch-tower/embeddings";
import { baseEnvSchema, logger, setLogLevel } from "@watch-tower/shared";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

// Test article templates
const TEST_ARTICLES = {
  original: {
    title: "Tesla Reports Record Q4 Deliveries Amid Strong EV Demand",
    snippet:
      "Tesla Inc. announced record vehicle deliveries in the fourth quarter, exceeding analyst expectations as electric vehicle demand continued to surge globally.",
    url: "https://test.local/article-original",
  },
  exactDuplicate: {
    title: "Tesla Reports Record Q4 Deliveries Amid Strong EV Demand",
    snippet:
      "Tesla Inc. announced record vehicle deliveries in the fourth quarter, exceeding analyst expectations as electric vehicle demand continued to surge globally.",
    url: "https://test.local/article-exact-dupe",
  },
  nearDuplicate: {
    title: "Tesla Achieves Record Deliveries in Q4 With Rising EV Demand",
    snippet:
      "The electric vehicle maker Tesla reported record-breaking deliveries for the fourth quarter, surpassing analyst forecasts as global demand for EVs continues to grow.",
    url: "https://test.local/article-near-dupe",
  },
  different: {
    title: "Apple Unveils New MacBook Pro with M3 Chip",
    snippet:
      "Apple today announced the new MacBook Pro featuring the M3 chip, promising significant performance improvements and better battery life for professional users.",
    url: "https://test.local/article-different",
  },
  sameTimestamp1: {
    title: "Bitcoin Hits New All-Time High Above $100K",
    snippet:
      "Bitcoin cryptocurrency surged past $100,000 for the first time in history, driven by institutional investment and growing mainstream adoption.",
    url: "https://test.local/article-same-ts-1",
  },
  sameTimestamp2: {
    title: "Bitcoin Hits New All-Time High Above $100K",
    snippet:
      "Bitcoin cryptocurrency surged past $100,000 for the first time in history, driven by institutional investment and growing mainstream adoption.",
    url: "https://test.local/article-same-ts-2",
  },
};

type TestResult = {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
};

const results: TestResult[] = [];

const addResult = (name: string, passed: boolean, expected: string, actual: string) => {
  results.push({ name, passed, expected, actual });
  const icon = passed ? "✅" : "❌";
  console.log(`${icon} ${name}`);
  if (!passed) {
    console.log(`   Expected: ${expected}`);
    console.log(`   Actual:   ${actual}`);
  }
};

const main = async () => {
  const env = baseEnvSchema.parse(process.env);
  setLogLevel("warn"); // Reduce noise during tests

  if (!env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY required for embedding tests");
    process.exit(1);
  }

  const { db, close } = createDb(env.DATABASE_URL);
  const embeddingProvider = createEmbeddingProvider({
    provider: "openai",
    apiKey: env.OPENAI_API_KEY,
    model: env.EMBEDDING_MODEL,
  });

  console.log("\n🧪 Semantic Deduplication Test Suite\n");
  console.log("═".repeat(50));

  try {
    // Clean up any previous test data
    console.log("\n📋 Cleaning up previous test data...");
    await db.execute(sql`
      DELETE FROM articles WHERE url LIKE 'https://test.local/%'
    `);

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 1: Exact Duplicate Detection
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("\n📝 Test 1: Exact Duplicate Detection\n");

    // Insert original article
    const origResult = await db.execute(sql`
      INSERT INTO articles (url, title, content_snippet, pipeline_stage)
      VALUES (
        ${TEST_ARTICLES.original.url},
        ${TEST_ARTICLES.original.title},
        ${TEST_ARTICLES.original.snippet},
        'ingested'
      )
      RETURNING id, created_at
    `);
    const originalId = (origResult.rows[0] as { id: string }).id;

    // Generate embedding for original
    const [origEmbedding] = await embeddingProvider.embedBatch([
      `${TEST_ARTICLES.original.title}\n${TEST_ARTICLES.original.snippet}`,
    ]);
    const origVectorStr = `[${origEmbedding.join(",")}]`;

    await db.execute(sql`
      UPDATE articles
      SET embedding = ${origVectorStr}::vector,
          embedding_model = ${embeddingProvider.model},
          pipeline_stage = 'embedded'
      WHERE id = ${originalId}::uuid
    `);

    // Insert exact duplicate (should be detected)
    const dupeResult = await db.execute(sql`
      INSERT INTO articles (url, title, content_snippet, pipeline_stage)
      VALUES (
        ${TEST_ARTICLES.exactDuplicate.url},
        ${TEST_ARTICLES.exactDuplicate.title},
        ${TEST_ARTICLES.exactDuplicate.snippet},
        'ingested'
      )
      RETURNING id, created_at
    `);
    const dupeId = (dupeResult.rows[0] as { id: string }).id;
    const dupeCreatedAt = (dupeResult.rows[0] as { created_at: string }).created_at;

    // Generate embedding and check similarity
    const [dupeEmbedding] = await embeddingProvider.embedBatch([
      `${TEST_ARTICLES.exactDuplicate.title}\n${TEST_ARTICLES.exactDuplicate.snippet}`,
    ]);

    const similar = await findSimilarArticles(db, dupeEmbedding, {
      threshold: 0.10, // 90% similarity
      limit: 1,
      excludeIds: [dupeId],
      maxAgeDays: 30,
      currentArticleCreatedAt: dupeCreatedAt,
      currentArticleId: dupeId,
    });

    addResult(
      "Exact duplicate detection",
      similar.length > 0 && similar[0].id === originalId,
      `Should find original article (${originalId})`,
      similar.length > 0
        ? `Found ${similar[0].id} with ${(similar[0].similarity * 100).toFixed(1)}% similarity`
        : "No similar articles found",
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 2: Near Duplicate Detection
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("\n📝 Test 2: Near Duplicate Detection (paraphrased)\n");

    const nearResult = await db.execute(sql`
      INSERT INTO articles (url, title, content_snippet, pipeline_stage)
      VALUES (
        ${TEST_ARTICLES.nearDuplicate.url},
        ${TEST_ARTICLES.nearDuplicate.title},
        ${TEST_ARTICLES.nearDuplicate.snippet},
        'ingested'
      )
      RETURNING id, created_at
    `);
    const nearId = (nearResult.rows[0] as { id: string }).id;
    const nearCreatedAt = (nearResult.rows[0] as { created_at: string }).created_at;

    const [nearEmbedding] = await embeddingProvider.embedBatch([
      `${TEST_ARTICLES.nearDuplicate.title}\n${TEST_ARTICLES.nearDuplicate.snippet}`,
    ]);

    const nearSimilar = await findSimilarArticles(db, nearEmbedding, {
      threshold: 0.10, // 90% similarity
      limit: 1,
      excludeIds: [nearId],
      maxAgeDays: 30,
      currentArticleCreatedAt: nearCreatedAt,
      currentArticleId: nearId,
    });

    addResult(
      "Near duplicate detection (paraphrased)",
      nearSimilar.length > 0 && nearSimilar[0].id === originalId,
      `Should find original article (${originalId})`,
      nearSimilar.length > 0
        ? `Found ${nearSimilar[0].id} with ${(nearSimilar[0].similarity * 100).toFixed(1)}% similarity`
        : "No similar articles found (threshold may be too strict)",
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 3: Different Content (should NOT match)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("\n📝 Test 3: Different Content (should NOT match)\n");

    const diffResult = await db.execute(sql`
      INSERT INTO articles (url, title, content_snippet, pipeline_stage)
      VALUES (
        ${TEST_ARTICLES.different.url},
        ${TEST_ARTICLES.different.title},
        ${TEST_ARTICLES.different.snippet},
        'ingested'
      )
      RETURNING id, created_at
    `);
    const diffId = (diffResult.rows[0] as { id: string }).id;
    const diffCreatedAt = (diffResult.rows[0] as { created_at: string }).created_at;

    const [diffEmbedding] = await embeddingProvider.embedBatch([
      `${TEST_ARTICLES.different.title}\n${TEST_ARTICLES.different.snippet}`,
    ]);

    const diffSimilar = await findSimilarArticles(db, diffEmbedding, {
      threshold: 0.10, // 90% similarity
      limit: 1,
      excludeIds: [diffId],
      maxAgeDays: 30,
      currentArticleCreatedAt: diffCreatedAt,
      currentArticleId: diffId,
    });

    addResult(
      "Different content (no false positive)",
      diffSimilar.length === 0,
      "Should NOT find any similar articles",
      diffSimilar.length > 0
        ? `False positive! Found ${diffSimilar[0].id} with ${(diffSimilar[0].similarity * 100).toFixed(1)}% similarity`
        : "No similar articles found (correct)",
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 4: Same Timestamp Tie-Breaker
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("\n📝 Test 4: Same Timestamp Tie-Breaker\n");

    // Insert two identical articles with the same timestamp
    const fixedTimestamp = new Date().toISOString();

    const ts1Result = await db.execute(sql`
      INSERT INTO articles (url, title, content_snippet, pipeline_stage, created_at)
      VALUES (
        ${TEST_ARTICLES.sameTimestamp1.url},
        ${TEST_ARTICLES.sameTimestamp1.title},
        ${TEST_ARTICLES.sameTimestamp1.snippet},
        'embedded',
        ${fixedTimestamp}::timestamptz
      )
      RETURNING id
    `);
    const ts1Id = (ts1Result.rows[0] as { id: string }).id;

    // Generate and save embedding for first article
    const [ts1Embedding] = await embeddingProvider.embedBatch([
      `${TEST_ARTICLES.sameTimestamp1.title}\n${TEST_ARTICLES.sameTimestamp1.snippet}`,
    ]);
    const ts1VectorStr = `[${ts1Embedding.join(",")}]`;

    await db.execute(sql`
      UPDATE articles
      SET embedding = ${ts1VectorStr}::vector,
          embedding_model = ${embeddingProvider.model}
      WHERE id = ${ts1Id}::uuid
    `);

    const ts2Result = await db.execute(sql`
      INSERT INTO articles (url, title, content_snippet, pipeline_stage, created_at)
      VALUES (
        ${TEST_ARTICLES.sameTimestamp2.url},
        ${TEST_ARTICLES.sameTimestamp2.title},
        ${TEST_ARTICLES.sameTimestamp2.snippet},
        'ingested',
        ${fixedTimestamp}::timestamptz
      )
      RETURNING id
    `);
    const ts2Id = (ts2Result.rows[0] as { id: string }).id;

    // Check if article 2 finds article 1 (they have same timestamp, should use UUID tie-breaker)
    const tsSimilar = await findSimilarArticles(db, ts1Embedding, {
      threshold: 0.10,
      limit: 1,
      excludeIds: [ts2Id],
      maxAgeDays: 30,
      currentArticleCreatedAt: fixedTimestamp,
      currentArticleId: ts2Id,
    });

    // One of them should be detected as duplicate of the other (based on UUID order)
    const foundMatch = tsSimilar.length > 0;

    addResult(
      "Same timestamp tie-breaker (UUID comparison)",
      foundMatch,
      "Should find match using UUID tie-breaker",
      foundMatch
        ? `Found ${tsSimilar[0].id} with ${(tsSimilar[0].similarity * 100).toFixed(1)}% similarity`
        : "No match found - tie-breaker may not be working",
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // CLEANUP
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("\n📋 Cleaning up test data...");
    await db.execute(sql`
      DELETE FROM articles WHERE url LIKE 'https://test.local/%'
    `);

    // ═══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("\n" + "═".repeat(50));
    console.log("📊 TEST SUMMARY\n");

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    console.log(`Total:  ${results.length}`);
    console.log(`Passed: ${passed} ✅`);
    console.log(`Failed: ${failed} ❌`);

    if (failed > 0) {
      console.log("\n⚠️  Some tests failed. Review the output above for details.");
    } else {
      console.log("\n🎉 All tests passed! Semantic dedup is working correctly.");
    }

    console.log("\n" + "═".repeat(50) + "\n");
  } catch (err) {
    console.error("\n❌ Test execution failed:", err);
    process.exit(1);
  } finally {
    await close();
  }

  process.exit(results.every((r) => r.passed) ? 0 : 1);
};

main();
