import { Worker } from "bullmq";
import Parser from "rss-parser";
import { JOB_INGEST_FETCH, QUEUE_INGEST } from "@watch-tower/shared";
import { type Database, articles, feedFetchRuns } from "@watch-tower/db";

type IngestDeps = {
  connection: { host: string; port: number };
  db: Database;
};

const parser = new Parser({ timeout: 15000 });

const truncateSnippet = (text: string | undefined, maxLen = 500) => {
  if (!text) return null;
  const cleaned = text.replace(/<[^>]*>/g, "").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
};

const recordFetchRun = async (
  db: Database,
  payload: {
    sourceId: string;
    status: "success" | "error";
    startedAt: Date;
    finishedAt: Date;
    durationMs: number;
    itemCount?: number;
    itemAdded?: number;
    errorMessage?: string;
  },
) => {
  try {
    await db.insert(feedFetchRuns).values({
      sourceId: payload.sourceId,
      status: payload.status,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt,
      durationMs: payload.durationMs,
      itemCount: payload.itemCount ?? null,
      itemAdded: payload.itemAdded ?? null,
      errorMessage: payload.errorMessage ?? null,
    });
  } catch (err) {
    console.error(`[${payload.sourceId}] failed to record fetch run`, err);
  }
};

export const createIngestWorker = ({ connection, db }: IngestDeps) =>
  new Worker(
    QUEUE_INGEST,
    async (job) => {
      if (job.name !== JOB_INGEST_FETCH) {
        return;
      }

      const { url, sourceId, maxAgeDays, sectorId } = job.data as {
        url: string;
        sourceId: string;
        maxAgeDays: number;
        sectorId?: string;
      };
      const startedAt = new Date();
      let feed;
      try {
        feed = await parser.parseURL(url);
      } catch (error) {
        const finishedAt = new Date();
        await recordFetchRun(db, {
          sourceId,
          status: "error",
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.error(`[${sourceId}] failed to parse ${url}`, error);
        return;
      }

      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const itemsToInsert = feed.items
        .map((item) => {
          const link = item.link ?? item.guid;
          if (!link) return null;

          const published = item.isoDate ?? item.pubDate ?? null;
          if (!published) return null;

          const publishedMs = new Date(published).getTime();
          if (Number.isNaN(publishedMs) || publishedMs < cutoff) return null;

          return {
            sourceId,
            sectorId: sectorId ?? null,
            url: link,
            title: item.title ?? "Untitled",
            contentSnippet: truncateSnippet(item.contentSnippet ?? item.content),
            publishedAt: new Date(published),
            pipelineStage: "ingested" as const,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      let itemAdded = 0;
      if (itemsToInsert.length > 0) {
        try {
          const inserted = await db
            .insert(articles)
            .values(itemsToInsert)
            .onConflictDoNothing({ target: articles.url })
            .returning({ id: articles.id });
          itemAdded = inserted.length;
        } catch (error) {
          const finishedAt = new Date();
          await recordFetchRun(db, {
            sourceId,
            status: "error",
            startedAt,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            itemCount: itemsToInsert.length,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          console.error(`[${sourceId}] insert failed`, error);
          return;
        }
      }

      const finishedAt = new Date();
      await recordFetchRun(db, {
        sourceId,
        status: "success",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        itemCount: itemsToInsert.length,
        itemAdded,
      });

      console.log(
        `[${sourceId}] parsed ${itemsToInsert.length}, added ${itemAdded} new from ${feed.title ?? url}`,
      );
    },
    { connection, concurrency: 5 },
  );
