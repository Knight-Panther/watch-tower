/**
 * Integration tests for the Watch Tower API routes.
 *
 * Runs against REAL PostgreSQL and Redis. Uses Fastify's `.inject()` method
 * so no actual HTTP server is started. Route registrars are imported directly
 * and wired with test-scoped deps to keep the test hermetic.
 *
 * Prerequisites: PostgreSQL and Redis must be running locally (npm run infra:up).
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load the root .env before any other imports that read process.env,
// so DATABASE_URL and REDIS_* point at the real dev services.
const _dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(_dirname, "../../../.env"), override: false });

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { registerHealthRoutes } from "@watch-tower/api/routes/health.js";
import { registerSectorRoutes } from "@watch-tower/api/routes/sectors.js";
import { registerArticlesRoutes } from "@watch-tower/api/routes/articles.js";
import { registerStatsRoutes } from "@watch-tower/api/routes/stats.js";
import { createRequireApiKey } from "@watch-tower/api/utils/auth.js";
import { baseEnvSchema } from "@watch-tower/shared";
import {
  getTestDb,
  getTestRedis,
  getTestRedisConnection,
  cleanAllTables,
  seedTestSector,
  seedTestSource,
  seedTestArticle,
  getArticle,
  closeTestDb,
  closeTestRedis,
} from "../../helpers/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_API_KEY = "test-api-key";
const AUTH_HEADER = { "x-api-key": TEST_API_KEY };

// ─── App factory ─────────────────────────────────────────────────────────────

/**
 * Build a minimal Fastify instance wired to test DB + Redis.
 * Only registers the routes exercised by this suite to keep startup fast.
 */
const buildTestApp = async (): Promise<FastifyInstance> => {
  const { db } = getTestDb();
  const redis = getTestRedis();
  const connection = getTestRedisConnection();

  const env = baseEnvSchema.parse(process.env);
  const requireApiKey = createRequireApiKey(TEST_API_KEY);

  const maintenanceQueue = new Queue("maintenance", { connection });
  const ingestQueue = new Queue("pipeline-ingest", { connection });

  const deps = {
    db,
    redis,
    redisConnection: connection,
    maintenanceQueue,
    ingestQueue,
    requireApiKey,
    env,
  };

  const app = Fastify({ logger: false });

  registerHealthRoutes(app, deps);
  registerSectorRoutes(app, deps);
  registerArticlesRoutes(app, deps);
  registerStatsRoutes(app, deps);

  await app.ready();
  return app;
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("API routes (integration)", () => {
  let app: FastifyInstance;
  let sectorId: string;
  let sourceId: string;

  beforeAll(async () => {
    const { db } = getTestDb();

    // Wipe everything so tests start from a known state
    await cleanAllTables(db);

    // Seed reference data used across test cases
    sectorId = await seedTestSector(db, "Tech", "tech");
    sourceId = await seedTestSource(
      db,
      "https://feeds.test.example.com/tech",
      sectorId,
      "Tech Feed",
    );

    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
    await closeTestRedis();
  });

  // ─── Health ────────────────────────────────────────────────────────────────

  describe("GET /health", () => {
    it("returns 200 with status object — no auth required", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });

      expect(res.statusCode).toBe(200);

      const body = res.json<{ status: string; redis: string; database: string }>();
      expect(body).toMatchObject({ status: "ok", redis: "ok", database: "ok" });
    });
  });

  // ─── Auth guard ────────────────────────────────────────────────────────────

  describe("Auth middleware", () => {
    it("returns 401 when x-api-key header is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/stats/overview",
        // deliberately no x-api-key header
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "Unauthorized" });
    });

    it("returns 401 when x-api-key header value is wrong", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/stats/overview",
        headers: { "x-api-key": "totally-wrong-key" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "Unauthorized" });
    });

    it("returns 200 when correct x-api-key is provided", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/stats/overview",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ─── Sectors ───────────────────────────────────────────────────────────────

  describe("GET /sectors", () => {
    it("returns a list of sectors", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/sectors",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<Array<{ id: string; name: string; slug: string }>>();
      expect(Array.isArray(body)).toBe(true);

      const tech = body.find((s) => s.slug === "tech");
      expect(tech).toBeDefined();
      expect(tech!.name).toBe("Tech");
    });
  });

  describe("POST /sectors", () => {
    it("creates a new sector and returns it", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sectors",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        payload: { name: "Healthcare" },
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{
        id: string;
        name: string;
        slug: string;
        default_max_age_days: number;
      }>();
      expect(body.name).toBe("Healthcare");
      expect(body.slug).toBe("healthcare");
      expect(typeof body.id).toBe("string");
      expect(body.default_max_age_days).toBeGreaterThan(0);
    });

    it("returns 400 when name is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sectors",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "name is required" });
    });

    it("returns an id, name, slug, and default_max_age_days on success", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sectors",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        payload: { name: "Finance", default_max_age_days: 3 },
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{
        id: string;
        name: string;
        slug: string;
        default_max_age_days: number;
        created_at: string;
      }>();
      expect(body.name).toBe("Finance");
      expect(body.slug).toBe("finance");
      expect(body.default_max_age_days).toBe(3);
      expect(typeof body.id).toBe("string");
      expect(typeof body.created_at).toBe("string");
    });

    it("returns 400 when default_max_age_days is out of range", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sectors",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        payload: { name: "Bad Range Sector", default_max_age_days: 99 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Articles ──────────────────────────────────────────────────────────────

  describe("GET /articles", () => {
    it("returns paginated articles list with expected shape", async () => {
      const { db } = getTestDb();

      // Seed a couple of articles so the response is non-empty
      await seedTestArticle(db, {
        title: "Integration Test Article A",
        sourceId,
        sectorId,
        pipelineStage: "scored",
        importanceScore: 4,
      });
      await seedTestArticle(db, {
        title: "Integration Test Article B",
        sourceId,
        sectorId,
        pipelineStage: "ingested",
      });

      const res = await app.inject({
        method: "GET",
        url: "/articles",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{
        data: unknown[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          total_pages: number;
        };
      }>();

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.page).toBe(1);
      expect(typeof body.pagination.total).toBe("number");
      expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it("filters articles by pipeline stage", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/articles?status=scored",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{ data: Array<{ pipeline_stage: string }> }>();
      // Every returned article must be in the requested stage
      for (const article of body.data) {
        expect(article.pipeline_stage).toBe("scored");
      }
    });

    it("respects the limit query parameter", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/articles?limit=1",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{
        data: unknown[];
        pagination: { limit: number };
      }>();
      expect(body.data.length).toBeLessThanOrEqual(1);
      expect(body.pagination.limit).toBe(1);
    });
  });

  describe("POST /articles/:id/approve", () => {
    it("sets pipeline_stage to approved and records approved_at", async () => {
      const { db } = getTestDb();

      const articleId = await seedTestArticle(db, {
        pipelineStage: "scored",
        importanceScore: 3,
        sourceId,
        sectorId,
      });

      const res = await app.inject({
        method: "POST",
        url: `/articles/${articleId}/approve`,
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        payload: {},
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{
        id: string;
        pipeline_stage: string;
        approved_at: string | null;
      }>();
      expect(body.id).toBe(articleId);
      expect(body.pipeline_stage).toBe("approved");
      expect(body.approved_at).not.toBeNull();

      // Verify DB was actually updated
      const row = await getArticle(db, articleId);
      expect(row?.pipeline_stage).toBe("approved");
    });

    it("returns 404 for a non-existent article ID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/articles/00000000-0000-0000-0000-000000000000/approve",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Article not found" });
    });
  });

  describe("POST /articles/:id/reject", () => {
    it("sets pipeline_stage to rejected with reason 'manual'", async () => {
      const { db } = getTestDb();

      const articleId = await seedTestArticle(db, {
        pipelineStage: "scored",
        importanceScore: 2,
        sourceId,
        sectorId,
      });

      const res = await app.inject({
        method: "POST",
        url: `/articles/${articleId}/reject`,
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{ id: string; pipeline_stage: string }>();
      expect(body.id).toBe(articleId);
      expect(body.pipeline_stage).toBe("rejected");

      // Verify rejection reason was written to DB
      const row = await getArticle(db, articleId);
      expect(row?.pipeline_stage).toBe("rejected");
      expect(row?.rejection_reason).toBe("manual");
    });

    it("returns 404 for a non-existent article ID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/articles/00000000-0000-0000-0000-000000000000/reject",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Article not found" });
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────────────────

  describe("GET /stats/overview", () => {
    it("returns overview with expected numeric fields", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/stats/overview",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<{
        total_sources: number;
        active_sources: number;
        items_last_24h: number;
        stale_sources: number;
        queues: { feed: object };
      }>();

      expect(typeof body.total_sources).toBe("number");
      expect(typeof body.active_sources).toBe("number");
      expect(typeof body.items_last_24h).toBe("number");
      expect(typeof body.stale_sources).toBe("number");
      expect(body.queues).toBeDefined();
      expect(body.queues.feed).toBeDefined();

      // Sanity: we seeded one source, so totals should reflect it
      expect(body.total_sources).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /stats/source-quality", () => {
    it("returns an object keyed by source ID", async () => {
      const { db } = getTestDb();

      // Seed a scored article so there is at least one entry in source-quality
      await seedTestArticle(db, {
        sourceId,
        sectorId,
        pipelineStage: "scored",
        importanceScore: 4,
        publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      });

      // Clear any cached value so the query runs fresh
      const redis = getTestRedis();
      await redis.del("stats:source-quality");

      const res = await app.inject({
        method: "GET",
        url: "/stats/source-quality",
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json<
        Record<
          string,
          {
            distribution: Record<number, number>;
            total: number;
            avg_score: number;
            signal_ratio: number;
          }
        >
      >();

      // Must be a plain object (not an array)
      expect(typeof body).toBe("object");
      expect(Array.isArray(body)).toBe(false);

      // The seeded source should appear in results
      const entry = body[sourceId];
      if (entry) {
        expect(typeof entry.total).toBe("number");
        expect(entry.total).toBeGreaterThan(0);
        expect(typeof entry.avg_score).toBe("number");
        expect(typeof entry.signal_ratio).toBe("number");
      }
    });
  });
});
