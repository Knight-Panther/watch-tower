import { API_BASE, authHeaders } from "./client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AdvisorAction = {
  type: string;
  endpoint: string;
  params: Record<string, unknown>;
};

export type AdvisorRecommendation = {
  id: string;
  category: string;
  priority: "high" | "medium" | "low";
  title: string;
  reason: string;
  action: AdvisorAction | null;
  applied_at: string | null;
};

export type AdvisorReport = {
  id: string;
  status: string;
  statsSnapshot: unknown;
  recommendations: AdvisorRecommendation[] | null;
  summary: string | null;
  recommendationCount: number;
  appliedCount: number;
  llmProvider: string | null;
  llmModel: string | null;
  llmTokensIn: number | null;
  llmTokensOut: number | null;
  llmCostMicrodollars: number | null;
  llmLatencyMs: number | null;
  errorMessage: string | null;
  triggeredBy: string;
  createdAt: string;
};

export type AdvisorReportSummary = {
  id: string;
  status: string;
  summary: string | null;
  recommendationCount: number;
  appliedCount: number;
  llmProvider: string | null;
  llmModel: string | null;
  llmCostMicrodollars: number | null;
  triggeredBy: string;
  errorMessage: string | null;
  createdAt: string;
};

export type AdvisorConfig = {
  enabled: boolean;
  time: string;
  timezone: string;
  provider: string;
  model: string;
  window_days: number;
};

export type AdvisorDataRange = {
  oldest_scored_at: string | null;
  newest_scored_at: string | null;
  available_days: number;
  total_scored: number;
  articles_in_window: number;
  window_days: number;
  feed_items_ttl_days: number;
};

// ─── API Functions ──────────────────────────────────────────────────────────

export const getLatestAdvisorReport = async (): Promise<AdvisorReport | null> => {
  const res = await fetch(`${API_BASE}/advisor/latest`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load advisor report");
  return res.json();
};

export const getAdvisorHistory = async (limit = 10): Promise<AdvisorReportSummary[]> => {
  const res = await fetch(`${API_BASE}/advisor/history?limit=${limit}`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to load advisor history");
  return res.json();
};

export const clearAdvisorHistory = async (): Promise<{ cleared: number }> => {
  const res = await fetch(`${API_BASE}/advisor/history`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to clear advisor history");
  return res.json();
};

export const getAdvisorReport = async (id: string): Promise<AdvisorReport> => {
  const res = await fetch(`${API_BASE}/advisor/reports/${id}`, { headers: authHeaders });
  if (!res.ok) throw new Error("Failed to load advisor report");
  return res.json();
};

export const triggerAdvisorRun = async (): Promise<{ queued: boolean }> => {
  const res = await fetch(`${API_BASE}/advisor/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: "{}",
  });
  if (!res.ok) throw new Error("Failed to trigger advisor run");
  return res.json();
};

export const markRecommendationApplied = async (
  reportId: string,
  recId: string,
): Promise<{ success: boolean; applied_at: string }> => {
  const res = await fetch(
    `${API_BASE}/advisor/reports/${reportId}/recommendations/${recId}/apply`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders },
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to mark recommendation applied");
  }
  return res.json();
};

export const getAdvisorConfig = async (): Promise<AdvisorConfig> => {
  const res = await fetch(`${API_BASE}/advisor/config`, { headers: authHeaders });
  if (!res.ok) throw new Error("Failed to load advisor config");
  return res.json();
};

export const updateAdvisorConfig = async (
  config: Partial<AdvisorConfig>,
): Promise<{ success: boolean }> => {
  const res = await fetch(`${API_BASE}/advisor/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update advisor config");
  }
  return res.json();
};

export const getAdvisorDataRange = async (): Promise<AdvisorDataRange> => {
  const res = await fetch(`${API_BASE}/advisor/data-range`, { headers: authHeaders });
  if (!res.ok) throw new Error("Failed to load data range");
  return res.json();
};
