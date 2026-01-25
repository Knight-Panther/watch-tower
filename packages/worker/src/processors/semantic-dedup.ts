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

type SemanticDedupDeps = {
  connection: { host: string; port: number };
  db: Database;
  embeddingProvider: EmbeddingProvider;
  llmQueue: Queue;
  similarityThreshold: number;
  batchSize?: number;
};

const BATCH_SIZE = 50;
const MIN_TEXT_LENGTH = 10; // Minimum characters to generate meaningful embedding

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

      // 3. Generate embeddings for batch
      const texts = validArticles.map((a) => `${a.title}\n${a.contentSnippet ?? ""}`.trim());

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

      // 4. For each article: save embedding + check for duplicates (atomic per article)
      const nonDuplicateIds: string[] = [];
      const embeddingModel = embeddingProvider.model;

      for (let i = 0; i < validArticles.length; i++) {
        const article = validArticles[i];
        const embedding = embeddings[i];
        const vectorStr = `[${embedding.join(",")}]`;

        // Check for similar articles (only older, non-duplicate articles)
        const similar = await findSimilarArticles(db, embedding, {
          threshold: 1 - similarityThreshold, // Convert similarity to distance
          limit: 1,
          excludeIds: [article.id],
          maxAgeDays: 30,
          currentArticleCreatedAt: article.createdAt,
        });

        if (similar.length > 0) {
          // ATOMIC: Save embedding + mark as duplicate in one update
          const original = similar[0];
          await db.execute(sql`
            UPDATE articles
            SET
              embedding = ${vectorStr}::vector,
              embedding_model = ${embeddingModel},
              pipeline_stage = 'duplicate',
              is_semantic_duplicate = true,
              duplicate_of_id = ${original.id}::uuid,
              similarity_score = ${original.similarity}
            WHERE id = ${article.id}::uuid
          `);

          logger.debug(
            `[semantic-dedup] ${article.id} is duplicate of ${original.id} (${(original.similarity * 100).toFixed(1)}%)`,
          );
        } else {
          // ATOMIC: Save embedding + advance to next stage
          await db.execute(sql`
            UPDATE articles
            SET
              embedding = ${vectorStr}::vector,
              embedding_model = ${embeddingModel},
              pipeline_stage = 'embedded'
            WHERE id = ${article.id}::uuid
          `);

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
