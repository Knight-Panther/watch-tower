import { API_BASE, authHeaders } from "./client";

export type StatsOverview = {
  total_sources: number;
  active_sources: number;
  items_last_24h: number;
  stale_sources: number;
  queues: {
    feed: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
    };
  };
};

export type StatsSource = {
  id: string;
  name: string | null;
  url: string;
  active: boolean;
  sector: { id: string; name: string; slug: string } | null;
  expected_interval_minutes: number | null;
  last_success_at: string | null;
  last_run: {
    status: "success" | "error";
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    item_count: number | null;
    item_added: number | null;
    error_message: string | null;
  } | null;
  is_stale: boolean;
};

export type SourceQuality = {
  distribution: Record<number, number>;
  total: number;
  avg_score: number;
  signal_ratio: number;
};

export type Constraints = {
  feedItemsTtl: { min: number; max: number; unit: string };
  fetchRunsTtl: { min: number; max: number; unit: string };
  interval: { min: number; max: number; unit: string };
  maxAge: { min: number; max: number; unit: string };
  llmTelemetryTtl: { min: number; max: number; unit: string };
  articleImagesTtl: { min: number; max: number; unit: string };
  postDeliveriesTtl: { min: number; max: number; unit: string };
  digestRunsTtl: { min: number; max: number; unit: string };
  alertDeliveriesTtl: { min: number; max: number; unit: string };
  alertWarningThreshold: { min: number; max: number; unit: string };
};

export const getStatsOverview = async (): Promise<StatsOverview> => {
  const res = await fetch(`${API_BASE}/stats/overview`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load stats overview");
  }
  return res.json();
};

export const getStatsSources = async (): Promise<StatsSource[]> => {
  const res = await fetch(`${API_BASE}/stats/sources`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load source stats");
  }
  return res.json();
};

export const getSourceQuality = async (): Promise<Record<string, SourceQuality>> => {
  const res = await fetch(`${API_BASE}/stats/source-quality`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load source quality");
  }
  return res.json();
};

export const getConstraints = async (): Promise<Constraints> => {
  const res = await fetch(`${API_BASE}/config/constraints`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load constraints");
  }
  return res.json();
};
