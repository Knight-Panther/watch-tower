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

const getFeedFetchRunsTtlHours = async (supabase: SupabaseClient) => {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "feed_fetch_runs_ttl_hours")
    .single();

  if (error) {
    return 336;
  }

  const hours = Number(data?.value ?? 336);
  if (Number.isNaN(hours) || hours <= 0 || hours > 2160) {
    return 336;
  }

  return hours;
};

const clampInterval = (value: number) => Math.min(4320, Math.max(1, value));

const scheduleSourceJobs = async (
  supabase: SupabaseClient,
  feedQueue: Queue,
) => {
  const { data, error } = await supabase
    .from("rss_sources")
    .select(
      "id,url,active,ingest_interval_minutes,max_age_days,sectors(default_max_age_days)",
    )
    .eq("active", true);

  if (error) {
    throw error;
  }

  const repeatableJobs = await feedQueue.getRepeatableJobs();
  const activeIds = new Set((data ?? []).map((source) => source.id));
  const repeatableById = new Map(
    repeatableJobs
      .filter((job) => job.name === JOB_FEED_PROCESS && job.id)
      .map((job) => [job.id as string, job]),
  );

  const desiredJobs = new Map<
    string,
    { sourceId: string; url: string; maxAgeDays: number; intervalMs: number }
  >();

  for (const source of data ?? []) {
    if (source.ingest_interval_minutes === null || source.ingest_interval_minutes === undefined) {
      console.warn("scheduler: missing ingest interval", { sourceId: source.id });
      continue;
    }

    const sectorMaxAge = source.sectors?.default_max_age_days;
    const maxAgeDays = Math.min(
      15,
      Math.max(1, source.max_age_days ?? sectorMaxAge ?? 5),
    );
    const intervalMinutes = clampInterval(source.ingest_interval_minutes);

    desiredJobs.set(`feed-process:${source.id}`, {
      sourceId: source.id,
      url: source.url,
      maxAgeDays,
      intervalMs: intervalMinutes * 60 * 1000,
    });
  }

  for (const job of repeatableJobs) {
    if (job.name !== JOB_FEED_PROCESS || !job.id) {
      continue;
    }
    if (job.id.startsWith("feed-process:")) {
      const sourceId = job.id.replace("feed-process:", "");
      if (!activeIds.has(sourceId)) {
        await feedQueue.removeRepeatableByKey(job.key);
        console.info("scheduler: removed inactive repeatable", { sourceId });
      }
    }
  }

  for (const [jobId, desired] of desiredJobs) {
    const existing = repeatableById.get(jobId);
    const existingEvery = existing?.every ? Number(existing.every) : null;
    const intervalMatches = existingEvery === desired.intervalMs;

    if (existing && !intervalMatches) {
      await feedQueue.removeRepeatableByKey(existing.key);
      console.info("scheduler: rescheduling", {
        jobId,
        fromMs: existingEvery,
        toMs: desired.intervalMs,
      });
    }

    if (!existing || !intervalMatches) {
      await feedQueue.add(
        JOB_FEED_PROCESS,
        {
          sourceId: desired.sourceId,
          url: desired.url,
          maxAgeDays: desired.maxAgeDays,
        },
        {
          jobId,
          repeat: { every: desired.intervalMs },
        },
      );
      console.info("scheduler: scheduled", {
        jobId,
        intervalMs: desired.intervalMs,
      });
    } else {
      console.info("scheduler: unchanged", {
        jobId,
        intervalMs: desired.intervalMs,
      });
    }
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

        const runsTtlHours = await getFeedFetchRunsTtlHours(supabase);
        const runsCutoff = new Date(
          Date.now() - runsTtlHours * 60 * 60 * 1000,
        ).toISOString();

        const { error: runsError } = await supabase
          .from("feed_fetch_runs")
          .delete()
          .lt("created_at", runsCutoff);

        if (runsError) {
          throw runsError;
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
