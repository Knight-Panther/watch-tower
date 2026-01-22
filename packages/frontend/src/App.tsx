import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  createSector,
  createSource,
  deleteSource,
  batchSourceAction,
  getFeedItemsTtl,
  getIngestInterval,
  setFeedItemsTtl,
  setIngestInterval,
  listSectors,
  listSources,
  runIngest,
  type Sector,
  type Source,
  updateSector,
  updateSource,
} from "./api";

const emptySourceForm = {
  url: "",
  name: "",
  sectorId: "",
  maxAgeDays: "",
  ingestIntervalMinutes: "",
};
const emptySectorForm = { name: "", defaultMaxAgeDays: "5", ingestIntervalMinutes: "" };

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceForm, setSourceForm] = useState(emptySourceForm);
  const [sourceErrors, setSourceErrors] = useState<{
    url?: string;
    sectorId?: string;
    maxAgeDays?: string;
    ingestIntervalMinutes?: string;
  }>({});
  const [sectorForm, setSectorForm] = useState(emptySectorForm);
  const [sectorErrors, setSectorErrors] = useState<{
    name?: string;
    defaultMaxAgeDays?: string;
    ingestIntervalMinutes?: string;
  }>({});
  const [isTriggering, setIsTriggering] = useState(false);
  const [maxAgeDrafts, setMaxAgeDrafts] = useState<Record<string, string>>({});
  const [confirmSource, setConfirmSource] = useState<Source | null>(null);
  const [sectorDrafts, setSectorDrafts] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState({ sectorId: "", maxAgeDays: "" });
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<Source | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [confirmBatchAction, setConfirmBatchAction] = useState<{
    action: "deactivate" | "delete";
    count: number;
    ids: string[];
  } | null>(null);
  const [ttlDays, setTtlDays] = useState("60");
  const [ttlError, setTtlError] = useState<string | null>(null);
  const [ingestIntervalMinutes, setIngestIntervalMinutes] = useState("15");
  const [ingestIntervalError, setIngestIntervalError] = useState<string | null>(null);
  const [sectorIntervalDrafts, setSectorIntervalDrafts] = useState<Record<string, string>>({});
  const [sourceIntervalDrafts, setSourceIntervalDrafts] = useState<Record<string, string>>({});

  const activeCount = useMemo(
    () => sources.filter((source) => source.active).length,
    [sources],
  );

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [sourcesData, sectorsData, ttlValue, ingestIntervalValue] = await Promise.all([
        listSources(),
        listSectors(),
        getFeedItemsTtl(),
        getIngestInterval(),
      ]);
      setSources(sourcesData);
      setSectors(sectorsData);
      setTtlDays(String(ttlValue));
      setIngestIntervalMinutes(String(ingestIntervalValue));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load sources";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSourceErrors({});
    if (!sourceForm.url) {
      setSourceErrors((prev) => ({ ...prev, url: "URL is required" }));
      setError("URL is required");
      return;
    }
    if (!sourceForm.sectorId) {
      setSourceErrors((prev) => ({
        ...prev,
        sectorId: "Sector is required",
      }));
      setError("Sector is required");
      return;
    }

    const maxAge =
      sourceForm.maxAgeDays.trim() === ""
        ? null
        : Number(sourceForm.maxAgeDays);
    if (maxAge !== null && (Number.isNaN(maxAge) || maxAge < 1 || maxAge > 15)) {
      setSourceErrors((prev) => ({
        ...prev,
        maxAgeDays: "Max age must be between 1 and 15",
      }));
      setError("Max age must be between 1 and 15");
      return;
    }

    const intervalRaw = sourceForm.ingestIntervalMinutes.trim();
    const intervalValue = intervalRaw === "" ? null : Number(intervalRaw);
    if (
      intervalValue !== null &&
      (Number.isNaN(intervalValue) || intervalValue < 1 || intervalValue > 4320)
    ) {
      setSourceErrors((prev) => ({
        ...prev,
        ingestIntervalMinutes: "Interval must be 1-4320",
      }));
      setError("Interval must be between 1 and 4320 minutes");
      return;
    }

    try {
      const created = await createSource({
        url: sourceForm.url,
        name: sourceForm.name,
        sector_id: sourceForm.sectorId,
        max_age_days: maxAge,
        ingest_interval_minutes: intervalValue,
      });
      setSources((prev) => [created, ...prev]);
      setSourceForm(emptySourceForm);
      toast.success("Source added");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create source";
      if (!message.toLowerCase().includes("already exists")) {
        setError(message);
      }
      toast.error(message);
    }
  };

  const onToggle = async (source: Source) => {
    try {
      const updated = await updateSource(source.id, {
        active: !source.active,
      });
      setSources((prev) =>
        prev.map((item) => (item.id === source.id ? updated : item)),
      );
      toast.success(source.active ? "Source deactivated" : "Source activated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update source";
      setError(message);
      toast.error(message);
    }
  };

  const onDelete = async (source: Source) => {
    setConfirmSource(source);
  };

  const confirmDeactivate = async () => {
    if (!confirmSource) {
      return;
    }
    try {
      const updated = await updateSource(confirmSource.id, { active: false });
      setSources((prev) =>
        prev.map((item) => (item.id === confirmSource.id ? updated : item)),
      );
      toast.success("Source deactivated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to deactivate source";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmSource(null);
    }
  };

  const confirmDelete = async () => {
    if (!confirmDeleteSource) {
      return;
    }
    try {
      const deleted = await deleteSource(confirmDeleteSource.id, true);
      setSources((prev) =>
        prev.filter((item) => item.id !== deleted.id),
      );
      toast.success("Source deleted");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete source";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmDeleteSource(null);
    }
  };

  const onSaveChanges = async (source: Source) => {
    const rawValue =
      maxAgeDrafts[source.id] ??
      String(
        source.max_age_days ??
          source.sectors?.default_max_age_days ??
          5,
      );

    let maxAgeValue: number | null = null;
    if (rawValue.trim() !== "") {
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 15) {
        setError("Max age must be between 1 and 15");
        toast.error("Max age must be between 1 and 15");
        return;
      }
      maxAgeValue = parsed;
    }

    const sectorId =
      sectorDrafts[source.id] ?? source.sector_id ?? "";

    if (!sectorId) {
      setError("Select a sector to save");
      toast.error("Select a sector to save");
      return;
    }

    const sectorChanged = sectorId !== (source.sector_id ?? "");
    const maxAgeChanged =
      maxAgeValue !==
      (source.max_age_days ?? source.sectors?.default_max_age_days ?? 5);

    const intervalValueRaw =
      sourceIntervalDrafts[source.id] ??
      String(
        source.ingest_interval_minutes ??
          source.sectors?.ingest_interval_minutes ??
          Number(ingestIntervalMinutes) ??
          15,
      );
    const intervalValue =
      intervalValueRaw.trim() === "" ? null : Number(intervalValueRaw);
    if (
      intervalValue !== null &&
      (Number.isNaN(intervalValue) || intervalValue < 1 || intervalValue > 4320)
    ) {
      setError("Interval must be between 1 and 4320 minutes");
      toast.error("Interval must be between 1 and 4320 minutes");
      return;
    }
    const intervalChanged =
      intervalValue !==
      (source.ingest_interval_minutes ??
        source.sectors?.ingest_interval_minutes ??
        Number(ingestIntervalMinutes) ??
        15);

    if (!sectorChanged && !maxAgeChanged && !intervalChanged) {
      toast("No changes to save");
      return;
    }

    try {
      const updated = await updateSource(source.id, {
        sector_id: sectorId,
        max_age_days: maxAgeValue,
        ingest_interval_minutes: intervalValue,
      });
      setSources((prev) =>
        prev.map((item) => (item.id === source.id ? updated : item)),
      );
      setMaxAgeDrafts((prev) => ({ ...prev, [source.id]: rawValue }));
      setSectorDrafts((prev) => {
        const next = { ...prev };
        delete next[source.id];
        return next;
      });

      if (sectorChanged && maxAgeChanged && intervalChanged) {
        toast.success("Sector, max age, and interval updated");
      } else if (sectorChanged && maxAgeChanged) {
        toast.success("Sector and max age updated");
      } else if (sectorChanged && intervalChanged) {
        toast.success("Sector and interval updated");
      } else if (maxAgeChanged && intervalChanged) {
        toast.success("Max age and interval updated");
      } else if (sectorChanged) {
        toast.success("Sector updated");
      } else if (maxAgeChanged) {
        toast.success("Max age updated");
      } else {
        toast.success("Interval updated");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update source";
      setError(message);
      toast.error(message);
    }
  };

  const onCreateSector = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSectorErrors({});
    if (!sectorForm.name.trim()) {
      setSectorErrors((prev) => ({
        ...prev,
        name: "Sector name is required",
      }));
      setError("Sector name is required");
      return;
    }

    const maxAge = Number(sectorForm.defaultMaxAgeDays);
    if (Number.isNaN(maxAge) || maxAge < 1 || maxAge > 15) {
      setSectorErrors((prev) => ({
        ...prev,
        defaultMaxAgeDays: "Default max age must be 1-15",
      }));
      setError("Default max age must be between 1 and 15");
      return;
    }

    const intervalRaw = sectorForm.ingestIntervalMinutes.trim();
    const intervalValue =
      intervalRaw === "" ? null : Number(intervalRaw);
    if (
      intervalValue !== null &&
      (Number.isNaN(intervalValue) ||
        intervalValue < 1 ||
        intervalValue > 4320)
    ) {
      setSectorErrors((prev) => ({
        ...prev,
        ingestIntervalMinutes: "Interval must be 1-4320",
      }));
      setError("Interval must be between 1 and 4320 minutes");
      return;
    }

    try {
      const created = await createSector({
        name: sectorForm.name.trim(),
        default_max_age_days: maxAge,
        ingest_interval_minutes: intervalValue,
      });
      setSectors((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSectorForm(emptySectorForm);
      toast.success("Sector created");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create sector";
      if (!message.toLowerCase().includes("already exists")) {
        setError(message);
      }
      toast.error(message);
    }
  };

  const onRunIngest = async () => {
    setIsTriggering(true);
    setError(null);
    try {
      await runIngest();
      toast.success("Ingest triggered");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to trigger ingest";
      setError(message);
      toast.error(message);
    } finally {
      setIsTriggering(false);
    }
  };

  const onSaveTtl = async () => {
    const value = Number(ttlDays);
    if (Number.isNaN(value) || value < 30 || value > 60) {
      setTtlError("TTL must be between 30 and 60 days");
      toast.error("TTL must be between 30 and 60 days");
      return;
    }
    try {
      const updated = await setFeedItemsTtl(value);
      setTtlDays(String(updated));
      setTtlError(null);
      toast.success("TTL updated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update TTL";
      setTtlError(message);
      toast.error(message);
    }
  };

  const onSaveIngestInterval = async () => {
    const value = Number(ingestIntervalMinutes);
    if (Number.isNaN(value) || value < 1 || value > 4320) {
      setIngestIntervalError("Interval must be between 1 and 4320 minutes");
      toast.error("Interval must be between 1 and 4320 minutes");
      return;
    }
    try {
      const updated = await setIngestInterval(value);
      setIngestIntervalMinutes(String(updated));
      setIngestIntervalError(null);
      toast.success("Ingest interval updated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update ingest interval";
      setIngestIntervalError(message);
      toast.error(message);
    }
  };

  const groupedSources = useMemo(() => {
    const maxAgeFilter = filters.maxAgeDays.trim()
      ? Number(filters.maxAgeDays)
      : null;
    const maxAgeValid =
      maxAgeFilter === null ||
      (!Number.isNaN(maxAgeFilter) && maxAgeFilter >= 1 && maxAgeFilter <= 15);

    const filteredSources = sources.filter((source) => {
      if (filters.sectorId && source.sector_id !== filters.sectorId) {
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
  }, [sources, filters]);

  const selectedCount = useMemo(
    () => Object.values(selectedIds).filter(Boolean).length,
    [selectedIds],
  );

  const toggleSelected = (id: string, value: boolean) => {
    setSelectedIds((prev) => ({ ...prev, [id]: value }));
  };

  const runBatchAction = async (action: "deactivate" | "delete") => {
    const ids = Object.entries(selectedIds)
      .filter(([, selected]) => selected)
      .map(([id]) => id);

    if (!ids.length) {
      toast.error("Select at least one source");
      return;
    }

    setConfirmBatchAction({ action, count: ids.length, ids });
  };

  const confirmBatch = async () => {
    if (!confirmBatchAction) {
      return;
    }
    const { action, ids } = confirmBatchAction;
    try {
      const updated = await batchSourceAction({ ids, action });
      if (action === "delete") {
        setSources((prev) => prev.filter((item) => !ids.includes(item.id)));
      } else {
        const updatedMap = new Map(updated.map((item) => [item.id, item]));
        setSources((prev) =>
          prev.map((item) => updatedMap.get(item.id) ?? item),
        );
      }
      setSelectedIds({});
      toast.success(
        action === "delete"
          ? "Sources deleted"
          : "Sources deactivated",
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update sources";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmBatchAction(null);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Toaster richColors position="top-right" />
      <section className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Media Watch Tower
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {activeCount} active sources - {sources.length} total
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onRunIngest}
              disabled={isTriggering}
              className="rounded-full border border-emerald-500/50 px-4 py-2 text-sm text-emerald-200 transition hover:border-emerald-300 disabled:opacity-50"
            >
              {isTriggering ? "Triggering..." : "Run ingest"}
            </button>
            <button
              onClick={refresh}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Refresh
            </button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Add source</h2>
          <form
            onSubmit={onSubmit}
            className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]"
          >
            <input
              value={sourceForm.url}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, url: event.target.value }))
              }
              placeholder="RSS URL"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sourceErrors.url ? (
              <p className="text-xs text-red-400">{sourceErrors.url}</p>
            ) : null}
            <input
              value={sourceForm.name}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Name (optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={sourceForm.sectorId}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, sectorId: event.target.value }))
              }
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            >
              <option value="" disabled>
                Select sector
              </option>
              {sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
            {sectors.length === 0 ? (
              <p className="text-xs text-amber-300">
                Create a sector before adding sources.
              </p>
            ) : null}
            {sourceErrors.sectorId ? (
              <p className="text-xs text-red-400">{sourceErrors.sectorId}</p>
            ) : null}
            <input
              value={sourceForm.maxAgeDays}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, maxAgeDays: event.target.value }))
              }
              placeholder="Max age days (1-15, optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sourceErrors.maxAgeDays ? (
              <p className="text-xs text-red-400">{sourceErrors.maxAgeDays}</p>
            ) : null}
            <input
              value={sourceForm.ingestIntervalMinutes}
              onChange={(event) =>
                setSourceForm((prev) => ({
                  ...prev,
                  ingestIntervalMinutes: event.target.value,
                }))
              }
              placeholder="Interval minutes (1-4320, optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sourceErrors.ingestIntervalMinutes ? (
              <p className="text-xs text-red-400">
                {sourceErrors.ingestIntervalMinutes}
              </p>
            ) : null}
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={sectors.length === 0}
                className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Add
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Add sector</h2>
          <form onSubmit={onCreateSector} className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]">
            <input
              value={sectorForm.name}
              onChange={(event) =>
                setSectorForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Sector name"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sectorErrors.name ? (
              <p className="text-xs text-red-400">{sectorErrors.name}</p>
            ) : null}
            <input
              value={sectorForm.defaultMaxAgeDays}
              onChange={(event) =>
                setSectorForm((prev) => ({
                  ...prev,
                  defaultMaxAgeDays: event.target.value,
                }))
              }
              placeholder="Default max age days (1-15)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sectorErrors.defaultMaxAgeDays ? (
              <p className="text-xs text-red-400">
                {sectorErrors.defaultMaxAgeDays}
              </p>
            ) : null}
            <input
              value={sectorForm.ingestIntervalMinutes}
              onChange={(event) =>
                setSectorForm((prev) => ({
                  ...prev,
                  ingestIntervalMinutes: event.target.value,
                }))
              }
              placeholder="Interval minutes (1-4320, optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sectorErrors.ingestIntervalMinutes ? (
              <p className="text-xs text-red-400">
                {sectorErrors.ingestIntervalMinutes}
              </p>
            ) : null}
            <div className="md:col-span-2">
              <button
                type="submit"
                className="w-full rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-slate-500"
              >
                Create sector
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Filters</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]">
            <select
              value={filters.sectorId}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, sectorId: event.target.value }))
              }
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            >
              <option value="">All sectors</option>
              {sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
            <input
              value={filters.maxAgeDays}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  maxAgeDays: event.target.value,
                }))
              }
              placeholder="Max age days (1-15)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
          </div>
          {filters.maxAgeDays.trim() !== "" ? (
            Number.isNaN(Number(filters.maxAgeDays)) ||
            Number(filters.maxAgeDays) < 1 ||
            Number(filters.maxAgeDays) > 15 ? (
              <p className="mt-2 text-xs text-red-400">
                Filter max age must be between 1 and 15
              </p>
            ) : null
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Scheduling</h2>
          <p className="mt-2 text-xs text-slate-500">
            Effective interval: source override &gt; sector override &gt; global.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <input
              value={ingestIntervalMinutes}
              onChange={(event) => setIngestIntervalMinutes(event.target.value)}
              placeholder="1-4320 minutes"
              className="w-40 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <button
              onClick={onSaveIngestInterval}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Save global interval
            </button>
            <span className="text-xs text-slate-500">
              In minutes (1 min - 3 days).
            </span>
          </div>
          {ingestIntervalError ? (
            <p className="mt-2 text-xs text-red-400">{ingestIntervalError}</p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Retention</h2>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <input
              value={ttlDays}
              onChange={(event) => setTtlDays(event.target.value)}
              placeholder="30-60"
              className="w-28 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <button
              onClick={onSaveTtl}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Save TTL
            </button>
            <span className="text-xs text-slate-500">
              Feed items older than this are deleted daily.
            </span>
          </div>
          {ttlError ? (
            <p className="mt-2 text-xs text-red-400">{ttlError}</p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sources</h2>
            <div className="flex items-center gap-3">
              {selectedCount > 0 ? (
                <span className="text-xs text-slate-400">
                  {selectedCount} selected
                </span>
              ) : null}
              <button
                onClick={() => runBatchAction("deactivate")}
                disabled={selectedCount === 0}
                className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Deactivate selected
              </button>
              <button
                onClick={() => runBatchAction("delete")}
                disabled={selectedCount === 0}
                className="rounded-full border border-red-500/60 px-3 py-1 text-xs text-red-200 transition hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete selected
              </button>
              {isLoading ? (
                <span className="text-xs text-slate-400">Loading...</span>
              ) : null}
            </div>
          </div>

          {error ? (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          ) : null}
          {!isLoading && sources.length > 0 && activeCount === 0 ? (
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
                          checked={Boolean(selectedIds[source.id])}
                          onChange={(event) =>
                            toggleSelected(source.id, event.target.checked)
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
                      <div className="flex items-center gap-3">
                        <select
                          value={sectorDrafts[source.id] ?? source.sector_id ?? ""}
                          onChange={(event) =>
                            setSectorDrafts((prev) => ({
                              ...prev,
                              [source.id]: event.target.value,
                            }))
                          }
                          className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                        >
                          <option value="">Unassigned</option>
                          {sectors.map((sector) => (
                            <option key={sector.id} value={sector.id}>
                              {sector.name}
                            </option>
                          ))}
                        </select>
                        <input
                          value={
                            maxAgeDrafts[source.id] ??
                            String(
                              source.max_age_days ??
                                source.sectors?.default_max_age_days ??
                                5,
                            )
                          }
                          onChange={(event) =>
                            setMaxAgeDrafts((prev) => ({
                              ...prev,
                              [source.id]: event.target.value,
                            }))
                          }
                          className="w-20 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                        />
                        <input
                          value={
                            sourceIntervalDrafts[source.id] ??
                            String(
                              source.ingest_interval_minutes ??
                                source.sectors?.ingest_interval_minutes ??
                                Number(ingestIntervalMinutes) ??
                                15,
                            )
                          }
                          onChange={(event) =>
                            setSourceIntervalDrafts((prev) => ({
                              ...prev,
                              [source.id]: event.target.value,
                            }))
                          }
                          className="w-24 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                        />
                        <button
                          onClick={() => onSaveChanges(source)}
                          className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 hover:text-white"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => onToggle(source)}
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            source.active
                              ? "bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
                              : "bg-slate-700/40 text-slate-300 hover:bg-slate-700/60"
                          }`}
                        >
                          {source.active ? "Active" : "Inactive"}
                        </button>
                        <button
                          onClick={() => onDelete(source)}
                          className="text-xs text-red-300 hover:text-red-200 hover:underline"
                        >
                          Deactivate
                        </button>
                        <button
                          onClick={() => setConfirmDeleteSource(source)}
                          className="text-xs text-red-400 hover:text-red-200 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!isLoading && sources.length === 0 ? (
              <p className="text-sm text-slate-400">No sources yet.</p>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Sectors</h2>
          <div className="mt-4 grid gap-3">
            {sectors.map((sector) => (
              <div
                key={sector.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold">{sector.name}</p>
                  <p className="text-xs text-slate-400">{sector.slug}</p>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    value={
                      sectorIntervalDrafts[sector.id] ??
                      String(sector.ingest_interval_minutes ?? "")
                    }
                    onChange={(event) =>
                      setSectorIntervalDrafts((prev) => ({
                        ...prev,
                        [sector.id]: event.target.value,
                      }))
                    }
                    placeholder="Interval (min)"
                    className="w-32 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                  />
                  <button
                    onClick={async () => {
                      const raw = sectorIntervalDrafts[sector.id] ?? "";
                      const value = raw.trim() === "" ? null : Number(raw);
                      if (
                        value !== null &&
                        (Number.isNaN(value) || value < 1 || value > 4320)
                      ) {
                        toast.error("Interval must be between 1 and 4320 minutes");
                        return;
                      }
                      try {
                        const updated = await updateSector(sector.id, {
                          ingest_interval_minutes: value,
                        });
                        setSectors((prev) =>
                          prev.map((item) =>
                            item.id === sector.id ? updated : item,
                          ),
                        );
                        setSectorIntervalDrafts((prev) => {
                          const next = { ...prev };
                          delete next[sector.id];
                          return next;
                        });
                        toast.success("Sector interval updated");
                      } catch (err) {
                        const message =
                          err instanceof Error
                            ? err.message
                            : "Failed to update sector";
                        setError(message);
                        toast.error(message);
                      }
                    }}
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 hover:text-white"
                  >
                    Save
                  </button>
                </div>
              </div>
            ))}
            {sectors.length === 0 ? (
              <p className="text-sm text-slate-400">No sectors yet.</p>
            ) : null}
          </div>
        </section>
      </section>

      {confirmSource ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Deactivate source</h3>
            <p className="mt-2 text-sm text-slate-400">
              Disable{" "}
              <span className="text-slate-200">
                {confirmSource.name ?? confirmSource.url}
              </span>
              ?
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmSource(null)}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeactivate}
                className="rounded-full bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200"
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmDeleteSource ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Delete source</h3>
            <p className="mt-2 text-sm text-slate-400">
              Permanently delete{" "}
              <span className="text-slate-200">
                {confirmDeleteSource.name ?? confirmDeleteSource.url}
              </span>
              ? Feed history will be kept.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDeleteSource(null)}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="rounded-full bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmBatchAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Confirm batch</h3>
            <p className="mt-2 text-sm text-slate-400">
              {confirmBatchAction.action === "delete" ? "Delete" : "Deactivate"}{" "}
              {confirmBatchAction.count} selected source(s)?
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmBatchAction(null)}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmBatch}
                className="rounded-full bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200"
              >
                {confirmBatchAction.action === "delete"
                  ? "Delete"
                  : "Deactivate"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
