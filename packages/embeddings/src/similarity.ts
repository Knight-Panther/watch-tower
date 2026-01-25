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
    threshold?: number; // Max cosine distance (default 0.15 = ~85% similarity)
    limit?: number; // Max results (default 5)
    excludeIds?: string[]; // Article IDs to exclude (e.g., self)
    maxAgeDays?: number; // Only compare against recent articles (default 30)
    currentArticleCreatedAt?: Date | string; // Only match against older articles (accepts ISO string from raw SQL)
  } = {},
): Promise<SimilarArticle[]> => {
  const {
    threshold = 0.15,
    limit = 5,
    excludeIds = [],
    maxAgeDays = 30,
    currentArticleCreatedAt,
  } = options;

  const vectorStr = `[${embedding.join(",")}]`;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  // Build exclude clause for raw SQL
  const excludeClause =
    excludeIds.length > 0
      ? `AND id NOT IN (${excludeIds.map((id) => `'${id}'::uuid`).join(", ")})`
      : "";

  // Build created_at filter for current article
  // Handle both Date objects and ISO strings from raw SQL results
  const createdAtClause = currentArticleCreatedAt
    ? `AND created_at < '${currentArticleCreatedAt instanceof Date ? currentArticleCreatedAt.toISOString() : currentArticleCreatedAt}'`
    : "";

  // Raw SQL for pgvector cosine distance operator
  const result = await db.execute(sql.raw(`
    SELECT
      id,
      title,
      created_at as "createdAt",
      1 - (embedding <=> '${vectorStr}'::vector) as similarity
    FROM articles
    WHERE
      embedding IS NOT NULL
      AND pipeline_stage NOT IN ('duplicate', 'rejected', 'ingested', 'embedding')
      AND is_semantic_duplicate = false
      AND created_at > '${cutoffDate.toISOString()}'
      ${createdAtClause}
      ${excludeClause}
      AND (embedding <=> '${vectorStr}'::vector) < ${threshold}
    ORDER BY embedding <=> '${vectorStr}'::vector, created_at ASC
    LIMIT ${limit}
  `));

  return result.rows as SimilarArticle[];
};
