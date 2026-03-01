import { API_BASE, authHeaders } from "./client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AlertTemplateLabels = {
  alert?: string;
  keyword?: string;
  score?: string;
  sector?: string;
  readMore?: string;
};

export type AlertTemplateConfig = {
  showAlert?: boolean;
  showTitle?: boolean;
  showUrl?: boolean;
  showSummary?: boolean;
  showScore?: boolean;
  showSector?: boolean;
  showKeyword?: boolean;
  alertEmoji?: string;
  labels?: AlertTemplateLabels;
};

export type AlertRule = {
  id: string;
  name: string;
  keywords: string[];
  min_score: number;
  telegram_chat_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  sector_id: string | null;
  template: AlertTemplateConfig | null;
  mute_until: string | null;
  language: "en" | "ka";
  total_deliveries: number;
  sent_count: number;
  last_triggered_at: string | null;
};

export type AlertDelivery = {
  id: string;
  article_id: string;
  matched_keyword: string;
  status: "sent" | "failed" | "skipped";
  sent_at: string;
  article_title: string | null;
};

export type AlertRuleDetail = Omit<
  AlertRule,
  "total_deliveries" | "sent_count" | "last_triggered_at"
> & {
  recent_deliveries: AlertDelivery[];
};

export type AlertWeeklyStats = {
  sent_this_week: number;
  total_this_week: number;
};

export type AlertSectorKeywords = {
  keywords: string[];
  rule_count: number;
};

// ─── CRUD ───────────────────────────────────────────────────────────────────

export const listAlertRules = async (): Promise<AlertRule[]> => {
  const res = await fetch(`${API_BASE}/alerts`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load alert rules");
  }
  return res.json();
};

export const getAlertRule = async (id: string): Promise<AlertRuleDetail> => {
  const res = await fetch(`${API_BASE}/alerts/${id}`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load alert rule");
  }
  return res.json();
};

export const createAlertRule = async (payload: {
  name: string;
  keywords: string[];
  min_score?: number;
  telegram_chat_id: string;
  active?: boolean;
  sector_id?: string | null;
  template?: AlertTemplateConfig | null;
  language?: "en" | "ka";
}): Promise<AlertRule> => {
  const res = await fetch(`${API_BASE}/alerts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create alert rule");
  }
  return res.json();
};

export const updateAlertRule = async (
  id: string,
  payload: {
    name?: string;
    keywords?: string[];
    min_score?: number;
    telegram_chat_id?: string;
    active?: boolean;
    sector_id?: string | null;
    template?: AlertTemplateConfig | null;
    language?: "en" | "ka";
  },
): Promise<AlertRule> => {
  const res = await fetch(`${API_BASE}/alerts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update alert rule");
  }
  return res.json();
};

export const deleteAlertRule = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/alerts/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete alert rule");
  }
};

// ─── Test / Mute / Unmute ───────────────────────────────────────────────────

export const testAlertRule = async (id: string): Promise<{ sent: boolean }> => {
  const res = await fetch(`${API_BASE}/alerts/${id}/test`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Test alert failed");
  }
  return res.json();
};

export const muteAlertRule = async (id: string, hours: number): Promise<AlertRule> => {
  const res = await fetch(`${API_BASE}/alerts/${id}/mute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ hours }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to mute alert rule");
  }
  return res.json();
};

export const unmuteAlertRule = async (id: string): Promise<AlertRule> => {
  const res = await fetch(`${API_BASE}/alerts/${id}/unmute`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to unmute alert rule");
  }
  return res.json();
};

// ─── Stats / Sector Keywords ────────────────────────────────────────────────

export const getAlertWeeklyStats = async (): Promise<AlertWeeklyStats> => {
  const res = await fetch(`${API_BASE}/alerts/stats/weekly`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load alert stats");
  }
  return res.json();
};

export const getAlertSectorKeywords = async (
  sectorId: string,
): Promise<AlertSectorKeywords> => {
  const res = await fetch(`${API_BASE}/alerts/sector-keywords/${sectorId}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load sector keywords");
  }
  return res.json();
};
