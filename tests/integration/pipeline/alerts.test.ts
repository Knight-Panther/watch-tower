/**
 * Integration tests for the keyword alert system.
 *
 * Runs against REAL PostgreSQL and Redis with the Telegram HTTP call mocked.
 * Each test seeds alert rules and scored articles directly into the database,
 * then calls checkAndFireAlerts() and asserts on alert_deliveries rows and
 * mock Telegram call counts.
 */

// ─── Mock Telegram BEFORE any alert-processor import ─────────────────────────
//
// vi.mock() is hoisted to the top of the compiled output by Vitest's transform.
// Any variable it closes over must also be hoisted via vi.hoisted() — otherwise
// the variable is not yet initialised when the factory runs.

import { vi } from "vitest";

const { mockSendTelegramAlert } = vi.hoisted(() => ({
  mockSendTelegramAlert: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@watch-tower/worker/utils/telegram-alert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@watch-tower/worker/utils/telegram-alert")>();
  return {
    ...actual,
    sendTelegramAlert: mockSendTelegramAlert,
  };
});

// ─── Imports ─────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { checkAndFireAlerts } from "@watch-tower/worker/processors/alert-processor";
import {
  getTestDb,
  closeTestDb,
  cleanAllTables,
  seedTestSector,
  seedTestArticle,
} from "../../helpers/test-db.js";
import {
  getTestRedis,
  cleanTestRedisKeys,
  closeTestRedis,
} from "../../helpers/test-redis.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScoredArticle = {
  articleId: string;
  title: string;
  llmSummary: string | null;
  url: string;
  sectorName: string | null;
  score: number;
  matchedAlertKeywords: string[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const TELEGRAM_CONFIG = {
  botToken: "test-bot-token",
  defaultChatId: "-100testchat",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Insert an alert rule and return its generated UUID.
 */
const seedAlertRule = async (
  db: ReturnType<typeof getTestDb>["db"],
  opts: {
    name?: string;
    keywords?: string[];
    minScore?: number;
    telegramChatId?: string;
    active?: boolean;
    sectorId?: string | null;
    muteUntil?: Date | null;
    language?: string;
  } = {},
): Promise<string> => {
  const {
    name = "Test Alert",
    keywords = ["bitcoin"],
    minScore = 3,
    telegramChatId = "-100testchat",
    active = true,
    sectorId = null,
    muteUntil = null,
    language = "en",
  } = opts;

  const keywordsLiteral = sql.join(
    keywords.map((k) => sql`${k}`),
    sql`, `,
  );

  const result = await db.execute(sql`
    INSERT INTO alert_rules (name, keywords, min_score, telegram_chat_id, active, sector_id, mute_until, language)
    VALUES (
      ${name},
      ARRAY[${keywordsLiteral}]::text[],
      ${minScore},
      ${telegramChatId},
      ${active},
      ${sectorId ? sql`${sectorId}::uuid` : sql`NULL`},
      ${muteUntil ?? null},
      ${language}
    )
    RETURNING id
  `);

  return (result.rows[0] as { id: string }).id;
};

/**
 * Query all rows from alert_deliveries for a given article ID.
 */
const getDeliveries = async (
  db: ReturnType<typeof getTestDb>["db"],
  articleId: string,
): Promise<Record<string, unknown>[]> => {
  const result = await db.execute(sql`
    SELECT * FROM alert_deliveries WHERE article_id = ${articleId}::uuid
  `);
  return result.rows as Record<string, unknown>[];
};

/**
 * Build a ScoredArticle test fixture with sensible defaults.
 * Callers MUST provide articleId when the test expects a delivery row —
 * the ID must reference a real row in the articles table.
 */
const makeScoredArticle = (overrides: Partial<ScoredArticle> = {}): ScoredArticle => ({
  articleId: overrides.articleId ?? "00000000-0000-0000-0000-000000000001",
  title: overrides.title ?? "Bitcoin Hits Record High as Institutional Buyers Pile In",
  llmSummary:
    overrides.llmSummary ?? "Bitcoin reached a new all-time high driven by institutional demand.",
  url: overrides.url ?? "https://example.com/bitcoin-record",
  sectorName: overrides.sectorName ?? "Crypto",
  score: overrides.score ?? 4,
  matchedAlertKeywords: overrides.matchedAlertKeywords ?? ["bitcoin"],
});

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("checkAndFireAlerts() — integration", () => {
  const { db } = getTestDb();

  beforeAll(async () => {
    const redis = getTestRedis();
    await redis.connect();
    await cleanAllTables(db);
    await cleanTestRedisKeys(redis);

    // Ensure no emergency_stop or quiet hours are active by default.
    await db.execute(sql`
      DELETE FROM app_config WHERE key IN (
        'emergency_stop',
        'alert_quiet_start',
        'alert_quiet_end',
        'alert_quiet_timezone'
      )
    `);
  });

  afterAll(async () => {
    await closeTestDb();
    await closeTestRedis();
  }, 20_000);

  beforeEach(async () => {
    const redis = getTestRedis();
    mockSendTelegramAlert.mockClear();
    await cleanAllTables(db);
    await cleanTestRedisKeys(redis);

    // Remove any config keys set by individual tests.
    await db.execute(sql`
      DELETE FROM app_config WHERE key IN (
        'emergency_stop',
        'alert_quiet_start',
        'alert_quiet_end',
        'alert_quiet_timezone'
      )
    `);
  });

  // ─── 1. Fires alert when keyword matches ─────────────────────────────────

  it("should fire an alert and record a delivery when a keyword matches", async () => {
    const sectorId = await seedTestSector(db, "Crypto", "crypto-alerts");
    const articleId = await seedTestArticle(db, {
      sectorId,
      title: "Bitcoin Hits Record High",
      pipelineStage: "scored",
      importanceScore: 4,
    });

    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 3, sectorId: null });

    const article = makeScoredArticle({
      articleId,
      title: "Bitcoin Hits Record High",
      score: 4,
      matchedAlertKeywords: ["bitcoin"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).toHaveBeenCalledOnce();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].matched_keyword).toBe("bitcoin");
    expect(deliveries[0].status).toBe("sent");
  });

  // ─── 2. Respects minimum score gate ──────────────────────────────────────

  it("should not fire an alert when the article score is below the rule min_score", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Bitcoin Briefly Dips Below $30k",
      pipelineStage: "scored",
      importanceScore: 2,
    });

    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 4 });

    const article = makeScoredArticle({
      articleId,
      score: 2,
      matchedAlertKeywords: ["bitcoin"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(0);
  });

  // ─── 3. Respects mute_until ──────────────────────────────────────────────

  it("should not fire an alert when the rule is muted until a future timestamp", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Bitcoin ETF Approved by SEC",
      pipelineStage: "scored",
      importanceScore: 5,
    });

    const futureDate = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours from now
    await seedAlertRule(db, {
      keywords: ["bitcoin"],
      minScore: 3,
      muteUntil: futureDate,
    });

    const article = makeScoredArticle({
      articleId,
      score: 5,
      matchedAlertKeywords: ["bitcoin"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(0);
  });

  // ─── 4. Respects inactive rules ──────────────────────────────────────────

  it("should not fire an alert when the rule is inactive", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Crypto Market Rallies on Fed Pause",
      pipelineStage: "scored",
      importanceScore: 4,
    });

    await seedAlertRule(db, { keywords: ["crypto"], minScore: 3, active: false });

    const article = makeScoredArticle({
      articleId,
      title: "Crypto Market Rallies on Fed Pause",
      score: 4,
      matchedAlertKeywords: ["crypto"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(0);
  });

  // ─── 5. Redis cooldown prevents duplicate Telegram sends ─────────────────

  it("should not send a second Telegram message for the same rule+article within the cooldown window", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Bitcoin Surges Past $100k",
      pipelineStage: "scored",
      importanceScore: 5,
    });

    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 3 });

    const article = makeScoredArticle({
      articleId,
      score: 5,
      matchedAlertKeywords: ["bitcoin"],
    });

    // First call — should fire and set the cooldown key.
    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).toHaveBeenCalledOnce();

    // Second call with the same article — cooldown key is present in Redis.
    // The processor should skip the send entirely (no new Telegram call).
    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    // Still only one Telegram call total — the second batch was suppressed.
    expect(mockSendTelegramAlert).toHaveBeenCalledOnce();

    // The sent row from the first call should still be present.
    const deliveries = await getDeliveries(db, articleId);
    const sentRow = deliveries.find((d) => d.status === "sent");
    expect(sentRow).toBeDefined();
  });

  // ─── 6. Keyword must be in both rule.keywords and matchedAlertKeywords ────

  it("should not fire an alert when the LLM-matched keyword is not in the rule keyword list", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Gold Futures Spike on Geopolitical Tensions",
      pipelineStage: "scored",
      importanceScore: 4,
    });

    // Rule watches for "bitcoin" only.
    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 3 });

    const article = makeScoredArticle({
      articleId,
      score: 4,
      // LLM flagged "gold" — not present in the rule's keyword list.
      matchedAlertKeywords: ["gold"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(0);
  });

  // ─── 7. Records correct delivery row fields ───────────────────────────────

  it("should record a delivery row with correct ruleId, articleId, matchedKeyword, and status=sent", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Ethereum Merge Goes Live",
      pipelineStage: "scored",
      importanceScore: 5,
    });

    const ruleId = await seedAlertRule(db, {
      name: "Eth Monitor",
      keywords: ["ethereum", "eth"],
      minScore: 3,
    });

    const article = makeScoredArticle({
      articleId,
      title: "Ethereum Merge Goes Live",
      score: 5,
      matchedAlertKeywords: ["ethereum"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(1);

    const row = deliveries[0];
    expect(row.rule_id).toBe(ruleId);
    expect(row.article_id).toBe(articleId);
    expect(row.matched_keyword).toBe("ethereum");
    expect(row.status).toBe("sent");
    expect(row.error_message).toBeNull();
  });

  // ─── 8. Emergency stop suppresses all alerts ─────────────────────────────

  it("should not fire any alerts when emergency_stop is set to true in app_config", async () => {
    await db.execute(sql`
      INSERT INTO app_config (key, value)
      VALUES ('emergency_stop', 'true')
      ON CONFLICT (key) DO UPDATE SET value = 'true'
    `);

    const articleId = await seedTestArticle(db, {
      title: "Major Exchange Goes Offline",
      pipelineStage: "scored",
      importanceScore: 5,
    });

    await seedAlertRule(db, { keywords: ["exchange"], minScore: 3 });

    const article = makeScoredArticle({
      articleId,
      title: "Major Exchange Goes Offline",
      score: 5,
      matchedAlertKeywords: ["exchange"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(0);
  });

  // ─── 9. No-op when article has no LLM-matched keywords ───────────────────

  it("should not fire any alerts when the article has no matched keywords", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Global Markets Mixed in Early Trading",
      pipelineStage: "scored",
      importanceScore: 4,
    });

    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 3 });

    const article = makeScoredArticle({
      articleId,
      score: 4,
      matchedAlertKeywords: [], // LLM found no matching keywords
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(0);
  });

  // ─── 10. Multiple articles — only matching ones fire ─────────────────────

  it("should fire exactly one alert when only one of two articles matches the rule keyword", async () => {
    const matchId = await seedTestArticle(db, {
      title: "Bitcoin Hash Rate Reaches New Peak",
      pipelineStage: "scored",
      importanceScore: 4,
    });
    const noMatchId = await seedTestArticle(db, {
      title: "Gold Prices Steady Amid Dollar Weakness",
      pipelineStage: "scored",
      importanceScore: 4,
    });

    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 3 });

    const articles: ScoredArticle[] = [
      makeScoredArticle({
        articleId: matchId,
        title: "Bitcoin Hash Rate Reaches New Peak",
        score: 4,
        matchedAlertKeywords: ["bitcoin"],
      }),
      makeScoredArticle({
        articleId: noMatchId,
        title: "Gold Prices Steady Amid Dollar Weakness",
        score: 4,
        matchedAlertKeywords: [], // No keyword match
      }),
    ];

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles,
    });

    expect(mockSendTelegramAlert).toHaveBeenCalledOnce();

    const matchDeliveries = await getDeliveries(db, matchId);
    expect(matchDeliveries).toHaveLength(1);
    expect(matchDeliveries[0].status).toBe("sent");

    const noMatchDeliveries = await getDeliveries(db, noMatchId);
    expect(noMatchDeliveries).toHaveLength(0);
  });

  // ─── 11. Multiple matching rules fire independently ───────────────────────

  it("should fire once per matching rule when multiple active rules match the same article", async () => {
    const articleId = await seedTestArticle(db, {
      title: "Bitcoin ETF Volume Breaks Daily Record",
      pipelineStage: "scored",
      importanceScore: 5,
    });

    const ruleIdA = await seedAlertRule(db, {
      name: "BTC Rule A",
      keywords: ["bitcoin"],
      minScore: 3,
      telegramChatId: "-100chatA",
    });
    const ruleIdB = await seedAlertRule(db, {
      name: "BTC Rule B",
      keywords: ["bitcoin", "etf"],
      minScore: 3,
      telegramChatId: "-100chatB",
    });

    const article = makeScoredArticle({
      articleId,
      score: 5,
      matchedAlertKeywords: ["bitcoin", "etf"],
    });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [article],
    });

    // Two separate Telegram calls — one per matching rule.
    expect(mockSendTelegramAlert).toHaveBeenCalledTimes(2);

    const deliveries = await getDeliveries(db, articleId);
    expect(deliveries).toHaveLength(2);

    const ruleIds = deliveries.map((d) => d.rule_id as string);
    expect(ruleIds).toContain(ruleIdA);
    expect(ruleIds).toContain(ruleIdB);
    expect(deliveries.every((d) => d.status === "sent")).toBe(true);
  });

  // ─── 12. No-op on empty articles array ───────────────────────────────────

  it("should return immediately without any DB or Telegram interaction when articles is empty", async () => {
    await seedAlertRule(db, { keywords: ["bitcoin"], minScore: 3 });

    await checkAndFireAlerts({
      db,
      redis: getTestRedis(),
      telegramConfig: TELEGRAM_CONFIG,
      articles: [],
    });

    expect(mockSendTelegramAlert).not.toHaveBeenCalled();
  });
});
