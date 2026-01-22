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
      .select("id,name,slug,default_max_age_days,ingest_interval_minutes,created_at")
      .order("name", { ascending: true });

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return data ?? [];
  });

  app.post<{
    Body: { name: string; default_max_age_days?: number; ingest_interval_minutes?: number };
  }>("/sectors", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { name, default_max_age_days, ingest_interval_minutes } = request.body ?? {};
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
    if (
      ingest_interval_minutes !== undefined &&
      (ingest_interval_minutes < 1 || ingest_interval_minutes > 4320)
    ) {
      return reply
        .code(400)
        .send({ error: "ingest_interval_minutes must be between 1 and 4320" });
    }

    const { data, error } = await deps.supabase
      .from("sectors")
      .insert({
        name,
        slug: slugify(name),
        default_max_age_days: default_max_age_days ?? 5,
        ingest_interval_minutes: ingest_interval_minutes ?? null,
      })
      .select("id,name,slug,default_max_age_days,ingest_interval_minutes,created_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return reply.code(409).send({ error: "Sector already exists" });
      }
      return reply.code(500).send({ error: error.message });
    }

    return data;
  });

  app.patch<{
    Params: { id: string };
    Body: { default_max_age_days?: number; ingest_interval_minutes?: number | null };
  }>("/sectors/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { default_max_age_days, ingest_interval_minutes } = request.body ?? {};

    if (
      default_max_age_days !== undefined &&
      (default_max_age_days < 1 || default_max_age_days > 15)
    ) {
      return reply
        .code(400)
        .send({ error: "default_max_age_days must be between 1 and 15" });
    }
    if (
      ingest_interval_minutes !== undefined &&
      ingest_interval_minutes !== null &&
      (ingest_interval_minutes < 1 || ingest_interval_minutes > 4320)
    ) {
      return reply
        .code(400)
        .send({ error: "ingest_interval_minutes must be between 1 and 4320" });
    }

    const updates = {
      ...(default_max_age_days !== undefined ? { default_max_age_days } : {}),
      ...(ingest_interval_minutes !== undefined
        ? { ingest_interval_minutes }
        : {}),
    };

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "No updates provided" });
    }

    const { data, error } = await deps.supabase
      .from("sectors")
      .update(updates)
      .eq("id", id)
      .select("id,name,slug,default_max_age_days,ingest_interval_minutes,created_at")
      .single();

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return data;
  });
};
