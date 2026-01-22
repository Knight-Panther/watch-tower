import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server";
import { JOB_FEED_PROCESS } from "@watch-tower/shared";

const clampMaxAgeDays = (value: number) => Math.min(15, Math.max(1, value));

export const registerSourceRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get("/sources", { preHandler: deps.requireApiKey }, async (_request, reply) => {
    const { data, error } = await deps.supabase
      .from("rss_sources")
      .select(
        "id,url,name,active,sector_id,max_age_days,ingest_interval_minutes,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days,ingest_interval_minutes)",
      )
      .order("created_at", { ascending: false });

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return data ?? [];
  });

  app.post<{
    Body: {
      url: string;
      name?: string;
      active?: boolean;
      sector_id?: string;
      max_age_days?: number;
      ingest_interval_minutes?: number;
    };
  }>("/sources", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { url, name, active, sector_id, max_age_days, ingest_interval_minutes } = request.body ?? {};

    if (!url) {
      return reply.code(400).send({ error: "url is required" });
    }

    if (!sector_id) {
      return reply.code(400).send({ error: "sector_id is required" });
    }

    if (max_age_days !== undefined && (max_age_days < 1 || max_age_days > 15)) {
      return reply.code(400).send({ error: "max_age_days must be 1-15" });
    }
    if (
      ingest_interval_minutes !== undefined &&
      (ingest_interval_minutes < 1 || ingest_interval_minutes > 4320)
    ) {
      return reply
        .code(400)
        .send({ error: "ingest_interval_minutes must be 1-4320" });
    }

    const { data, error } = await deps.supabase
      .from("rss_sources")
      .insert({
        url,
        name: name ?? null,
        active: active ?? true,
        sector_id: sector_id ?? null,
        max_age_days: max_age_days ?? null,
        ingest_interval_minutes: ingest_interval_minutes ?? null,
      })
      .select(
        "id,url,name,active,sector_id,max_age_days,ingest_interval_minutes,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days,ingest_interval_minutes)",
      )
      .single();

    if (error) {
      if (error.code === "23505") {
        return reply.code(409).send({ error: "RSS URL already exists" });
      }
      return reply.code(500).send({ error: error.message });
    }

    if (data?.active) {
      const maxAge =
        data.max_age_days ?? data.sectors?.default_max_age_days ?? 5;
      const maxAgeDays = clampMaxAgeDays(maxAge);
      await deps.feedQueue.add(
        JOB_FEED_PROCESS,
        {
          sourceId: data.id,
          url: data.url,
          maxAgeDays,
        },
        { jobId: `feed-process-${data.id}-${Date.now()}` },
      );
    }

    return data;
  });

  app.delete<{ Params: { id: string }; Querystring: { hard?: string } }>(
    "/sources/:id",
    { preHandler: deps.requireApiKey },
    async (request, reply) => {
      const { id } = request.params;
      const hard = request.query.hard === "true";

    const { data, error } = hard
      ? await deps.supabase
          .from("rss_sources")
          .delete()
          .eq("id", id)
          .select(
            "id,url,name,active,sector_id,max_age_days,ingest_interval_minutes,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days,ingest_interval_minutes)",
          )
          .single()
      : await deps.supabase
          .from("rss_sources")
          .update({ active: false })
          .eq("id", id)
          .select(
            "id,url,name,active,sector_id,max_age_days,ingest_interval_minutes,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days,ingest_interval_minutes)",
          )
          .single();

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      return data;
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
      return reply
        .code(400)
        .send({ error: "action must be deactivate or delete" });
    }

    const query =
      action === "delete"
        ? deps.supabase.from("rss_sources").delete()
        : deps.supabase.from("rss_sources").update({ active: false });

    const { data, error } = await query
      .in("id", ids)
      .select(
        "id,url,name,active,sector_id,max_age_days,ingest_interval_minutes,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days,ingest_interval_minutes)",
      );

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return data ?? [];
  });

  app.patch<{
    Params: { id: string };
    Body: {
      url?: string;
      name?: string;
      active?: boolean;
      sector_id?: string;
      max_age_days?: number | null;
      ingest_interval_minutes?: number | null;
    };
  }>("/sources/:id", { preHandler: deps.requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { url, name, active, sector_id, max_age_days, ingest_interval_minutes } = request.body ?? {};

    const updates = {
      ...(url ? { url } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(sector_id !== undefined ? { sector_id } : {}),
      ...(max_age_days !== undefined ? { max_age_days } : {}),
      ...(ingest_interval_minutes !== undefined
        ? { ingest_interval_minutes }
        : {}),
    };

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "No updates provided" });
    }

    if (max_age_days !== undefined && max_age_days !== null) {
      if (max_age_days < 1 || max_age_days > 15) {
        return reply.code(400).send({ error: "max_age_days must be 1-15" });
      }
    }
    if (ingest_interval_minutes !== undefined && ingest_interval_minutes !== null) {
      if (ingest_interval_minutes < 1 || ingest_interval_minutes > 4320) {
        return reply.code(400).send({ error: "ingest_interval_minutes must be 1-4320" });
      }
    }

    const { data, error } = await deps.supabase
      .from("rss_sources")
      .update(updates)
      .eq("id", id)
      .select(
        "id,url,name,active,sector_id,max_age_days,ingest_interval_minutes,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days,ingest_interval_minutes)",
      )
      .single();

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return data;
  });
};
