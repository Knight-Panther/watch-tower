import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import Tabs, { useTabState } from "../components/ui/Tabs";
import ConfirmModal from "../components/ConfirmModal";
import Button from "../components/ui/Button";
import EmptyState from "../components/ui/EmptyState";
import {
  getAllowedDomains,
  addAllowedDomain,
  deleteAllowedDomain,
  updateAllowedDomain,
  getSecurityConfig,
  getTranslationConfig,
  updateTranslationConfig,
  getAutoApproveThreshold,
  setAutoApproveThreshold as setAutoApproveThresholdApi,
  getAutoRejectThreshold,
  setAutoRejectThreshold as setAutoRejectThresholdApi,
  getSimilarityThreshold,
  setSimilarityThreshold as setSimilarityThresholdApi,
  createSector,
  deleteSector,
  getConstraints,
  listSectors,
  updateSector,
  type AllowedDomain,
  type SecurityConfig,
  type TranslationConfig,
  type Constraints,
  type Sector,
} from "../api";
import Spinner from "../components/Spinner";

const emptySectorForm = { name: "", defaultMaxAgeDays: "5" };

function SectorsTab() {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sectorForm, setSectorForm] = useState(emptySectorForm);
  const [sectorErrors, setSectorErrors] = useState<{ name?: string; defaultMaxAgeDays?: string }>(
    {},
  );
  const [sectorMaxAgeDrafts, setSectorMaxAgeDrafts] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<Sector | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [sectorsData, constraintsData] = await Promise.all([listSectors(), getConstraints()]);
        setSectors(sectorsData);
        setConstraints(constraintsData);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load sectors");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const onCreateSector = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSectorErrors({});
    if (!sectorForm.name.trim()) {
      setSectorErrors((prev) => ({ ...prev, name: "Sector name is required" }));
      return;
    }
    const maMin = constraints?.maxAge.min ?? 1;
    const maMax = constraints?.maxAge.max ?? 15;
    const maxAge = Number(sectorForm.defaultMaxAgeDays);
    if (Number.isNaN(maxAge) || maxAge < maMin || maxAge > maMax) {
      setSectorErrors((prev) => ({
        ...prev,
        defaultMaxAgeDays: `Default max age must be ${maMin}-${maMax}`,
      }));
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
      toast.error(err instanceof Error ? err.message : "Failed to create sector");
    }
  };

  const onSaveSectorSettings = async (sectorId: string) => {
    const sector = sectors.find((item) => item.id === sectorId);
    if (!sector) {
      toast.error("Sector not found");
      return;
    }
    const maMin = constraints?.maxAge.min ?? 1;
    const maMax = constraints?.maxAge.max ?? 15;
    const maxAgeRaw = sectorMaxAgeDrafts[sectorId] ?? String(sector.default_max_age_days);
    const maxAgeValue = Number(maxAgeRaw);
    if (Number.isNaN(maxAgeValue) || maxAgeValue < maMin || maxAgeValue > maMax) {
      toast.error(`Default max age must be between ${maMin} and ${maMax}`);
      return;
    }
    if (maxAgeValue === sector.default_max_age_days) {
      toast("No changes to save");
      return;
    }
    try {
      const updated = await updateSector(sectorId, { default_max_age_days: maxAgeValue });
      setSectors((prev) => prev.map((item) => (item.id === sectorId ? updated : item)));
      setSectorMaxAgeDrafts((prev) => {
        const next = { ...prev };
        delete next[sectorId];
        return next;
      });
      toast.success("Default max age updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update sector");
    }
  };

  const onConfirmDelete = async () => {
    if (!confirmDelete) return;
    try {
      const deleted = await deleteSector(confirmDelete.id);
      setSectors((prev) => prev.filter((item) => item.id !== deleted.id));
      toast.success("Sector deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete sector");
    } finally {
      setConfirmDelete(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Create Sector</h2>
        <p className="mt-2 text-sm text-slate-400">Add a new sector for RSS source grouping.</p>
        <form onSubmit={onCreateSector} className="mt-6 grid gap-4 md:grid-cols-[2fr,1fr]">
          <input
            value={sectorForm.name}
            onChange={(event) => setSectorForm({ ...sectorForm, name: event.target.value })}
            placeholder="Sector name"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {sectorErrors.name ? <p className="text-xs text-red-400">{sectorErrors.name}</p> : null}
          <input
            value={sectorForm.defaultMaxAgeDays}
            onChange={(event) =>
              setSectorForm({ ...sectorForm, defaultMaxAgeDays: event.target.value })
            }
            placeholder="Default max age days (1-15)"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {sectorErrors.defaultMaxAgeDays ? (
            <p className="text-xs text-red-400">{sectorErrors.defaultMaxAgeDays}</p>
          ) : null}
          <div className="md:col-span-2">
            <Button variant="secondary" type="submit" fullWidth>
              Create sector
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Current sector settings</h2>
        <p className="mt-2 text-xs text-slate-500">
          Review current sectors or remove them. Sources keep their items until TTL cleanup.
        </p>
        <div className="mt-4 grid gap-3">
          {sectors.map((sector) => {
            const draft = sectorMaxAgeDrafts[sector.id] ?? String(sector.default_max_age_days);
            const changed = Number(draft) !== sector.default_max_age_days;
            return (
              <div
                key={sector.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold">{sector.name}</p>
                  <p className="text-xs text-slate-500">{sector.slug}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                  <label className="flex items-center gap-2">
                    <span>Max age:</span>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={draft}
                      onChange={(e) =>
                        setSectorMaxAgeDrafts((prev) => ({ ...prev, [sector.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Escape")
                          setSectorMaxAgeDrafts((prev) => ({
                            ...prev,
                            [sector.id]: String(sector.default_max_age_days),
                          }));
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onSaveSectorSettings(sector.id);
                        }
                      }}
                      className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center text-xs text-slate-200 outline-none focus:border-slate-500"
                    />
                    <span>days</span>
                  </label>
                  {changed && (
                    <>
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => onSaveSectorSettings(sector.id)}
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setSectorMaxAgeDrafts((prev) => ({
                            ...prev,
                            [sector.id]: String(sector.default_max_age_days),
                          }))
                        }
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                  <button
                    onClick={() => setConfirmDelete(sector)}
                    className="text-xs text-red-300 hover:text-red-200 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {sectors.length === 0 ? (
            <EmptyState
              title="No sectors yet"
              description="Create your first sector using the form above."
            />
          ) : null}
        </div>
      </section>

      {confirmDelete && (
        <ConfirmModal
          title="Delete sector"
          message={
            <>
              Remove <span className="text-slate-200">{confirmDelete.name}</span>? Sources will be
              unassigned.
            </>
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={onConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}

export default function SiteRules() {
  const [activeTab, setActiveTab] = useTabState("sectors", [
    "sectors",
    "domains",
    "limits",
    "api",
    "thresholds",
    "translation",
    "dedup",
  ]);

  const DOMAINS_PER_PAGE = 20;

  // Domain delete confirmation
  const [domainToDelete, setDomainToDelete] = useState<string | null>(null);

  // Domain whitelist state
  const [domains, setDomains] = useState<AllowedDomain[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainNotes, setNewDomainNotes] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [domainSearch, setDomainSearch] = useState("");
  const [domainPage, setDomainPage] = useState(1);

  // Security config state
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  // Translation config state
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(null);

  // Score threshold state
  const [approveThreshold, setApproveThreshold] = useState(5);
  const [rejectThreshold, setRejectThreshold] = useState(2);
  const [isApproveLoading, setIsApproveLoading] = useState(false);
  const [isRejectLoading, setIsRejectLoading] = useState(false);

  // Dedup threshold state
  const [dedupThreshold, setDedupThreshold] = useState(0.65);
  const [dedupSavedValue, setDedupSavedValue] = useState<number | null>(null);
  const [dedupSource, setDedupSource] = useState<"database" | "default">("default");
  const [dedupSaving, setDedupSaving] = useState(false);

  // Load domains
  const loadDomains = useCallback(async () => {
    try {
      setDomainsLoading(true);
      const data = await getAllowedDomains();
      setDomains(data);
      setDomainsError(null);
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to load domains");
    } finally {
      setDomainsLoading(false);
    }
  }, []);

  // Load security config
  const loadSecurityConfig = useCallback(async () => {
    try {
      setConfigLoading(true);
      const data = await getSecurityConfig();
      setSecurityConfig(data);
    } catch {
      // Non-critical, just leave as null
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // Load translation config
  const loadTranslationConfig = useCallback(async () => {
    try {
      const data = await getTranslationConfig();
      setTranslationConfig(data);
    } catch {
      // Non-critical
    }
  }, []);

  // Load score thresholds
  const loadThresholds = useCallback(async () => {
    try {
      const [approveVal, rejectVal] = await Promise.all([
        getAutoApproveThreshold(),
        getAutoRejectThreshold(),
      ]);
      setApproveThreshold(approveVal);
      setRejectThreshold(rejectVal);
    } catch {
      // Non-critical, defaults are fine
    }
  }, []);

  // Load dedup threshold
  const loadDedupThreshold = useCallback(async () => {
    try {
      const { value, source } = await getSimilarityThreshold();
      setDedupThreshold(value);
      setDedupSavedValue(value);
      setDedupSource(source);
    } catch {
      // Non-critical, env fallback is fine
    }
  }, []);

  // Filtered + paginated domains
  const filteredDomains = useMemo(() => {
    if (!domainSearch.trim()) return domains;
    const q = domainSearch.toLowerCase();
    return domains.filter(
      (d) => d.domain.toLowerCase().includes(q) || (d.notes && d.notes.toLowerCase().includes(q)),
    );
  }, [domains, domainSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredDomains.length / DOMAINS_PER_PAGE));
  const pagedDomains = filteredDomains.slice(
    (domainPage - 1) * DOMAINS_PER_PAGE,
    domainPage * DOMAINS_PER_PAGE,
  );

  // Reset page when search changes or domains reload
  useEffect(() => {
    setDomainPage(1);
  }, [domainSearch, domains]);

  // Initial load
  useEffect(() => {
    loadDomains();
    loadSecurityConfig();
    loadTranslationConfig();
    loadThresholds();
    loadDedupThreshold();
  }, [loadDomains, loadSecurityConfig, loadTranslationConfig, loadThresholds, loadDedupThreshold]);

  // Add domain
  const handleAddDomain = async () => {
    if (!newDomain.trim()) return;
    try {
      setAddingDomain(true);
      await addAllowedDomain(newDomain.trim(), newDomainNotes.trim() || undefined);
      setNewDomain("");
      setNewDomainNotes("");
      await loadDomains();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add domain");
    } finally {
      setAddingDomain(false);
    }
  };

  // Delete domain
  const handleDeleteDomain = async (id: string) => {
    setDomainToDelete(id);
  };

  const confirmDeleteDomain = async () => {
    if (!domainToDelete) return;
    try {
      await deleteAllowedDomain(domainToDelete);
      await loadDomains();
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to delete domain");
    } finally {
      setDomainToDelete(null);
    }
  };

  // Toggle domain active
  const handleToggleDomain = async (id: string, isActive: boolean) => {
    try {
      await updateAllowedDomain(id, { isActive: !isActive });
      await loadDomains();
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to update domain");
    }
  };

  const handleApproveChange = useCallback(async (newValue: number) => {
    setIsApproveLoading(true);
    try {
      await setAutoApproveThresholdApi(newValue);
      setApproveThreshold(newValue);
      toast.success(
        newValue === 0 ? "Auto-approve disabled" : `Auto-approve threshold set to ${newValue}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update threshold";
      toast.error(message);
    } finally {
      setIsApproveLoading(false);
    }
  }, []);

  const handleRejectChange = useCallback(async (newValue: number) => {
    setIsRejectLoading(true);
    try {
      await setAutoRejectThresholdApi(newValue);
      setRejectThreshold(newValue);
      toast.success(
        newValue === 0 ? "Auto-reject disabled" : `Auto-reject threshold set to ${newValue}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update threshold";
      toast.error(message);
    } finally {
      setIsRejectLoading(false);
    }
  }, []);

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Restrictions</h1>
        <p className="mt-1 text-sm text-slate-400">
          Security settings, domain whitelist, and emergency controls.
        </p>
      </div>

      <Tabs
        tabs={[
          { id: "sectors", label: "Sectors" },
          { id: "domains", label: "Domain Whitelist" },
          { id: "limits", label: "Feed Limits" },
          { id: "api", label: "API Security" },
          { id: "thresholds", label: "Score Thresholds" },
          { id: "dedup", label: "Dedup Sensitivity" },
          { id: "translation", label: "Translation" },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Sectors Tab */}
      {activeTab === "sectors" && <SectorsTab />}

      {/* Domain Whitelist Tab */}
      {activeTab === "domains" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Allowed RSS Domains</h2>
          <p className="mt-1 text-sm text-slate-400">
            Only RSS sources from these domains can be added. Protects against SSRF attacks.
          </p>

          {/* Add Domain Form */}
          <div className="mt-4 flex flex-wrap gap-3">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="example.com"
              className="flex-1 min-w-[200px] rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <input
              value={newDomainNotes}
              onChange={(e) => setNewDomainNotes(e.target.value)}
              placeholder="Notes (optional)"
              className="flex-1 min-w-[200px] rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <Button
              variant="primary"
              onClick={handleAddDomain}
              disabled={addingDomain || !newDomain.trim()}
              loading={addingDomain}
              loadingText="Adding..."
            >
              Add Domain
            </Button>
          </div>

          {domainsError && <p className="mt-3 text-sm text-red-400">{domainsError}</p>}

          {/* Domain List */}
          {domainsLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading domains...
            </div>
          ) : domains.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="No domains configured"
                description="Add your first trusted domain above to whitelist RSS sources."
              />
            </div>
          ) : (
            <>
              {/* Search filter (shown when 10+ domains) */}
              {domains.length >= 10 && (
                <div className="mt-4">
                  <input
                    value={domainSearch}
                    onChange={(e) => setDomainSearch(e.target.value)}
                    placeholder="Filter domains..."
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
                  />
                </div>
              )}

              <div className={`${domains.length >= 10 ? "mt-2" : "mt-4"} space-y-2`}>
                {pagedDomains.length === 0 ? (
                  <p className="py-4 text-center text-sm text-slate-500">
                    No domains match "{domainSearch}"
                  </p>
                ) : (
                  pagedDomains.map((domain) => (
                    <div
                      key={domain.id}
                      className={`flex items-center justify-between rounded-xl border p-3 ${
                        domain.isActive
                          ? "border-slate-800 bg-slate-950/70"
                          : "border-slate-700 bg-slate-900/50 opacity-60"
                      }`}
                    >
                      <div>
                        <p
                          className={`font-mono text-sm ${domain.isActive ? "text-slate-200" : "text-slate-400"}`}
                        >
                          {domain.domain}
                        </p>
                        {domain.notes && (
                          <p className="mt-0.5 text-xs text-slate-500">{domain.notes}</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleToggleDomain(domain.id, domain.isActive)}
                          className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                            domain.isActive
                              ? "bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
                              : "bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
                          }`}
                        >
                          {domain.isActive ? "Disable" : "Enable"}
                        </button>
                        <Button
                          variant="danger-soft"
                          size="sm"
                          onClick={() => handleDeleteDomain(domain.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Pagination controls */}
              {filteredDomains.length > DOMAINS_PER_PAGE && (
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs text-slate-500">
                    Showing {(domainPage - 1) * DOMAINS_PER_PAGE + 1}–
                    {Math.min(domainPage * DOMAINS_PER_PAGE, filteredDomains.length)} of{" "}
                    {filteredDomains.length}
                    {domainSearch && ` (filtered from ${domains.length})`}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setDomainPage((p) => Math.max(1, p - 1))}
                      disabled={domainPage <= 1}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <span className="flex items-center text-xs text-slate-400">
                      {domainPage} / {totalPages}
                    </span>
                    <button
                      onClick={() => setDomainPage((p) => Math.min(totalPages, p + 1))}
                      disabled={domainPage >= totalPages}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}

              {/* Total domain count */}
              {!domainSearch && domains.length > DOMAINS_PER_PAGE && (
                <p className="mt-1 text-xs text-slate-600">{domains.length} domains total</p>
              )}
            </>
          )}
        </section>
      )}

      {/* Feed Limits Tab */}
      {activeTab === "limits" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Feed Limits</h2>
          <p className="mt-1 text-sm text-slate-400">
            Global defaults for RSS ingestion limits. Set via environment variables.
          </p>

          {configLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading config...
            </div>
          ) : securityConfig ? (
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Max Feed Size</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.maxFeedSizeMb} MB
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  RSS feeds larger than this are rejected
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Articles Per Fetch</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.maxArticlesPerFetch}
                </p>
                <p className="mt-1 text-xs text-slate-500">Max articles per single RSS fetch</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Daily Per Source</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.maxArticlesPerSourceDaily}
                </p>
                <p className="mt-1 text-xs text-slate-500">Max articles per source per day</p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Could not load configuration.</p>
          )}

          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/30 p-3">
            <p className="text-sm text-slate-300">
              To change these limits, update the environment variables:
            </p>
            <pre className="mt-2 text-xs text-slate-500 font-mono">
              {`MAX_FEED_SIZE_MB=5
MAX_ARTICLES_PER_FETCH=100
MAX_ARTICLES_PER_SOURCE_DAILY=500`}
            </pre>
          </div>
        </section>
      )}

      {/* API Security Tab */}
      {activeTab === "api" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">API Security</h2>
          <p className="mt-1 text-sm text-slate-400">
            CORS and rate limiting configuration. Set via environment variables.
          </p>

          {configLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading config...
            </div>
          ) : securityConfig ? (
            <div className="mt-4 space-y-4">
              {/* Rate Limit */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">API Rate Limit</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.apiRateLimitPerMinute}{" "}
                  <span className="text-sm font-normal text-slate-400">/ minute</span>
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Requests exceeding this limit receive 429 Too Many Requests
                </p>
              </div>

              {/* CORS Origins */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Allowed Origins (CORS)
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {securityConfig.allowedOrigins.map((origin, i) => (
                    <span
                      key={i}
                      className="rounded-lg bg-slate-800 px-3 py-1 font-mono text-sm text-slate-200"
                    >
                      {origin}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Only these origins can make cross-origin requests to the API
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Could not load configuration.</p>
          )}

          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/30 p-3">
            <p className="text-sm text-slate-300">
              To change these settings, update the environment variables:
            </p>
            <pre className="mt-2 text-xs text-slate-500 font-mono">
              {`ALLOWED_ORIGINS=https://yourdomain.com
API_RATE_LIMIT_PER_MINUTE=200`}
            </pre>
          </div>
        </section>
      )}

      {/* Score Thresholds Tab */}
      {activeTab === "thresholds" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Global Score Thresholds</h2>
          <p className="mt-1 text-sm text-slate-400">
            Default thresholds for auto-approve, manual review, and auto-reject. Per-sector rules
            override these when configured.
          </p>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Auto-Approve */}
            <div className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-200">Auto-Approve</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {approveThreshold === 0
                      ? "Disabled — all scored articles go to manual review"
                      : "Articles scoring \u2265 this are auto-approved"}
                  </p>
                </div>
                <select
                  value={approveThreshold}
                  onChange={(e) => handleApproveChange(Number(e.target.value))}
                  disabled={isApproveLoading}
                  className={`w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-200 outline-none focus:border-slate-500 ${isApproveLoading ? "opacity-50" : ""}`}
                >
                  <option value={0}>OFF</option>
                  {[2, 3, 4, 5].map((v) => (
                    <option
                      key={v}
                      value={v}
                      disabled={rejectThreshold !== 0 && v <= rejectThreshold}
                    >
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Auto-Reject */}
            <div className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-200">Auto-Reject</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {rejectThreshold === 0
                      ? "Disabled — all scored articles go to manual review"
                      : "Articles scoring \u2264 this are auto-rejected"}
                  </p>
                </div>
                <select
                  value={rejectThreshold}
                  onChange={(e) => handleRejectChange(Number(e.target.value))}
                  disabled={isRejectLoading}
                  className={`w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-200 outline-none focus:border-slate-500 ${isRejectLoading ? "opacity-50" : ""}`}
                >
                  <option value={0}>OFF</option>
                  {[1, 2, 3, 4].map((v) => (
                    <option
                      key={v}
                      value={v}
                      disabled={approveThreshold !== 0 && v >= approveThreshold}
                    >
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <p className="mt-4 text-xs text-slate-500">
            Scores between thresholds go to manual review. Changes take effect on the next scoring
            batch.
          </p>
        </section>
      )}

      {/* Translation Tab */}
      {activeTab === "translation" && (
        <section className="grid gap-6">
          {/* Posting Language Toggle */}
          <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-amber-200">Posting Language</h3>
                <p className="text-sm text-amber-200/70">
                  All posts will use this language. Georgian requires translation to be configured.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    updateTranslationConfig({ posting_language: "en" })
                      .then(() => toast.success("Switched to English"))
                      .catch(() => toast.error("Failed to update language"));
                    setTranslationConfig((prev) =>
                      prev ? { ...prev, posting_language: "en" } : null,
                    );
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    translationConfig?.posting_language === "en"
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                  }`}
                >
                  English
                </button>
                <button
                  onClick={() => {
                    updateTranslationConfig({ posting_language: "ka" })
                      .then(() => toast.success("Switched to Georgian"))
                      .catch(() => toast.error("Failed to update language"));
                    setTranslationConfig((prev) =>
                      prev ? { ...prev, posting_language: "ka" } : null,
                    );
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    translationConfig?.posting_language === "ka"
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                  }`}
                >
                  Georgian
                </button>
              </div>
            </div>
          </div>

          {/* Scores to Translate */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-lg font-medium mb-4">Translate Articles with Score</h3>
            <div className="flex gap-4">
              {[3, 4, 5].map((score) => (
                <label key={score} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={translationConfig?.scores.includes(score) ?? false}
                    onChange={(e) => {
                      const newScores = e.target.checked
                        ? [...(translationConfig?.scores ?? []), score]
                        : (translationConfig?.scores ?? []).filter((s) => s !== score);
                      updateTranslationConfig({ scores: newScores })
                        .then(() => toast.success("Translation scores updated"))
                        .catch(() => toast.error("Failed to update scores"));
                      setTranslationConfig((prev) =>
                        prev ? { ...prev, scores: newScores } : null,
                      );
                    }}
                    className="rounded border-slate-600"
                  />
                  <span className="text-sm text-slate-200">Score {score}</span>
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Only articles ingested <span className="text-slate-300">after</span> you enable a
              score will be auto-translated. Already-scored articles won't be picked up
              retroactively. To translate older articles, use the translate button on individual
              articles.
            </p>
          </div>

          {/* Translation Provider & Model */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-lg font-medium mb-4">Translation Provider & Model</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm text-slate-400 mb-2">Provider</label>
                <select
                  value={translationConfig?.provider ?? "gemini"}
                  onChange={(e) => {
                    const provider = e.target.value as "gemini" | "openai";
                    const defaultModel = provider === "openai" ? "gpt-4o-mini" : "gemini-2.5-flash";
                    updateTranslationConfig({ provider, model: defaultModel })
                      .then(() => toast.success(`Provider set to ${provider}`))
                      .catch(() => toast.error("Failed to update provider"));
                    setTranslationConfig((prev) =>
                      prev ? { ...prev, provider, model: defaultModel } : null,
                    );
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm"
                >
                  <option value="gemini">Gemini (Google)</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-2">Model</label>
                <select
                  value={translationConfig?.model ?? "gemini-2.5-flash"}
                  onChange={(e) => {
                    updateTranslationConfig({ model: e.target.value })
                      .then(() => toast.success(`Model set to ${e.target.value}`))
                      .catch(() => toast.error("Failed to update model"));
                    setTranslationConfig((prev) =>
                      prev ? { ...prev, model: e.target.value } : null,
                    );
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm"
                >
                  {translationConfig?.provider === "openai" ? (
                    <>
                      <option value="gpt-4o-mini">gpt-4o-mini (fast, cheap)</option>
                      <option value="gpt-4o">gpt-4o (quality)</option>
                      <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                      <option value="gpt-4.1-nano">gpt-4.1-nano</option>
                    </>
                  ) : (
                    <>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash (balanced)</option>
                      <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite (budget)</option>
                      <option value="gemini-2.5-pro">Gemini 2.5 Pro (deep reasoning)</option>
                      <option value="gemini-3-flash-preview">
                        Gemini 3 Flash (high performance)
                      </option>
                      <option value="gemini-3-pro-preview">Gemini 3 Pro (flagship)</option>
                    </>
                  )}
                </select>
              </div>
            </div>
          </div>

          {/* Translation Instructions */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-lg font-medium mb-4">Translation Instructions</h3>
            <p className="text-sm text-slate-400 mb-4">
              Customize how the AI translates content to Georgian
            </p>
            <textarea
              value={translationConfig?.instructions ?? ""}
              onChange={(e) => {
                setTranslationConfig((prev) =>
                  prev ? { ...prev, instructions: e.target.value } : null,
                );
              }}
              onBlur={() => {
                if (translationConfig) {
                  updateTranslationConfig({ instructions: translationConfig.instructions })
                    .then(() => toast.success("Instructions saved"))
                    .catch(() => toast.error("Failed to save instructions"));
                }
              }}
              rows={6}
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm"
              placeholder="Translate the following English news summary into Georgian..."
            />
          </div>
        </section>
      )}

      {/* Dedup Sensitivity Tab */}
      {activeTab === "dedup" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Dedup Sensitivity</h2>
          <p className="mt-1 text-sm text-slate-400">
            Controls how similar two articles must be to count as duplicates. Higher values mean
            stricter matching (only near-identical articles are deduped). Lower values are more
            aggressive (loosely related articles may also be deduped).
          </p>

          <div className="mt-6 rounded-xl border border-slate-700 bg-slate-950/70 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-slate-300">Similarity Threshold</span>
              <span className="text-2xl font-semibold text-slate-100">
                {Math.round(dedupThreshold * 100)}%
              </span>
            </div>

            <input
              type="range"
              min="50"
              max="95"
              step="5"
              value={Math.round(dedupThreshold * 100)}
              onChange={(e) => setDedupThreshold(Number(e.target.value) / 100)}
              className="w-full accent-cyan-500"
            />

            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>50% — Aggressive (catches loosely related)</span>
              <span>95% — Strict (only near-identical)</span>
            </div>

            <div className="mt-3 text-xs text-slate-500">
              {dedupThreshold < 0.65 && (
                <p className="text-amber-400">
                  Very aggressive — related but different articles may be incorrectly deduped.
                </p>
              )}
              {dedupThreshold >= 0.65 && dedupThreshold < 0.8 && (
                <p>
                  Moderate — good balance between catching duplicates and preserving unique content.
                </p>
              )}
              {dedupThreshold >= 0.8 && dedupThreshold < 0.9 && (
                <p>Recommended range — only substantially similar articles are deduped.</p>
              )}
              {dedupThreshold >= 0.9 && (
                <p className="text-amber-400">
                  Very strict — only near-identical articles will be deduped. Some duplicates may
                  slip through.
                </p>
              )}
            </div>

            <Button
              variant="primary"
              fullWidth
              className="mt-4"
              onClick={async () => {
                setDedupSaving(true);
                try {
                  await setSimilarityThresholdApi(dedupThreshold);
                  setDedupSavedValue(dedupThreshold);
                  setDedupSource("database");
                  toast.success(`Threshold set to ${Math.round(dedupThreshold * 100)}%`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to save");
                } finally {
                  setDedupSaving(false);
                }
              }}
              disabled={dedupSaving}
              loading={dedupSaving}
              loadingText="Saving..."
            >
              Save Threshold
            </Button>
          </div>

          {dedupSavedValue != null && (
            <div
              className={`mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 ${dedupSource === "database" ? "border-slate-700 bg-slate-950/50" : "border-amber-800/50 bg-amber-950/20"}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${dedupSource === "database" ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              <span className="text-xs text-slate-500">
                {dedupSource === "database" ? (
                  <>
                    Worker using:{" "}
                    <span className="font-medium text-slate-200">
                      {Math.round(dedupSavedValue * 100)}%
                    </span>{" "}
                    <span className="text-slate-500">(saved in database)</span>
                  </>
                ) : (
                  <>
                    Worker using:{" "}
                    <span className="font-medium text-amber-200">
                      {Math.round(dedupSavedValue * 100)}%
                    </span>{" "}
                    <span className="text-amber-400">(fallback — not yet saved to database)</span>
                  </>
                )}
                {dedupThreshold !== dedupSavedValue && (
                  <span className="ml-2 text-amber-400">
                    (unsaved slider: {Math.round(dedupThreshold * 100)}%)
                  </span>
                )}
              </span>
            </div>
          )}

          <div className="mt-4 rounded-xl border border-amber-800/50 bg-amber-950/20 p-4">
            <p className="text-sm font-medium text-amber-200">Important</p>
            <p className="mt-1 text-xs text-amber-200/70">
              Changes affect new articles only. Previously deduped articles will not be
              re-evaluated. The new threshold takes effect on the next dedup batch without requiring
              a worker restart.
            </p>
          </div>
        </section>
      )}
      {domainToDelete && (
        <ConfirmModal
          title="Remove Domain"
          message="Remove this domain from the whitelist? RSS sources from this domain will no longer be allowed."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={confirmDeleteDomain}
          onCancel={() => setDomainToDelete(null)}
        />
      )}
    </div>
  );
}
