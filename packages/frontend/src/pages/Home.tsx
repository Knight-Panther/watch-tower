import { useMemo } from "react";
import type { Sector, Source } from "../api";

type HomeProps = {
  sources: Source[];
  sectors: Sector[];
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
  filters: { sectorId: string; maxAgeDays: string };
  selectedCount: number;
  selectedIds: Record<string, boolean>;
  isTriggering: boolean;
  onRunIngest: () => void;
  onRefresh: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onToggle: (source: Source) => void;
  onDeletePermanent: (source: Source) => void;
  onSaveChanges: (source: Source) => void;
  onFilterChange: (next: { sectorId: string; maxAgeDays: string }) => void;
  onSourceFormChange: (next: HomeProps["sourceForm"]) => void;
  onMaxAgeDraftChange: (id: string, value: string) => void;
  onSourceIntervalDraftChange: (id: string, value: string) => void;
  onSectorDraftChange: (id: string, value: string) => void;
  onSelectToggle: (id: string, value: boolean) => void;
  onBatchDeactivate: () => void;
  onBatchDelete: () => void;
};

export default function Home(props: HomeProps) {
  const groupedSources = useMemo(() => {
    const maxAgeFilter = props.filters.maxAgeDays.trim()
      ? Number(props.filters.maxAgeDays)
      : null;
    const maxAgeValid =
      maxAgeFilter === null ||
      (!Number.isNaN(maxAgeFilter) && maxAgeFilter >= 1 && maxAgeFilter <= 15);

    const filteredSources = props.sources.filter((source) => {
      if (props.filters.sectorId && source.sector_id !== props.filters.sectorId) {
        return false;
      }
      if (!maxAgeValid) {
        return true;
      }
      if (maxAgeFilter !== null) {
        const effectiveMaxAge =
          source.max_age_days ?? source.sectors?.default_max_age_days ?? 5;
        return effectiveMaxAge === maxAgeFilter;
      }
      return true;
    });

    const groups = new Map<string, { title: string; sources: Source[] }>();

    filteredSources.forEach((source) => {
      const sectorName = source.sectors?.name ?? "Unassigned";
      const maxAge =
        source.max_age_days ?? source.sectors?.default_max_age_days ?? 5;
      const key = `${sectorName}::${maxAge}`;
      const title = `${sectorName} - max age ${maxAge} days`;
      const group = groups.get(key) ?? { title, sources: [] };
      group.sources.push(source);
      groups.set(key, group);
    });

    return Array.from(groups.values()).sort((a, b) =>
      a.title.localeCompare(b.title),
    );
  }, [props.sources, props.filters]);

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Media Watch Tower
          </h1>
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
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Add source</h2>
        <form
          onSubmit={props.onSubmit}
          className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]"
        >
          <input
            value={props.sourceForm.url}
            onChange={(event) =>
              props.onSourceFormChange({
                ...props.sourceForm,
                url: event.target.value,
              })
            }
            placeholder="RSS URL"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {props.sourceErrors.url ? (
            <p className="text-xs text-red-400">{props.sourceErrors.url}</p>
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
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          <select
            value={props.sourceForm.sectorId}
            onChange={(event) =>
              props.onSourceFormChange({
                ...props.sourceForm,
                sectorId: event.target.value,
              })
            }
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
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
            <p className="text-xs text-amber-300">
              Create a sector before adding sources.
            </p>
          ) : null}
          {props.sourceErrors.sectorId ? (
            <p className="text-xs text-red-400">{props.sourceErrors.sectorId}</p>
          ) : null}
          <input
            value={props.sourceForm.maxAgeDays}
            onChange={(event) =>
              props.onSourceFormChange({
                ...props.sourceForm,
                maxAgeDays: event.target.value,
              })
            }
            placeholder="Max age days (1-15, optional)"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {props.sourceErrors.maxAgeDays ? (
            <p className="text-xs text-red-400">{props.sourceErrors.maxAgeDays}</p>
          ) : null}
          <input
            value={props.sourceForm.ingestIntervalMinutes}
            onChange={(event) =>
              props.onSourceFormChange({
                ...props.sourceForm,
                ingestIntervalMinutes: event.target.value,
              })
            }
            placeholder="Interval minutes (1-4320)"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {props.sourceErrors.ingestIntervalMinutes ? (
            <p className="text-xs text-red-400">
              {props.sourceErrors.ingestIntervalMinutes}
            </p>
          ) : null}
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={props.sectors.length === 0}
              className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Filters</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]">
          <select
            value={props.filters.sectorId}
            onChange={(event) =>
              props.onFilterChange({
                ...props.filters,
                sectorId: event.target.value,
              })
            }
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
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
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
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

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sources</h2>
          <div className="flex items-center gap-3">
            {props.selectedCount > 0 ? (
              <span className="text-xs text-slate-400">
                {props.selectedCount} selected
              </span>
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
            {props.isLoading ? (
              <span className="text-xs text-slate-400">Loading...</span>
            ) : null}
          </div>
        </div>

        {props.error ? (
          <p className="mt-3 text-sm text-red-400">{props.error}</p>
        ) : null}
        {!props.isLoading && props.sources.length > 0 && props.activeCount === 0 ? (
          <p className="mt-3 text-sm text-amber-300">
            All sources are inactive. Ingest will not pull any items.
          </p>
        ) : null}

        <div className="mt-4 grid gap-6">
          {groupedSources.map((group) => (
            <div key={group.title} className="rounded-xl border border-slate-800">
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
                <p className="text-sm font-semibold text-slate-200">
                  {group.title}
                </p>
                <span className="text-xs text-slate-500">
                  {group.sources.length} sources
                </span>
              </div>
              <div className="grid gap-3 p-4">
                {group.sources.map((source) => (
                  <div
                    key={source.id}
                    className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={Boolean(props.selectedIds[source.id])}
                        onChange={(event) =>
                          props.onSelectToggle(source.id, event.target.checked)
                        }
                        className="h-4 w-4 accent-emerald-400"
                      />
                      <div>
                        <p className="text-sm font-semibold">
                          {source.name ?? "Untitled source"}
                        </p>
                        <p className="text-xs text-slate-400">{source.url}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">
                          Sector
                        </span>
                        <select
                          value={props.sectorDrafts[source.id] ?? source.sector_id ?? ""}
                          onChange={(event) =>
                            props.onSectorDraftChange(source.id, event.target.value)
                          }
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
                            String(
                              source.max_age_days ??
                                source.sectors?.default_max_age_days ??
                                5,
                            )
                          }
                          onChange={(event) =>
                            props.onMaxAgeDraftChange(source.id, event.target.value)
                          }
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
                ))}
              </div>
            </div>
          ))}
          {!props.isLoading && props.sources.length === 0 ? (
            <p className="text-sm text-slate-400">No sources yet.</p>
          ) : null}
        </div>
      </section>
    </>
  );
}
