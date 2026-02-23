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
  defaultMaxAgeDays: smallint("default_max_age_days").notNull().default(1),
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
  // Security: per-source quota overrides (NULL = use global default)
  maxArticlesPerFetch: integer("max_articles_per_fetch"),
  maxArticlesPerDay: integer("max_articles_per_day"),
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
    author: text("author"),
    contentSnippet: text("content_snippet"),
    articleCategories: text("article_categories").array(),
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
    scoreReasoning: text("score_reasoning"),
    rejectionReason: text("rejection_reason"),
    scoringModel: text("scoring_model"),
    // Georgian translation fields
    titleKa: text("title_ka"),
    llmSummaryKa: text("llm_summary_ka"),
    translationModel: text("translation_model"),
    translationStatus: text("translation_status"), // NULL | 'translating' | 'translated' | 'failed' | 'exhausted'
    translationAttempts: integer("translation_attempts").default(0).notNull(),
    translationError: text("translation_error"),
    translatedAt: timestamp("translated_at", { withTimezone: true }),
    // Posting retry tracking
    postingAttempts: integer("posting_attempts").notNull().default(0),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_articles_source_published").on(table.sourceId, table.publishedAt),
    index("idx_articles_sector_stage").on(table.sectorId, table.pipelineStage),
    index("idx_articles_stage").on(table.pipelineStage),
    // Translation worker: WHERE importance_score = ANY([4,5]) AND translation_status IS NULL
    index("idx_articles_translation").on(
      table.importanceScore,
      table.translationStatus,
      table.createdAt,
    ),
    // Maintenance zombie reset: WHERE pipeline_stage IN (...) AND created_at < threshold
    index("idx_articles_stage_created").on(table.pipelineStage, table.createdAt),
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
  autoApproveThreshold: smallint("auto_approve_threshold").notNull().default(5),
  autoRejectThreshold: smallint("auto_reject_threshold").notNull().default(2),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Social Accounts ─────────────────────────────────────────────────────────

export const socialAccounts = pgTable("social_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: text("platform").notNull(),
  accountName: text("account_name").notNull(),
  credentials: jsonb("credentials").notNull().default({}),
  postTemplate: jsonb("post_template"), // PostTemplateConfig from @watch-tower/shared
  isActive: boolean("is_active").notNull().default(true),
  rateLimitPerHour: smallint("rate_limit_per_hour").notNull().default(4),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Post Deliveries (scheduled/immediate posting) ───────────────────────────

export const postDeliveries = pgTable(
  "post_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // 'telegram' | 'facebook' | 'linkedin'
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }), // null = immediate
    status: text("status").notNull().default("scheduled"), // 'scheduled' | 'posting' | 'posted' | 'failed' | 'cancelled'
    platformPostId: text("platform_post_id"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_post_deliveries_due").on(table.scheduledAt),
    index("idx_post_deliveries_article").on(table.articleId),
    index("idx_post_deliveries_status").on(table.status),
    // Prevent duplicate active deliveries per article+platform
    // Only one 'scheduled' or 'posting' delivery can exist at a time
    uniqueIndex("idx_post_deliveries_active_unique")
      .on(table.articleId, table.platform)
      .where(sql`status IN ('scheduled', 'posting')`),
  ],
);

// ─── Feed Fetch Runs (telemetry) ─────────────────────────────────────────────

export const feedFetchRuns = pgTable(
  "feed_fetch_runs",
  {
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
  },
  (table) => [
    // Stats endpoint + maintenance scheduler: WHERE source_id = ? AND status = 'success'
    index("idx_feed_fetch_runs_source_status").on(table.sourceId, table.status, table.createdAt),
  ],
);

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

    // Outcome
    status: text("status").notNull().default("success"), // 'success' | 'error'
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_llm_telemetry_created").on(table.createdAt),
    index("idx_llm_telemetry_provider").on(table.provider),
    index("idx_llm_telemetry_operation").on(table.operation),
  ],
);

// ─── Article Images (AI-generated news card images) ─────────────────────────

export const articleImages = pgTable(
  "article_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),

    // Generation details
    provider: text("provider").notNull(), // 'gpt-image-mini', 'dalle', 'stable'
    model: text("model"),
    prompt: text("prompt").notNull(),

    // Result
    imageUrl: text("image_url"),
    r2Key: text("r2_key"), // R2 object key for cleanup
    status: text("status").notNull().default("pending"), // 'pending', 'generating', 'ready', 'failed'
    errorMessage: text("error_message"),

    // Cost tracking (microdollars)
    costMicrodollars: integer("cost_microdollars"),

    // Timing
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Image generation polling + TTL cleanup
    index("idx_article_images_created").on(table.createdAt),
  ],
);

// ─── App Config ──────────────────────────────────────────────────────────────

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Platform Health ─────────────────────────────────────────────────────────

export const platformHealth = pgTable("platform_health", {
  platform: text("platform").primaryKey(), // 'telegram' | 'facebook' | 'linkedin'
  healthy: boolean("healthy").notNull().default(false),
  error: text("error"),

  // Token tracking
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  tokenFirstSeenAt: timestamp("token_first_seen_at", { withTimezone: true }),
  tokenHash: text("token_hash"), // SHA256 of token - detect rotation

  // Platform API rate limits (informational - captured from health check response)
  rateLimitRemaining: integer("rate_limit_remaining"),
  rateLimitMax: integer("rate_limit_max"),
  rateLimitPercent: integer("rate_limit_percent"), // Facebook: 0-100
  rateLimitResetsAt: timestamp("rate_limit_resets_at", { withTimezone: true }),

  // Timestamps
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }).notNull(),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Allowed Domains (Security Layer 1) ──────────────────────────────────────

export const allowedDomains = pgTable("allowed_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: text("domain").notNull().unique(), // e.g., "reuters.com"
  notes: text("notes"), // Optional description
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Alert Rules (P3: Keyword Alerts → Telegram) ────────────────────────────

// ─── Digest Runs (history of sent digests) ──────────────────────────────────

export const digestRuns = pgTable(
  "digest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    isTest: boolean("is_test").notNull().default(false),
    language: text("language").notNull().default("en"), // "en" | "ka"
    articleCount: smallint("article_count").notNull().default(0),
    channels: text("channels").array().notNull(), // ["telegram", "facebook", "linkedin"]
    channelResults: jsonb("channel_results").notNull().default({}), // { telegram: "sent", facebook: "failed" }
    provider: text("provider").notNull(), // "claude" | "openai" | "deepseek" | "gemini"
    model: text("model").notNull(),
    minScore: smallint("min_score").notNull().default(3),
    statsScanned: integer("stats_scanned").notNull().default(0),
    statsScored: integer("stats_scored").notNull().default(0),
    statsAboveThreshold: integer("stats_above_threshold").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_digest_runs_sent_at").on(table.sentAt)],
);

// ─── Alert Rules (P3: Keyword Alerts → Telegram) ────────────────────────────

export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    keywords: text("keywords").array().notNull(),
    minScore: smallint("min_score").notNull().default(1),
    telegramChatId: text("telegram_chat_id").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_alert_rules_active").on(table.active)],
);

export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    matchedKeyword: text("matched_keyword").notNull(),
    status: text("status").notNull().default("sent"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_alert_deliveries_unique").on(table.ruleId, table.articleId),
    index("idx_alert_deliveries_rule").on(table.ruleId),
  ],
);
