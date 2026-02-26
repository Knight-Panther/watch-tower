import { API_BASE, authHeaders } from "./client";

// ─── Telemetry Types ────────────────────────────────────────────────────────

export type TelemetryPeriodStats = {
  requests: number;
  tokens: number;
  cost_usd: number;
  cost_microdollars: number;
  avg_latency_ms: number;
};

export type TelemetrySummary = {
  today: TelemetryPeriodStats;
  last_7_days: TelemetryPeriodStats;
  last_30_days: TelemetryPeriodStats;
  all_time: TelemetryPeriodStats;
  generated_at: string;
};

export type TelemetryProviderStats = {
  provider: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cost_microdollars: number;
  avg_latency_ms: number;
  fallback_count: number;
};

export type TelemetryByProvider = {
  period_days: number;
  since: string;
  providers: TelemetryProviderStats[];
};

export type TelemetryOperationStats = {
  operation: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
  cost_microdollars: number;
  avg_latency_ms: number;
};

export type TelemetryByOperation = {
  period_days: number;
  since: string;
  operations: TelemetryOperationStats[];
};

export type TelemetryDailyStats = {
  date: string;
  requests: number;
  tokens: number;
  cost_usd: number;
  cost_microdollars: number;
};

export type TelemetryDaily = {
  period_days: number;
  since: string;
  daily: TelemetryDailyStats[];
};

// ─── Telemetry API ──────────────────────────────────────────────────────────

export const getTelemetrySummary = async (): Promise<TelemetrySummary> => {
  const res = await fetch(`${API_BASE}/telemetry/summary`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load telemetry summary");
  }
  return res.json();
};

export const getTelemetryByProvider = async (days = 30): Promise<TelemetryByProvider> => {
  const res = await fetch(`${API_BASE}/telemetry/by-provider?days=${days}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load telemetry by provider");
  }
  return res.json();
};

export const getTelemetryByOperation = async (days = 30): Promise<TelemetryByOperation> => {
  const res = await fetch(`${API_BASE}/telemetry/by-operation?days=${days}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load telemetry by operation");
  }
  return res.json();
};

export const getTelemetryDaily = async (days = 30): Promise<TelemetryDaily> => {
  const res = await fetch(`${API_BASE}/telemetry/daily?days=${days}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load daily telemetry");
  }
  return res.json();
};
