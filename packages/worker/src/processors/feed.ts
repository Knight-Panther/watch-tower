import { Worker } from "bullmq";
import Parser from "rss-parser";
import {
  JOB_FEED_PROCESS,
  QUEUE_FEED,
} from "@watch-tower/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

type FeedDeps = {
  connection: { host: string; port: number };
  supabase: SupabaseClient;
};

const parser = new Parser({
  timeout: 15000,
});

const recordFetchRun = async (
  supabase: SupabaseClient,
  payload: {
    source_id: string;
    status: "success" | "error";
    started_at: string;
    finished_at: string;
    duration_ms: number;
    item_count?: number;
    item_added?: number;
    error_message?: string;
  },
) => {
  const { error } = await supabase.from("feed_fetch_runs").insert(payload);
  if (error) {
    console.error(
      `[${payload.source_id}] failed to record fetch run`,
      error,
    );
  }
};

export const createFeedWorker = ({ connection, supabase }: FeedDeps) =>
  new Worker(
    QUEUE_FEED,
    async (job) => {
      if (job.name !== JOB_FEED_PROCESS) {
        return;
      }

      const { url, sourceId, maxAgeDays } = job.data as {
        url: string;
        sourceId: string;
        maxAgeDays: number;
      };
      const startedAt = new Date();
      let feed;
      try {
        feed = await parser.parseURL(url);
      } catch (error) {
        const finishedAt = new Date();
        await recordFetchRun(supabase, {
          source_id: sourceId,
          status: "error",
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          error_message: error instanceof Error ? error.message : String(error),
        });
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

      let itemAdded = 0;
      if (itemsToInsert.length > 0) {
        const { data: inserted, error } = await supabase
          .from("feed_items")
          .upsert(itemsToInsert, {
            onConflict: "url",
            ignoreDuplicates: true,
          })
          .select("id");

        if (error) {
          const finishedAt = new Date();
          await recordFetchRun(supabase, {
            source_id: sourceId,
            status: "error",
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            item_count: itemsToInsert.length,
            error_message: error.message,
          });
          console.error(`[${sourceId}] upsert failed`, error.message);
          return;
        }
        itemAdded = inserted?.length ?? 0;
      }

      const finishedAt = new Date();
      await recordFetchRun(supabase, {
        source_id: sourceId,
        status: "success",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        item_count: itemsToInsert.length,
        item_added: itemAdded,
      });

      console.log(
        `[${sourceId}] parsed ${itemsToInsert.length}, added ${itemAdded} new from ${feed.title ?? url}`,
      );
    },
    { connection, concurrency: 5 },
  );
