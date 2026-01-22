import { Worker } from "bullmq";
import {
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  QUEUE_MAINTENANCE,
} from "@watch-tower/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import { JOB_FEED_PROCESS } from "@watch-tower/shared";

type MaintenanceDeps = {
  connection: { host: string; port: number };
  supabase: SupabaseClient;
  feedQueue: Queue;
};

const getFeedItemsTtlDays = async (supabase: SupabaseClient) => {
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

const getGlobalIngestInterval = async (supabase: SupabaseClient) => {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ingest_interval_minutes")
    .single();

  if (error) {
    return 15;
  }

  const minutes = Number(data?.value ?? 15);
  if (Number.isNaN(minutes) || minutes < 1 || minutes > 4320) {
    return 15;
  }

  return minutes;
};

const clampInterval = (value: number) => Math.min(4320, Math.max(1, value));

const scheduleSourceJobs = async (
  supabase: SupabaseClient,
  feedQueue: Queue,
) => {
  const globalInterval = await getGlobalIngestInterval(supabase);
  const { data, error } = await supabase
    .from("rss_sources")
    .select(
      "id,url,active,ingest_interval_minutes,max_age_days,sectors(default_max_age_days,ingest_interval_minutes)",
    )
    .eq("active", true);

  if (error) {
    throw error;
  }

  const repeatableJobs = await feedQueue.getRepeatableJobs();
  const activeIds = new Set((data ?? []).map((source) => source.id));

  for (const job of repeatableJobs) {
    if (job.name !== JOB_FEED_PROCESS) {
      continue;
    }
    if (job.id && job.id.startsWith("feed-process:")) {
      const sourceId = job.id.replace("feed-process:", "");
      if (!activeIds.has(sourceId)) {
        await feedQueue.removeRepeatableByKey(job.key);
      }
    }
  }

  for (const source of data ?? []) {
    const sectorMaxAge = source.sectors?.default_max_age_days;
    const maxAgeDays = Math.min(
      15,
      Math.max(1, source.max_age_days ?? sectorMaxAge ?? 5),
    );
    const sectorInterval = source.sectors?.ingest_interval_minutes;
    const interval = clampInterval(
      source.ingest_interval_minutes ?? sectorInterval ?? globalInterval,
    );
    const jobId = `feed-process:${source.id}`;

    for (const job of repeatableJobs) {
      if (job.name === JOB_FEED_PROCESS && job.id === jobId) {
        await feedQueue.removeRepeatableByKey(job.key);
      }
    }

    await feedQueue.add(
      JOB_FEED_PROCESS,
      {
        sourceId: source.id,
        url: source.url,
        maxAgeDays,
      },
      {
        jobId,
        repeat: { every: interval * 60 * 1000 },
      },
    );
  }
};

export const createMaintenanceWorker = ({
  connection,
  supabase,
  feedQueue,
}: MaintenanceDeps) =>
  new Worker(
    QUEUE_MAINTENANCE,
    async (job) => {
      if (job.name === JOB_MAINTENANCE_CLEANUP) {
        const ttlDays = await getFeedItemsTtlDays(supabase);
        const cutoff = new Date(
          Date.now() - ttlDays * 24 * 60 * 60 * 1000,
        ).toISOString();

        const { error } = await supabase
          .from("feed_items")
          .delete()
          .lt("created_at", cutoff);

        if (error) {
          throw error;
        }
        return;
      }

      if (job.name === JOB_MAINTENANCE_SCHEDULE) {
        await scheduleSourceJobs(supabase, feedQueue);
        return;
      }
    },
    { connection },
  );
