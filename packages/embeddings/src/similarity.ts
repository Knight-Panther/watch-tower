import { sql, type Database } from "@watch-tower/db";

export type SimilarArticle = {
  id: string;
  title: string;
  similarity: number;
  createdAt: Date;
};

/**
 * Find articles similar to the given embedding vector.
 * Uses cosine distance (1 - cosine_similarity).
 * Lower distance = more similar.
 *
 * IMPORTANT: Orders by distance first, then by created_at ASC to ensure
 * older articles are preferred as the "canonical" original. This prevents
 * newer articles from becoming the duplicate target.
 *
 * Also excludes articles that are themselves duplicates to prevent chains
 * (A->B->C). We only link to non-duplicate articles.
 */
export const findSimilarArticles = async (
  db: Database,
  embedding: number[],
  options: {
    threshold?: number; // Max cosine distance (default 0.10 = ~90% similarity)
    limit?: number; // Max results (default 5)
    excludeIds?: string[]; // Article IDs to exclude (e.g., self)
    maxAgeDays?: number; // Only compare against recent articles (default 30)
    currentArticleCreatedAt?: Date | string; // Only match against older articles (accepts ISO string from raw SQL)
    currentArticleId?: string; // For deterministic tie-breaking when timestamps match
  } = {},
): Promise<SimilarArticle[]> => {
  const {
    threshold = 0.1, // 90% similarity (Gemini recommendation: start stricter)
    limit = 5,
    excludeIds = [],
    maxAgeDays = 30,
    currentArticleCreatedAt,
    currentArticleId,
  } = options;

  const vectorStr = `[${embedding.join(",")}]`;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  // Build exclude clause for raw SQL
  const excludeClause =
    excludeIds.length > 0
      ? `AND id NOT IN (${excludeIds.map((id) => `'${id}'::uuid`).join(", ")})`
      : "";

  // Build created_at filter with deterministic tie-breaker for same-timestamp articles
  // Uses UUID comparison when timestamps match to ensure consistent "older" selection
  // This fixes same-batch duplicates that would otherwise both pass as unique
  const ts =
    currentArticleCreatedAt instanceof Date
      ? currentArticleCreatedAt.toISOString()
      : currentArticleCreatedAt;

  const createdAtClause =
    currentArticleCreatedAt && currentArticleId
      ? `AND (created_at < '${ts}' OR (created_at = '${ts}' AND id < '${currentArticleId}'::uuid))`
      : currentArticleCreatedAt
        ? `AND created_at < '${ts}'`
        : "";

  // Raw SQL for pgvector cosine distance operator
  // Two-phase dedup: includes 'embedding' stage articles that already have embeddings
  // This allows concurrent workers to see each other's in-flight articles
  // NULL handling: uses IS NOT TRUE to correctly handle NULL values
  const result = await db.execute(
    sql.raw(`
    SELECT
      id,
      title,
      created_at as "createdAt",
      1 - (embedding <=> '${vectorStr}'::vector) as similarity
    FROM articles
    WHERE
      embedding IS NOT NULL
      AND (
        pipeline_stage NOT IN ('duplicate', 'rejected', 'ingested')
        OR (pipeline_stage = 'embedding' AND embedding IS NOT NULL)
      )
      AND is_semantic_duplicate IS NOT TRUE
      AND created_at > '${cutoffDate.toISOString()}'
      ${createdAtClause}
      ${excludeClause}
      AND (embedding <=> '${vectorStr}'::vector) < ${threshold}
    ORDER BY embedding <=> '${vectorStr}'::vector, created_at ASC
    LIMIT ${limit}
  `),
  );

  return result.rows as SimilarArticle[];
};
