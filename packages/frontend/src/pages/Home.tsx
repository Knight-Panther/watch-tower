import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  batchSourceAction,
  checkProviderHealth,
  createSource,
  deleteSource,
  getConstraints,
  getSourceQuality,
  getStatsSources,
  listSectors,
  listSources,
  runIngest,
  updateSource,
  verifyFeedUrl,
  type Constraints,
  type FeedVerifyResult,
  type ProviderHealthResult,
  type Sector,
  type Source,
  type SourceQuality,
  type StatsSource,
} from "../api";
import ConfirmModal from "../components/ConfirmModal";
import Spinner from "../components/Spinner";
import ApiHealthModal from "../components/ApiHealthModal";
import Button from "../components/ui/Button";
import EmptyState from "../components/ui/EmptyState";

const emptySourceForm = {
  url: "",
  name: "",
  sectorId: "",
  maxAgeDays: "",
  ingestIntervalMinutes: "",
};

export default function Home() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceForm, setSourceForm] = useState(emptySourceForm);
  const [sourceErrors, setSourceErrors] = useState<{
    url?: string;
    sectorId?: string;
    maxAgeDays?: string;
    ingestIntervalMinutes?: string;
  }>({});
  const [isTriggering, setIsTriggering] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<FeedVerifyResult | null>(null);
  const [skipVerification, setSkipVerification] = useState(false);
  const [maxAgeDrafts, setMaxAgeDrafts] = useState<Record<string, string>>({});
  const [sectorDrafts, setSectorDrafts] = useState<Record<string, string>>({});
  const [sourceIntervalDrafts, setSourceIntervalDrafts] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState({ sectorId: "", maxAgeDays: "", search: "" });
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<Source | null>(null);
  const [confirmBatchAction, setConfirmBatchAction] = useState<{
    action: "deactivate" | "delete";
    count: number;
    ids: string[];
  } | null>(null);
  const [sourceQuality, setSourceQuality] = useState<Record<string, SourceQuality>>({});
  const [statsSources, setStatsSources] = useState<StatsSource[]>([]);

  const [sortBy, setSortBy] = useState<"default" | "signal-best" | "signal-worst" | "name">(
    "default",
  );
  const [healthModalOpen, setHealthModalOpen] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthResults, setHealthResults] = useState<ProviderHealthResult[] | null>(null);
  const [healthCheckedAt, setHealthCheckedAt] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const activeCount = useMemo(() => sources.filter((s) => s.active).length, [sources]);
  const selectedCount = useMemo(
    () => Object.values(selectedIds).filter(Boolean).length,
    [selectedIds],
  );
  const statsLookup = useMemo(() => {
    const map = new Map<string, StatsSource>();
    statsSources.forEach((s) => map.set(s.id, s));
    return map;
  }, [statsSources]);

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [sourcesData, sectorsData, constraintsData] = await Promise.all([
        listSources(),
        listSectors(),
        getConstraints(),
      ]);
      setSources(sourcesData);
      setSectors(sectorsData);
      setConstraints(constraintsData);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load sources";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const refreshStats = async () => {
    try {
      const [sourcesData, qualityData] = await Promise.all([getStatsSources(), getSourceQuality()]);
      setStatsSources(sourcesData);
      setSourceQuality(qualityData);
    } catch {
      // stats are non-critical, don't show error
    }
  };

  useEffect(() => {
    refresh();
    refreshStats();
  }, []);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSourceErrors({});
    setError(null);
    if (!sourceForm.url) {
      setSourceErrors((prev) => ({ ...prev, url: "URL is required" }));
      setError("URL is required");
      return;
    }
    if (!sourceForm.sectorId) {
      setSourceErrors((prev) => ({ ...prev, sectorId: "Sector is required" }));
      setError("Sector is required");
      return;
    }

    const maxAgeMin = constraints?.maxAge.min ?? 1;
    const maxAgeMax = constraints?.maxAge.max ?? 15;
    const maxAge = sourceForm.maxAgeDays.trim() === "" ? null : Number(sourceForm.maxAgeDays);
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
      const created = await createSource(
        {
          url: sourceForm.url,
          name: sourceForm.name,
          sector_id: sourceForm.sectorId,
          max_age_days: maxAge,
          ingest_interval_minutes: intervalValue,
        },
        { skipVerification },
      );
      setSources((prev) => [created, ...prev]);
      setSourceForm(emptySourceForm);
      setVerifyResult(null);
      setSkipVerification(false);
      toast.success("Source added");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create source";
      if (!message.toLowerCase().includes("already exists")) {
        setError(message);
      }
      toast.error(message);
    }
  };

  const onToggle = async (source: Source) => {
    try {
      const updated = await updateSource(source.id, { active: !source.active });
      setSources((prev) => prev.map((item) => (item.id === source.id ? updated : item)));
      toast.success(source.active ? "Source deactivated" : "Source activated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update source";
      setError(message);
      toast.error(message);
    }
  };

  const onConfirmDelete = async () => {
    if (!confirmDeleteSource) return;
    try {
      const deleted = await deleteSource(confirmDeleteSource.id, true);
      setSources((prev) => prev.filter((item) => item.id !== deleted.id));
      toast.success("Source deleted");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete source";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmDeleteSource(null);
    }
  };

  const onSaveChanges = async (source: Source) => {
    const rawValue =
      maxAgeDrafts[source.id] ??
      String(source.max_age_days ?? source.sectors?.default_max_age_days ?? 5);

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
      maxAgeValue !== (source.max_age_days ?? source.sectors?.default_max_age_days ?? 5);

    const intMin = constraints?.interval.min ?? 1;
    const intMax = constraints?.interval.max ?? 4320;
    const intervalValueRaw =
      sourceIntervalDrafts[source.id] ?? String(source.ingest_interval_minutes);
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
    const intervalChanged = intervalValue !== source.ingest_interval_minutes;

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
      setSources((prev) => prev.map((item) => (item.id === source.id ? updated : item)));
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
      const message = err instanceof Error ? err.message : "Failed to update source";
      setError(message);
      toast.error(message);
    }
  };

  const onRunIngest = async () => {
    setIsTriggering(true);
    setError(null);
    try {
      await runIngest();
      toast.success("Ingest triggered");
      setTimeout(() => refreshStats(), 5_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to trigger ingest";
      setError(message);
      toast.error(message);
    } finally {
      setIsTriggering(false);
    }
  };

  const runBatchAction = (action: "deactivate" | "delete") => {
    const ids = Object.entries(selectedIds)
      .filter(([, selected]) => selected)
      .map(([id]) => id);
    if (!ids.length) {
      toast.error("Select at least one source");
      return;
    }
    setConfirmBatchAction({ action, count: ids.length, ids });
  };

  const onConfirmBatch = async () => {
    if (!confirmBatchAction) return;
    const { action, ids } = confirmBatchAction;
    try {
      const updated = await batchSourceAction({ ids, action });
      if (action === "delete") {
        setSources((prev) => prev.filter((item) => !ids.includes(item.id)));
      } else {
        const updatedMap = new Map(updated.map((item) => [item.id, item]));
        setSources((prev) => prev.map((item) => updatedMap.get(item.id) ?? item));
      }
      setSelectedIds({});
      toast.success(action === "delete" ? "Sources deleted" : "Sources deactivated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update sources";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmBatchAction(null);
    }
  };

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
    const maxAgeFilter = filters.maxAgeDays.trim() ? Number(filters.maxAgeDays) : null;
    const maxAgeValid =
      maxAgeFilter === null ||
      (!Number.isNaN(maxAgeFilter) && maxAgeFilter >= 1 && maxAgeFilter <= 15);
    const searchQuery = filters.search.trim().toLowerCase();

    const filtered = sources.filter((source) => {
      if (filters.sectorId && source.sector_id !== filters.sectorId) return false;
      if (!maxAgeValid) return true;
      if (maxAgeFilter !== null) {
        const effectiveMaxAge = source.max_age_days ?? source.sectors?.default_max_age_days ?? 1;
        if (effectiveMaxAge !== maxAgeFilter) return false;
      }
      if (searchQuery) {
        const haystack = `${source.name ?? ""} ${source.url}`.toLowerCase();
        if (!haystack.includes(searchQuery)) return false;
      }
      return true;
    });

    if (sortBy === "name") {
      return [...filtered].sort((a, b) => (a.name ?? a.url).localeCompare(b.name ?? b.url));
    }
    if (sortBy === "signal-best" || sortBy === "signal-worst") {
      return [...filtered].sort((a, b) => {
        const ra = sourceQuality[a.id]?.signal_ratio ?? -1;
        const rb = sourceQuality[b.id]?.signal_ratio ?? -1;
        return sortBy === "signal-best" ? rb - ra : ra - rb;
      });
    }
    return filtered;
  }, [sources, filters, sourceQuality, sortBy]);

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Media Watch Tower</h1>
          <p className="mt-2 text-sm text-slate-400">
            {activeCount} active sources - {sources.length} total
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={onRunIngest}
            disabled={isTriggering}
            loading={isTriggering}
            loadingText="Ingesting..."
          >
            Run ingest
          </Button>
          <Button variant="secondary" onClick={refresh}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={onCheckApiHealth}>
            Check API Health
          </Button>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-sm font-semibold text-slate-300">Add source</h2>
          <p className="mt-1 text-xs text-slate-500">
            Paste an RSS/Atom feed URL and click Verify to check it before adding. Verification
            fetches the feed, confirms it returns valid XML with articles, and checks freshness.
          </p>
          <form onSubmit={onSubmit} className="mt-3 grid gap-2.5 grid-cols-2">
            <div className="col-span-2 flex gap-2">
              <input
                value={sourceForm.url}
                onChange={(e) => {
                  setSourceForm({ ...sourceForm, url: e.target.value });
                  setVerifyResult(null);
                }}
                placeholder="RSS URL"
                className="flex-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!sourceForm.url.trim() || isVerifying}
                loading={isVerifying}
                loadingText="..."
                onClick={async () => {
                  setIsVerifying(true);
                  setVerifyResult(null);
                  try {
                    const result = await verifyFeedUrl(sourceForm.url.trim());
                    setVerifyResult(result);
                  } catch {
                    setVerifyResult({
                      ok: false,
                      error: "Network error",
                      errorKind: "unknown",
                    });
                  } finally {
                    setIsVerifying(false);
                  }
                }}
                title="Fetches the URL, parses RSS/Atom XML, and reports feed title, item count, and latest article date. Takes up to 8 seconds."
              >
                Verify
              </Button>
            </div>
            {verifyResult &&
              (verifyResult.ok ? (
                <div
                  className={`col-span-2 rounded-lg border px-3 py-2 text-xs ${
                    verifyResult.warnings.length > 0
                      ? "border-amber-800/50 bg-amber-950/30 text-amber-300"
                      : "border-emerald-800/50 bg-emerald-950/30 text-emerald-300"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span>{verifyResult.warnings.length > 0 ? "~" : "OK"}</span>
                    <span className="font-semibold">{verifyResult.title ?? "Untitled feed"}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] opacity-80">
                    {verifyResult.itemCount} article{verifyResult.itemCount !== 1 ? "s" : ""} in
                    feed
                    {verifyResult.mostRecentDate && (
                      <>
                        {" / "}latest published:{" "}
                        {new Date(verifyResult.mostRecentDate).toLocaleDateString()}
                        {verifyResult.staleDays !== null && verifyResult.staleDays <= 1
                          ? " (today)"
                          : verifyResult.staleDays !== null
                            ? ` (${verifyResult.staleDays}d ago)`
                            : ""}
                      </>
                    )}
                  </div>
                  {verifyResult.warnings.map((w, i) => (
                    <div key={i} className="mt-1 text-[11px] text-amber-400">
                      {w}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="col-span-2 rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                  <div className="font-semibold">Verification failed</div>
                  <div className="mt-0.5 text-[11px] opacity-80">{verifyResult.error}</div>
                  {verifyResult.errorKind === "timeout" && (
                    <div className="mt-1 text-[11px] text-red-400/70">
                      The server did not respond within 8 seconds. It may be down, blocking
                      non-browser requests, or very slow.
                    </div>
                  )}
                  {verifyResult.errorKind === "http" && (
                    <div className="mt-1 text-[11px] text-red-400/70">
                      The server returned an HTTP error. Check that the URL points to a valid RSS
                      feed and the server is accessible.
                    </div>
                  )}
                  {verifyResult.errorKind === "parse" && (
                    <div className="mt-1 text-[11px] text-red-400/70">
                      The URL returned content that could not be parsed as RSS or Atom XML. It may
                      be an HTML page, JSON API, or malformed feed.
                    </div>
                  )}
                  {verifyResult.errorKind === "empty" && (
                    <div className="mt-1 text-[11px] text-red-400/70">
                      The feed parsed successfully but contains zero articles. It may be a valid
                      feed that is currently empty.
                    </div>
                  )}
                </div>
              ))}
            {sourceErrors.url ? (
              <p className="col-span-2 text-xs text-red-400">{sourceErrors.url}</p>
            ) : null}
            <input
              value={sourceForm.name}
              onChange={(e) => setSourceForm({ ...sourceForm, name: e.target.value })}
              placeholder="Name (optional)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={sourceForm.sectorId}
              onChange={(e) => setSourceForm({ ...sourceForm, sectorId: e.target.value })}
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
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
              <p className="col-span-2 text-xs text-amber-300">
                Create a sector before adding sources.
              </p>
            ) : null}
            {sourceErrors.sectorId ? (
              <p className="col-span-2 text-xs text-red-400">{sourceErrors.sectorId}</p>
            ) : null}
            <input
              value={sourceForm.maxAgeDays}
              onChange={(e) => setSourceForm({ ...sourceForm, maxAgeDays: e.target.value })}
              placeholder="Max age (1-15 days)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sourceErrors.maxAgeDays ? (
              <p className="col-span-2 text-xs text-red-400">{sourceErrors.maxAgeDays}</p>
            ) : null}
            <input
              value={sourceForm.ingestIntervalMinutes}
              onChange={(e) =>
                setSourceForm({ ...sourceForm, ingestIntervalMinutes: e.target.value })
              }
              placeholder="Interval (1-4320 min)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            {sourceErrors.ingestIntervalMinutes ? (
              <p className="col-span-2 text-xs text-red-400">
                {sourceErrors.ingestIntervalMinutes}
              </p>
            ) : null}
            <label
              className="col-span-2 flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none"
              title="When checked, the feed URL will not be verified on submit. Use for temporarily-down feeds or non-standard sources you trust."
            >
              <input
                type="checkbox"
                checked={skipVerification}
                onChange={(e) => setSkipVerification(e.target.checked)}
                className="h-3.5 w-3.5 accent-slate-500"
              />
              Skip feed verification on submit
              <span className="text-slate-600">(for temporarily-down or trusted feeds)</span>
            </label>
            <div className="col-span-2">
              <Button variant="primary" type="submit" fullWidth disabled={sectors.length === 0}>
                Add
              </Button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-sm font-semibold text-slate-300">Filters</h2>
          <div className="mt-3 grid gap-2.5">
            <input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="Search name or URL"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={filters.sectorId}
              onChange={(e) => setFilters({ ...filters, sectorId: e.target.value })}
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
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
              onChange={(e) => setFilters({ ...filters, maxAgeDays: e.target.value })}
              placeholder="Max age days (1-15)"
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
          </div>
          {filters.maxAgeDays.trim() !== "" ? (
            Number.isNaN(Number(filters.maxAgeDays)) ||
            Number(filters.maxAgeDays) < 1 ||
            Number(filters.maxAgeDays) > 15 ? (
              <p className="mt-2 text-xs text-red-400">Filter max age must be between 1 and 15</p>
            ) : null
          ) : null}
        </section>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Sources
            <span className="ml-2 text-sm font-normal text-slate-500">
              {filteredSources.length} of {sources.length}
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
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const allSelected = filteredSources.every((s) => selectedIds[s.id]);
                if (allSelected) {
                  setSelectedIds({});
                } else {
                  setSelectedIds(
                    filteredSources.reduce(
                      (acc, s) => ({ ...acc, [s.id]: true }),
                      {} as Record<string, boolean>,
                    ),
                  );
                }
              }}
            >
              {filteredSources.length > 0 && filteredSources.every((s) => selectedIds[s.id])
                ? "Deselect All"
                : "Select All"}
            </Button>
            {selectedCount > 0 ? (
              <span className="text-xs text-slate-500">{selectedCount} selected</span>
            ) : null}
            <Button
              variant="secondary"
              size="xs"
              onClick={() => runBatchAction("deactivate")}
              disabled={selectedCount === 0}
            >
              Deactivate selected
            </Button>
            <Button
              variant="danger"
              size="xs"
              onClick={() => runBatchAction("delete")}
              disabled={selectedCount === 0}
            >
              Delete selected
            </Button>
            {isLoading ? <Spinner /> : null}
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
        {!isLoading && sources.length > 0 && activeCount === 0 ? (
          <p className="mt-3 text-sm text-amber-300">
            All sources are inactive. Ingest will not pull any items.
          </p>
        ) : null}

        <div className="mt-4 grid gap-3">
          {filteredSources.map((source) => {
            const stats = statsLookup.get(source.id);
            const quality = sourceQuality[source.id];
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

            const signalColor = !quality
              ? "text-slate-500"
              : quality.signal_ratio >= 40
                ? "text-emerald-400"
                : quality.signal_ratio >= 15
                  ? "text-amber-400"
                  : "text-red-400";

            const hasDraftChanges =
              (maxAgeDrafts[source.id] !== undefined &&
                maxAgeDrafts[source.id] !==
                  String(source.max_age_days ?? source.sectors?.default_max_age_days ?? 1)) ||
              (sectorDrafts[source.id] !== undefined &&
                sectorDrafts[source.id] !== (source.sector_id ?? "")) ||
              (sourceIntervalDrafts[source.id] !== undefined &&
                sourceIntervalDrafts[source.id] !== String(source.ingest_interval_minutes));

            const revertDrafts = () => {
              setMaxAgeDrafts((prev) => ({
                ...prev,
                [source.id]: String(
                  source.max_age_days ?? source.sectors?.default_max_age_days ?? 1,
                ),
              }));
              setSectorDrafts((prev) => ({ ...prev, [source.id]: source.sector_id ?? "" }));
              setSourceIntervalDrafts((prev) => ({
                ...prev,
                [source.id]: String(source.ingest_interval_minutes),
              }));
            };

            const handleEscape = (e: React.KeyboardEvent) => {
              if (e.key === "Escape") revertDrafts();
            };

            return (
              <div
                key={source.id}
                className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 transition-colors ${
                  hasDraftChanges
                    ? "border-emerald-800/50 bg-emerald-950/20"
                    : "border-slate-800 bg-slate-950/70"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0 flex-shrink">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedIds[source.id])}
                    onChange={(e) =>
                      setSelectedIds((prev) => ({ ...prev, [source.id]: e.target.checked }))
                    }
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
                          toast.success("URL copied");
                        }}
                        className="flex-shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200 transition"
                      >
                        Copy URL
                      </button>
                    </div>
                  </div>
                  {quality &&
                    quality.total > 0 &&
                    (() => {
                      const barColors: Record<number, string> = {
                        1: "bg-red-500",
                        2: "bg-orange-400",
                        3: "bg-amber-400",
                        4: "bg-emerald-400",
                        5: "bg-emerald-300",
                      };
                      const textColors: Record<number, string> = {
                        1: "text-red-400",
                        2: "text-orange-400",
                        3: "text-amber-400",
                        4: "text-emerald-400",
                        5: "text-emerald-300",
                      };
                      const segments = [1, 2, 3, 4, 5]
                        .map((s) => ({ score: s, count: quality.distribution[s] ?? 0 }))
                        .filter((s) => s.count > 0);
                      return (
                        <div className="ml-2 min-w-0 self-center">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-8 text-right text-xs font-semibold tabular-nums ${signalColor}`}
                              title="Signal ratio — percentage of articles that scored 4 or 5 (high-value). Green means 40%+ are high-value, amber means 15-39%, red means under 15%."
                            >
                              {quality.signal_ratio}%
                            </span>
                            <div
                              className="w-40"
                              title="Score distribution bar — each colored segment represents a score level (1 to 5, left to right). Wider segments mean more articles at that score. Red/orange = low scores, green = high scores."
                            >
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
                                    {count / quality.total >= 0.08 ? `${score}:${count}` : count}
                                  </div>
                                ))}
                              </div>
                            </div>
                            <span
                              className="w-6 text-right text-[10px] tabular-nums text-slate-500"
                              title="Total number of articles scored from this source in the last 30 days."
                            >
                              {quality.total}
                            </span>
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
                      value={sectorDrafts[source.id] ?? source.sector_id ?? ""}
                      onChange={(e) =>
                        setSectorDrafts((prev) => ({ ...prev, [source.id]: e.target.value }))
                      }
                      onKeyDown={handleEscape}
                      className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                    >
                      <option value="">Unassigned</option>
                      {sectors.map((sector) => (
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
                        maxAgeDrafts[source.id] ??
                        String(source.max_age_days ?? source.sectors?.default_max_age_days ?? 1)
                      }
                      onChange={(e) =>
                        setMaxAgeDrafts((prev) => ({ ...prev, [source.id]: e.target.value }))
                      }
                      onKeyDown={handleEscape}
                      className="w-20 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Interval (min)
                    </span>
                    <input
                      value={
                        sourceIntervalDrafts[source.id] ?? String(source.ingest_interval_minutes)
                      }
                      onChange={(e) =>
                        setSourceIntervalDrafts((prev) => ({
                          ...prev,
                          [source.id]: e.target.value,
                        }))
                      }
                      onKeyDown={handleEscape}
                      className="w-24 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                    />
                  </div>
                  <Button variant="primary" size="xs" onClick={() => onSaveChanges(source)}>
                    Save
                  </Button>
                  {hasDraftChanges && (
                    <Button variant="ghost" size="xs" onClick={revertDrafts}>
                      Cancel
                    </Button>
                  )}
                  <div className="flex items-center gap-3">
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
                      onClick={() => setConfirmDeleteSource(source)}
                      className="text-xs text-red-400 hover:text-red-200 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {!isLoading && sources.length === 0 ? (
            <EmptyState
              title="No sources yet"
              description="Add your first RSS source using the form above to start monitoring."
            />
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

      {confirmDeleteSource && (
        <ConfirmModal
          title="Delete source"
          message={
            <>
              Permanently delete{" "}
              <span className="text-slate-200">
                {confirmDeleteSource.name ?? confirmDeleteSource.url}
              </span>
              ? Feed history will be kept.
            </>
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={onConfirmDelete}
          onCancel={() => setConfirmDeleteSource(null)}
        />
      )}
      {confirmBatchAction && (
        <ConfirmModal
          title="Confirm batch"
          message={`${confirmBatchAction.action === "delete" ? "Delete" : "Deactivate"} ${confirmBatchAction.count} selected source(s)?`}
          confirmLabel={confirmBatchAction.action === "delete" ? "Delete" : "Deactivate"}
          variant="danger"
          onConfirm={onConfirmBatch}
          onCancel={() => setConfirmBatchAction(null)}
        />
      )}
    </>
  );
}
