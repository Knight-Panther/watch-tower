import { API_BASE, authHeaders } from "./client";

// ─── Analytics (P7) ─────────────────────────────────────────────────────────

export type AnalyticsData = {
  period_days: number;
  score_distribution: Record<number, number>;
  approval_by_score: Array<{ score: number; stage: string; cnt: number }>;
  rejection_breakdown: Array<{ rejection_type: string; cnt: number }>;
  source_ranking: Array<{
    source_id: string;
    source_name: string | null;
    total_scored: number;
    avg_score: number;
    approved_pct: number;
    signal_ratio: number;
  }>;
  sector_performance: Array<{
    sector_id: string;
    sector_name: string | null;
    total: number;
    avg_score: number;
    approved_pct: number;
    signal_count: number;
  }>;
};

export const getAnalytics = async (): Promise<AnalyticsData> => {
  const res = await fetch(`${API_BASE}/stats/analytics`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load analytics");
  }
  return res.json();
};

// ─── Dedup Sensitivity ──────────────────────────────────────────────────────

export const getSimilarityThreshold = async (): Promise<{
  value: number;
  source: "database" | "default";
}> => {
  const res = await fetch(`${API_BASE}/config/similarity-threshold`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to load similarity threshold");
  const data = await res.json();
  return { value: data.value ?? 0.65, source: data.source ?? "default" };
};

export const setSimilarityThreshold = async (value: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/similarity-threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update similarity threshold");
  }
  const data = await res.json();
  return data.value ?? value;
};
