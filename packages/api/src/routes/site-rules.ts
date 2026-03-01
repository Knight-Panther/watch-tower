import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { allowedDomains } from "@watch-tower/db";
import { securityEnvSchema, logger } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export const registerSiteRulesRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  const securityEnv = securityEnvSchema.parse(process.env);

  // ─────────────────────────────────────────────────────────────────────────────
  // Domain Whitelist (Layer 1)
  // ─────────────────────────────────────────────────────────────────────────────

  // GET /site-rules/domains - List all allowed domains
  app.get("/site-rules/domains", { preHandler: deps.requireApiKey }, async () => {
    return deps.db.select().from(allowedDomains).orderBy(allowedDomains.domain);
  });

  // POST /site-rules/domains - Add a new allowed domain
  app.post<{ Body: { domain: string; notes?: string } }>(
    "/site-rules/domains",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { domain, notes } = request.body ?? {};

      if (!domain || typeof domain !== "string") {
        return reply.code(400).send({ error: "domain is required" });
      }

      // Normalize domain (lowercase, trim, remove protocol if accidentally included)
      let normalized = domain.toLowerCase().trim();
      // Remove http:// or https:// if user accidentally included it
      normalized = normalized.replace(/^https?:\/\//, "");
      // Remove trailing slash
      normalized = normalized.replace(/\/$/, "");
      // Remove path if included
      normalized = normalized.split("/")[0];

      if (!normalized || normalized.length < 3) {
        return reply.code(400).send({ error: "Invalid domain format" });
      }

      try {
        const [inserted] = await deps.db
          .insert(allowedDomains)
          .values({ domain: normalized, notes: notes || null })
          .returning();
        logger.info({ domain: normalized }, "[site-rules] domain added to whitelist");
        return inserted;
      } catch (err) {
        const pgCode =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (pgCode === "23505") {
          return reply.code(409).send({ error: "Domain already exists in the whitelist" });
        }
        throw err;
      }
    },
  );

  // PATCH /site-rules/domains/:id - Update domain (toggle active, update notes)
  app.patch<{ Params: { id: string }; Body: { isActive?: boolean; notes?: string } }>(
    "/site-rules/domains/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const { isActive, notes } = request.body ?? {};

      const updates: Partial<{ isActive: boolean; notes: string | null }> = {};
      if (typeof isActive === "boolean") updates.isActive = isActive;
      if (typeof notes === "string") updates.notes = notes || null;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "No valid fields to update" });
      }

      const [updated] = await deps.db
        .update(allowedDomains)
        .set(updates)
        .where(eq(allowedDomains.id, id))
        .returning();

      if (!updated) {
        return reply.code(404).send({ error: "Domain not found" });
      }

      logger.info({ id, updates }, "[site-rules] domain updated");
      return updated;
    },
  );

  // DELETE /site-rules/domains/:id - Remove domain from whitelist
  app.delete<{ Params: { id: string } }>(
    "/site-rules/domains/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const [deleted] = await deps.db
        .delete(allowedDomains)
        .where(eq(allowedDomains.id, id))
        .returning();

      if (!deleted) {
        return reply.code(404).send({ error: "Domain not found" });
      }

      logger.info({ domain: deleted.domain }, "[site-rules] domain removed from whitelist");
      return { success: true };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Security Config (read-only from env)
  // ─────────────────────────────────────────────────────────────────────────────

  // GET /site-rules/config - Get current security configuration
  app.get("/site-rules/config", { preHandler: deps.requireApiKey }, async () => {
    return {
      maxFeedSizeMb: securityEnv.MAX_FEED_SIZE_MB,
      maxArticlesPerFetch: securityEnv.MAX_ARTICLES_PER_FETCH,
      maxArticlesPerSourceDaily: securityEnv.MAX_ARTICLES_PER_SOURCE_DAILY,
      allowedOrigins: securityEnv.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
      apiRateLimitPerMinute: securityEnv.API_RATE_LIMIT_PER_MINUTE,
    };
  });
};
