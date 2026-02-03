import { useMemo, useState } from "react";
import type { StatsOverview, StatsSource, ResetResult } from "../api";
import { resetAllData } from "../api";
import Spinner from "../components/Spinner";

type MonitoringProps = {
  overview: StatsOverview | null;
  sources: StatsSource[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
  onRefresh: () => void;
  autoRefreshEnabled: boolean;
  onToggleAutoRefresh: () => void;
};

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

export default function Monitoring({
  overview,
  sources,
  isLoading,
  error,
  lastUpdated,
  onRefresh,
  autoRefreshEnabled,
  onToggleAutoRefresh,
}: MonitoringProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeOnly, setActiveOnly] = useState(true);
  const [sectorFilter, setSectorFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showResetModal, setShowResetModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

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
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Monitoring</h1>
            <p className="mt-1 text-sm text-slate-400">
              Source health, queue pressure, and freshness.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {lastUpdated ? `Updated ${lastUpdated}` : "Not updated yet"}
            </span>
            <button
              onClick={onToggleAutoRefresh}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                autoRefreshEnabled
                  ? "border-emerald-500/40 text-emerald-200"
                  : "border-slate-700 text-slate-300"
              }`}
            >
              {autoRefreshEnabled ? "Auto-refresh on" : "Auto-refresh off"}
            </button>
            <button
              onClick={onRefresh}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Refresh
            </button>
            <button
              onClick={() => setShowResetModal(true)}
              className="rounded-full border border-red-800/60 bg-red-950/30 px-4 py-2 text-sm text-red-300 transition hover:border-red-600 hover:bg-red-950/50"
            >
              Reset Data
            </button>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      </section>

      <section className="grid gap-3 md:grid-cols-5">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.total_sources ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Active sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.active_sources ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Items 24h</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.items_last_24h ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Stale sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {overview?.stale_sources ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Queue backlog</p>
          <p className="mt-2 text-sm text-slate-300">
            W:{overview?.queues.feed.waiting ?? "—"} A:{overview?.queues.feed.active ?? "—"} D:
            {overview?.queues.feed.delayed ?? "—"} F:
            <span
              className={
                (overview?.queues.feed.failed ?? 0) > 0 ? "text-red-300" : "text-slate-300"
              }
            >
              {overview?.queues.feed.failed ?? "—"}
            </span>
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
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
              <option value="ok">OK</option>
              <option value="stale">Stale</option>
              <option value="error">Error</option>
            </select>
            <button
              onClick={() => setActiveOnly((prev) => !prev)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                activeOnly
                  ? "border-emerald-500/40 text-emerald-200"
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
              ? "border-amber-500/40 text-amber-200"
              : source.last_run?.status === "error"
                ? "border-red-500/40 text-red-200"
                : "border-emerald-500/40 text-emerald-200";
            return (
              <div
                key={source.id}
                className={`grid gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-[2.2fr,3fr] ${
                  source.active ? "" : "opacity-70"
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusTone}`}>
                      {statusLabel}
                    </span>
                    <span className="text-xs text-slate-500">
                      {source.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-100">
                    {source.name ?? "Untitled source"}
                  </p>
                  <p className="text-xs text-slate-400">{source.url}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    Sector: {source.sector?.name ?? "Unassigned"}
                  </p>
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
                  <span className="text-slate-300 line-clamp-1">
                    {source.last_run?.status === "error"
                      ? (source.last_run.error_message ?? "Unknown error")
                      : "-"}
                  </span>
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
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading monitoring data...
            </div>
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
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
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
              <button
                onClick={() => {
                  setShowResetModal(false);
                  setResetError(null);
                }}
                disabled={isResetting}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                disabled={isResetting}
                className="flex items-center gap-2 rounded-lg border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-200 transition hover:bg-red-900 disabled:opacity-50"
              >
                {isResetting ? (
                  <>
                    <Spinner /> Resetting...
                  </>
                ) : (
                  "Yes, Reset Everything"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
