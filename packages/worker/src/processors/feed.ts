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

const parser = new Parser();

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
    { connection },
  );
