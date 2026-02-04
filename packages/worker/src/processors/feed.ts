import { Worker } from "bullmq";
import { JOB_INGEST_FETCH, QUEUE_INGEST, logger, securityEnvSchema } from "@watch-tower/shared";
import { type Database, articles, feedFetchRuns } from "@watch-tower/db";
import type { EventPublisher } from "../events.js";
import { fetchFeedSecurely } from "../utils/secure-rss.js";
import { checkArticleQuota } from "../utils/article-quota.js";
import { isDomainAllowed } from "../utils/domain-whitelist.js";

type IngestDeps = {
  connection: { host: string; port: number };
  db: Database;
  eventPublisher: EventPublisher;
};

// Parse security config at module load
const securityEnv = securityEnvSchema.parse(process.env);
const MAX_FEED_SIZE_BYTES = securityEnv.MAX_FEED_SIZE_MB * 1024 * 1024;
const FEED_TIMEOUT_MS = 15000;

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
    logger.error(`[${payload.sourceId}] failed to record fetch run`, err);
  }
};

export const createIngestWorker = ({ connection, db, eventPublisher }: IngestDeps) =>
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

      // Layer 1: Domain whitelist check (blocks fetch if domain not whitelisted)
      const whitelistCheck = await isDomainAllowed(db, url);
      if (!whitelistCheck.allowed) {
        const finishedAt = new Date();
        const errorMessage = whitelistCheck.whitelistEmpty
          ? "WHITELIST_EMPTY: Add domains to Site Rules to enable ingestion"
          : `DOMAIN_BLOCKED: ${whitelistCheck.reason}`;

        await recordFetchRun(db, {
          sourceId,
          status: "error",
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorMessage,
        });

        logger.warn(
          { sourceId, url, domain: whitelistCheck.domain, reason: whitelistCheck.reason },
          "[ingest] domain not in whitelist, skipping fetch",
        );
        return;
      }

      // Layer 3 & 4: Secure fetch with size limit and XXE protection
      const fetchResult = await fetchFeedSecurely(url, {
        maxSizeBytes: MAX_FEED_SIZE_BYTES,
        timeoutMs: FEED_TIMEOUT_MS,
      });

      if (!fetchResult.success) {
        const finishedAt = new Date();
        await recordFetchRun(db, {
          sourceId,
          status: "error",
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorMessage: fetchResult.error,
        });
        logger.error({ sourceId, url, error: fetchResult.error }, "[ingest] secure fetch failed");
        return;
      }

      const feed = fetchResult.feed!;

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

      // Layer 5: Check article quota before inserting
      const quota = await checkArticleQuota(db, sourceId);

      if (quota.allowed === 0) {
        const finishedAt = new Date();
        logger.warn(
          { sourceId, dailyUsed: quota.dailyUsed, dailyLimit: quota.dailyLimit },
          "[ingest] daily quota exhausted, skipping",
        );
        await recordFetchRun(db, {
          sourceId,
          status: "success", // Not an error, just quota reached
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          itemCount: itemsToInsert.length,
          itemAdded: 0,
          errorMessage: `Daily quota reached (${quota.dailyUsed}/${quota.dailyLimit})`,
        });
        return;
      }

      // Apply quota limit
      const itemsWithinQuota = itemsToInsert.slice(0, quota.allowed);

      if (itemsWithinQuota.length < itemsToInsert.length) {
        logger.info(
          {
            sourceId,
            original: itemsToInsert.length,
            limited: itemsWithinQuota.length,
            perFetchLimit: quota.perFetchLimit,
            dailyRemaining: quota.dailyRemaining,
          },
          "[ingest] articles limited by quota",
        );
      }

      let itemAdded = 0;
      if (itemsWithinQuota.length > 0) {
        try {
          const inserted = await db
            .insert(articles)
            .values(itemsWithinQuota)
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
            itemCount: itemsWithinQuota.length,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          logger.error(`[${sourceId}] insert failed`, error);
          return;
        }
      }

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await recordFetchRun(db, {
        sourceId,
        status: "success",
        startedAt,
        finishedAt,
        durationMs,
        itemCount: itemsWithinQuota.length,
        itemAdded,
      });

      // Publish event for real-time UI
      await eventPublisher.publish({
        type: "source:fetched",
        data: {
          sourceId,
          sourceName: feed.title ?? null,
          articlesFound: itemsWithinQuota.length,
          articlesAdded: itemAdded,
          durationMs,
        },
      });

      logger.debug(
        `[${sourceId}] parsed ${itemsWithinQuota.length}, added ${itemAdded} new from ${feed.title ?? url}`,
      );
    },
    { connection, concurrency: 5 },
  );
