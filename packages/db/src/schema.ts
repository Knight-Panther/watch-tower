import {
  pgTable,
  uuid,
  text,
  boolean,
  smallint,
  integer,
  real,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Custom Types ────────────────────────────────────────────────────────────

// pgvector custom type for embedding storage
const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    const dimensions = (config as { dimensions?: number })?.dimensions ?? 1536;
    return `vector(${dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // Handle both "[1,2,3]" and "1,2,3" formats
    const cleaned = value.replace(/^\[|\]$/g, "");
    return cleaned.split(",").map(Number);
  },
});

// ─── Sectors ─────────────────────────────────────────────────────────────────

export const sectors = pgTable("sectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  defaultMaxAgeDays: smallint("default_max_age_days").notNull().default(5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── RSS Sources ─────────────────────────────────────────────────────────────

export const rssSources = pgTable("rss_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull().unique(),
  name: text("name"),
  active: boolean("active").notNull().default(true),
  sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "set null" }),
  maxAgeDays: smallint("max_age_days"),
  ingestIntervalMinutes: smallint("ingest_interval_minutes").notNull().default(15),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
});

// ─── Articles ────────────────────────────────────────────────────────────────

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").references(() => rssSources.id, { onDelete: "set null" }),
    sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "set null" }),
    url: text("url").notNull().unique(),
    title: text("title").notNull(),
    contentSnippet: text("content_snippet"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    pipelineStage: text("pipeline_stage").notNull().default("ingested"),
    // Semantic dedup fields
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    isSemanticDuplicate: boolean("is_semantic_duplicate").notNull().default(false),
    duplicateOfId: uuid("duplicate_of_id"),
    similarityScore: real("similarity_score"),
    // LLM scoring fields
    importanceScore: smallint("importance_score"),
    llmSummary: text("llm_summary"),
    scoringModel: text("scoring_model"),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_articles_source_published").on(table.sourceId, table.publishedAt),
    index("idx_articles_sector_stage").on(table.sectorId, table.pipelineStage),
    index("idx_articles_stage").on(table.pipelineStage),
  ],
);

// ─── Scoring Rules ───────────────────────────────────────────────────────────

export const scoringRules = pgTable("scoring_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  sectorId: uuid("sector_id")
    .notNull()
    .references(() => sectors.id, { onDelete: "cascade" })
    .unique(),
  promptTemplate: text("prompt_template").notNull(),
  scoreCriteria: jsonb("score_criteria").notNull().default({}),
  modelPreference: text("model_preference").default("claude"),
  autoApproveThreshold: smallint("auto_approve_threshold").notNull().default(5),
  autoRejectThreshold: smallint("auto_reject_threshold").notNull().default(2),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Post Batches ────────────────────────────────────────────────────────────

export const postBatches = pgTable("post_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "set null" }),
  status: text("status").notNull().default("draft"),
  format: text("format").notNull().default("top5"),
  contentText: text("content_text"),
  articleIds: uuid("article_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Social Accounts ─────────────────────────────────────────────────────────

export const socialAccounts = pgTable("social_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: text("platform").notNull(),
  accountName: text("account_name").notNull(),
  credentials: jsonb("credentials").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  sectorIds: uuid("sector_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  rateLimitPerHour: smallint("rate_limit_per_hour").notNull().default(4),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Post Deliveries ─────────────────────────────────────────────────────────

export const postDeliveries = pgTable("post_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => postBatches.id, { onDelete: "cascade" }),
  socialAccountId: uuid("social_account_id")
    .notNull()
    .references(() => socialAccounts.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  status: text("status").notNull().default("pending"),
  platformPostId: text("platform_post_id"),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Feed Fetch Runs (telemetry) ─────────────────────────────────────────────

export const feedFetchRuns = pgTable("feed_fetch_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => rssSources.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  itemCount: integer("item_count"),
  itemAdded: integer("item_added"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── LLM Telemetry ──────────────────────────────────────────────────────────

export const llmTelemetry = pgTable(
  "llm_telemetry",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // What was processed (nullable for batch operations like embeddings)
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "set null" }),
    operation: text("operation").notNull(), // 'score_and_summarize', 'embed_batch'

    // Provider info
    provider: text("provider").notNull(), // 'deepseek', 'openai', 'claude'
    model: text("model").notNull(), // 'deepseek-chat', 'gpt-4o-mini'
    isFallback: boolean("is_fallback").notNull().default(false),

    // Token counts
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),

    // Cost (in USD microdollars for precision: $1 = 1,000,000 microdollars)
    costMicrodollars: integer("cost_microdollars"),

    // Timing
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_llm_telemetry_created").on(table.createdAt),
    index("idx_llm_telemetry_provider").on(table.provider),
    index("idx_llm_telemetry_operation").on(table.operation),
  ],
);

// ─── App Config ──────────────────────────────────────────────────────────────

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
