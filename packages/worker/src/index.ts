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
const maintenanceQueue = new Queue("maintenance", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});
const parser = new Parser();
const clampMaxAgeDays = (value: number) => Math.min(15, Math.max(1, value));

const getFeedItemsTtlDays = async () => {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "feed_items_ttl_days")
    .single();

  if (error) {
    return 60;
  }

  const days = Number(data?.value ?? 60);
  if (Number.isNaN(days) || days < 30 || days > 60) {
    return 60;
  }

  return days;
};

const ingestWorker = new Worker(
  "ingest",
  async (job) => {
    if (job.name !== "ingest:poll") {
      return;
    }

    const { data, error } = await supabase
      .from("rss_sources")
      .select("id,url,active,max_age_days,sectors(default_max_age_days)")
      .eq("active", true);

    if (error) {
      throw error;
    }

    for (const source of data ?? []) {
      const sectorMaxAge = source.sectors?.default_max_age_days;
      const maxAgeDays = clampMaxAgeDays(
        source.max_age_days ?? sectorMaxAge ?? 5,
      );
      await feedQueue.add("feed:process", {
        sourceId: source.id,
        url: source.url,
        maxAgeDays,
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

    const { url, sourceId, maxAgeDays } = job.data as {
      url: string;
      sourceId: string;
      maxAgeDays: number;
    };
    let feed;
    try {
      feed = await parser.parseURL(url);
    } catch (error) {
      console.error(`[${sourceId}] failed to parse ${url}`, error);
      return;
    }

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const itemsToInsert = feed.items
      .map((item) => {
        const link = item.link ?? item.guid;
        if (!link) {
          return null;
        }

        const published = item.isoDate ?? item.pubDate ?? null;
        if (!published) {
          return null;
        }

        const publishedAt = new Date(published).getTime();
        if (Number.isNaN(publishedAt) || publishedAt < cutoff) {
          return null;
        }

        return {
          source_id: sourceId,
          url: link,
          title: item.title ?? null,
          published_at: published,
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

const maintenanceWorker = new Worker(
  "maintenance",
  async (job) => {
    if (job.name !== "maintenance:cleanup") {
      return;
    }

    const ttlDays = await getFeedItemsTtlDays();
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase
      .from("feed_items")
      .delete()
      .lt("created_at", cutoff);

    if (error) {
      throw error;
    }
  },
  { connection }
);

ingestWorker.on("failed", (job, err) => {
  console.error(`[ingest] job ${job?.id ?? "unknown"} failed`, err);
});

feedWorker.on("failed", (job, err) => {
  console.error(`[feed-processing] job ${job?.id ?? "unknown"} failed`, err);
});

maintenanceWorker.on("failed", (job, err) => {
  console.error(`[maintenance] job ${job?.id ?? "unknown"} failed`, err);
});

await ingestQueue.add(
  "ingest:poll",
  {},
  { repeat: { every: 15 * 60 * 1000 }, jobId: "ingest:poll" }
);

await maintenanceQueue.add(
  "maintenance:cleanup",
  {},
  { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "maintenance:cleanup" }
);
