import type { FastifyInstance } from "fastify";
import { eq, desc, inArray } from "drizzle-orm";
import { rssSources, sectors } from "@watch-tower/db";
import { JOB_INGEST_FETCH } from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

const clampMaxAgeDays = (value: number) => Math.min(15, Math.max(1, value));

const selectSourcesWithSector = async (deps: ApiDeps, condition?: Parameters<typeof eq>) => {
  const rows = await deps.db
    .select({
      id: rssSources.id,
      url: rssSources.url,
      name: rssSources.name,
      active: rssSources.active,
      sector_id: rssSources.sectorId,
      max_age_days: rssSources.maxAgeDays,
      ingest_interval_minutes: rssSources.ingestIntervalMinutes,
      created_at: rssSources.createdAt,
      last_fetched_at: rssSources.lastFetchedAt,
      sectors: {
        id: sectors.id,
        name: sectors.name,
        slug: sectors.slug,
        default_max_age_days: sectors.defaultMaxAgeDays,
      },
    })
    .from(rssSources)
    .leftJoin(sectors, eq(rssSources.sectorId, sectors.id))
    .orderBy(desc(rssSources.createdAt));

  return rows.map((r) => ({
    ...r,
    sectors: r.sectors?.id ? r.sectors : null,
  }));
};

export const registerSourceRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/sources", { preHandler: deps.requireApiKey }, async () => {
    return selectSourcesWithSector(deps);
  });

  app.post<{
    Body: {
      url: string;
      name?: string;
      active?: boolean;
      sector_id?: string;
      max_age_days?: number;
      ingest_interval_minutes: number;
    };
  }>("/sources", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { url, name, active, sector_id, max_age_days, ingest_interval_minutes } =
      request.body ?? {};

    if (!url) {
      return reply.code(400).send({ error: "url is required" });
    }
    if (!sector_id) {
      return reply.code(400).send({ error: "sector_id is required" });
    }
    if (ingest_interval_minutes === undefined) {
      return reply.code(400).send({ error: "ingest_interval_minutes is required" });
    }
    if (max_age_days !== undefined && (max_age_days < 1 || max_age_days > 15)) {
      return reply.code(400).send({ error: "max_age_days must be 1-15" });
    }
    if (ingest_interval_minutes < 1 || ingest_interval_minutes > 4320) {
      return reply.code(400).send({ error: "ingest_interval_minutes must be 1-4320" });
    }

    let inserted;
    try {
      [inserted] = await deps.db
        .insert(rssSources)
        .values({
          url,
          name: name ?? null,
          active: active ?? true,
          sectorId: sector_id ?? null,
          maxAgeDays: max_age_days ?? null,
          ingestIntervalMinutes: ingest_interval_minutes,
        })
        .returning();
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        return reply.code(409).send({ error: "RSS URL already exists" });
      }
      throw err;
    }

    if (inserted.active) {
      // Look up sector default for max age
      let sectorMaxAge = 5;
      if (inserted.sectorId) {
        const [sector] = await deps.db
          .select({ defaultMaxAgeDays: sectors.defaultMaxAgeDays })
          .from(sectors)
          .where(eq(sectors.id, inserted.sectorId));
        if (sector) {
          sectorMaxAge = sector.defaultMaxAgeDays;
        }
      }
      const maxAgeDays = clampMaxAgeDays(inserted.maxAgeDays ?? sectorMaxAge);
      await deps.ingestQueue.add(
        JOB_INGEST_FETCH,
        { sourceId: inserted.id, url: inserted.url, maxAgeDays },
        { jobId: `ingest-${inserted.id}-${Date.now()}` },
      );
    }

    return inserted;
  });

  app.delete<{ Params: { id: string }; Querystring: { hard?: string } }>(
    "/sources/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const hard = request.query.hard === "true";

      const [row] = hard
        ? await deps.db.delete(rssSources).where(eq(rssSources.id, id)).returning()
        : await deps.db
            .update(rssSources)
            .set({ active: false })
            .where(eq(rssSources.id, id))
            .returning();

      if (!row) {
        return reply.code(404).send({ error: "Source not found" });
      }

      return row;
    },
  );

  app.post<{
    Body: { ids: string[]; action: "deactivate" | "delete" };
  }>("/sources/batch", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { ids, action } = request.body ?? {};
    if (!ids?.length) {
      return reply.code(400).send({ error: "ids are required" });
    }
    if (!action || !["deactivate", "delete"].includes(action)) {
      return reply.code(400).send({ error: "action must be deactivate or delete" });
    }

    const rows =
      action === "delete"
        ? await deps.db.delete(rssSources).where(inArray(rssSources.id, ids)).returning()
        : await deps.db
            .update(rssSources)
            .set({ active: false })
            .where(inArray(rssSources.id, ids))
            .returning();

    return rows;
  });

  app.patch<{
    Params: { id: string };
    Body: {
      url?: string;
      name?: string;
      active?: boolean;
      sector_id?: string;
      max_age_days?: number | null;
      ingest_interval_minutes?: number;
    };
  }>("/sources/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { url, name, active, sector_id, max_age_days, ingest_interval_minutes } =
      request.body ?? {};

    const updates: Record<string, unknown> = {};
    if (url !== undefined) updates.url = url;
    if (name !== undefined) updates.name = name;
    if (active !== undefined) updates.active = active;
    if (sector_id !== undefined) updates.sectorId = sector_id;
    if (max_age_days !== undefined) updates.maxAgeDays = max_age_days;
    if (ingest_interval_minutes !== undefined)
      updates.ingestIntervalMinutes = ingest_interval_minutes;

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "No updates provided" });
    }

    if (max_age_days !== undefined && max_age_days !== null) {
      if (max_age_days < 1 || max_age_days > 15) {
        return reply.code(400).send({ error: "max_age_days must be 1-15" });
      }
    }
    if (ingest_interval_minutes !== undefined) {
      if (ingest_interval_minutes < 1 || ingest_interval_minutes > 4320) {
        return reply.code(400).send({ error: "ingest_interval_minutes must be 1-4320" });
      }
    }

    const [row] = await deps.db
      .update(rssSources)
      .set(updates)
      .where(eq(rssSources.id, id))
      .returning();

    if (!row) {
      return reply.code(404).send({ error: "Source not found" });
    }

    // Re-query with sector join to return full shape matching GET /sources
    const [full] = await deps.db
      .select({
        id: rssSources.id,
        url: rssSources.url,
        name: rssSources.name,
        active: rssSources.active,
        sector_id: rssSources.sectorId,
        max_age_days: rssSources.maxAgeDays,
        ingest_interval_minutes: rssSources.ingestIntervalMinutes,
        created_at: rssSources.createdAt,
        last_fetched_at: rssSources.lastFetchedAt,
        sectors: {
          id: sectors.id,
          name: sectors.name,
          slug: sectors.slug,
          default_max_age_days: sectors.defaultMaxAgeDays,
        },
      })
      .from(rssSources)
      .leftJoin(sectors, eq(rssSources.sectorId, sectors.id))
      .where(eq(rssSources.id, id));

    return { ...full, sectors: full.sectors?.id ? full.sectors : null };
  });
};
