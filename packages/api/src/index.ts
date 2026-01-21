import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import { Queue } from "bullmq";
import cors from "@fastify/cors";
import { baseEnvSchema, createSupabaseClient } from "@watch-tower/shared";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const env = baseEnvSchema.parse(process.env);

const supabase = createSupabaseClient({
  url: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const queueConnection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
};
const ingestQueue = new Queue("ingest", { connection: queueConnection });

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
});

app.get("/health", async () => ({ status: "ok" }));

const requireApiKey = async (
  request: typeof app.request,
  reply: typeof app.reply,
) => {
  if (!env.API_KEY) {
    return;
  }

  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
};

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

app.get("/sectors", { preHandler: requireApiKey }, async (_request, reply) => {
  const { data, error } = await supabase
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
}>("/sectors", { preHandler: requireApiKey }, async (request, reply) => {
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

  const { data, error } = await supabase
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

app.get("/sources", { preHandler: requireApiKey }, async (_request, reply) => {
  const { data, error } = await supabase
    .from("rss_sources")
    .select(
      "id,url,name,active,sector_id,max_age_days,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days)",
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
  };
}>("/sources", { preHandler: requireApiKey }, async (request, reply) => {
  const { url, name, active, sector_id, max_age_days } = request.body ?? {};

  if (!url) {
    return reply.code(400).send({ error: "url is required" });
  }

  if (!sector_id) {
    return reply.code(400).send({ error: "sector_id is required" });
  }

  if (max_age_days !== undefined && (max_age_days < 1 || max_age_days > 15)) {
    return reply.code(400).send({ error: "max_age_days must be 1-15" });
  }

  const { data, error } = await supabase
    .from("rss_sources")
    .insert({
      url,
      name: name ?? null,
      active: active ?? true,
      sector_id: sector_id ?? null,
      max_age_days: max_age_days ?? null,
    })
    .select(
      "id,url,name,active,sector_id,max_age_days,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days)",
    )
    .single();

  if (error) {
    if (error.code === "23505") {
      return reply.code(409).send({ error: "RSS URL already exists" });
    }
    return reply.code(500).send({ error: error.message });
  }

  return data;
});

app.delete<{ Params: { id: string }; Querystring: { hard?: string } }>(
  "/sources/:id",
  { preHandler: requireApiKey },
  async (request, reply) => {
    const { id } = request.params;
    const hard = request.query.hard === "true";

    const { data, error } = hard
      ? await supabase
          .from("rss_sources")
          .delete()
          .eq("id", id)
          .select(
            "id,url,name,active,sector_id,max_age_days,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days)",
          )
          .single()
      : await supabase
          .from("rss_sources")
          .update({ active: false })
          .eq("id", id)
          .select(
            "id,url,name,active,sector_id,max_age_days,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days)",
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
}>("/sources/batch", { preHandler: requireApiKey }, async (request, reply) => {
  const { ids, action } = request.body ?? {};
  if (!ids?.length) {
    return reply.code(400).send({ error: "ids are required" });
  }
  if (!action || !["deactivate", "delete"].includes(action)) {
    return reply.code(400).send({ error: "action must be deactivate or delete" });
  }

  const query =
    action === "delete"
      ? supabase.from("rss_sources").delete()
      : supabase.from("rss_sources").update({ active: false });

  const { data, error } = await query
    .in("id", ids)
    .select(
      "id,url,name,active,sector_id,max_age_days,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days)",
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
  };
}>("/sources/:id", { preHandler: requireApiKey }, async (request, reply) => {
  const { id } = request.params;
  const { url, name, active, sector_id, max_age_days } = request.body ?? {};

  const updates = {
    ...(url ? { url } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(sector_id !== undefined ? { sector_id } : {}),
    ...(max_age_days !== undefined ? { max_age_days } : {}),
  };

  if (Object.keys(updates).length === 0) {
    return reply.code(400).send({ error: "No updates provided" });
  }

  if (max_age_days !== undefined && max_age_days !== null) {
    if (max_age_days < 1 || max_age_days > 15) {
      return reply.code(400).send({ error: "max_age_days must be 1-15" });
    }
  }

  const { data, error } = await supabase
    .from("rss_sources")
    .update(updates)
    .eq("id", id)
    .select(
      "id,url,name,active,sector_id,max_age_days,created_at,last_fetched_at,sectors(id,name,slug,default_max_age_days)",
    )
    .single();

  if (error) {
    return reply.code(500).send({ error: error.message });
  }

  return data;
});

app.post("/ingest/run", { preHandler: requireApiKey }, async (_request, reply) => {
  try {
    const job = await ingestQueue.add("ingest:poll", {}, {
      jobId: `ingest-poll-manual-${Date.now()}`,
    });
    return { queued: true, jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue";
    return reply.code(500).send({ error: message });
  }
});

app.get("/config/feed-items-ttl", { preHandler: requireApiKey }, async (_request, reply) => {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "feed_items_ttl_days")
    .single();

  if (error) {
    return reply.code(500).send({ error: error.message });
  }

  return { days: Number(data?.value ?? 60) };
});

app.patch<{ Body: { days: number } }>(
  "/config/feed-items-ttl",
  { preHandler: requireApiKey },
  async (request, reply) => {
    const { days } = request.body ?? {};
    if (!days || days < 30 || days > 60) {
      return reply.code(400).send({ error: "days must be between 30 and 60" });
    }

    const { data, error } = await supabase
      .from("app_config")
      .upsert({
        key: "feed_items_ttl_days",
        value: String(days),
        updated_at: new Date().toISOString(),
      })
      .select("value")
      .single();

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return { days: Number(data?.value ?? days) };
  },
);

const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
