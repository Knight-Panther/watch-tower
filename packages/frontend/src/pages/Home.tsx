import { useMemo, useState } from "react";
import type { Sector, Source, StatsSource, ProviderHealthResult, SourceQuality } from "../api";
import { checkProviderHealth } from "../api";
import Spinner from "../components/Spinner";
import ApiHealthModal from "../components/ApiHealthModal";

type HomeProps = {
  sources: Source[];
  sectors: Sector[];
  statsLookup: Map<string, StatsSource>;
  sourceQuality: Record<string, SourceQuality>;
  activeCount: number;
  isLoading: boolean;
  error: string | null;
  sourceForm: {
    url: string;
    name: string;
    sectorId: string;
    maxAgeDays: string;
    ingestIntervalMinutes: string;
  };
  sourceErrors: {
    url?: string;
    sectorId?: string;
    maxAgeDays?: string;
    ingestIntervalMinutes?: string;
  };
  maxAgeDrafts: Record<string, string>;
  sourceIntervalDrafts: Record<string, string>;
  sectorDrafts: Record<string, string>;
  filters: { sectorId: string; maxAgeDays: string; search: string };
  selectedCount: number;
  selectedIds: Record<string, boolean>;
  isTriggering: boolean;
  onRunIngest: () => void;
  onRefresh: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onToggle: (source: Source) => void;
  onDeletePermanent: (source: Source) => void;
  onSaveChanges: (source: Source) => void;
  onFilterChange: (next: { sectorId: string; maxAgeDays: string; search: string }) => void;
  onSourceFormChange: (next: HomeProps["sourceForm"]) => void;
  onMaxAgeDraftChange: (id: string, value: string) => void;
  onSourceIntervalDraftChange: (id: string, value: string) => void;
  onSectorDraftChange: (id: string, value: string) => void;
  onSelectToggle: (id: string, value: boolean) => void;
  onBatchDeactivate: () => void;
  onBatchDelete: () => void;
};

export default function Home(props: HomeProps) {
  const [sortBy, setSortBy] = useState<"default" | "signal-best" | "signal-worst" | "name">(
    "default",
  );
  const [healthModalOpen, setHealthModalOpen] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthResults, setHealthResults] = useState<ProviderHealthResult[] | null>(null);
  const [healthCheckedAt, setHealthCheckedAt] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const onCheckApiHealth = async () => {
    setHealthModalOpen(true);
    setHealthLoading(true);
    setHealthError(null);
    setHealthResults(null);
    try {
      const data = await checkProviderHealth();
      setHealthResults(data.results);
      setHealthCheckedAt(data.checked_at);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setHealthLoading(false);
    }
  };

  const filteredSources = useMemo(() => {
    const maxAgeFilter = props.filters.maxAgeDays.trim() ? Number(props.filters.maxAgeDays) : null;
    const maxAgeValid =
      maxAgeFilter === null ||
      (!Number.isNaN(maxAgeFilter) && maxAgeFilter >= 1 && maxAgeFilter <= 15);
    const searchQuery = props.filters.search.trim().toLowerCase();

    const filtered = props.sources.filter((source) => {
      if (props.filters.sectorId && source.sector_id !== props.filters.sectorId) {
        return false;
      }
      if (!maxAgeValid) {
        return true;
      }
      if (maxAgeFilter !== null) {
        const effectiveMaxAge = source.max_age_days ?? source.sectors?.default_max_age_days ?? 1;
        if (effectiveMaxAge !== maxAgeFilter) {
          return false;
        }
      }
      if (searchQuery) {
        const haystack = `${source.name ?? ""} ${source.url}`.toLowerCase();
        if (!haystack.includes(searchQuery)) {
          return false;
        }
      }
      return true;
    });

    if (sortBy === "name") {
      return [...filtered].sort((a, b) =>
        (a.name ?? a.url).localeCompare(b.name ?? b.url),
      );
    }
    if (sortBy === "signal-best" || sortBy === "signal-worst") {
      return [...filtered].sort((a, b) => {
        const qa = props.sourceQuality[a.id];
        const qb = props.sourceQuality[b.id];
        const ra = qa?.signal_ratio ?? -1;
        const rb = qb?.signal_ratio ?? -1;
        return sortBy === "signal-best" ? rb - ra : ra - rb;
      });
    }
    return filtered;
  }, [props.sources, props.filters, props.sourceQuality, sortBy]);

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Media Watch Tower</h1>
          <p className="mt-2 text-sm text-slate-400">
            {props.activeCount} active sources - {props.sources.length} total
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={props.onRunIngest}
            disabled={props.isTriggering}
            className="rounded-full border border-emerald-500/50 px-4 py-2 text-sm text-emerald-200 transition hover:border-emerald-300 disabled:opacity-50"
          >
            {props.isTriggering ? "Triggering..." : "Run ingest"}
          </button>
          <button
            onClick={props.onRefresh}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
          >
            Refresh
          </button>
          <button
            onClick={onCheckApiHealth}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
          >
            Check API Health
          </button>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-sm font-semibold text-slate-300">Add source</h2>
          <form onSubmit={props.onSubmit} className="mt-3 grid gap-2.5 grid-cols-2">
            <input
              value={props.sourceForm.url}
              onChange={(event) =>
                props.onSourceFormChange({
                  ...props.sourceForm,
                  url: event.target.value,
                })
              }
              placeholder="RSS URL"
              className="col-span-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {props.sourceErrors.url ? (
              <p className="col-span-2 text-xs text-red-400">{props.sourceErrors.url}</p>
            ) : null}
            <input
              value={props.sourceForm.name}
              onChange={(event) =>
                props.onSourceFormChange({
                  ...props.sourceForm,
                  name: event.target.value,
                })
              }
              placeholder="Name (optional)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={props.sourceForm.sectorId}
              onChange={(event) =>
                props.onSourceFormChange({
                  ...props.sourceForm,
                  sectorId: event.target.value,
                })
              }
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            >
              <option value="" disabled>
                Select sector
              </option>
              {props.sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
            {props.sectors.length === 0 ? (
              <p className="col-span-2 text-xs text-amber-300">
                Create a sector before adding sources.
              </p>
            ) : null}
            {props.sourceErrors.sectorId ? (
              <p className="col-span-2 text-xs text-red-400">{props.sourceErrors.sectorId}</p>
            ) : null}
            <input
              value={props.sourceForm.maxAgeDays}
              onChange={(event) =>
                props.onSourceFormChange({
                  ...props.sourceForm,
                  maxAgeDays: event.target.value,
                })
              }
              placeholder="Max age (1-15 days)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {props.sourceErrors.maxAgeDays ? (
              <p className="col-span-2 text-xs text-red-400">{props.sourceErrors.maxAgeDays}</p>
            ) : null}
            <input
              value={props.sourceForm.ingestIntervalMinutes}
              onChange={(event) =>
                props.onSourceFormChange({
                  ...props.sourceForm,
                  ingestIntervalMinutes: event.target.value,
                })
              }
              placeholder="Interval (1-4320 min)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {props.sourceErrors.ingestIntervalMinutes ? (
              <p className="col-span-2 text-xs text-red-400">
                {props.sourceErrors.ingestIntervalMinutes}
              </p>
            ) : null}
            <div className="col-span-2">
              <button
                type="submit"
                disabled={props.sectors.length === 0}
                className="w-full rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Add
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-sm font-semibold text-slate-300">Filters</h2>
          <div className="mt-3 grid gap-2.5">
            <input
              value={props.filters.search}
              onChange={(event) =>
                props.onFilterChange({
                  ...props.filters,
                  search: event.target.value,
                })
              }
              placeholder="Search name or URL"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={props.filters.sectorId}
              onChange={(event) =>
                props.onFilterChange({
                  ...props.filters,
                  sectorId: event.target.value,
                })
              }
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            >
              <option value="">All sectors</option>
              {props.sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
            <input
              value={props.filters.maxAgeDays}
              onChange={(event) =>
                props.onFilterChange({
                  ...props.filters,
                  maxAgeDays: event.target.value,
                })
              }
              placeholder="Max age days (1-15)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
          </div>
          {props.filters.maxAgeDays.trim() !== "" ? (
            Number.isNaN(Number(props.filters.maxAgeDays)) ||
            Number(props.filters.maxAgeDays) < 1 ||
            Number(props.filters.maxAgeDays) > 15 ? (
              <p className="mt-2 text-xs text-red-400">
                Filter max age must be between 1 and 15
              </p>
            ) : null
          ) : null}
        </section>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Sources
            <span className="ml-2 text-sm font-normal text-slate-500">
              {filteredSources.length} of {props.sources.length}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-300 outline-none"
              title="Sort sources by signal quality or name"
            >
              <option value="default">Default order</option>
              <option value="signal-best">Best signal first</option>
              <option value="signal-worst">Worst signal first</option>
              <option value="name">Name A-Z</option>
            </select>
            {props.selectedCount > 0 ? (
              <span className="text-xs text-slate-400">{props.selectedCount} selected</span>
            ) : null}
            <button
              onClick={props.onBatchDeactivate}
              disabled={props.selectedCount === 0}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Deactivate selected
            </button>
            <button
              onClick={props.onBatchDelete}
              disabled={props.selectedCount === 0}
              className="rounded-full border border-red-500/60 px-3 py-1 text-xs text-red-200 transition hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Delete selected
            </button>
            {props.isLoading ? <Spinner /> : null}
          </div>
        </div>

        {props.error ? <p className="mt-3 text-sm text-red-400">{props.error}</p> : null}
        {!props.isLoading && props.sources.length > 0 && props.activeCount === 0 ? (
          <p className="mt-3 text-sm text-amber-300">
            All sources are inactive. Ingest will not pull any items.
          </p>
        ) : null}

        <div className="mt-4 grid gap-3">
          {filteredSources.map((source) => {
            const stats = props.statsLookup.get(source.id);
            const quality = props.sourceQuality[source.id];
            const healthStatus = stats?.is_stale
              ? "stale"
              : stats?.last_run?.status === "error"
                ? "error"
                : stats?.last_run
                  ? "ok"
                  : "unknown";
            const healthDot =
              healthStatus === "ok"
                ? "bg-emerald-400"
                : healthStatus === "error"
                  ? "bg-red-400"
                  : healthStatus === "stale"
                    ? "bg-amber-400"
                    : "bg-slate-500";
            const healthTitle =
              healthStatus === "ok"
                ? "Healthy"
                : healthStatus === "error"
                  ? (stats?.last_run?.error_message ?? "Last fetch failed")
                  : healthStatus === "stale"
                    ? "Stale - no recent updates"
                    : "No fetch data yet";

            // Signal ratio badge color
            const signalColor = !quality
              ? "text-slate-500"
              : quality.signal_ratio >= 40
                ? "text-emerald-400"
                : quality.signal_ratio >= 15
                  ? "text-amber-400"
                  : "text-red-400";

            return (
              <div
                key={source.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0 flex-shrink">
                  <input
                    type="checkbox"
                    checked={Boolean(props.selectedIds[source.id])}
                    onChange={(event) => props.onSelectToggle(source.id, event.target.checked)}
                    className="h-4 w-4 flex-shrink-0 accent-emerald-400"
                  />
                  <span
                    className={`h-2 w-2 flex-shrink-0 rounded-full ${healthDot}`}
                    title={healthTitle}
                  />
                  <div className="w-[160px] flex-shrink-0">
                    <p className="text-sm font-semibold truncate">
                      {source.name ?? "Untitled source"}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-slate-500 truncate" title={source.url}>
                        {(() => {
                          try {
                            const u = new URL(source.url);
                            return u.hostname;
                          } catch {
                            return source.url;
                          }
                        })()}
                      </p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(source.url);
                          const btn = e.currentTarget;
                          btn.textContent = "✓";
                          setTimeout(() => { btn.textContent = "Copy URL"; }, 1200);
                        }}
                        className="flex-shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200 transition"
                      >
                        Copy URL
                      </button>
                    </div>
                  </div>
                  {quality && quality.total > 0 && (() => {
                    const barColors: Record<number, string> = {
                      1: "bg-red-500", 2: "bg-orange-400", 3: "bg-amber-400", 4: "bg-emerald-400", 5: "bg-emerald-300",
                    };
                    const textColors: Record<number, string> = {
                      1: "text-red-400", 2: "text-orange-400", 3: "text-amber-400", 4: "text-emerald-400", 5: "text-emerald-300",
                    };
                    const segments = [1, 2, 3, 4, 5]
                      .map((s) => ({ score: s, count: quality.distribution[s] ?? 0 }))
                      .filter((s) => s.count > 0);
                    return (
                    <div className="ml-2 flex-shrink-0 self-center">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-8 text-right text-xs font-semibold tabular-nums ${signalColor}`}
                          title="Signal ratio — percentage of articles that scored 4 or 5 (high-value). Green means 40%+ are high-value, amber means 15-39%, red means under 15%."
                        >
                          {quality.signal_ratio}%
                        </span>
                        <div className="w-44" title="Score distribution bar — each colored segment represents a score level (1 to 5, left to right). Wider segments mean more articles at that score. Red/orange = low scores, green = high scores.">
                          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                            {segments.map(({ score, count }) => (
                              <div
                                key={score}
                                className={barColors[score]}
                                style={{ width: `${(count / quality.total) * 100}%` }}
                              />
                            ))}
                          </div>
                          <div className="flex w-full mt-0.5">
                            {segments.map(({ score, count }) => (
                              <div
                                key={score}
                                className={`text-center text-[9px] leading-tight ${textColors[score]}`}
                                style={{ width: `${(count / quality.total) * 100}%` }}
                              >
                                {(count / quality.total) >= 0.08 ? `${score}:${count}` : count}
                              </div>
                            ))}
                          </div>
                        </div>
                        <span className="w-6 text-right text-[10px] tabular-nums text-slate-500" title="Total number of articles scored from this source in the last 30 days.">{quality.total}</span>
                        {quality.total >= 30 && quality.signal_ratio >= 40 && (
                          <span
                            className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400"
                            title="This source produces 40%+ high-value articles (score 4+) over 30+ scored articles. Great signal source."
                          >
                            High signal
                          </span>
                        )}
                        {quality.total >= 30 && quality.signal_ratio < 10 && (
                          <span
                            className="rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-red-400"
                            title="This source produces less than 10% high-value articles (score 4+) over 30+ scored articles. Consider disabling it or adjusting its sector."
                          >
                            Low signal
                          </span>
                        )}
                      </div>
                    </div>
                    );
                  })()}
                </div>
                <div className="flex items-end gap-3 ml-auto flex-shrink-0">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Sector
                    </span>
                    <select
                      value={props.sectorDrafts[source.id] ?? source.sector_id ?? ""}
                      onChange={(event) => props.onSectorDraftChange(source.id, event.target.value)}
                      className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                    >
                      <option value="">Unassigned</option>
                      {props.sectors.map((sector) => (
                        <option key={sector.id} value={sector.id}>
                          {sector.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Max age (days)
                    </span>
                    <input
                      value={
                        props.maxAgeDrafts[source.id] ??
                        String(source.max_age_days ?? source.sectors?.default_max_age_days ?? 1)
                      }
                      onChange={(event) => props.onMaxAgeDraftChange(source.id, event.target.value)}
                      className="w-20 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Interval (min)
                    </span>
                    <input
                      value={
                        props.sourceIntervalDrafts[source.id] ??
                        String(source.ingest_interval_minutes)
                      }
                      onChange={(event) =>
                        props.onSourceIntervalDraftChange(source.id, event.target.value)
                      }
                      className="w-24 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                    />
                  </div>
                  <button
                    onClick={() => props.onSaveChanges(source)}
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 hover:text-white"
                  >
                    Save
                  </button>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => props.onToggle(source)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        source.active
                          ? "bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
                          : "bg-slate-700/40 text-slate-300 hover:bg-slate-700/60"
                      }`}
                    >
                      {source.active ? "Active" : "Inactive"}
                    </button>
                    <button
                      onClick={() => props.onDeletePermanent(source)}
                      className="text-xs text-red-400 hover:text-red-200 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {!props.isLoading && props.sources.length === 0 ? (
            <p className="text-sm text-slate-400">No sources yet.</p>
          ) : null}
        </div>
      </section>

      {healthModalOpen && (
        <ApiHealthModal
          results={healthResults}
          checkedAt={healthCheckedAt}
          loading={healthLoading}
          error={healthError}
          onClose={() => setHealthModalOpen(false)}
        />
      )}
    </>
  );
}
