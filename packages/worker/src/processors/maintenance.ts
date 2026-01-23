import { Worker } from "bullmq";
import {
  JOB_FEED_PROCESS,
  JOB_MAINTENANCE_CLEANUP,
  JOB_MAINTENANCE_SCHEDULE,
  QUEUE_MAINTENANCE,
} from "@watch-tower/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";

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

/**
 * Checks which active sources are due for ingestion and fires one-shot
 * feed jobs for each. A source is "due" if it has never been successfully
 * fetched, or if (now - last_success) >= ingest_interval.
 */
const runScheduledIngests = async (
  supabase: SupabaseClient,
  feedQueue: Queue,
) => {
  const { data: sources, error } = await supabase
    .from("rss_sources")
    .select(
      "id,url,active,ingest_interval_minutes,max_age_days,sectors(default_max_age_days)",
    )
    .eq("active", true);

  if (error) {
    throw error;
  }

  if (!sources || sources.length === 0) {
    return;
  }

  // Get latest successful run for each source
  const sourceIds = sources.map((s) => s.id);
  const { data: runs, error: runsError } = await supabase
    .from("feed_fetch_runs")
    .select("source_id,finished_at,created_at")
    .in("source_id", sourceIds)
    .eq("status", "success")
    .order("created_at", { ascending: false });

  if (runsError) {
    throw runsError;
  }

  const lastSuccessBySource = new Map<string, number>();
  for (const run of runs ?? []) {
    if (!lastSuccessBySource.has(run.source_id)) {
      const ts = Date.parse(run.finished_at ?? run.created_at);
      if (!Number.isNaN(ts)) {
        lastSuccessBySource.set(run.source_id, ts);
      }
    }
  }

  const now = Date.now();
  let fired = 0;

  for (const source of sources) {
    const intervalMinutes = source.ingest_interval_minutes;
    if (!intervalMinutes || intervalMinutes <= 0) {
      continue;
    }

    const intervalMs = Math.min(4320, Math.max(1, intervalMinutes)) * 60 * 1000;
    const lastSuccess = lastSuccessBySource.get(source.id);

    // Source is due if never fetched or interval has elapsed
    const isDue = !lastSuccess || (now - lastSuccess) >= intervalMs;

    if (!isDue) {
      continue;
    }

    const sector = source.sectors as unknown as { default_max_age_days: number } | null;
    const sectorMaxAge = sector?.default_max_age_days;
    const maxAgeDays = Math.min(
      15,
      Math.max(1, source.max_age_days ?? sectorMaxAge ?? 5),
    );

    await feedQueue.add(JOB_FEED_PROCESS, {
      sourceId: source.id,
      url: source.url,
      maxAgeDays,
    });

    fired++;
  }

  if (fired > 0) {
    console.info(`[scheduler] fired ${fired} feed jobs`);
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

        console.info("[maintenance] cleanup complete");
        return;
      }

      if (job.name === JOB_MAINTENANCE_SCHEDULE) {
        await runScheduledIngests(supabase, feedQueue);
        return;
      }
    },
    { connection },
  );
