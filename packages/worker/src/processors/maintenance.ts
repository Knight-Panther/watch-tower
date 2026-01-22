import { Worker } from "bullmq";
import {
  JOB_MAINTENANCE_CLEANUP,
  QUEUE_MAINTENANCE,
} from "@watch-tower/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

type MaintenanceDeps = {
  connection: { host: string; port: number };
  supabase: SupabaseClient;
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

export const createMaintenanceWorker = ({ connection, supabase }: MaintenanceDeps) =>
  new Worker(
    QUEUE_MAINTENANCE,
    async (job) => {
      if (job.name !== JOB_MAINTENANCE_CLEANUP) {
        return;
      }

      const ttlDays = await getFeedItemsTtlDays(supabase);
      const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();

      const { error } = await supabase
        .from("feed_items")
        .delete()
        .lt("created_at", cutoff);

      if (error) {
        throw error;
      }
    },
    { connection },
  );
