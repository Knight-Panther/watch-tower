import { useMemo } from "react";
import type {
  TelemetrySummary,
  TelemetryByProvider,
  TelemetryByOperation,
  TelemetryDaily,
} from "../api";
import Spinner from "../components/Spinner";

type TelemetryProps = {
  summary: TelemetrySummary | null;
  byProvider: TelemetryByProvider | null;
  byOperation: TelemetryByOperation | null;
  daily: TelemetryDaily | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
  onRefresh: () => void;
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

export default function Telemetry({
  summary,
  byProvider,
  byOperation,
  daily,
  isLoading,
  error,
  lastUpdated,
  onRefresh,
}: TelemetryProps) {
  const totalCostToday = summary?.today.cost_usd ?? 0;
  const totalCost30d = summary?.last_30_days.cost_usd ?? 0;

  // Calculate daily average for sparkline display
  const dailyMax = useMemo(() => {
    if (!daily?.daily.length) return 1;
    return Math.max(...daily.daily.map((d) => d.cost_usd), 0.001);
  }, [daily]);

  return (
    <div className="grid gap-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">LLM Telemetry</h1>
            <p className="mt-1 text-sm text-slate-400">
              Token usage, costs, and latency metrics for LLM and embedding operations.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {lastUpdated ? `Updated ${lastUpdated}` : "Not updated yet"}
            </span>
            <button
              onClick={onRefresh}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Refresh
            </button>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      </section>

      {/* Summary Cards */}
      <section className="grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Today</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-300">
            {formatCost(totalCostToday)}
          </p>
          <p className="mt-1 text-xs text-slate-400">{summary?.today.requests ?? 0} requests</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Last 7 Days</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {formatCost(summary?.last_7_days.cost_usd ?? 0)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {formatTokens(summary?.last_7_days.tokens ?? 0)} tokens
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Last 30 Days</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">{formatCost(totalCost30d)}</p>
          <p className="mt-1 text-xs text-slate-400">
            {formatTokens(summary?.last_30_days.tokens ?? 0)} tokens
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">All Time</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {formatCost(summary?.all_time.cost_usd ?? 0)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {summary?.all_time.requests ?? 0} total requests
          </p>
        </div>
      </section>

      {/* Daily Cost Chart (simple bar representation) */}
      {daily && daily.daily.length > 0 ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold">Daily Costs (Last 30 Days)</h2>
          <div className="mt-4 flex items-end gap-1" style={{ height: 80 }}>
            {daily.daily.map((day, idx) => {
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
            <span>{daily.daily[0]?.date}</span>
            <span>{daily.daily[daily.daily.length - 1]?.date}</span>
          </div>
        </section>
      ) : null}

      {/* By Provider */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold">By Provider (Last 30 Days)</h2>
        <div className="mt-4 grid gap-3">
          {byProvider?.providers.map((provider) => (
            <div
              key={`${provider.provider}-${provider.model}`}
              className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-[1.5fr,2fr]"
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
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Tokens</span>
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
          {!byProvider?.providers.length && !isLoading ? (
            <p className="text-sm text-slate-400">No provider data yet.</p>
          ) : null}
        </div>
      </section>

      {/* By Operation */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold">By Operation (Last 30 Days)</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {byOperation?.operations.map((op) => (
            <div
              key={op.operation}
              className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"
            >
              <p className="text-sm font-semibold text-slate-100">{op.operation}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Requests
                  </span>
                  <p className="mt-1 text-slate-200">{op.requests}</p>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Tokens</span>
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
          {!byOperation?.operations.length && !isLoading ? (
            <p className="text-sm text-slate-400">No operation data yet.</p>
          ) : null}
        </div>
      </section>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Spinner /> Loading telemetry data...
        </div>
      ) : null}
    </div>
  );
}
