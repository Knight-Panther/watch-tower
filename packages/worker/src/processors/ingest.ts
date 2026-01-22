import { Worker, type Queue } from "bullmq";
import {
  JOB_FEED_PROCESS,
  JOB_INGEST_POLL,
  QUEUE_INGEST,
} from "@watch-tower/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

const clampMaxAgeDays = (value: number) => Math.min(15, Math.max(1, value));

type IngestDeps = {
  connection: { host: string; port: number };
  supabase: SupabaseClient;
  feedQueue: Queue;
};

export const createIngestWorker = ({ connection, supabase, feedQueue }: IngestDeps) =>
  new Worker(
    QUEUE_INGEST,
    async (job) => {
      if (job.name !== JOB_INGEST_POLL) {
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
        await feedQueue.add(JOB_FEED_PROCESS, {
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
    { connection },
  );
