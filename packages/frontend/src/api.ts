import type { Sector, Source } from "@watch-tower/shared";

export type { Sector, Source };

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
const authHeaders: Record<string, string> = API_KEY ? { "x-api-key": API_KEY } : {};

export const listSectors = async (): Promise<Sector[]> => {
  const res = await fetch(`${API_URL}/sectors`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load sectors");
  }
  return res.json();
};

export const createSector = async (payload: {
  name: string;
  default_max_age_days?: number;
}): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create sector");
  }

  return res.json();
};

export const listSources = async (): Promise<Source[]> => {
  const res = await fetch(`${API_URL}/sources`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load sources");
  }
  return res.json();
};

export const createSource = async (payload: {
  url: string;
  name?: string;
  active?: boolean;
  sector_id?: string;
  max_age_days?: number | null;
  ingest_interval_minutes: number;
}): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create source");
  }

  return res.json();
};

export const updateSource = async (
  id: string,
  payload: {
    url?: string;
    name?: string;
    active?: boolean;
    sector_id?: string;
    max_age_days?: number | null;
    ingest_interval_minutes?: number;
  },
): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to update source");
  }

  return res.json();
};

export const runIngest = async (): Promise<{ queued: boolean; jobId?: string }> => {
  const res = await fetch(`${API_URL}/ingest/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error("Failed to trigger ingest");
  }
  return res.json();
};

export const deleteSource = async (id: string, hard = false): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources/${id}?hard=${hard}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete source");
  }
  return res.json();
};

export const batchSourceAction = async (payload: {
  ids: string[];
  action: "deactivate" | "delete";
}): Promise<Source[]> => {
  const res = await fetch(`${API_URL}/sources/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update sources");
  }
  return res.json();
};

export const getFeedItemsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-items-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 60);
};

export const setFeedItemsTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-items-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

export const getFeedFetchRunsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-fetch-runs-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load fetch runs TTL");
  }
  const data = await res.json();
  return Number(data.hours ?? 336);
};

export const setFeedFetchRunsTtl = async (hours: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-fetch-runs-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ hours }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update fetch runs TTL");
  }
  const data = await res.json();
  return Number(data.hours ?? hours);
};

// LLM Telemetry TTL
export const getLlmTelemetryTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/llm-telemetry-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load LLM telemetry TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setLlmTelemetryTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/llm-telemetry-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update LLM telemetry TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

// Article Images TTL
export const getArticleImagesTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/article-images-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load article images TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setArticleImagesTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/article-images-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update article images TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

// Post Deliveries TTL
export const getPostDeliveriesTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/post-deliveries-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load post deliveries TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setPostDeliveriesTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/post-deliveries-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update post deliveries TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

export const updateSector = async (
  id: string,
  payload: { default_max_age_days?: number },
): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update sector");
  }
  return res.json();
};

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

export const getStatsOverview = async (): Promise<StatsOverview> => {
  const res = await fetch(`${API_URL}/stats/overview`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load stats overview");
  }
  return res.json();
};

export const getStatsSources = async (): Promise<StatsSource[]> => {
  const res = await fetch(`${API_URL}/stats/sources`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load source stats");
  }
  return res.json();
};

export type Constraints = {
  feedItemsTtl: { min: number; max: number; unit: string };
  fetchRunsTtl: { min: number; max: number; unit: string };
  interval: { min: number; max: number; unit: string };
  maxAge: { min: number; max: number; unit: string };
  llmTelemetryTtl: { min: number; max: number; unit: string };
  articleImagesTtl: { min: number; max: number; unit: string };
  postDeliveriesTtl: { min: number; max: number; unit: string };
};

export const getConstraints = async (): Promise<Constraints> => {
  const res = await fetch(`${API_URL}/config/constraints`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load constraints");
  }
  return res.json();
};

export const deleteSector = async (id: string): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete sector");
  }
  return res.json();
};

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
  const res = await fetch(`${API_URL}/telemetry/summary`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load telemetry summary");
  }
  return res.json();
};

export const getTelemetryByProvider = async (days = 30): Promise<TelemetryByProvider> => {
  const res = await fetch(`${API_URL}/telemetry/by-provider?days=${days}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load telemetry by provider");
  }
  return res.json();
};

export const getTelemetryByOperation = async (days = 30): Promise<TelemetryByOperation> => {
  const res = await fetch(`${API_URL}/telemetry/by-operation?days=${days}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load telemetry by operation");
  }
  return res.json();
};

export const getTelemetryDaily = async (days = 30): Promise<TelemetryDaily> => {
  const res = await fetch(`${API_URL}/telemetry/daily?days=${days}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load daily telemetry");
  }
  return res.json();
};

// ─── Articles Types ─────────────────────────────────────────────────────────

export type Article = {
  id: string;
  title: string;
  url: string;
  content_snippet: string | null;
  llm_summary: string | null;
  importance_score: number | null;
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

  const res = await fetch(`${API_URL}/articles?${params}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load articles");
  }
  return res.json();
};

export const getArticleFilterOptions = async (): Promise<ArticleFilterOptions> => {
  const res = await fetch(`${API_URL}/articles/filters/options`, {
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
  const res = await fetch(`${API_URL}/articles/${id}/approve`, {
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
  const res = await fetch(`${API_URL}/articles/${id}/reject`, {
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
  const res = await fetch(`${API_URL}/articles/${id}/translate`, {
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
  const res = await fetch(`${API_URL}/articles/batch/approve`, {
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
  const res = await fetch(`${API_URL}/articles/batch/reject`, {
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
  const res = await fetch(`${API_URL}/articles/${id}`, {
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
  const res = await fetch(`${API_URL}/articles/${articleId}/schedule`, {
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
  const res = await fetch(`${API_URL}/articles/${articleId}/schedule${params}`, {
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

  const res = await fetch(`${API_URL}/scheduled?${params}`, {
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
  const res = await fetch(`${API_URL}/scheduled/${deliveryId}`, {
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
  const res = await fetch(`${API_URL}/scheduled/${deliveryId}`, {
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
  const res = await fetch(`${API_URL}/scheduled/stats`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scheduled stats");
  }
  return res.json();
};

// ─── Scoring Rules Types ────────────────────────────────────────────────────

export type ScoringConfig = {
  priorities: string[];
  ignore: string[];
  score1: string;
  score2: string;
  score3: string;
  score4: string;
  score5: string;
  examples: Array<{ title: string; score: number; reasoning: string }>;
  summaryMaxChars: number;
  summaryTone: "professional" | "casual" | "urgent";
  summaryLanguage: string;
  summaryStyle: string;
};

export type ScoringRule = {
  id?: string;
  sector_id: string;
  sector_name: string;
  sector_slug?: string;
  config: ScoringConfig;
  is_legacy: boolean;
  auto_approve_threshold: number;
  auto_reject_threshold: number;
  prompt_preview?: string;
  legacy_prompt?: string | null;
  updated_at: string | null;
};

// ─── Scoring Rules API ──────────────────────────────────────────────────────

export const listScoringRules = async (): Promise<ScoringRule[]> => {
  const res = await fetch(`${API_URL}/scoring-rules`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scoring rules");
  }
  return res.json();
};

export const getScoringRule = async (sectorId: string): Promise<ScoringRule> => {
  const res = await fetch(`${API_URL}/scoring-rules/${sectorId}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scoring rule");
  }
  return res.json();
};

export const saveScoringRule = async (
  sectorId: string,
  config: ScoringConfig,
  autoApprove: number,
  autoReject: number,
): Promise<{ success: boolean; prompt_preview: string }> => {
  const res = await fetch(`${API_URL}/scoring-rules/${sectorId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      config,
      auto_approve_threshold: autoApprove,
      auto_reject_threshold: autoReject,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save scoring rule");
  }
  return res.json();
};

export const deleteScoringRule = async (sectorId: string): Promise<{ success: boolean }> => {
  const res = await fetch(`${API_URL}/scoring-rules/${sectorId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete scoring rule");
  }
  return res.json();
};

export const previewScoringPrompt = async (
  config: ScoringConfig,
  sectorName: string,
): Promise<{ prompt: string }> => {
  const res = await fetch(`${API_URL}/scoring-rules/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ config, sector_name: sectorName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to preview prompt");
  }
  return res.json();
};

// ─── Auto-Post Config (Per-Platform) ─────────────────────────────────────────
// Each platform has its own auto-post toggle. When enabled, auto-approved
// articles (score >= auto_approve_threshold) are immediately posted to that platform.

// ── Telegram (Active) ──
export const getAutoPostTelegram = async (): Promise<boolean> => {
  const res = await fetch(`${API_URL}/config/auto-post-telegram`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load Telegram auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? true;
};

export const setAutoPostTelegram = async (enabled: boolean): Promise<boolean> => {
  const res = await fetch(`${API_URL}/config/auto-post-telegram`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update Telegram auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? enabled;
};

// ── Facebook (Placeholder - Coming Soon) ──
// TODO: Enable when Facebook Graph API integration is complete
// To wire up:
// 1. Implement FacebookProvider in packages/social/src/facebook.ts
// 2. Add facebook case to distribution.ts worker
// 3. Uncomment these functions and the UI toggle
export const getAutoPostFacebook = async (): Promise<boolean> => {
  const res = await fetch(`${API_URL}/config/auto-post-facebook`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load Facebook auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? false; // Default OFF for new platforms
};

export const setAutoPostFacebook = async (enabled: boolean): Promise<boolean> => {
  const res = await fetch(`${API_URL}/config/auto-post-facebook`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update Facebook auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? enabled;
};

// ── LinkedIn (Placeholder - Coming Soon) ──
// TODO: Enable when LinkedIn API integration is complete
// To wire up:
// 1. Implement LinkedInProvider in packages/social/src/linkedin.ts
// 2. Add linkedin case to distribution.ts worker
// 3. Uncomment these functions and the UI toggle
export const getAutoPostLinkedin = async (): Promise<boolean> => {
  const res = await fetch(`${API_URL}/config/auto-post-linkedin`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load LinkedIn auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? false; // Default OFF for new platforms
};

export const setAutoPostLinkedin = async (enabled: boolean): Promise<boolean> => {
  const res = await fetch(`${API_URL}/config/auto-post-linkedin`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update LinkedIn auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? enabled;
};

// ─── Score Thresholds ────────────────────────────────────────────────────────
// Controls which scores trigger auto-approve, auto-reject, or manual review.

export const getAutoApproveThreshold = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/auto-approve-threshold`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load auto-approve threshold");
  }
  const data = await res.json();
  return data.value ?? 5;
};

export const setAutoApproveThreshold = async (value: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/auto-approve-threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update auto-approve threshold");
  }
  const data = await res.json();
  return data.value ?? value;
};

export const getAutoRejectThreshold = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/auto-reject-threshold`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load auto-reject threshold");
  }
  const data = await res.json();
  return data.value ?? 2;
};

export const setAutoRejectThreshold = async (value: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/auto-reject-threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update auto-reject threshold");
  }
  const data = await res.json();
  return data.value ?? value;
};

// ─── Reset Data ──────────────────────────────────────────────────────────────

export type ResetResult = {
  success: boolean;
  cleared: {
    articles: number;
    feed_fetch_runs: number;
    llm_telemetry: number;
    post_deliveries: number;
    article_images: number;
    redis_keys: number;
  };
};

/**
 * Reset all transient data (articles, telemetry, queues).
 * Preserves configuration (sectors, sources, scoring rules, app config).
 */
export const resetAllData = async (): Promise<ResetResult> => {
  const res = await fetch(`${API_URL}/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ confirm: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to reset data");
  }
  return res.json();
};

// ─── Post Templates ──────────────────────────────────────────────────────────

export interface PostTemplateConfig {
  showBreakingLabel: boolean;
  showSectorTag: boolean;
  showTitle: boolean;
  showSummary: boolean;
  showUrl: boolean;
  showImage: boolean;
  autoCommentUrl: boolean;
  breakingEmoji: string;
  breakingText: string;
  urlLinkText: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  account_name: string;
  is_active: boolean;
  rate_limit_per_hour: number;
  post_template: PostTemplateConfig;
  is_template_custom: boolean;
  created_at: string;
  updated_at: string;
}

export const listSocialAccounts = async (): Promise<SocialAccount[]> => {
  const res = await fetch(`${API_URL}/social-accounts`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to fetch social accounts");
  }
  return res.json();
};

export const getPostTemplate = async (
  accountId: string,
): Promise<{ platform: string; template: PostTemplateConfig; is_default: boolean }> => {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/template`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to fetch template");
  }
  return res.json();
};

export const savePostTemplate = async (
  accountId: string,
  template: PostTemplateConfig,
): Promise<{ success: boolean; platform: string; template: PostTemplateConfig }> => {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/template`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ template }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save template");
  }
  return res.json();
};

export const resetPostTemplate = async (
  accountId: string,
): Promise<{ success: boolean; message: string; template: PostTemplateConfig }> => {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/template`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to reset template");
  }
  return res.json();
};

export const previewPost = async (
  platform: string,
  template: PostTemplateConfig,
  article: { title: string; summary: string; url: string; sector: string },
): Promise<{ platform: string; formatted_text: string; char_count: number }> => {
  const res = await fetch(`${API_URL}/social-accounts/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ platform, template, article }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to preview post");
  }
  return res.json();
};

// ─── Rate Limit Usage ────────────────────────────────────────────────────────

export type PlatformUsage = {
  platform: string;
  current: number;
  limit: number;
  percentage: number;
  status: "ok" | "warning" | "blocked";
};

export const getSocialAccountsUsage = async (): Promise<{ usage: PlatformUsage[] }> => {
  const res = await fetch(`${API_URL}/social-accounts/usage`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load usage stats");
  }
  return res.json();
};

export const updateSocialAccountRateLimit = async (
  accountId: string,
  rateLimitPerHour: number,
): Promise<{ success: boolean; platform: string; rate_limit_per_hour: number }> => {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/rate-limit`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ rate_limit_per_hour: rateLimitPerHour }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update rate limit");
  }
  return res.json();
};

// ─── Platform Health ──────────────────────────────────────────────────────────

export type PlatformHealth = {
  platform: string;
  healthy: boolean;
  status: "active" | "expiring" | "expired" | "error";
  error: string | null;
  expiresAt: string | null;
  daysRemaining?: number;
  lastCheck: string;
  lastPost: string | null;
  rateLimit: {
    remaining: number | null;
    limit: number | null;
    percent: number | null;
    resetsAt: string | null;
  };
};

export const getPlatformHealth = async (): Promise<PlatformHealth[]> => {
  const res = await fetch(`${API_URL}/health/platforms`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch platform health");
  const data = await res.json();
  return data.platforms;
};

export const refreshPlatformHealth = async (): Promise<void> => {
  const res = await fetch(`${API_URL}/health/platforms/refresh`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to trigger health check");
};

// ─── Provider Credits/Balances ───────────────────────────────────────────────

export type ProviderBalance = {
  provider: string;
  display_name: string;
  available: boolean;
  currency: string;
  total_balance: number | null;
  granted_balance: number | null;
  topped_up_balance: number | null;
  error: string | null;
};

export type ProviderBalancesResponse = {
  providers: ProviderBalance[];
  generated_at: string;
};

export const getProviderBalances = async (): Promise<ProviderBalancesResponse> => {
  const res = await fetch(`${API_URL}/credits`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load provider balances");
  }
  return res.json();
};

export const refreshProviderBalances = async (): Promise<ProviderBalancesResponse> => {
  const res = await fetch(`${API_URL}/credits/refresh`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to refresh provider balances");
  }
  return res.json();
};

// ─── Site Rules (Security) ───────────────────────────────────────────────────

export type AllowedDomain = {
  id: string;
  domain: string;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
};

export type SecurityConfig = {
  maxFeedSizeMb: number;
  maxArticlesPerFetch: number;
  maxArticlesPerSourceDaily: number;
  allowedOrigins: string[];
  apiRateLimitPerMinute: number;
};

// Domain Whitelist
export const getAllowedDomains = async (): Promise<AllowedDomain[]> => {
  const res = await fetch(`${API_URL}/site-rules/domains`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch allowed domains");
  return res.json();
};

export const addAllowedDomain = async (
  domain: string,
  notes?: string,
): Promise<AllowedDomain> => {
  const res = await fetch(`${API_URL}/site-rules/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ domain, notes }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to add domain");
  }
  return res.json();
};

export const updateAllowedDomain = async (
  id: string,
  updates: { isActive?: boolean; notes?: string },
): Promise<AllowedDomain> => {
  const res = await fetch(`${API_URL}/site-rules/domains/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update domain");
  }
  return res.json();
};

export const deleteAllowedDomain = async (id: string): Promise<void> => {
  const res = await fetch(`${API_URL}/site-rules/domains/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete domain");
  }
};

// Security Config (read-only from env)
export const getSecurityConfig = async (): Promise<SecurityConfig> => {
  const res = await fetch(`${API_URL}/site-rules/config`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch security config");
  return res.json();
};

// Kill Switch (Emergency Stop)
export const getEmergencyStop = async (): Promise<{ enabled: boolean }> => {
  const res = await fetch(`${API_URL}/config/emergency-stop`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch emergency stop status");
  return res.json();
};

export const setEmergencyStop = async (enabled: boolean): Promise<{ enabled: boolean }> => {
  const res = await fetch(`${API_URL}/config/emergency-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to set emergency stop");
  }
  return res.json();
};

// ─── Translation Config ─────────────────────────────────────────────────────

export type TranslationConfig = {
  posting_language: "en" | "ka";
  scores: number[];
  provider: "gemini" | "openai";
  model: string;
  instructions: string;
};

export const getTranslationConfig = async (): Promise<TranslationConfig> => {
  const res = await fetch(`${API_URL}/config/translation`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get translation config");
  return res.json();
};

export const updateTranslationConfig = async (
  config: Partial<TranslationConfig>,
): Promise<void> => {
  const res = await fetch(`${API_URL}/config/translation`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to update translation config");
};

// ─── Provider Health Check ────────────────────────────────────────────────

export type ProviderHealthResult = {
  provider: string;
  role: string;
  displayName: string;
  model: string;
  healthy: boolean;
  latencyMs: number;
  error: string | null;
};

export type ProviderHealthResponse = {
  results: ProviderHealthResult[];
  checked_at: string;
};

export const checkProviderHealth = async (): Promise<ProviderHealthResponse> => {
  const res = await fetch(`${API_URL}/health/providers`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to check provider health");
  }
  return res.json();
};

// ─── Image Generation Config ─────────────────────────────────────────────

export type ImageGenerationConfig = {
  enabled: boolean;
  minScore: number;
  quality: string;
  size: string;
  prompt: string;
};

export type ImageTemplateConfig2 = {
  titlePosition: { x: number; y: number };
  titleAlignment: "left" | "center" | "right";
  titleMaxWidth: number;
  titleFontSize: number;
  titleFontFamily: string;
  titleColor: string;
  backdropEnabled: boolean;
  backdropColor: string;
  backdropPadding: number;
  backdropBorderRadius: number;
  watermarkPosition: { x: number; y: number };
  watermarkScale: number;
};

export const getImageGenerationConfig = async (): Promise<ImageGenerationConfig> => {
  const res = await fetch(`${API_URL}/config/image-generation`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get image generation config");
  return res.json();
};

export const updateImageGenerationConfig = async (
  config: Partial<ImageGenerationConfig>,
): Promise<void> => {
  const res = await fetch(`${API_URL}/config/image-generation`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to update image generation config");
};

export const getImageTemplate = async (): Promise<ImageTemplateConfig2> => {
  const res = await fetch(`${API_URL}/config/image-template`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get image template");
  return res.json();
};

export const updateImageTemplate = async (template: ImageTemplateConfig2): Promise<void> => {
  const res = await fetch(`${API_URL}/config/image-template`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
  if (!res.ok) throw new Error("Failed to update image template");
};
