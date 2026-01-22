import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server";

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const registerSectorRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/sectors", { preHandler: deps.requireApiKey }, async (_request, reply) => {
    const { data, error } = await deps.supabase
      .from("sectors")
      .select("id,name,slug,default_max_age_days,created_at")
      .order("name", { ascending: true });

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return data ?? [];
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

    const { data, error } = await deps.supabase
      .from("sectors")
      .insert({
        name,
        slug: slugify(name),
        default_max_age_days: default_max_age_days ?? 5,
      })
      .select("id,name,slug,default_max_age_days,created_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return reply.code(409).send({ error: "Sector already exists" });
      }
      return reply.code(500).send({ error: error.message });
    }

    return data;
  });
};
