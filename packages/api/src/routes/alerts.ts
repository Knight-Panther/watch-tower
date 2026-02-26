import type { FastifyInstance } from "fastify";
import { eq, desc, sql, and } from "drizzle-orm";
import { alertRules, alertDeliveries, articles, sectors } from "@watch-tower/db";
import { logger } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

const mapRule = (r: typeof alertRules.$inferSelect) => ({
  id: r.id,
  name: r.name,
  keywords: r.keywords,
  min_score: r.minScore,
  telegram_chat_id: r.telegramChatId,
  active: r.active,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
  sector_id: r.sectorId,
  template: r.template,
  mute_until: r.muteUntil,
});

export const registerAlertsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /alerts — list all rules with last-triggered info
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/alerts", { preHandler: deps.requireApiKey }, async () => {
    const rows = await deps.db.select().from(alertRules).orderBy(desc(alertRules.createdAt));

    // Get last delivery timestamp + total count per rule (one query for all)
    const deliveryStats = await deps.db.execute(sql`
      SELECT
        rule_id,
        COUNT(*)::int AS total_deliveries,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
        MAX(sent_at) AS last_triggered_at
      FROM alert_deliveries
      GROUP BY rule_id
    `);

    const statsMap = new Map(
      (deliveryStats.rows as { rule_id: string; total_deliveries: number; sent_count: number; last_triggered_at: string | null }[])
        .map((s) => [s.rule_id, s]),
    );

    return rows.map((r) => {
      const stats = statsMap.get(r.id);
      return {
        ...mapRule(r),
        total_deliveries: stats?.total_deliveries ?? 0,
        sent_count: stats?.sent_count ?? 0,
        last_triggered_at: stats?.last_triggered_at ?? null,
      };
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /alerts/:id — single rule + recent deliveries
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/alerts/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [rule] = await deps.db.select().from(alertRules).where(eq(alertRules.id, id));

      if (!rule) return reply.code(404).send({ error: "Alert rule not found" });

      const deliveries = await deps.db
        .select({
          id: alertDeliveries.id,
          articleId: alertDeliveries.articleId,
          matchedKeyword: alertDeliveries.matchedKeyword,
          status: alertDeliveries.status,
          sentAt: alertDeliveries.sentAt,
          articleTitle: articles.title,
        })
        .from(alertDeliveries)
        .leftJoin(articles, eq(alertDeliveries.articleId, articles.id))
        .where(eq(alertDeliveries.ruleId, id))
        .orderBy(desc(alertDeliveries.sentAt))
        .limit(20);

      return {
        ...mapRule(rule),
        recent_deliveries: deliveries.map((d) => ({
          id: d.id,
          article_id: d.articleId,
          matched_keyword: d.matchedKeyword,
          status: d.status,
          sent_at: d.sentAt,
          article_title: d.articleTitle,
        })),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /alerts — create rule
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      name: string;
      keywords: string[];
      min_score?: number;
      telegram_chat_id: string;
      active?: boolean;
      sector_id?: string | null;
      template?: Record<string, unknown> | null;
    };
  }>("/alerts", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const {
      name,
      keywords,
      min_score = 1,
      telegram_chat_id,
      active = true,
      sector_id = null,
      template = null,
    } = request.body ?? {};

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return reply.code(400).send({ error: "keywords must be a non-empty array" });
    }
    if (keywords.some((k: unknown) => typeof k !== "string" || (k as string).trim().length < 3)) {
      return reply.code(400).send({ error: "Each keyword must be at least 3 characters" });
    }
    if (!telegram_chat_id || typeof telegram_chat_id !== "string") {
      return reply.code(400).send({ error: "telegram_chat_id is required" });
    }
    if (!Number.isInteger(min_score) || min_score < 1 || min_score > 5) {
      return reply.code(400).send({ error: "min_score must be 1-5" });
    }

    // Validate sector_id if provided
    if (sector_id) {
      const [sector] = await deps.db.select().from(sectors).where(eq(sectors.id, sector_id));
      if (!sector) return reply.code(400).send({ error: "Invalid sector_id" });
    }

    const [inserted] = await deps.db
      .insert(alertRules)
      .values({
        name: name.trim(),
        keywords: keywords.map((k: string) => k.trim()),
        minScore: min_score,
        telegramChatId: telegram_chat_id.trim(),
        active,
        sectorId: sector_id,
        template: template,
      })
      .returning();

    logger.info({ ruleId: inserted.id, name: inserted.name }, "[alerts] rule created");
    return mapRule(inserted);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /alerts/:id — update rule
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      keywords?: string[];
      min_score?: number;
      telegram_chat_id?: string;
      active?: boolean;
      sector_id?: string | null;
      template?: Record<string, unknown> | null;
    };
  }>("/alerts/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ error: "name cannot be empty" });
      updates.name = body.name.trim();
    }
    if (body.keywords !== undefined) {
      if (!Array.isArray(body.keywords) || body.keywords.length === 0) {
        return reply.code(400).send({ error: "keywords must be a non-empty array" });
      }
      updates.keywords = body.keywords.map((k: string) => k.trim());
    }
    if (body.min_score !== undefined) {
      if (!Number.isInteger(body.min_score) || body.min_score < 1 || body.min_score > 5) {
        return reply.code(400).send({ error: "min_score must be 1-5" });
      }
      updates.minScore = body.min_score;
    }
    if (body.telegram_chat_id !== undefined) {
      updates.telegramChatId = body.telegram_chat_id.trim();
    }
    if (typeof body.active === "boolean") {
      updates.active = body.active;
    }
    if (body.sector_id !== undefined) {
      if (body.sector_id !== null) {
        const [sector] = await deps.db.select().from(sectors).where(eq(sectors.id, body.sector_id));
        if (!sector) return reply.code(400).send({ error: "Invalid sector_id" });
      }
      updates.sectorId = body.sector_id;
    }
    if (body.template !== undefined) {
      updates.template = body.template;
    }

    const [updated] = await deps.db
      .update(alertRules)
      .set(updates)
      .where(eq(alertRules.id, id))
      .returning();

    if (!updated) return reply.code(404).send({ error: "Alert rule not found" });

    logger.info({ ruleId: id }, "[alerts] rule updated");
    return mapRule(updated);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /alerts/:id — delete rule (cascade deletes deliveries)
  // ─────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/alerts/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [deleted] = await deps.db
        .delete(alertRules)
        .where(eq(alertRules.id, id))
        .returning();

      if (!deleted) return reply.code(404).send({ error: "Alert rule not found" });

      logger.info({ ruleId: id, name: deleted.name }, "[alerts] rule deleted");
      return { success: true };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /alerts/:id/test — send test alert to verify chat ID
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/alerts/:id/test",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [rule] = await deps.db.select().from(alertRules).where(eq(alertRules.id, id));
      if (!rule) return reply.code(404).send({ error: "Alert rule not found" });

      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return reply.code(500).send({ error: "TELEGRAM_BOT_TOKEN not configured" });

      const chatId = rule.telegramChatId || process.env.TELEGRAM_CHAT_ID;
      if (!chatId) return reply.code(500).send({ error: "No chat ID configured" });

      // Build test message
      const sectorName = rule.sectorId
        ? (await deps.db.select({ name: sectors.name }).from(sectors).where(eq(sectors.id, rule.sectorId)))?.[0]?.name ?? "Unknown"
        : "All sectors";

      const text = [
        `<b>🛎️ Test Alert: ${rule.name}</b>`,
        ``,
        `Keywords: ${rule.keywords.map((k) => `<code>${k}</code>`).join(", ")}`,
        `Min score: ${rule.minScore}/5`,
        `Sector: ${sectorName}`,
        ``,
        `<i>This is a test. If you see this, your chat ID is working.</i>`,
      ].join("\n");

      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        });
        const data = (await res.json()) as { ok: boolean; description?: string };
        if (data.ok) return { sent: true };
        return reply.code(502).send({ sent: false, error: data.description ?? "Telegram rejected" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return reply.code(502).send({ sent: false, error: msg });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /alerts/:id/mute — mute rule for N hours
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { hours?: number } }>(
    "/alerts/:id/mute",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const hours = request.body?.hours ?? 24;
      if (hours < 1 || hours > 168) {
        return reply.code(400).send({ error: "hours must be 1-168" });
      }

      const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
      const [updated] = await deps.db
        .update(alertRules)
        .set({ muteUntil, updatedAt: new Date() })
        .where(eq(alertRules.id, id))
        .returning();

      if (!updated) return reply.code(404).send({ error: "Alert rule not found" });
      return mapRule(updated);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /alerts/:id/unmute — clear mute
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/alerts/:id/unmute",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [updated] = await deps.db
        .update(alertRules)
        .set({ muteUntil: null, updatedAt: new Date() })
        .where(eq(alertRules.id, id))
        .returning();

      if (!updated) return reply.code(404).send({ error: "Alert rule not found" });
      return mapRule(updated);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /alerts/sector-keywords/:sectorId — keywords for LLM Brain page display
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { sectorId: string } }>(
    "/alerts/sector-keywords/:sectorId",
    { preHandler: deps.requireApiKey },
    async (request) => {
      const { sectorId } = request.params;

      // Fetch rules for this sector + global rules (sector_id IS NULL)
      const rules = await deps.db
        .select({ keywords: alertRules.keywords, sectorId: alertRules.sectorId })
        .from(alertRules)
        .where(
          and(
            eq(alertRules.active, true),
            sql`(${alertRules.sectorId} = ${sectorId}::uuid OR ${alertRules.sectorId} IS NULL)`,
          ),
        );

      const allKeywords = rules.flatMap((r) => r.keywords);
      const unique = [...new Set(allKeywords)];

      return {
        keywords: unique,
        rule_count: rules.length,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /alerts/stats/weekly — alert count for page header
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/alerts/stats/weekly", { preHandler: deps.requireApiKey }, async () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const result = await deps.db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
        COUNT(*)::int AS total_count
      FROM alert_deliveries
      WHERE sent_at >= ${weekAgo}
    `);
    const row = result.rows[0] as { sent_count: number; total_count: number } | undefined;
    return {
      sent_this_week: row?.sent_count ?? 0,
      total_this_week: row?.total_count ?? 0,
    };
  });
};
