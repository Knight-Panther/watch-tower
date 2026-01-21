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
});

app.get("/health", async () => ({ status: "ok" }));

app.get("/sources", async (_request, reply) => {
  const { data, error } = await supabase
    .from("rss_sources")
    .select("id,url,name,active,created_at,last_fetched_at")
    .order("created_at", { ascending: false });

  if (error) {
    return reply.code(500).send({ error: error.message });
  }

  return data ?? [];
});

app.post<{
  Body: { url: string; name?: string; active?: boolean };
}>("/sources", async (request, reply) => {
  const { url, name, active } = request.body ?? {};

  if (!url) {
    return reply.code(400).send({ error: "url is required" });
  }

  const { data, error } = await supabase
    .from("rss_sources")
    .insert({
      url,
      name: name ?? null,
      active: active ?? true,
    })
    .select("id,url,name,active,created_at,last_fetched_at")
    .single();

  if (error) {
    return reply.code(500).send({ error: error.message });
  }

  return data;
});

app.delete<{ Params: { id: string } }>("/sources/:id", async (request, reply) => {
  const { id } = request.params;

  const { error } = await supabase.from("rss_sources").delete().eq("id", id);

  if (error) {
    return reply.code(500).send({ error: error.message });
  }

  return { deleted: true };
});

app.patch<{
  Params: { id: string };
  Body: { url?: string; name?: string; active?: boolean };
}>("/sources/:id", async (request, reply) => {
  const { id } = request.params;
  const { url, name, active } = request.body ?? {};

  const updates = {
    ...(url ? { url } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(active !== undefined ? { active } : {}),
  };

  if (Object.keys(updates).length === 0) {
    return reply.code(400).send({ error: "No updates provided" });
  }

  const { data, error } = await supabase
    .from("rss_sources")
    .update(updates)
    .eq("id", id)
    .select("id,url,name,active,created_at,last_fetched_at")
    .single();

  if (error) {
    return reply.code(500).send({ error: error.message });
  }

  return data;
});

app.post("/ingest/run", async (_request, reply) => {
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

const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
