import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  getConstraints,
  getFeedItemsTtl,
  setFeedItemsTtl,
  getFeedFetchRunsTtl,
  setFeedFetchRunsTtl,
  getLlmTelemetryTtl,
  setLlmTelemetryTtl,
  getArticleImagesTtl,
  setArticleImagesTtl,
  getPostDeliveriesTtl,
  setPostDeliveriesTtl,
  getAlertDeliveriesTtl,
  setAlertDeliveriesTtl,
  getDigestRunsTtl,
  setDigestRunsTtl,
  getTelemetrySummary,
  getTelemetryByProvider,
  getTelemetryByOperation,
  getTelemetryDaily,
  getProviderBalances,
  refreshProviderBalances,
  type Constraints,
  type TelemetrySummary,
  type TelemetryByProvider,
  type TelemetryByOperation,
  type TelemetryDaily,
  type ProviderBalancesResponse,
} from "../api";
import Spinner from "../components/Spinner";

type TabId = "telemetry" | "cleanup";

const formatCost = (usd: number): string => {
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
};

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
};

const formatLatency = (ms: number): string => {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
};

const OPERATION_LABELS: Record<string, string> = {
  score_and_summarize: "LLM Scoring",
  embed_batch: "Embeddings",
  translate: "Translation",
  image_generation: "Image Generation",
};

const formatOperation = (op: string): string =>
  OPERATION_LABELS[op] ?? op.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Human-readable TTL hint from a numeric days value. */
function formatTtlHint(raw: string, unit: "days" | "hours" = "days"): string {
  const n = Number(raw);
  if (Number.isNaN(n) || n <= 0) return "";
  const totalHours = unit === "days" ? n * 24 : n;
  const days = totalHours / 24;
  if (days >= 365) return `≈ ${(days / 365).toFixed(1).replace(/\.0$/, "")} yr`;
  if (days >= 30) {
    const mo = Math.floor(days / 30);
    const rem = Math.round(days % 30);
    return rem > 0 ? `≈ ${mo} mo ${rem} d` : `≈ ${mo} mo`;
  }
  if (days >= 7 && days % 7 === 0) return `= ${days / 7} wk`;
  if (days >= 1 && Number.isInteger(days)) return `= ${days} d`;
  // fractional days → show days + hours
  const wholeDays = Math.floor(days);
  const remHours = Math.round((days - wholeDays) * 24);
  if (wholeDays === 0) return `= ${remHours} hr`;
  return `≈ ${wholeDays} d ${remHours} hr`;
}

export default function Settings() {
  // URL-based tab state
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: TabId = tabParam === "cleanup" ? "cleanup" : "telemetry";

  const setActiveTab = (tab: TabId) => {
    setSearchParams(tab === "telemetry" ? {} : { tab }, { replace: true });
  };

  // TTL state
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [isLoading, setIsLoading] = useState(true);
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
  const [alertDeliveriesTtlDays, setAlertDeliveriesTtlDays] = useState("");
  const [alertDeliveriesTtlError, setAlertDeliveriesTtlError] = useState<string | null>(null);
  const [digestRunsTtlDays, setDigestRunsTtlDays] = useState("");
  const [digestRunsTtlError, setDigestRunsTtlError] = useState<string | null>(null);

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

  // Balances
  const [providerBalances, setProviderBalances] = useState<ProviderBalancesResponse | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const [
        ttlValue,
        fetchRunsTtlHours,
        constraintsData,
        llmTelemetryTtl,
        articleImagesTtl,
        postDeliveriesTtl,
        alertDeliveriesTtl,
        digestRunsTtl,
      ] = await Promise.all([
        getFeedItemsTtl(),
        getFeedFetchRunsTtl(),
        getConstraints(),
        getLlmTelemetryTtl(),
        getArticleImagesTtl(),
        getPostDeliveriesTtl(),
        getAlertDeliveriesTtl(),
        getDigestRunsTtl(),
      ]);
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
      setAlertDeliveriesTtlDays(String(alertDeliveriesTtl));
      setDigestRunsTtlDays(String(digestRunsTtl));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load settings";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

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

  const onSaveAlertDeliveriesTtl = async () => {
    const min = constraints?.alertDeliveriesTtl?.min ?? 1;
    const max = constraints?.alertDeliveriesTtl?.max ?? 60;
    const value = Number(alertDeliveriesTtlDays);
    if (Number.isNaN(value) || value < min || value > max) {
      setAlertDeliveriesTtlError(`TTL must be between ${min} and ${max} days`);
      toast.error(`TTL must be between ${min} and ${max} days`);
      return;
    }
    try {
      const updated = await setAlertDeliveriesTtl(value);
      setAlertDeliveriesTtlDays(String(updated));
      setAlertDeliveriesTtlError(null);
      toast.success("Alert deliveries TTL updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update alert deliveries TTL";
      setAlertDeliveriesTtlError(message);
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

  useEffect(() => {
    loadSettings();
    refreshTelemetry();
  }, []);

  const dailyMax = useMemo(() => {
    if (!telemetryDaily?.daily.length) return 1;
    return Math.max(...telemetryDaily.daily.map((d) => d.cost_usd), 0.001);
  }, [telemetryDaily]);

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">DB / Telemetry</h1>
        <p className="mt-1 text-sm text-slate-400">
          LLM usage metrics and database retention settings.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {[
          { id: "telemetry", label: "LLM Telemetry" },
          { id: "cleanup", label: "Database Cleanup" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id
                ? "border-b-2 border-cyan-400 text-cyan-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* LLM Telemetry Tab */}
      {activeTab === "telemetry" && (
      <>
        {/* Header + Refresh */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">LLM Telemetry</h2>
            <p className="mt-1 text-sm text-slate-400">
              Token usage, costs, and latency metrics.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {telemetryUpdatedAt ? `Updated ${telemetryUpdatedAt}` : ""}
            </span>
            <button
              onClick={refreshTelemetry}
              disabled={telemetryLoading}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
            >
              {telemetryLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
        {telemetryError ? <p className="text-sm text-red-400">{telemetryError}</p> : null}

        {/* Provider Balances */}
        {providerBalances && providerBalances.providers.length > 0 ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-300">Provider Credits</h3>
              <button
                onClick={refreshBalances}
                disabled={balancesLoading}
                className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                {balancesLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              {providerBalances.providers.map((provider) => (
                <div
                  key={provider.provider}
                  className={`rounded-xl border p-4 ${
                    provider.error
                      ? "border-slate-700 bg-slate-950/50"
                      : provider.total_balance !== null && provider.total_balance < 5
                        ? "border-amber-500/40 bg-amber-950/20"
                        : "border-slate-800 bg-slate-950/70"
                  }`}
                >
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {provider.display_name}
                  </p>
                  {provider.total_balance !== null ? (
                    <>
                      <p
                        className={`mt-2 text-2xl font-semibold ${
                          provider.total_balance < 5 ? "text-amber-300" : "text-cyan-300"
                        }`}
                      >
                        ${provider.total_balance.toFixed(2)}
                      </p>
                      {provider.granted_balance !== null && provider.granted_balance > 0 ? (
                        <p className="mt-1 text-xs text-slate-400">
                          ${provider.granted_balance.toFixed(2)} granted
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-lg font-semibold text-slate-400">N/A</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {provider.error ?? "Balance unavailable"}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Cost Summary */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h3 className="text-sm font-semibold text-slate-300">Cost Overview</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {([
              { label: "Today", stats: telemetrySummary?.today, accent: true },
              { label: "Last 7 Days", stats: telemetrySummary?.last_7_days, accent: false },
              { label: "Last 30 Days", stats: telemetrySummary?.last_30_days, accent: false },
              { label: "All Time", stats: telemetrySummary?.all_time, accent: false },
            ] as const).map((card) => (
              <div key={card.label} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
                <p className={`mt-2 text-2xl font-semibold ${card.accent ? "text-emerald-300" : "text-slate-100"}`}>
                  {formatCost(card.stats?.cost_usd ?? 0)}
                </p>
                <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-400">
                  <span>{card.stats?.requests ?? 0} req</span>
                  <span className="text-slate-700">|</span>
                  <span>{formatTokens(card.stats?.tokens ?? 0)} tok</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Daily Cost Chart */}
        {telemetryDaily && telemetryDaily.daily.length > 0 ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-sm font-semibold text-slate-300">Daily Costs (Last 30 Days)</h3>
            <div className="relative mt-3" style={{ height: 130 }}>
              <span className="absolute -top-0.5 left-0 text-[10px] text-slate-600">
                {formatCost(dailyMax)}
              </span>
              <div className="flex h-full items-end gap-[3px] pt-3">
                {telemetryDaily.daily.map((day) => {
                  const pct = Math.max((day.cost_usd / dailyMax) * 100, 2);
                  return (
                    <div
                      key={day.date}
                      className="group relative flex-1 rounded-t bg-emerald-500/50 transition hover:bg-emerald-400/80"
                      style={{ height: `${pct}%` }}
                    >
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 shadow-lg group-hover:block">
                        <span className="font-medium">{day.date}</span>
                        <br />
                        {formatCost(day.cost_usd)} &middot; {day.requests} req
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-slate-600">
              <span>{telemetryDaily.daily[0]?.date}</span>
              <span>{telemetryDaily.daily[telemetryDaily.daily.length - 1]?.date}</span>
            </div>
          </section>
        ) : null}

        {/* By Provider — Table */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h3 className="text-sm font-semibold text-slate-300">By Provider (Last 30 Days)</h3>
          {telemetryByProvider?.providers.length ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-3 font-medium">Provider</th>
                    <th className="pb-2 pr-3 font-medium">Model</th>
                    <th className="pb-2 pr-3 text-right font-medium">Requests</th>
                    <th className="pb-2 pr-3 text-right font-medium">Tokens</th>
                    <th className="pb-2 pr-1 text-right font-medium">Cost</th>
                    <th className="pb-2 pr-3 font-medium" style={{ width: "18%" }} />
                    <th className="pb-2 text-right font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {(() => {
                    const totalProviderCost = telemetryByProvider.providers.reduce(
                      (sum, p) => sum + p.cost_usd, 0,
                    );
                    return telemetryByProvider.providers.map((p) => {
                      const costPct = totalProviderCost > 0
                        ? (p.cost_usd / totalProviderCost) * 100
                        : 0;
                      return (
                        <tr key={`${p.provider}-${p.model}`}>
                          <td className="py-2.5 pr-3 font-medium text-slate-200">
                            {p.provider}
                            {p.fallback_count > 0 ? (
                              <span className="ml-1.5 text-[10px] text-amber-400">{p.fallback_count} fb</span>
                            ) : null}
                          </td>
                          <td className="py-2.5 pr-3 text-xs text-slate-400">{p.model}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-slate-300">{p.requests}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-slate-300">
                            {p.model?.startsWith("gpt-image") ? `${p.requests} img` : formatTokens(p.total_tokens)}
                          </td>
                          <td className="py-2.5 pr-1 text-right tabular-nums font-medium text-emerald-400">
                            {formatCost(p.cost_usd)}
                          </td>
                          <td className="py-2.5 pr-3">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="h-full rounded-full bg-emerald-500/60"
                                style={{ width: `${Math.max(costPct, 1)}%` }}
                              />
                            </div>
                          </td>
                          <td className="py-2.5 text-right text-xs text-slate-400">
                            {formatLatency(p.avg_latency_ms)}
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          ) : !telemetryLoading ? (
            <p className="mt-3 text-sm text-slate-400">No provider data yet.</p>
          ) : null}
        </section>

        {/* By Operation — Table */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h3 className="text-sm font-semibold text-slate-300">By Operation (Last 30 Days)</h3>
          {telemetryByOperation?.operations.length ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-3 font-medium">Operation</th>
                    <th className="pb-2 pr-3 text-right font-medium">Requests</th>
                    <th className="pb-2 pr-3 text-right font-medium">Tokens</th>
                    <th className="pb-2 pr-1 text-right font-medium">Cost</th>
                    <th className="pb-2 pr-3 font-medium" style={{ width: "18%" }} />
                    <th className="pb-2 text-right font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {(() => {
                    const totalOpCost = telemetryByOperation.operations.reduce(
                      (sum, o) => sum + o.cost_usd, 0,
                    );
                    return telemetryByOperation.operations.map((op) => {
                      const costPct = totalOpCost > 0
                        ? (op.cost_usd / totalOpCost) * 100
                        : 0;
                      return (
                        <tr key={op.operation}>
                          <td className="py-2.5 pr-3 font-medium text-slate-200">
                            {formatOperation(op.operation)}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-slate-300">{op.requests}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-slate-300">
                            {op.operation === "image_generation" ? `${op.requests} img` : formatTokens(op.total_tokens)}
                          </td>
                          <td className="py-2.5 pr-1 text-right tabular-nums font-medium text-emerald-400">
                            {formatCost(op.cost_usd)}
                          </td>
                          <td className="py-2.5 pr-3">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="h-full rounded-full bg-emerald-500/60"
                                style={{ width: `${Math.max(costPct, 1)}%` }}
                              />
                            </div>
                          </td>
                          <td className="py-2.5 text-right text-xs text-slate-400">
                            {formatLatency(op.avg_latency_ms)}
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          ) : !telemetryLoading ? (
            <p className="mt-3 text-sm text-slate-400">No operation data yet.</p>
          ) : null}
        </section>
      </>
      )}

      {/* Database Cleanup Tab */}
      {activeTab === "cleanup" && (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Database Cleanup</h2>
        <p className="mt-1 text-sm text-slate-400">
          Control retention and TTL settings for database tables.
        </p>

        {isLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Loading settings...
          </div>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="pb-2 pr-4 font-medium">Table</th>
                  <th className="pb-2 pr-4 font-medium">Retention</th>
                  <th className="pb-2 pr-4 font-medium">Human</th>
                  <th className="pb-2 pr-4 font-medium" />
                  <th className="pb-2 font-medium">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {/* Articles TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">Articles</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={ttlDays}
                        onChange={(e) => setTtlDays(e.target.value)}
                        placeholder="30-60"
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <span className="text-slate-500">days</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(ttlDays)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSaveTtl}
                      disabled={!ttlDays.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    Feed items older than this are deleted.
                    {ttlError ? <span className="ml-2 text-red-400">{ttlError}</span> : null}
                  </td>
                </tr>

                {/* Fetch Runs TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">Fetch Runs</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={fetchRunsTtlValue}
                        onChange={(e) => setFetchRunsTtlValue(e.target.value)}
                        placeholder={fetchRunsTtlUnit === "days" ? "Days" : "Hours"}
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <select
                        value={fetchRunsTtlUnit}
                        onChange={(e) =>
                          onFetchRunsTtlUnitChange(e.target.value as "hours" | "days")
                        }
                        className="rounded-lg border border-slate-800 bg-slate-950 px-1.5 py-1.5 text-xs text-slate-300 outline-none focus:border-slate-600"
                      >
                        <option value="hours">hr</option>
                        <option value="days">days</option>
                      </select>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(fetchRunsTtlValue, fetchRunsTtlUnit)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSaveFetchRunsTtl}
                      disabled={!fetchRunsTtlValue.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    Fetch run telemetry retention.
                    {fetchRunsTtlError ? (
                      <span className="ml-2 text-red-400">{fetchRunsTtlError}</span>
                    ) : null}
                  </td>
                </tr>

                {/* LLM Telemetry TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">LLM Telemetry</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={llmTelemetryTtlDays}
                        onChange={(e) => setLlmTelemetryTtlDays(e.target.value)}
                        placeholder="1-60"
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <span className="text-slate-500">days</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(llmTelemetryTtlDays)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSaveLlmTelemetryTtl}
                      disabled={!llmTelemetryTtlDays.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    LLM usage telemetry retention.
                    {llmTelemetryTtlError ? (
                      <span className="ml-2 text-red-400">{llmTelemetryTtlError}</span>
                    ) : null}
                  </td>
                </tr>

                {/* Article Images TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">Article Images</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={articleImagesTtlDays}
                        onChange={(e) => setArticleImagesTtlDays(e.target.value)}
                        placeholder="1-60"
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <span className="text-slate-500">days</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(articleImagesTtlDays)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSaveArticleImagesTtl}
                      disabled={!articleImagesTtlDays.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    Generated images retention.
                    {articleImagesTtlError ? (
                      <span className="ml-2 text-red-400">{articleImagesTtlError}</span>
                    ) : null}
                  </td>
                </tr>

                {/* Post Deliveries TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">Post Deliveries</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={postDeliveriesTtlDays}
                        onChange={(e) => setPostDeliveriesTtlDays(e.target.value)}
                        placeholder="1-60"
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <span className="text-slate-500">days</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(postDeliveriesTtlDays)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSavePostDeliveriesTtl}
                      disabled={!postDeliveriesTtlDays.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    Completed/failed/cancelled deliveries retention.
                    {postDeliveriesTtlError ? (
                      <span className="ml-2 text-red-400">{postDeliveriesTtlError}</span>
                    ) : null}
                  </td>
                </tr>

                {/* Alert Deliveries TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">Alert Deliveries</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={alertDeliveriesTtlDays}
                        onChange={(e) => setAlertDeliveriesTtlDays(e.target.value)}
                        placeholder="1-60"
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <span className="text-slate-500">days</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(alertDeliveriesTtlDays)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSaveAlertDeliveriesTtl}
                      disabled={!alertDeliveriesTtlDays.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    Keyword alert delivery audit trail retention.
                    {alertDeliveriesTtlError ? (
                      <span className="ml-2 text-red-400">{alertDeliveriesTtlError}</span>
                    ) : null}
                  </td>
                </tr>

                {/* Digest Runs TTL */}
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-300">Digest Runs</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <input
                        value={digestRunsTtlDays}
                        onChange={(e) => setDigestRunsTtlDays(e.target.value)}
                        placeholder="1-90"
                        className="w-20 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
                      />
                      <span className="text-slate-500">days</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-emerald-400/70">
                    {formatTtlHint(digestRunsTtlDays)}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={onSaveDigestRunsTtl}
                      disabled={!digestRunsTtlDays.trim()}
                      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </td>
                  <td className="py-3 text-xs text-slate-500">
                    Digest history retention (runs + drafts).
                    {digestRunsTtlError ? (
                      <span className="ml-2 text-red-400">{digestRunsTtlError}</span>
                    ) : null}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </div>
  );
}
