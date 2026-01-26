import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  QUEUE_SEMANTIC_DEDUP,
  JOB_SEMANTIC_BATCH,
  JOB_LLM_SCORE_BATCH,
  logger,
} from "@watch-tower/shared";
import { type Database } from "@watch-tower/db";
import { type EmbeddingProvider, findSimilarArticles } from "@watch-tower/embeddings";
import type { Queue } from "bullmq";
import type { EventPublisher } from "../events.js";

type SemanticDedupDeps = {
  connection: { host: string; port: number };
  db: Database;
  embeddingProvider: EmbeddingProvider;
  llmQueue: Queue;
  similarityThreshold: number;
  batchSize?: number;
  eventPublisher: EventPublisher;
};

const BATCH_SIZE = 50;
const MIN_TEXT_LENGTH = 10; // Minimum characters to generate meaningful embedding
const MAX_EMBEDDING_CHARS = 30000; // ~7500 tokens, safe margin for text-embedding-3-small (8192 limit)

type ClaimedArticle = {
  id: string;
  title: string;
  contentSnippet: string | null;
  createdAt: string; // ISO string from raw SQL RETURNING (not Date)
};

export const createSemanticDedupWorker = ({
  connection,
  db,
  embeddingProvider,
  llmQueue,
  similarityThreshold,
  batchSize = BATCH_SIZE,
  eventPublisher,
}: SemanticDedupDeps) =>
  new Worker(
    QUEUE_SEMANTIC_DEDUP,
    async (job) => {
      if (job.name !== JOB_SEMANTIC_BATCH) return;

      // 1. CLAIM articles atomically using FOR UPDATE SKIP LOCKED
      // This prevents multiple workers from processing the same articles
      // and uses 'embedding' as intermediate stage to prevent stuck rows
      const claimResult = await db.execute(sql`
        UPDATE articles
        SET pipeline_stage = 'embedding'
        WHERE id IN (
          SELECT id FROM articles
          WHERE pipeline_stage = 'ingested'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        RETURNING id, title, content_snippet as "contentSnippet", created_at as "createdAt"
      `);

      const claimedArticles = claimResult.rows as ClaimedArticle[];

      if (claimedArticles.length === 0) {
        logger.debug("[semantic-dedup] no pending articles");
        return;
      }

      logger.info(`[semantic-dedup] claimed ${claimedArticles.length} articles`);

      // 2. Filter out empty/short content that would produce poor embeddings
      const validArticles: ClaimedArticle[] = [];
      const skippedIds: string[] = [];

      for (const article of claimedArticles) {
        const text = `${article.title}\n${article.contentSnippet ?? ""}`.trim();
        if (text.length >= MIN_TEXT_LENGTH) {
          validArticles.push(article);
        } else {
          skippedIds.push(article.id);
          logger.warn(
            `[semantic-dedup] skipping ${article.id}: insufficient text (${text.length} chars)`,
          );
        }
      }

      // Mark skipped articles as embedded (pass through) to avoid blocking pipeline
      if (skippedIds.length > 0) {
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'embedded'
          WHERE id = ANY(${skippedIds}::uuid[])
        `);
      }

      if (validArticles.length === 0) {
        return;
      }

      // 3. Generate embeddings for batch (with token truncation for API safety)
      const texts = validArticles.map((a) =>
        `${a.title}\n${a.contentSnippet ?? ""}`.trim().slice(0, MAX_EMBEDDING_CHARS),
      );

      let embeddings: number[][];
      try {
        embeddings = await embeddingProvider.embedBatch(texts);
      } catch (err) {
        // On failure, reset articles back to 'ingested' so they can be retried
        const failedIds = validArticles.map((a) => a.id);
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'ingested'
          WHERE id = ANY(${failedIds}::uuid[])
        `);
        logger.error("[semantic-dedup] embedding generation failed, reset articles", err);
        throw err; // Will retry via BullMQ
      }

      // 4. TWO-PHASE DEDUP APPROACH (fixes concurrent worker race condition)
      // Phase 1: Save all embeddings first (keeps pipeline_stage = 'embedding')
      // This makes embeddings visible to other workers immediately
      const embeddingModel = embeddingProvider.model;

      for (let i = 0; i < validArticles.length; i++) {
        const article = validArticles[i];
        const embedding = embeddings[i];
        const vectorStr = `[${embedding.join(",")}]`;

        await db.execute(sql`
          UPDATE articles
          SET
            embedding = ${vectorStr}::vector,
            embedding_model = ${embeddingModel}
          WHERE id = ${article.id}::uuid
        `);
      }

      logger.debug(`[semantic-dedup] Phase 1 complete: saved ${validArticles.length} embeddings`);

      // Phase 2: Run dedup checks (now other workers can see our embeddings)
      const nonDuplicateIds: string[] = [];

      for (let i = 0; i < validArticles.length; i++) {
        const article = validArticles[i];
        const embedding = embeddings[i];
        const vectorStr = `[${embedding.join(",")}]`;

        // Check for similar articles - now includes 'embedding' stage with embeddings
        // Uses UUID tie-breaker for same-timestamp articles
        const similar = await findSimilarArticles(db, embedding, {
          threshold: 1 - similarityThreshold, // Convert similarity to distance
          limit: 1,
          excludeIds: [article.id],
          maxAgeDays: 30,
          currentArticleCreatedAt: article.createdAt,
          currentArticleId: article.id, // For deterministic tie-breaking
        });

        if (similar.length > 0) {
          // Mark as duplicate
          const original = similar[0];
          await db.execute(sql`
            UPDATE articles
            SET
              pipeline_stage = 'duplicate',
              is_semantic_duplicate = true,
              duplicate_of_id = ${original.id}::uuid,
              similarity_score = ${original.similarity}
            WHERE id = ${article.id}::uuid
          `);

          // Publish duplicate event
          await eventPublisher.publish({
            type: "article:embedded",
            data: {
              id: article.id,
              isDuplicate: true,
              duplicateOfId: original.id,
              similarityScore: original.similarity,
            },
          });

          logger.debug(
            `[semantic-dedup] ${article.id} is duplicate of ${original.id} (${(original.similarity * 100).toFixed(1)}%)`,
          );
        } else {
          // Advance to next stage
          await db.execute(sql`
            UPDATE articles
            SET pipeline_stage = 'embedded'
            WHERE id = ${article.id}::uuid
          `);

          // Publish embedded event
          await eventPublisher.publish({
            type: "article:embedded",
            data: {
              id: article.id,
              isDuplicate: false,
              duplicateOfId: null,
              similarityScore: null,
            },
          });

          nonDuplicateIds.push(article.id);
        }
      }

      logger.info(
        `[semantic-dedup] ${nonDuplicateIds.length}/${validArticles.length} unique articles`,
      );

      // 5. Queue non-duplicates for LLM scoring
      if (nonDuplicateIds.length > 0) {
        const LLM_BATCH_SIZE = 10;
        for (let i = 0; i < nonDuplicateIds.length; i += LLM_BATCH_SIZE) {
          const batch = nonDuplicateIds.slice(i, i + LLM_BATCH_SIZE);
          await llmQueue.add(JOB_LLM_SCORE_BATCH, { articleIds: batch });
        }
      }
    },
    { connection, concurrency: 2 },
  );
