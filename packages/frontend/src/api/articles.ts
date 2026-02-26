import { API_BASE, authHeaders } from "./client";

// ─── Articles Types ─────────────────────────────────────────────────────────

export type Article = {
  id: string;
  title: string;
  url: string;
  content_snippet: string | null;
  llm_summary: string | null;
  score_reasoning: string | null;
  rejection_reason: string | null;
  importance_score: number | null;
  article_categories: string[] | null;
  pipeline_stage: string;
  published_at: string | null;
  created_at: string;
  scored_at: string | null;
  approved_at: string | null;
  source_id: string | null;
  source_name: string | null;
  source_url: string | null;
  sector_id: string | null;
  sector_name: string | null;
  // Translation fields
  title_ka: string | null;
  llm_summary_ka: string | null;
  translation_status: string | null;
  translation_error: string | null;
};

export type ArticlesResponse = {
  data: Article[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
};

export type ArticleFilters = {
  page?: number;
  limit?: number;
  sector_id?: string;
  source_id?: string;
  status?: string;
  rejection_type?: string;
  category?: string;
  min_score?: number;
  max_score?: number;
  date_from?: string;
  date_to?: string;
  search?: string;
  sort_by?: "published_at" | "importance_score" | "created_at";
  sort_dir?: "asc" | "desc";
};

export type ArticleFilterOptions = {
  sectors: { id: string; name: string }[];
  sources: { id: string; name: string | null }[];
  statuses: { status: string; count: number }[];
};

// ─── Articles API ───────────────────────────────────────────────────────────

export const getArticles = async (filters: ArticleFilters = {}): Promise<ArticlesResponse> => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  });

  const res = await fetch(`${API_BASE}/articles?${params}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load articles");
  }
  return res.json();
};

export const getArticleFilterOptions = async (): Promise<ArticleFilterOptions> => {
  const res = await fetch(`${API_BASE}/articles/filters/options`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load filter options");
  }
  return res.json();
};

export const approveArticle = async (
  id: string,
  llm_summary?: string,
): Promise<{
  id: string;
  llm_summary: string | null;
  pipeline_stage: string;
  approved_at: string;
}> => {
  const res = await fetch(`${API_BASE}/articles/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ llm_summary }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to approve article");
  }
  return res.json();
};

export const rejectArticle = async (
  id: string,
): Promise<{ id: string; pipeline_stage: string }> => {
  const res = await fetch(`${API_BASE}/articles/${id}/reject`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to reject article");
  }
  return res.json();
};

export const translateArticle = async (
  id: string,
): Promise<{ id: string; translation_status: string }> => {
  const res = await fetch(`${API_BASE}/articles/${id}/translate`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to queue translation");
  }
  return res.json();
};

export const batchApproveArticles = async (
  ids: string[],
): Promise<{ updated: number; ids: string[] }> => {
  const res = await fetch(`${API_BASE}/articles/batch/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to batch approve articles");
  }
  return res.json();
};

export const batchRejectArticles = async (
  ids: string[],
): Promise<{ updated: number; ids: string[] }> => {
  const res = await fetch(`${API_BASE}/articles/batch/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to batch reject articles");
  }
  return res.json();
};

export const updateArticle = async (
  id: string,
  updates: {
    title?: string;
    llm_summary?: string;
    title_ka?: string;
    llm_summary_ka?: string;
  },
): Promise<Article> => {
  const res = await fetch(`${API_BASE}/articles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update article");
  }
  return res.json();
};
