import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Queue, Worker } from "bullmq";
import Parser from "rss-parser";
import { baseEnvSchema, createSupabaseClient } from "@watch-tower/shared";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const env = baseEnvSchema.parse(process.env);
const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
};

const supabase = createSupabaseClient({
  url: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const ingestQueue = new Queue("ingest", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
const feedQueue = new Queue("feed-processing", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
const parser = new Parser();

const ingestWorker = new Worker(
  "ingest",
  async (job) => {
    if (job.name !== "ingest:poll") {
      return;
    }

    const { data, error } = await supabase
      .from("rss_sources")
      .select("id,url,active")
      .eq("active", true);

    if (error) {
      throw error;
    }

    for (const source of data ?? []) {
      await feedQueue.add("feed:process", {
        sourceId: source.id,
        url: source.url,
      });
    }

    await supabase
      .from("rss_sources")
      .update({ last_fetched_at: new Date().toISOString() })
      .in(
        "id",
        (data ?? []).map((source) => source.id),
      );
  },
  { connection }
);

const feedWorker = new Worker(
  "feed-processing",
  async (job) => {
    if (job.name !== "feed:process") {
      return;
    }

    const { url, sourceId } = job.data as { url: string; sourceId: string };
    let feed;
    try {
      feed = await parser.parseURL(url);
    } catch (error) {
      console.error(`[${sourceId}] failed to parse ${url}`, error);
      return;
    }

    const itemsToInsert = feed.items
      .map((item) => {
        const link = item.link ?? item.guid;
        if (!link) {
          return null;
        }

        return {
          source_id: sourceId,
          url: link,
          title: item.title ?? null,
          published_at: item.isoDate ?? item.pubDate ?? null,
          raw: item,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    if (itemsToInsert.length === 0) {
      return;
    }

    const { error } = await supabase.from("feed_items").upsert(itemsToInsert, {
      onConflict: "url",
      ignoreDuplicates: true,
    });

    if (error) {
      throw error;
    }

    console.log(
      `[${sourceId}] upserted ${itemsToInsert.length} items from ${feed.title ?? url}`,
    );
  },
  { connection }
);

ingestWorker.on("failed", (job, err) => {
  console.error(`[ingest] job ${job?.id ?? "unknown"} failed`, err);
});

feedWorker.on("failed", (job, err) => {
  console.error(`[feed-processing] job ${job?.id ?? "unknown"} failed`, err);
});

await ingestQueue.add(
  "ingest:poll",
  {},
  { repeat: { every: 15 * 60 * 1000 }, jobId: "ingest:poll" }
);
