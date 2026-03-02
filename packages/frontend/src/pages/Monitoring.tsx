import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { StatsOverview, StatsSource, ResetResult } from "../api";
import { getStatsOverview, getStatsSources, resetAllData } from "../api";
import { Skeleton, SkeletonText } from "../components/ui/Skeleton";
import Button from "../components/ui/Button";

type StatusFilter = "all" | "stale" | "error" | "ok";

const formatRelative = (value: string | null) => {
  if (!value) {
    return "Never";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Unknown";
  }
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) {
    return "Just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

const formatDuration = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  if (value < 60000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${Math.round(value / 60000)}m`;
};

export default function Monitoring() {
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [sources, setSources] = useState<StatsSource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeOnly, setActiveOnly] = useState(true);
  const [sectorFilter, setSectorFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showResetModal, setShowResetModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const onRefresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [overviewData, sourcesData] = await Promise.all([
        getStatsOverview(),
        getStatsSources(),
      ]);
      setOverview(overviewData);
      setSources(sourcesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitoring stats");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    onRefresh();
  }, []);

  const handleReset = async () => {
    setIsResetting(true);
    setResetError(null);
    try {
      const result = await resetAllData();
      setResetResult(result);
      setShowResetModal(false);
      // Refresh data after reset
      onRefresh();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setIsResetting(false);
    }
  };

  const sectors = useMemo(() => {
    const entries = new Map<string, string>();
    sources.forEach((source) => {
      if (source.sector) {
        entries.set(source.sector.id, source.sector.name);
      }
    });
    return Array.from(entries.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [sources]);

  const filteredSources = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sources.filter((source) => {
      if (activeOnly && !source.active) {
        return false;
      }
      if (sectorFilter !== "all" && source.sector?.id !== sectorFilter) {
        return false;
      }
      if (statusFilter === "stale" && !source.is_stale) {
        return false;
      }
      if (statusFilter === "error" && source.last_run?.status !== "error") {
        return false;
      }
      if (statusFilter === "ok" && (source.is_stale || source.last_run?.status === "error")) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = `${source.name ?? ""} ${source.url}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [sources, activeOnly, sectorFilter, statusFilter, search]);

  return (
    <div className="grid gap-4">
      {/* Header - sticky below nav */}
      <section className="sticky top-[var(--nav-h)] z-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
            <p className="mt-1 text-sm text-slate-400">
              Source health, queue pressure, and freshness.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={onRefresh}>
              Refresh
            </Button>
            <Button variant="danger" onClick={() => setShowResetModal(true)}>
              Reset Data
            </Button>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      </section>

      <section className="grid gap-3 md:grid-cols-5">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" title="Total number of RSS sources configured in the system">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.total_sources ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" title="Sources currently enabled for fetching">
          <p className="text-xs uppercase tracking-wide text-slate-500">Active sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.active_sources ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" title="Articles ingested in the last 24 hours">
          <p className="text-xs uppercase tracking-wide text-slate-500">Items 24h</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.items_last_24h ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" title="Sources with no successful fetch in 2+ hours">
          <p className="text-xs uppercase tracking-wide text-slate-500">Stale sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.stale_sources ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" title="BullMQ pipeline queue status">
          <p className="text-xs uppercase tracking-wide text-slate-500">Queue backlog</p>
          <p className="mt-2 text-sm text-slate-300">
            <span title="Waiting — jobs queued but not yet processing">W:{overview?.queues.feed.waiting ?? "—"}</span>{" "}
            <span title="Active — jobs currently being processed">A:{overview?.queues.feed.active ?? "—"}</span>{" "}
            <span title="Delayed — jobs scheduled for future execution">D:{overview?.queues.feed.delayed ?? "—"}</span>{" "}
            <span
              title="Failed — jobs that errored during processing"
              className={
                (overview?.queues.feed.failed ?? 0) > 0 ? "text-red-300" : "text-slate-300"
              }
            >
              F:{overview?.queues.feed.failed ?? "—"}
            </span>
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Sources</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or URL"
              className="w-52 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={sectorFilter}
              onChange={(event) => setSectorFilter(event.target.value)}
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200"
            >
              <option value="all">All sectors</option>
              {sectors.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200"
            >
              <option value="all">All status</option>
              <option value="ok">OK — last fetch succeeded</option>
              <option value="stale">Stale — no fetch in 2+ expected intervals</option>
              <option value="error">Error — last fetch failed</option>
            </select>
            <button
              onClick={() => setActiveOnly((prev) => !prev)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                activeOnly
                  ? "border-emerald-500/30 text-emerald-200"
                  : "border-slate-700 text-slate-300"
              }`}
            >
              {activeOnly ? "Active only" : "All sources"}
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3">
          {filteredSources.map((source) => {
            const statusLabel = source.is_stale
              ? "Stale"
              : source.last_run?.status === "error"
                ? "Error"
                : "OK";
            const statusTone = source.is_stale
              ? "border-amber-500/30 text-amber-200"
              : source.last_run?.status === "error"
                ? "border-red-500/30 text-red-200"
                : "border-emerald-500/30 text-emerald-200";
            return (
              <div
                key={source.id}
                className={`grid gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-[2.2fr,3fr] ${
                  source.active ? "" : "opacity-70"
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusTone}`}>
                    {statusLabel}
                  </span>
                  <span className="text-xs text-slate-500">
                    {source.active ? "Active" : "Inactive"}
                  </span>
                  <span className="text-sm font-semibold text-slate-100">
                    {source.name ?? "Untitled source"}
                  </span>
                  <span className="text-xs text-slate-500" title={source.url}>
                    {(() => {
                      try {
                        return new URL(source.url).hostname;
                      } catch {
                        return source.url;
                      }
                    })()}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(source.url);
                      toast.success("URL copied");
                    }}
                    className="flex-shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200 transition"
                  >
                    Copy URL
                  </button>
                  <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                    {source.sector?.name ?? "Unassigned"}
                  </span>
                </div>
                <div className="grid grid-rows-2 grid-flow-col auto-cols-fr gap-x-4 gap-y-1 text-xs">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Interval
                  </span>
                  <span className="text-slate-200">
                    {source.expected_interval_minutes ?? "-"} min
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Last success
                  </span>
                  <span className="text-slate-300">{formatRelative(source.last_success_at)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Last run
                  </span>
                  <span className="text-slate-300">
                    {source.last_run
                      ? formatRelative(source.last_run.finished_at ?? source.last_run.started_at)
                      : "Never"}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Duration
                  </span>
                  <span className="text-slate-300">
                    {source.last_run ? formatDuration(source.last_run.duration_ms) : "-"}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Item Count
                  </span>
                  <span className="text-slate-200">{source.last_run?.item_count ?? "-"}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Items Added
                  </span>
                  <span className="text-slate-200">{source.last_run?.item_added ?? "-"}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Error</span>
                  {source.last_run?.status === "error" && source.last_run.error_message ? (
                    <details className="text-slate-300">
                      <summary className="cursor-pointer line-clamp-1 hover:text-slate-100 list-none">
                        {source.last_run.error_message}
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap break-all text-xs text-red-300/80 bg-red-950/20 rounded px-2 py-1">
                        {source.last_run.error_message}
                      </p>
                    </details>
                  ) : (
                    <span className="text-slate-300">-</span>
                  )}
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Last update
                  </span>
                  <span className="text-slate-300">
                    {source.last_run?.finished_at
                      ? new Date(source.last_run.finished_at).toLocaleString()
                      : "-"}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Status</span>
                  <span className="text-slate-300">{source.last_run?.status ?? "-"}</span>
                </div>
              </div>
            );
          })}
          {filteredSources.length === 0 && !isLoading ? (
            <p className="text-sm text-slate-400">No sources match the filters.</p>
          ) : null}
          {isLoading && filteredSources.length === 0 ? (
            <>
              {Array.from({ length: 4 }, (_, i) => (
                <div
                  key={i}
                  className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-[2.2fr,3fr]"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Skeleton className="w-12 h-5 rounded-full" />
                    <SkeletonText className="w-20 h-4" />
                    <SkeletonText className="w-48 h-4" />
                  </div>
                  <div className="grid grid-rows-2 grid-flow-col auto-cols-fr gap-x-4 gap-y-2">
                    {Array.from({ length: 8 }, (_, j) => (
                      <SkeletonText key={j} className="w-16 h-3" />
                    ))}
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </section>

      {/* Reset Success Message */}
      {resetResult && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-emerald-700/50 bg-emerald-950/90 p-4 shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-emerald-200">Data Reset Complete</p>
              <ul className="mt-2 space-y-1 text-xs text-emerald-300/80">
                <li>Articles: {resetResult.cleared.articles}</li>
                <li>Feed runs: {resetResult.cleared.feed_fetch_runs}</li>
                <li>LLM telemetry: {resetResult.cleared.llm_telemetry}</li>
                <li>Deliveries: {resetResult.cleared.post_deliveries}</li>
                <li>Images: {resetResult.cleared.article_images}</li>
                <li>Redis keys: {resetResult.cleared.redis_keys}</li>
              </ul>
            </div>
            <button
              onClick={() => setResetResult(null)}
              className="text-emerald-400 hover:text-emerald-200"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-red-300">Reset All Data?</h3>
            <p className="mt-3 text-sm text-slate-300">
              This will permanently delete:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-slate-400">
              <li>• All articles and their embeddings</li>
              <li>• Feed fetch history</li>
              <li>• LLM telemetry logs</li>
              <li>• Scheduled and completed deliveries</li>
              <li>• Generated images</li>
              <li>• All queued jobs in Redis</li>
            </ul>
            <p className="mt-3 text-sm text-slate-300">
              Configuration (sectors, sources, scoring rules) will be preserved.
            </p>
            {resetError && (
              <p className="mt-3 text-sm text-red-400">{resetError}</p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowResetModal(false);
                  setResetError(null);
                }}
                disabled={isResetting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleReset}
                disabled={isResetting}
                loading={isResetting}
                loadingText="Resetting..."
              >
                Yes, Reset Everything
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
