import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server";

type FetchRunRow = {
  source_id: string;
  status: "success" | "error";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  item_count: number | null;
  item_added: number | null;
  error_message: string | null;
  created_at: string;
};

const getRunTimestamp = (run: FetchRunRow) =>
  run.finished_at ?? run.created_at;

export const registerStatsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.get(
    "/stats/overview",
    { preHandler: deps.requireApiKey },
    async (_request, reply) => {
      const now = Date.now();
      const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();

      const [
        totalSourcesRes,
        activeSourcesRes,
        itemsRes,
      ] = await Promise.all([
        deps.supabase.from("rss_sources").select("id", { count: "exact", head: true }),
        deps.supabase
          .from("rss_sources")
          .select("id", { count: "exact", head: true })
          .eq("active", true),
        deps.supabase
          .from("feed_items")
          .select("id", { count: "exact", head: true })
          .gte("created_at", cutoff),
      ]);

      if (totalSourcesRes.error) {
        return reply.code(500).send({ error: totalSourcesRes.error.message });
      }
      if (activeSourcesRes.error) {
        return reply.code(500).send({ error: activeSourcesRes.error.message });
      }
      if (itemsRes.error) {
        return reply.code(500).send({ error: itemsRes.error.message });
      }

      const { data: sources, error: sourcesError } = await deps.supabase
        .from("rss_sources")
        .select("id,ingest_interval_minutes,active")
        .eq("active", true);

      if (sourcesError) {
        return reply.code(500).send({ error: sourcesError.message });
      }

      const activeSources = sources ?? [];
      const sourceIds = activeSources.map((source) => source.id);
      const latestSuccessBySource = new Map<string, FetchRunRow>();

      if (sourceIds.length > 0) {
        const { data: runs, error: runsError } = await deps.supabase
          .from("feed_fetch_runs")
          .select(
            "source_id,status,started_at,finished_at,duration_ms,item_count,item_added,error_message,created_at",
          )
          .in("source_id", sourceIds)
          .eq("status", "success")
          .order("created_at", { ascending: false });

        if (runsError) {
          return reply.code(500).send({ error: runsError.message });
        }

        for (const run of runs ?? []) {
          if (!latestSuccessBySource.has(run.source_id)) {
            latestSuccessBySource.set(run.source_id, run);
          }
        }
      }

      let staleSources = 0;
      for (const source of activeSources) {
        const intervalMinutes = source.ingest_interval_minutes;
        const lastSuccess = latestSuccessBySource.get(source.id);
        if (!intervalMinutes) {
          staleSources += 1;
          continue;
        }
        if (!lastSuccess) {
          staleSources += 1;
          continue;
        }
        const lastSuccessAt = Date.parse(getRunTimestamp(lastSuccess));
        if (Number.isNaN(lastSuccessAt)) {
          staleSources += 1;
          continue;
        }
        if (now > lastSuccessAt + intervalMinutes * 2 * 60 * 1000) {
          staleSources += 1;
        }
      }

      const feedQueueCounts = await deps.feedQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
      );

      return {
        total_sources: totalSourcesRes.count ?? 0,
        active_sources: activeSourcesRes.count ?? 0,
        items_last_24h: itemsRes.count ?? 0,
        stale_sources: staleSources,
        queues: {
          feed: feedQueueCounts,
        },
      };
    },
  );

  app.get(
    "/stats/sources",
    { preHandler: deps.requireApiKey },
    async (_request, reply) => {
      const { data: sources, error } = await deps.supabase
        .from("rss_sources")
        .select("id,url,name,active,sector_id,ingest_interval_minutes,sectors(id,name,slug)")
        .order("created_at", { ascending: false });

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      const sourceIds = (sources ?? []).map((source) => source.id);
      const latestRunBySource = new Map<string, FetchRunRow>();
      const latestSuccessBySource = new Map<string, FetchRunRow>();

      if (sourceIds.length > 0) {
        const { data: runs, error: runsError } = await deps.supabase
          .from("feed_fetch_runs")
          .select(
            "source_id,status,started_at,finished_at,duration_ms,item_count,item_added,error_message,created_at",
          )
          .in("source_id", sourceIds)
          .order("created_at", { ascending: false });

        if (runsError) {
          return reply.code(500).send({ error: runsError.message });
        }

        for (const run of runs ?? []) {
          if (!latestRunBySource.has(run.source_id)) {
            latestRunBySource.set(run.source_id, run);
          }
          if (run.status === "success" && !latestSuccessBySource.has(run.source_id)) {
            latestSuccessBySource.set(run.source_id, run);
          }
        }
      }

      const now = Date.now();
      const response = (sources ?? []).map((source) => {
        const latestRun = latestRunBySource.get(source.id) ?? null;
        const latestSuccess = latestSuccessBySource.get(source.id) ?? null;
        const intervalMinutes = source.ingest_interval_minutes ?? null;
        const lastSuccessAt = latestSuccess ? getRunTimestamp(latestSuccess) : null;

        let isStale = false;
        if (source.active) {
          if (!intervalMinutes || !lastSuccessAt) {
            isStale = true;
          } else {
            const lastSuccessMs = Date.parse(lastSuccessAt);
            if (Number.isNaN(lastSuccessMs)) {
              isStale = true;
            } else {
              isStale =
                now > lastSuccessMs + intervalMinutes * 2 * 60 * 1000;
            }
          }
        }

        return {
          id: source.id,
          name: source.name,
          url: source.url,
          active: source.active,
          sector: source.sectors
            ? {
                id: source.sectors.id,
                name: source.sectors.name,
                slug: source.sectors.slug,
              }
            : null,
          expected_interval_minutes: intervalMinutes,
          last_success_at: lastSuccessAt,
          last_run: latestRun
            ? {
                status: latestRun.status,
                started_at: latestRun.started_at,
                finished_at: latestRun.finished_at,
                duration_ms: latestRun.duration_ms,
                item_count: latestRun.item_count,
                item_added: latestRun.item_added,
                error_message: latestRun.error_message,
              }
            : null,
          is_stale: isStale,
        };
      });

      return response;
    },
  );
};
