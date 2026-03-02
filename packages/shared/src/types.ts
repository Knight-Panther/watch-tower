/**
 * Core entity types shared between API and frontend
 * Note: API responses use snake_case for REST convention
 */

export type Sector = {
  id: string;
  name: string;
  slug: string;
  default_max_age_days: number;
  created_at: string;
};

export type Source = {
  id: string;
  url: string;
  name: string | null;
  active: boolean;
  sector_id: string | null;
  max_age_days: number | null;
  ingest_interval_minutes: number;
  created_at: string;
  last_fetched_at: string | null;
  sectors: {
    id: string;
    name: string;
    slug: string;
    default_max_age_days: number;
  } | null;
};

// ─── SmartHub Advisor Types ──────────────────────────────────────────────────

export type AdvisorCategory =
  | "source"
  | "keyword"
  | "threshold"
  | "prompt"
  | "interval"
  | "dedup"
  | "cost"
  | "alert";

export type AdvisorPriority = "high" | "medium" | "low";

export type AdvisorActionType =
  | "disable_source"
  | "change_interval"
  | "add_reject_keyword"
  | "remove_reject_keyword"
  | "add_priority"
  | "remove_priority"
  | "remove_ignore"
  | "change_sector_threshold"
  | "change_global_threshold"
  | "change_similarity_threshold"
  | "info_only";

export interface AdvisorAction {
  type: AdvisorActionType;
  endpoint: string;
  params: Record<string, unknown>;
}

export interface AdvisorRecommendation {
  id: string;
  category: AdvisorCategory;
  priority: AdvisorPriority;
  title: string;
  reason: string;
  action: AdvisorAction | null;
  applied_at: string | null;
}

// ─── Advisor Stats Sub-types ─────────────────────────────────────────────────

export interface SourceStats {
  source_id: string;
  source_name: string;
  source_url: string;
  sector_id: string | null;
  sector_name: string | null;
  active: boolean;
  ingest_interval_minutes: number;
  total_articles: number;
  total_scored: number;
  signal_ratio: number;
  avg_score: number;
  score_distribution: Record<string, number>;
  rejection_rate: number;
  dedup_rate: number;
  signal_ratio_current: number;
  signal_ratio_previous: number;
}

export interface SectorStats {
  sector_id: string;
  sector_name: string;
  total_articles: number;
  total_scored: number;
  avg_score: number;
  signal_ratio: number;
  cost_microdollars: number;
  cost_per_useful_article: number;
}

export interface RejectionStats {
  total_rejected: number;
  pre_filter_count: number;
  llm_reject_count: number;
  manual_reject_count: number;
  keyword_hits: { keyword: string; field: string; count: number }[];
}

export interface ScoreTrend {
  current_week: Record<string, number>;
  previous_week: Record<string, number>;
  high_score_change_pct: number;
}

export interface KeywordStats {
  sector_id: string;
  sector_name: string;
  keyword: string;
  type: "priority" | "ignore" | "reject";
  match_count: number;
}

export interface CategoryCorrelation {
  category: string;
  sector_id: string | null;
  sector_name: string | null;
  total: number;
  avg_score: number;
  high_score_pct: number;
  low_score_pct: number;
}

export interface DedupStats {
  total_duplicates: number;
  chains: { follower_source: string; original_source: string; count: number; avg_similarity: number }[];
}

export interface CostStats {
  total_cost_microdollars: number;
  cost_by_operation: Record<string, number>;
  cost_by_sector: { sector_id: string; sector_name: string; cost: number; useful_articles: number }[];
}

export interface OperatorOverrideStats {
  total_overrides: number;
  by_sector: { sector_id: string; sector_name: string; count: number }[];
  by_source: { source_id: string; source_name: string; count: number }[];
}

export interface FetchEfficiencyStats {
  source_id: string;
  source_name: string;
  total_fetches: number;
  success_rate: number;
  empty_fetch_rate: number;
  avg_duration_ms: number;
}

export interface PlatformDeliveryStats {
  by_platform: { platform: string; success: number; failed: number; total: number }[];
}

export interface AlertEffectivenessStats {
  rule_id: string;
  rule_name: string;
  keywords: string[];
  fires: number;
  unique_keywords_matched: number;
}

export interface AdvisorStatsSnapshot {
  generated_at: string;
  window_days: number;
  total_articles: number;
  total_scored: number;
  total_rejected: number;
  total_duplicates: number;
  sources: SourceStats[];
  sectors: SectorStats[];
  rejection_breakdown: RejectionStats;
  score_distribution: Record<string, number>;
  score_trend: ScoreTrend;
  keyword_effectiveness: KeywordStats[];
  category_correlations: CategoryCorrelation[];
  dedup_patterns: DedupStats;
  cost_summary: CostStats;
  operator_overrides: OperatorOverrideStats;
  fetch_efficiency: FetchEfficiencyStats[];
  platform_delivery: PlatformDeliveryStats;
  alert_effectiveness: AlertEffectivenessStats[];
}
