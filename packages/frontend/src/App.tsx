import { useEffect, useMemo, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Toaster, toast } from "sonner";
import {
  createSector,
  createSource,
  deleteSector,
  deleteSource,
  batchSourceAction,
  getConstraints,
  getFeedItemsTtl,
  getFeedFetchRunsTtl,
  setFeedItemsTtl,
  setFeedFetchRunsTtl,
  listSectors,
  listSources,
  runIngest,
  type Constraints,
  type Sector,
  type Source,
  updateSector,
  getStatsOverview,
  getStatsSources,
  updateSource,
  type StatsOverview,
  type StatsSource,
} from "./api";
import Layout from "./components/Layout";
import Database from "./pages/Database";
import Monitoring from "./pages/Monitoring";
import Home from "./pages/Home";
import SectorManagement from "./pages/SectorManagement";

const emptySourceForm = {
  url: "",
  name: "",
  sectorId: "",
  maxAgeDays: "",
  ingestIntervalMinutes: "",
};
const emptySectorForm = { name: "", defaultMaxAgeDays: "5" };

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
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
  }>({});
  const [isTriggering, setIsTriggering] = useState(false);
  const [maxAgeDrafts, setMaxAgeDrafts] = useState<Record<string, string>>({});
  const [sectorDrafts, setSectorDrafts] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState({ sectorId: "", maxAgeDays: "" });
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<Source | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [confirmBatchAction, setConfirmBatchAction] = useState<{
    action: "deactivate" | "delete";
    count: number;
    ids: string[];
  } | null>(null);
  const [ttlDays, setTtlDays] = useState("");
  const [ttlError, setTtlError] = useState<string | null>(null);
  const [fetchRunsTtlValue, setFetchRunsTtlValue] = useState("");
  const [fetchRunsTtlUnit, setFetchRunsTtlUnit] = useState<"hours" | "days">("days");
  const [fetchRunsTtlError, setFetchRunsTtlError] = useState<string | null>(null);
  const [sourceIntervalDrafts, setSourceIntervalDrafts] = useState<Record<string, string>>({});
  const [sectorMaxAgeDrafts, setSectorMaxAgeDrafts] = useState<Record<string, string>>({});
  const [confirmSectorDelete, setConfirmSectorDelete] = useState<Sector | null>(null);
  const [statsOverview, setStatsOverview] = useState<StatsOverview | null>(null);
  const [statsSources, setStatsSources] = useState<StatsSource[]>([]);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsUpdatedAt, setStatsUpdatedAt] = useState<string | null>(null);
  const [statsAutoRefresh, setStatsAutoRefresh] = useState(true);

  const activeCount = useMemo(
    () => sources.filter((source) => source.active).length,
    [sources],
  );

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [sourcesData, sectorsData, ttlValue, fetchRunsTtlHours, constraintsData] =
        await Promise.all([
          listSources(),
          listSectors(),
          getFeedItemsTtl(),
          getFeedFetchRunsTtl(),
          getConstraints(),
        ]);
      setSources(sourcesData);
      setSectors(sectorsData);
      setConstraints(constraintsData);
      setTtlDays(String(ttlValue));
      if (Number.isNaN(fetchRunsTtlHours)) {
        setFetchRunsTtlUnit("days");
        setFetchRunsTtlValue("14");
      } else if (fetchRunsTtlHours % 24 === 0) {
        setFetchRunsTtlUnit("days");
        setFetchRunsTtlValue(String(fetchRunsTtlHours / 24));
      } else {
        setFetchRunsTtlUnit("hours");
        setFetchRunsTtlValue(String(fetchRunsTtlHours));
      }
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

  useEffect(() => {
    refreshStats();
  }, []);

  useEffect(() => {
    if (!statsAutoRefresh) {
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        refreshStats();
      }, 30_000);
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        refreshStats(); // Immediate refresh when tab becomes visible
        startPolling();
      }
    };

    // Start polling if tab is visible
    if (!document.hidden) {
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [statsAutoRefresh]);

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

    const maxAgeMin = constraints?.maxAge.min ?? 1;
    const maxAgeMax = constraints?.maxAge.max ?? 15;
    const maxAge =
      sourceForm.maxAgeDays.trim() === ""
        ? null
        : Number(sourceForm.maxAgeDays);
    if (maxAge !== null && (Number.isNaN(maxAge) || maxAge < maxAgeMin || maxAge > maxAgeMax)) {
      setSourceErrors((prev) => ({
        ...prev,
        maxAgeDays: `Max age must be between ${maxAgeMin} and ${maxAgeMax}`,
      }));
      setError(`Max age must be between ${maxAgeMin} and ${maxAgeMax}`);
      return;
    }

    const intervalMin = constraints?.interval.min ?? 1;
    const intervalMax = constraints?.interval.max ?? 4320;
    const intervalRaw = sourceForm.ingestIntervalMinutes.trim();
    if (!intervalRaw) {
      setSourceErrors((prev) => ({
        ...prev,
        ingestIntervalMinutes: "Interval is required",
      }));
      setError("Interval is required");
      return;
    }
    const intervalValue = Number(intervalRaw);
    if (Number.isNaN(intervalValue) || intervalValue < intervalMin || intervalValue > intervalMax) {
      setSourceErrors((prev) => ({
        ...prev,
        ingestIntervalMinutes: `Interval must be ${intervalMin}-${intervalMax}`,
      }));
      setError(`Interval must be between ${intervalMin} and ${intervalMax} minutes`);
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

    const maMin = constraints?.maxAge.min ?? 1;
    const maMax = constraints?.maxAge.max ?? 15;
    let maxAgeValue: number | null = null;
    if (rawValue.trim() !== "") {
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed) || parsed < maMin || parsed > maMax) {
        setError(`Max age must be between ${maMin} and ${maMax}`);
        toast.error(`Max age must be between ${maMin} and ${maMax}`);
        return;
      }
      maxAgeValue = parsed;
    }

    const sectorDraft = sectorDrafts[source.id];
    const sectorId = sectorDraft ?? source.sector_id ?? "";

    const sectorChanged = sectorId !== (source.sector_id ?? "");

    if (sectorChanged && !sectorId) {
      setError("Select a sector to save");
      toast.error("Select a sector to save");
      return;
    }
    const maxAgeChanged =
      maxAgeValue !==
      (source.max_age_days ?? source.sectors?.default_max_age_days ?? 5);

    const intMin = constraints?.interval.min ?? 1;
    const intMax = constraints?.interval.max ?? 4320;
    const intervalValueRaw =
      sourceIntervalDrafts[source.id] ??
      String(source.ingest_interval_minutes);
    if (!intervalValueRaw.trim()) {
      setError("Interval is required");
      toast.error("Interval is required");
      return;
    }
    const intervalValue = Number(intervalValueRaw);
    if (Number.isNaN(intervalValue) || intervalValue < intMin || intervalValue > intMax) {
      setError(`Interval must be between ${intMin} and ${intMax} minutes`);
      toast.error(`Interval must be between ${intMin} and ${intMax} minutes`);
      return;
    }
    const intervalChanged =
      intervalValue !== source.ingest_interval_minutes;

    if (!sectorChanged && !maxAgeChanged && !intervalChanged) {
      toast("No changes to save");
      return;
    }

    try {
      const updated = await updateSource(source.id, {
        ...(sectorChanged ? { sector_id: sectorId } : {}),
        max_age_days: maxAgeValue,
        ingest_interval_minutes: intervalValue,
      });
      setSources((prev) =>
        prev.map((item) => (item.id === source.id ? updated : item)),
      );
      setMaxAgeDrafts((prev) => {
        const next = { ...prev };
        delete next[source.id];
        return next;
      });
      setSectorDrafts((prev) => {
        const next = { ...prev };
        delete next[source.id];
        return next;
      });
      setSourceIntervalDrafts((prev) => {
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

    const sectorMaMin = constraints?.maxAge.min ?? 1;
    const sectorMaMax = constraints?.maxAge.max ?? 15;
    const maxAge = Number(sectorForm.defaultMaxAgeDays);
    if (Number.isNaN(maxAge) || maxAge < sectorMaMin || maxAge > sectorMaMax) {
      setSectorErrors((prev) => ({
        ...prev,
        defaultMaxAgeDays: `Default max age must be ${sectorMaMin}-${sectorMaMax}`,
      }));
      setError(`Default max age must be between ${sectorMaMin} and ${sectorMaMax}`);
      return;
    }

    try {
      const created = await createSector({
        name: sectorForm.name.trim(),
        default_max_age_days: maxAge,
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
    const ttlMin = constraints?.feedItemsTtl.min ?? 30;
    const ttlMax = constraints?.feedItemsTtl.max ?? 60;
    const value = Number(ttlDays);
    if (Number.isNaN(value) || value < ttlMin || value > ttlMax) {
      setTtlError(`TTL must be between ${ttlMin} and ${ttlMax} days`);
      toast.error(`TTL must be between ${ttlMin} and ${ttlMax} days`);
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

  const onFetchRunsTtlUnitChange = (nextUnit: "hours" | "days") => {
    if (nextUnit === fetchRunsTtlUnit) {
      return;
    }
    const rawValue = Number(fetchRunsTtlValue);
    if (!Number.isNaN(rawValue)) {
      const nextValue =
        nextUnit === "days" ? rawValue / 24 : rawValue * 24;
      setFetchRunsTtlValue(String(nextValue));
    }
    setFetchRunsTtlUnit(nextUnit);
  };

  const onSaveFetchRunsTtl = async () => {
    const rawValue = Number(fetchRunsTtlValue);
    if (Number.isNaN(rawValue) || rawValue <= 0) {
      setFetchRunsTtlError("TTL must be greater than 0");
      toast.error("TTL must be greater than 0");
      return;
    }

    const fetchRunsMax = constraints?.fetchRunsTtl.max ?? 2160;
    const hours =
      fetchRunsTtlUnit === "days" ? rawValue * 24 : rawValue;
    if (hours > fetchRunsMax) {
      const maxDays = Math.floor(fetchRunsMax / 24);
      setFetchRunsTtlError(`TTL must be ${maxDays} days or less`);
      toast.error(`TTL must be ${maxDays} days or less`);
      return;
    }

    try {
      const updated = await setFeedFetchRunsTtl(hours);
      if (updated % 24 === 0) {
        setFetchRunsTtlUnit("days");
        setFetchRunsTtlValue(String(updated / 24));
      } else {
        setFetchRunsTtlUnit("hours");
        setFetchRunsTtlValue(String(updated));
      }
      setFetchRunsTtlError(null);
      toast.success("Fetch runs TTL updated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update fetch runs TTL";
      setFetchRunsTtlError(message);
      toast.error(message);
    }
  };

  const selectedCount = useMemo(
    () => Object.values(selectedIds).filter(Boolean).length,
    [selectedIds],
  );

  const toggleSelected = (id: string, value: boolean) => {
    setSelectedIds((prev) => ({ ...prev, [id]: value }));
  };

  const onSourceFormChange = (next: typeof sourceForm) => {
    setSourceForm(next);
  };

  const onFilterChange = (next: typeof filters) => {
    setFilters(next);
  };

  const onMaxAgeDraftChange = (id: string, value: string) => {
    setMaxAgeDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const onSourceIntervalDraftChange = (id: string, value: string) => {
    setSourceIntervalDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const onSectorDraftChange = (id: string, value: string) => {
    setSectorDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const onSectorFormChange = (next: typeof sectorForm) => {
    setSectorForm(next);
  };

  const onSectorMaxAgeDraftChange = (id: string, value: string) => {
    setSectorMaxAgeDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const onDeletePermanent = (source: Source) => {
    setConfirmDeleteSource(source);
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

  const onSaveSectorSettings = async (sectorId: string) => {
    const sector = sectors.find((item) => item.id === sectorId);
    if (!sector) {
      toast.error("Sector not found");
      return;
    }

    const saveMaMin = constraints?.maxAge.min ?? 1;
    const saveMaMax = constraints?.maxAge.max ?? 15;
    const maxAgeRaw =
      sectorMaxAgeDrafts[sectorId] ?? String(sector.default_max_age_days);
    const maxAgeValue = Number(maxAgeRaw);
    if (Number.isNaN(maxAgeValue) || maxAgeValue < saveMaMin || maxAgeValue > saveMaMax) {
      toast.error(`Default max age must be between ${saveMaMin} and ${saveMaMax}`);
      return;
    }

    const maxAgeChanged = maxAgeValue !== sector.default_max_age_days;

    if (!maxAgeChanged) {
      toast("No changes to save");
      return;
    }

    try {
      const updated = await updateSector(sectorId, {
        default_max_age_days: maxAgeValue,
      });
      setSectors((prev) =>
        prev.map((item) => (item.id === sectorId ? updated : item)),
      );
      setSectorMaxAgeDrafts((prev) => {
        const next = { ...prev };
        delete next[sectorId];
        return next;
      });
      toast.success("Default max age updated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update sector";
      setError(message);
      toast.error(message);
    }
  };

  const onDeleteSector = (sector: Sector) => {
    setConfirmSectorDelete(sector);
  };

  const refreshStats = async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const [overview, sourcesData] = await Promise.all([
        getStatsOverview(),
        getStatsSources(),
      ]);
      setStatsOverview(overview);
      setStatsSources(sourcesData);
      setStatsUpdatedAt(new Date().toLocaleTimeString());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load monitoring stats";
      setStatsError(message);
    } finally {
      setStatsLoading(false);
    }
  };

  const confirmSectorDeleteAction = async () => {
    if (!confirmSectorDelete) {
      return;
    }
    try {
      const deleted = await deleteSector(confirmSectorDelete.id);
      setSectors((prev) => prev.filter((item) => item.id !== deleted.id));
      setSources((prev) =>
        prev.map((item) =>
          item.sector_id === deleted.id ? { ...item, sector_id: null, sectors: null } : item,
        ),
      );
      toast.success("Sector deleted");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete sector";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmSectorDelete(null);
    }
  };

  return (
    <Layout>
      <Toaster richColors position="top-right" />
      <Routes>
        <Route
          path="/"
          element={
            <Home
              sources={sources}
              sectors={sectors}
              activeCount={activeCount}
              isLoading={isLoading}
              error={error}
              sourceForm={sourceForm}
              sourceErrors={sourceErrors}
              maxAgeDrafts={maxAgeDrafts}
              sourceIntervalDrafts={sourceIntervalDrafts}
              sectorDrafts={sectorDrafts}
              filters={filters}
              selectedCount={selectedCount}
              selectedIds={selectedIds}
              isTriggering={isTriggering}
              onRunIngest={onRunIngest}
              onRefresh={refresh}
              onSubmit={onSubmit}
              onToggle={onToggle}
              onDeletePermanent={onDeletePermanent}
              onSaveChanges={onSaveChanges}
              onFilterChange={onFilterChange}
              onSourceFormChange={onSourceFormChange}
              onMaxAgeDraftChange={onMaxAgeDraftChange}
              onSourceIntervalDraftChange={onSourceIntervalDraftChange}
              onSectorDraftChange={onSectorDraftChange}
              onSelectToggle={toggleSelected}
              onBatchDeactivate={() => runBatchAction('deactivate')}
              onBatchDelete={() => runBatchAction('delete')}
            />
          }
        />
        <Route
          path="/sectors"
          element={
            <SectorManagement
              sectorForm={sectorForm}
              sectorErrors={sectorErrors}
              sectors={sectors}
              onCreateSector={onCreateSector}
              onSectorFormChange={onSectorFormChange}
              onDeleteSector={onDeleteSector}
            />
          }
        />
        <Route
          path="/database"
          element={
            <Database
              isLoading={isLoading}
              ttlDays={ttlDays}
              ttlError={ttlError}
              onTtlChange={setTtlDays}
              onSaveTtl={onSaveTtl}
              fetchRunsTtlValue={fetchRunsTtlValue}
              fetchRunsTtlUnit={fetchRunsTtlUnit}
              fetchRunsTtlError={fetchRunsTtlError}
              onFetchRunsTtlChange={setFetchRunsTtlValue}
              onFetchRunsTtlUnitChange={onFetchRunsTtlUnitChange}
              onSaveFetchRunsTtl={onSaveFetchRunsTtl}
            />
          }
        />
        <Route
          path="/monitoring"
          element={
            <Monitoring
              overview={statsOverview}
              sources={statsSources}
              isLoading={statsLoading}
              error={statsError}
              lastUpdated={statsUpdatedAt}
              onRefresh={refreshStats}
              autoRefreshEnabled={statsAutoRefresh}
              onToggleAutoRefresh={() => setStatsAutoRefresh((prev) => !prev)}
            />
          }
        />
      </Routes>

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
      {confirmSectorDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Delete sector</h3>
            <p className="mt-2 text-sm text-slate-400">
              Remove{" "}
              <span className="text-slate-200">{confirmSectorDelete.name}</span>
              ? Sources will be unassigned.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmSectorDelete(null)}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmSectorDeleteAction}
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
    </Layout>
  );
}
