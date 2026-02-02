import { useMemo } from "react";
import type {
  TelemetrySummary,
  TelemetryByProvider,
  TelemetryByOperation,
  TelemetryDaily,
} from "../api";
import Spinner from "../components/Spinner";

type SettingsProps = {
  // Telemetry props
  telemetrySummary: TelemetrySummary | null;
  telemetryByProvider: TelemetryByProvider | null;
  telemetryByOperation: TelemetryByOperation | null;
  telemetryDaily: TelemetryDaily | null;
  telemetryLoading: boolean;
  telemetryError: string | null;
  telemetryLastUpdated: string | null;
  onRefreshTelemetry: () => void;
  // Database props
  isLoading: boolean;
  ttlDays: string;
  ttlError: string | null;
  onTtlChange: (value: string) => void;
  onSaveTtl: () => void;
  fetchRunsTtlValue: string;
  fetchRunsTtlUnit: "hours" | "days";
  fetchRunsTtlError: string | null;
  onFetchRunsTtlChange: (value: string) => void;
  onFetchRunsTtlUnitChange: (unit: "hours" | "days") => void;
  onSaveFetchRunsTtl: () => void;
  llmTelemetryTtlDays: string;
  llmTelemetryTtlError: string | null;
  onLlmTelemetryTtlChange: (value: string) => void;
  onSaveLlmTelemetryTtl: () => void;
  articleImagesTtlDays: string;
  articleImagesTtlError: string | null;
  onArticleImagesTtlChange: (value: string) => void;
  onSaveArticleImagesTtl: () => void;
  postDeliveriesTtlDays: string;
  postDeliveriesTtlError: string | null;
  onPostDeliveriesTtlChange: (value: string) => void;
  onSavePostDeliveriesTtl: () => void;
};

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

export default function Settings({
  telemetrySummary,
  telemetryByProvider,
  telemetryByOperation,
  telemetryDaily,
  telemetryLoading,
  telemetryError,
  telemetryLastUpdated,
  onRefreshTelemetry,
  isLoading,
  ttlDays,
  ttlError,
  onTtlChange,
  onSaveTtl,
  fetchRunsTtlValue,
  fetchRunsTtlUnit,
  fetchRunsTtlError,
  onFetchRunsTtlChange,
  onFetchRunsTtlUnitChange,
  onSaveFetchRunsTtl,
  llmTelemetryTtlDays,
  llmTelemetryTtlError,
  onLlmTelemetryTtlChange,
  onSaveLlmTelemetryTtl,
  articleImagesTtlDays,
  articleImagesTtlError,
  onArticleImagesTtlChange,
  onSaveArticleImagesTtl,
  postDeliveriesTtlDays,
  postDeliveriesTtlError,
  onPostDeliveriesTtlChange,
  onSavePostDeliveriesTtl,
}: SettingsProps) {
  const totalCostToday = telemetrySummary?.today.cost_usd ?? 0;
  const totalCost30d = telemetrySummary?.last_30_days.cost_usd ?? 0;

  const dailyMax = useMemo(() => {
    if (!telemetryDaily?.daily.length) return 1;
    return Math.max(...telemetryDaily.daily.map((d) => d.cost_usd), 0.001);
  }, [telemetryDaily]);

  return (
    <div className="grid gap-8">
      {/* ═══════════════════════════════════════════════════════════════════════
          TELEMETRY SECTION
          ═══════════════════════════════════════════════════════════════════════ */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">LLM Telemetry</h1>
            <p className="mt-1 text-sm text-slate-400">
              Token usage, costs, and latency metrics.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {telemetryLastUpdated ? `Updated ${telemetryLastUpdated}` : "Not updated yet"}
            </span>
            <button
              onClick={onRefreshTelemetry}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Refresh
            </button>
          </div>
        </div>
        {telemetryError ? <p className="mt-3 text-sm text-red-400">{telemetryError}</p> : null}

        {/* Summary Cards */}
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Today</p>
            <p className="mt-2 text-2xl font-semibold text-emerald-300">
              {formatCost(totalCostToday)}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {telemetrySummary?.today.requests ?? 0} requests
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Last 7 Days</p>
            <p className="mt-2 text-2xl font-semibold text-slate-100">
              {formatCost(telemetrySummary?.last_7_days.cost_usd ?? 0)}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {formatTokens(telemetrySummary?.last_7_days.tokens ?? 0)} tokens
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Last 30 Days</p>
            <p className="mt-2 text-2xl font-semibold text-slate-100">{formatCost(totalCost30d)}</p>
            <p className="mt-1 text-xs text-slate-400">
              {formatTokens(telemetrySummary?.last_30_days.tokens ?? 0)} tokens
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">All Time</p>
            <p className="mt-2 text-2xl font-semibold text-slate-100">
              {formatCost(telemetrySummary?.all_time.cost_usd ?? 0)}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {telemetrySummary?.all_time.requests ?? 0} total requests
            </p>
          </div>
        </div>

        {/* Daily Cost Chart */}
        {telemetryDaily && telemetryDaily.daily.length > 0 ? (
          <div className="mt-5">
            <h2 className="text-sm font-semibold text-slate-300">Daily Costs (Last 30 Days)</h2>
            <div className="mt-3 flex items-end gap-1" style={{ height: 60 }}>
              {telemetryDaily.daily.map((day) => {
                const height = Math.max((day.cost_usd / dailyMax) * 100, 2);
                return (
                  <div
                    key={day.date}
                    className="group relative flex-1 rounded-t bg-emerald-500/60 transition hover:bg-emerald-400"
                    style={{ height: `${height}%` }}
                    title={`${day.date}: ${formatCost(day.cost_usd)}`}
                  >
                    <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-slate-200 group-hover:block">
                      {day.date}: {formatCost(day.cost_usd)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-xs text-slate-500">
              <span>{telemetryDaily.daily[0]?.date}</span>
              <span>{telemetryDaily.daily[telemetryDaily.daily.length - 1]?.date}</span>
            </div>
          </div>
        ) : null}

        {/* By Provider */}
        <div className="mt-5">
          <h2 className="text-sm font-semibold text-slate-300">By Provider (Last 30 Days)</h2>
          <div className="mt-3 grid gap-2">
            {telemetryByProvider?.providers.map((provider) => (
              <div
                key={`${provider.provider}-${provider.model}`}
                className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/70 p-3 md:grid-cols-[1.5fr,2fr]"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-100">{provider.provider}</p>
                  <p className="text-xs text-slate-400">{provider.model}</p>
                  {provider.fallback_count > 0 ? (
                    <p className="mt-1 text-xs text-amber-300">
                      {provider.fallback_count} fallback calls
                    </p>
                  ) : null}
                </div>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Requests
                    </span>
                    <p className="mt-1 text-slate-200">{provider.requests}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Tokens
                    </span>
                    <p className="mt-1 text-slate-200">{formatTokens(provider.total_tokens)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">Cost</span>
                    <p className="mt-1 text-emerald-300">{formatCost(provider.cost_usd)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Avg Latency
                    </span>
                    <p className="mt-1 text-slate-200">{formatLatency(provider.avg_latency_ms)}</p>
                  </div>
                </div>
              </div>
            ))}
            {!telemetryByProvider?.providers.length && !telemetryLoading ? (
              <p className="text-sm text-slate-400">No provider data yet.</p>
            ) : null}
          </div>
        </div>

        {/* By Operation */}
        <div className="mt-5">
          <h2 className="text-sm font-semibold text-slate-300">By Operation (Last 30 Days)</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {telemetryByOperation?.operations.map((op) => (
              <div
                key={op.operation}
                className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
              >
                <p className="text-sm font-semibold text-slate-100">{op.operation}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Requests
                    </span>
                    <p className="mt-1 text-slate-200">{op.requests}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Tokens
                    </span>
                    <p className="mt-1 text-slate-200">{formatTokens(op.total_tokens)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">Cost</span>
                    <p className="mt-1 text-emerald-300">{formatCost(op.cost_usd)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      Avg Latency
                    </span>
                    <p className="mt-1 text-slate-200">{formatLatency(op.avg_latency_ms)}</p>
                  </div>
                </div>
              </div>
            ))}
            {!telemetryByOperation?.operations.length && !telemetryLoading ? (
              <p className="text-sm text-slate-400">No operation data yet.</p>
            ) : null}
          </div>
        </div>

        {telemetryLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Loading telemetry data...
          </div>
        ) : null}
      </section>

      {/* ═══════════════════════════════════════════════════════════════════════
          DATABASE CLEANUP SECTION
          ═══════════════════════════════════════════════════════════════════════ */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h1 className="text-2xl font-semibold tracking-tight">Database Cleanup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Control retention and TTL settings for database tables.
        </p>

        {isLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Loading settings...
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            {/* Articles TTL */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="w-40 text-sm text-slate-300">Articles TTL</label>
              <input
                value={ttlDays}
                onChange={(event) => onTtlChange(event.target.value)}
                placeholder="30-60"
                className="w-24 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
              <span className="text-sm text-slate-400">days</span>
              <button
                onClick={onSaveTtl}
                disabled={!ttlDays.trim()}
                className="rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
              >
                Save
              </button>
              <span className="text-xs text-slate-500">Feed items older than this are deleted.</span>
              {ttlError ? <p className="w-full text-xs text-red-400">{ttlError}</p> : null}
            </div>

            {/* Feed Fetch Runs TTL */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="w-40 text-sm text-slate-300">Fetch Runs TTL</label>
              <input
                value={fetchRunsTtlValue}
                onChange={(event) => onFetchRunsTtlChange(event.target.value)}
                placeholder={fetchRunsTtlUnit === "days" ? "Days" : "Hours"}
                className="w-24 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
              <select
                value={fetchRunsTtlUnit}
                onChange={(event) =>
                  onFetchRunsTtlUnitChange(event.target.value as "hours" | "days")
                }
                className="rounded-xl border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-slate-600"
              >
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
              <button
                onClick={onSaveFetchRunsTtl}
                disabled={!fetchRunsTtlValue.trim()}
                className="rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
              >
                Save
              </button>
              <span className="text-xs text-slate-500">Fetch run telemetry retention.</span>
              {fetchRunsTtlError ? (
                <p className="w-full text-xs text-red-400">{fetchRunsTtlError}</p>
              ) : null}
            </div>

            {/* LLM Telemetry TTL */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="w-40 text-sm text-slate-300">LLM Telemetry TTL</label>
              <input
                value={llmTelemetryTtlDays}
                onChange={(event) => onLlmTelemetryTtlChange(event.target.value)}
                placeholder="1-60"
                className="w-24 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
              <span className="text-sm text-slate-400">days</span>
              <button
                onClick={onSaveLlmTelemetryTtl}
                disabled={!llmTelemetryTtlDays.trim()}
                className="rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
              >
                Save
              </button>
              <span className="text-xs text-slate-500">LLM usage telemetry retention.</span>
              {llmTelemetryTtlError ? (
                <p className="w-full text-xs text-red-400">{llmTelemetryTtlError}</p>
              ) : null}
            </div>

            {/* Article Images TTL */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="w-40 text-sm text-slate-300">Article Images TTL</label>
              <input
                value={articleImagesTtlDays}
                onChange={(event) => onArticleImagesTtlChange(event.target.value)}
                placeholder="1-60"
                className="w-24 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
              <span className="text-sm text-slate-400">days</span>
              <button
                onClick={onSaveArticleImagesTtl}
                disabled={!articleImagesTtlDays.trim()}
                className="rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
              >
                Save
              </button>
              <span className="text-xs text-slate-500">Generated images retention.</span>
              {articleImagesTtlError ? (
                <p className="w-full text-xs text-red-400">{articleImagesTtlError}</p>
              ) : null}
            </div>

            {/* Post Deliveries TTL */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="w-40 text-sm text-slate-300">Post Deliveries TTL</label>
              <input
                value={postDeliveriesTtlDays}
                onChange={(event) => onPostDeliveriesTtlChange(event.target.value)}
                placeholder="1-60"
                className="w-24 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
              <span className="text-sm text-slate-400">days</span>
              <button
                onClick={onSavePostDeliveriesTtl}
                disabled={!postDeliveriesTtlDays.trim()}
                className="rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
              >
                Save
              </button>
              <span className="text-xs text-slate-500">
                Completed/failed/cancelled deliveries retention.
              </span>
              {postDeliveriesTtlError ? (
                <p className="w-full text-xs text-red-400">{postDeliveriesTtlError}</p>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
