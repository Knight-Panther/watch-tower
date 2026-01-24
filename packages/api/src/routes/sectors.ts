import type { FastifyInstance } from "fastify";
import { eq, asc } from "drizzle-orm";
import { sectors, rssSources } from "@watch-tower/db";
import type { ApiDeps } from "../server.js";

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const registerSectorRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/sectors", { preHandler: deps.requireApiKey }, async () => {
    return deps.db.select().from(sectors).orderBy(asc(sectors.name));
  });

  app.post<{
    Body: { name: string; default_max_age_days?: number };
  }>("/sectors", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { name, default_max_age_days } = request.body ?? {};
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    if (
      default_max_age_days !== undefined &&
      (default_max_age_days < 1 || default_max_age_days > 15)
    ) {
      return reply
        .code(400)
        .send({ error: "default_max_age_days must be between 1 and 15" });
    }

    try {
      const [row] = await deps.db
        .insert(sectors)
        .values({
          name,
          slug: slugify(name),
          defaultMaxAgeDays: default_max_age_days ?? 5,
        })
        .returning();
      return row;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        return reply.code(409).send({ error: "Sector already exists" });
      }
      throw err;
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { default_max_age_days?: number };
  }>("/sectors/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { default_max_age_days } = request.body ?? {};

    if (
      default_max_age_days !== undefined &&
      (default_max_age_days < 1 || default_max_age_days > 15)
    ) {
      return reply
        .code(400)
        .send({ error: "default_max_age_days must be between 1 and 15" });
    }

    if (default_max_age_days === undefined) {
      return reply.code(400).send({ error: "No updates provided" });
    }

    const [row] = await deps.db
      .update(sectors)
      .set({ defaultMaxAgeDays: default_max_age_days })
      .where(eq(sectors.id, id))
      .returning();

    if (!row) {
      return reply.code(404).send({ error: "Sector not found" });
    }

    return row;
  });

  app.delete<{
    Params: { id: string };
  }>("/sectors/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;

    // Clear sector_id from sources before deleting
    await deps.db
      .update(rssSources)
      .set({ sectorId: null })
      .where(eq(rssSources.sectorId, id));

    const [row] = await deps.db
      .delete(sectors)
      .where(eq(sectors.id, id))
      .returning();

    if (!row) {
      return reply.code(404).send({ error: "Sector not found" });
    }

    return row;
  });
};
