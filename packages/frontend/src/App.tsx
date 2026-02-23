import { useCallback, useEffect, useMemo, useState } from "react";
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
  getLlmTelemetryTtl,
  setLlmTelemetryTtl,
  getArticleImagesTtl,
  setArticleImagesTtl,
  getPostDeliveriesTtl,
  setPostDeliveriesTtl,
  getDigestRunsTtl,
  setDigestRunsTtl,
  listSectors,
  listSources,
  runIngest,
  type Constraints,
  type Sector,
  type Source,
  updateSector,
  getStatsOverview,
  getStatsSources,
  getSourceQuality,
  updateSource,
  type StatsOverview,
  type StatsSource,
  type SourceQuality,
  getTelemetrySummary,
  getTelemetryByProvider,
  getTelemetryByOperation,
  getTelemetryDaily,
  type TelemetrySummary,
  type TelemetryByProvider,
  type TelemetryByOperation,
  type TelemetryDaily,
  getProviderBalances,
  refreshProviderBalances,
  type ProviderBalancesResponse,
} from "./api";
import Layout from "./components/Layout";
import Monitoring from "./pages/Monitoring";
import Settings from "./pages/Settings";
import Home from "./pages/Home";
import SectorManagement from "./pages/SectorManagement";
import ArticleScheduler from "./pages/ArticleScheduler";
import ScoringRules from "./pages/ScoringRules";
import MediaChannelControl from "./pages/MediaChannelControl";
import ImageTemplate from "./pages/ImageTemplate";
import SiteRules from "./pages/SiteRules";
import Alerts from "./pages/Alerts";
import DigestSettings from "./pages/DigestSettings";
import Analytics from "./pages/Analytics";
import {
  ServerEventsProvider,
  useServerEventsContext,
} from "./contexts/ServerEventsContext";
import { useDebouncedCallback } from "./hooks/useDebouncedCallback";

/**
 * Inner shell that lives inside ServerEventsProvider.
 * Provides SSE connection status to Layout and replaces 30s monitoring polling
 * with event-driven refetch.
 */
function AppShell({
  children,
  onRefreshStats,
}: {
  children: React.ReactNode;
  onRefreshStats: () => void;
}) {
  const { status, subscribe } = useServerEventsContext();

  const debouncedRefreshStats = useDebouncedCallback(onRefreshStats, 2000);

  useEffect(() => {
    const unsubscribe = subscribe(
      ["source:fetched", "article:scored", "article:approved", "article:rejected", "article:posted"],
      debouncedRefreshStats,
    );
    return unsubscribe;
  }, [subscribe, debouncedRefreshStats]);

  return <Layout connectionStatus={status}>{children}</Layout>;
}

const emptySourceForm = {
  url: "",
  name: "",
  sectorId: "",
  maxAgeDays: "",
  ingestIntervalMinutes: "",
};
const emptySectorForm = { name: "", defaultMaxAgeDays: "1" };

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
  const [filters, setFilters] = useState({ sectorId: "", maxAgeDays: "", search: "" });
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
  const [llmTelemetryTtlDays, setLlmTelemetryTtlDays] = useState("");
  const [llmTelemetryTtlError, setLlmTelemetryTtlError] = useState<string | null>(null);
  const [articleImagesTtlDays, setArticleImagesTtlDays] = useState("");
  const [articleImagesTtlError, setArticleImagesTtlError] = useState<string | null>(null);
  const [postDeliveriesTtlDays, setPostDeliveriesTtlDays] = useState("");
  const [postDeliveriesTtlError, setPostDeliveriesTtlError] = useState<string | null>(null);
  const [digestRunsTtlDays, setDigestRunsTtlDays] = useState("");
  const [digestRunsTtlError, setDigestRunsTtlError] = useState<string | null>(null);
  const [sourceIntervalDrafts, setSourceIntervalDrafts] = useState<Record<string, string>>({});
  const [sectorMaxAgeDrafts, setSectorMaxAgeDrafts] = useState<Record<string, string>>({});
  const [confirmSectorDelete, setConfirmSectorDelete] = useState<Sector | null>(null);
  const [statsOverview, setStatsOverview] = useState<StatsOverview | null>(null);
  const [statsSources, setStatsSources] = useState<StatsSource[]>([]);
  const [sourceQuality, setSourceQuality] = useState<Record<string, SourceQuality>>({});
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  // Telemetry state
  const [telemetrySummary, setTelemetrySummary] = useState<TelemetrySummary | null>(null);
  const [telemetryByProvider, setTelemetryByProvider] = useState<TelemetryByProvider | null>(null);
  const [telemetryByOperation, setTelemetryByOperation] = useState<TelemetryByOperation | null>(
    null,
  );
  const [telemetryDaily, setTelemetryDaily] = useState<TelemetryDaily | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [telemetryUpdatedAt, setTelemetryUpdatedAt] = useState<string | null>(null);

  // Provider balances state
  const [providerBalances, setProviderBalances] = useState<ProviderBalancesResponse | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);

  const activeCount = useMemo(() => sources.filter((source) => source.active).length, [sources]);

  const statsLookup = useMemo(() => {
    const map = new Map<string, StatsSource>();
    statsSources.forEach((s) => map.set(s.id, s));
    return map;
  }, [statsSources]);

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [
        sourcesData,
        sectorsData,
        ttlValue,
        fetchRunsTtlHours,
        constraintsData,
        llmTelemetryTtl,
        articleImagesTtl,
        postDeliveriesTtl,
        digestRunsTtl,
      ] = await Promise.all([
        listSources(),
        listSectors(),
        getFeedItemsTtl(),
        getFeedFetchRunsTtl(),
        getConstraints(),
        getLlmTelemetryTtl(),
        getArticleImagesTtl(),
        getPostDeliveriesTtl(),
        getDigestRunsTtl(),
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
      setLlmTelemetryTtlDays(String(llmTelemetryTtl));
      setArticleImagesTtlDays(String(articleImagesTtl));
      setPostDeliveriesTtlDays(String(postDeliveriesTtl));
      setDigestRunsTtlDays(String(digestRunsTtl));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load sources";
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
    refreshTelemetry();
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
      const message = err instanceof Error ? err.message : "Failed to create source";
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
      setSources((prev) => prev.map((item) => (item.id === source.id ? updated : item)));
      toast.success(source.active ? "Source deactivated" : "Source activated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update source";
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
      String(source.max_age_days ?? source.sectors?.default_max_age_days ?? 1);

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
      maxAgeValue !== (source.max_age_days ?? source.sectors?.default_max_age_days ?? 1);

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
      const message = err instanceof Error ? err.message : "Failed to create sector";
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
      // Auto-refresh stats after ingest completes (give worker time to process)
      setTimeout(() => refreshStats(), 5_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to trigger ingest";
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
      const message = err instanceof Error ? err.message : "Failed to update TTL";
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
      const nextValue = nextUnit === "days" ? rawValue / 24 : rawValue * 24;
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
    const hours = fetchRunsTtlUnit === "days" ? rawValue * 24 : rawValue;
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
      const message = err instanceof Error ? err.message : "Failed to update fetch runs TTL";
      setFetchRunsTtlError(message);
      toast.error(message);
    }
  };

  const onSaveLlmTelemetryTtl = async () => {
    const min = constraints?.llmTelemetryTtl?.min ?? 1;
    const max = constraints?.llmTelemetryTtl?.max ?? 60;
    const value = Number(llmTelemetryTtlDays);
    if (Number.isNaN(value) || value < min || value > max) {
      setLlmTelemetryTtlError(`TTL must be between ${min} and ${max} days`);
      toast.error(`TTL must be between ${min} and ${max} days`);
      return;
    }
    try {
      const updated = await setLlmTelemetryTtl(value);
      setLlmTelemetryTtlDays(String(updated));
      setLlmTelemetryTtlError(null);
      toast.success("LLM telemetry TTL updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update LLM telemetry TTL";
      setLlmTelemetryTtlError(message);
      toast.error(message);
    }
  };

  const onSaveArticleImagesTtl = async () => {
    const min = constraints?.articleImagesTtl?.min ?? 1;
    const max = constraints?.articleImagesTtl?.max ?? 60;
    const value = Number(articleImagesTtlDays);
    if (Number.isNaN(value) || value < min || value > max) {
      setArticleImagesTtlError(`TTL must be between ${min} and ${max} days`);
      toast.error(`TTL must be between ${min} and ${max} days`);
      return;
    }
    try {
      const updated = await setArticleImagesTtl(value);
      setArticleImagesTtlDays(String(updated));
      setArticleImagesTtlError(null);
      toast.success("Article images TTL updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update article images TTL";
      setArticleImagesTtlError(message);
      toast.error(message);
    }
  };

  const onSavePostDeliveriesTtl = async () => {
    const min = constraints?.postDeliveriesTtl?.min ?? 1;
    const max = constraints?.postDeliveriesTtl?.max ?? 60;
    const value = Number(postDeliveriesTtlDays);
    if (Number.isNaN(value) || value < min || value > max) {
      setPostDeliveriesTtlError(`TTL must be between ${min} and ${max} days`);
      toast.error(`TTL must be between ${min} and ${max} days`);
      return;
    }
    try {
      const updated = await setPostDeliveriesTtl(value);
      setPostDeliveriesTtlDays(String(updated));
      setPostDeliveriesTtlError(null);
      toast.success("Post deliveries TTL updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update post deliveries TTL";
      setPostDeliveriesTtlError(message);
      toast.error(message);
    }
  };

  const onSaveDigestRunsTtl = async () => {
    const min = constraints?.digestRunsTtl?.min ?? 1;
    const max = constraints?.digestRunsTtl?.max ?? 90;
    const value = Number(digestRunsTtlDays);
    if (Number.isNaN(value) || value < min || value > max) {
      setDigestRunsTtlError(`TTL must be between ${min} and ${max} days`);
      toast.error(`TTL must be between ${min} and ${max} days`);
      return;
    }
    try {
      const updated = await setDigestRunsTtl(value);
      setDigestRunsTtlDays(String(updated));
      setDigestRunsTtlError(null);
      toast.success("Digest runs TTL updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update digest runs TTL";
      setDigestRunsTtlError(message);
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

  const onSaveSectorSettings = async (sectorId: string) => {
    const sector = sectors.find((item) => item.id === sectorId);
    if (!sector) {
      toast.error("Sector not found");
      return;
    }

    const saveMaMin = constraints?.maxAge.min ?? 1;
    const saveMaMax = constraints?.maxAge.max ?? 15;
    const maxAgeRaw = sectorMaxAgeDrafts[sectorId] ?? String(sector.default_max_age_days);
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
      setSectors((prev) => prev.map((item) => (item.id === sectorId ? updated : item)));
      setSectorMaxAgeDrafts((prev) => {
        const next = { ...prev };
        delete next[sectorId];
        return next;
      });
      toast.success("Default max age updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update sector";
      setError(message);
      toast.error(message);
    }
  };

  const onDeleteSector = (sector: Sector) => {
    setConfirmSectorDelete(sector);
  };

  const refreshStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const [overview, sourcesData, qualityData] = await Promise.all([
        getStatsOverview(),
        getStatsSources(),
        getSourceQuality().catch(() => ({})),
      ]);
      setStatsOverview(overview);
      setStatsSources(sourcesData);
      setSourceQuality(qualityData);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load monitoring stats";
      setStatsError(message);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const refreshTelemetry = async () => {
    setTelemetryLoading(true);
    setTelemetryError(null);
    try {
      const [summary, byProvider, byOperation, daily, balances] = await Promise.all([
        getTelemetrySummary(),
        getTelemetryByProvider(30),
        getTelemetryByOperation(30),
        getTelemetryDaily(30),
        getProviderBalances().catch(() => null), // Don't fail telemetry if balances fail
      ]);
      setTelemetrySummary(summary);
      setTelemetryByProvider(byProvider);
      setTelemetryByOperation(byOperation);
      setTelemetryDaily(daily);
      if (balances) setProviderBalances(balances);
      setTelemetryUpdatedAt(new Date().toLocaleTimeString());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load telemetry data";
      setTelemetryError(message);
    } finally {
      setTelemetryLoading(false);
    }
  };

  const refreshBalances = async () => {
    setBalancesLoading(true);
    try {
      const balances = await refreshProviderBalances();
      setProviderBalances(balances);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refresh balances");
    } finally {
      setBalancesLoading(false);
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
      const message = err instanceof Error ? err.message : "Failed to delete sector";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmSectorDelete(null);
    }
  };

  return (
    <ServerEventsProvider>
      <AppShell onRefreshStats={refreshStats}>
        <Toaster richColors position="top-right" />
        <Routes>
        <Route
          path="/"
          element={
            <Home
              sources={sources}
              sectors={sectors}
              statsLookup={statsLookup}
              sourceQuality={sourceQuality}
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
              onBatchDeactivate={() => runBatchAction("deactivate")}
              onBatchDelete={() => runBatchAction("delete")}
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
              sectorMaxAgeDrafts={sectorMaxAgeDrafts}
              onCreateSector={onCreateSector}
              onSectorFormChange={onSectorFormChange}
              onDeleteSector={onDeleteSector}
              onSectorMaxAgeDraftChange={onSectorMaxAgeDraftChange}
              onSaveSectorSettings={onSaveSectorSettings}
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
              onRefresh={refreshStats}
            />
          }
        />
        <Route path="/article-scheduler" element={<ArticleScheduler />} />
        <Route path="/scoring-rules" element={<ScoringRules />} />
        <Route path="/media-channels" element={<MediaChannelControl />} />
        <Route path="/image-template" element={<ImageTemplate />} />
        <Route path="/site-rules" element={<SiteRules />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/digest" element={<DigestSettings />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route
          path="/settings"
          element={
            <Settings
              telemetrySummary={telemetrySummary}
              telemetryByProvider={telemetryByProvider}
              telemetryByOperation={telemetryByOperation}
              telemetryDaily={telemetryDaily}
              telemetryLoading={telemetryLoading}
              telemetryError={telemetryError}
              telemetryLastUpdated={telemetryUpdatedAt}
              onRefreshTelemetry={refreshTelemetry}
              providerBalances={providerBalances}
              balancesLoading={balancesLoading}
              onRefreshBalances={refreshBalances}
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
              llmTelemetryTtlDays={llmTelemetryTtlDays}
              llmTelemetryTtlError={llmTelemetryTtlError}
              onLlmTelemetryTtlChange={setLlmTelemetryTtlDays}
              onSaveLlmTelemetryTtl={onSaveLlmTelemetryTtl}
              articleImagesTtlDays={articleImagesTtlDays}
              articleImagesTtlError={articleImagesTtlError}
              onArticleImagesTtlChange={setArticleImagesTtlDays}
              onSaveArticleImagesTtl={onSaveArticleImagesTtl}
              postDeliveriesTtlDays={postDeliveriesTtlDays}
              postDeliveriesTtlError={postDeliveriesTtlError}
              onPostDeliveriesTtlChange={setPostDeliveriesTtlDays}
              onSavePostDeliveriesTtl={onSavePostDeliveriesTtl}
              digestRunsTtlDays={digestRunsTtlDays}
              digestRunsTtlError={digestRunsTtlError}
              onDigestRunsTtlChange={setDigestRunsTtlDays}
              onSaveDigestRunsTtl={onSaveDigestRunsTtl}
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
              Remove <span className="text-slate-200">{confirmSectorDelete.name}</span>? Sources
              will be unassigned.
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
                {confirmBatchAction.action === "delete" ? "Delete" : "Deactivate"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </AppShell>
    </ServerEventsProvider>
  );
}
