import { API_BASE, authHeaders } from "./client";

// ─── Alert Rules ─────────────────────────────────────────────────────────────

export type AlertRule = {
  id: string;
  name: string;
  keywords: string[];
  min_score: number;
  telegram_chat_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
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

export type AlertRuleDetail = Omit<AlertRule, "total_deliveries" | "sent_count" | "last_triggered_at"> & {
  recent_deliveries: AlertDelivery[];
};

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
