import { API_BASE, authHeaders } from "./client";

// ─── Scheduled Deliveries Types ──────────────────────────────────────────────

export type ScheduledDelivery = {
  id: string;
  article_id: string;
  platform: string;
  scheduled_at: string | null;
  status: string;
  platform_post_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  article_title: string;
  article_url: string;
  article_summary: string | null;
  article_score: number | null;
  article_title_ka: string | null;
  article_summary_ka: string | null;
  source_name: string | null;
  sector_id: string | null;
  sector_name: string | null;
};

export type ScheduledFilters = {
  page?: number;
  limit?: number;
  status?: string;
  platform?: string;
  sector_id?: string;
  from?: string;
  to?: string;
  sort_by?: "scheduled_at" | "created_at";
  sort_dir?: "asc" | "desc";
};

export type ScheduledResponse = {
  data: ScheduledDelivery[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
};

export type ScheduledStats = {
  by_status: Record<string, number>;
  due_in_next_hour: number;
};

// ─── Scheduled Deliveries API ────────────────────────────────────────────────

export const scheduleArticle = async (
  articleId: string,
  payload: {
    platforms: string[];
    scheduled_at?: string;
    title?: string;
    title_ka?: string;
    llm_summary?: string;
    llm_summary_ka?: string;
  },
): Promise<{
  deliveries: Array<{
    delivery_id: string;
    platform: string;
    scheduled_at: string;
    status: string;
  }>;
  article_id: string;
  platforms: string[];
}> => {
  const res = await fetch(`${API_BASE}/articles/${articleId}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to schedule article");
  }
  return res.json();
};

export const cancelArticleSchedule = async (
  articleId: string,
  platform?: string,
): Promise<{ cancelled: number; deliveries: { id: string; platform: string }[] }> => {
  const params = platform ? `?platform=${platform}` : "";
  const res = await fetch(`${API_BASE}/articles/${articleId}/schedule${params}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to cancel schedule");
  }
  return res.json();
};

export const getScheduledDeliveries = async (
  filters: ScheduledFilters = {},
): Promise<ScheduledResponse> => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  });

  const res = await fetch(`${API_BASE}/scheduled?${params}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scheduled deliveries");
  }
  return res.json();
};

export const rescheduleDelivery = async (
  deliveryId: string,
  scheduledAt: string,
): Promise<{ id: string; scheduled_at: string; status: string }> => {
  const res = await fetch(`${API_BASE}/scheduled/${deliveryId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ scheduled_at: scheduledAt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to reschedule delivery");
  }
  return res.json();
};

export const cancelDelivery = async (
  deliveryId: string,
): Promise<{ id: string; status: string }> => {
  const res = await fetch(`${API_BASE}/scheduled/${deliveryId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to cancel delivery");
  }
  return res.json();
};

export const getScheduledStats = async (): Promise<ScheduledStats> => {
  const res = await fetch(`${API_BASE}/scheduled/stats`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scheduled stats");
  }
  return res.json();
};
