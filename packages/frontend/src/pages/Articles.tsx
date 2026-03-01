import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import ScheduleModal from "../components/ScheduleModal";
import ConfirmModal from "../components/ConfirmModal";
import { SkeletonTable } from "../components/ui/Skeleton";
import Button from "../components/ui/Button";
import EmptyState from "../components/ui/EmptyState";
import { useLocalStorageFilters } from "../hooks/useLocalStorageFilters";
import { useServerEventsContext } from "../contexts/ServerEventsContext";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import {
  getArticles,
  getArticleFilterOptions,
  getTranslationConfig,
  updateArticle,
  rejectArticle,
  translateArticle,
  scheduleArticle,
  batchApproveArticles,
  batchRejectArticles,
  batchTranslateArticles,
  type Article,
  type ArticleFilters,
  type ArticleFilterOptions,
  type ArticlesResponse,
} from "../api";

/** Only allow http/https URLs as link targets (block javascript:, data:, etc.) */
const safeHref = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};

const PIPELINE_STAGES = [
  { value: "ingested", label: "Ingested" },
  { value: "embedded", label: "Embedded" },
  { value: "scored", label: "Scored" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "posted", label: "Posted" },
  { value: "posting_failed", label: "Posting Failed" },
  { value: "duplicate", label: "Duplicate" },
];

const SCORE_OPTIONS = [1, 2, 3, 4, 5];

const DEFAULT_FILTERS: ArticleFilters = {
  page: 1,
  limit: 50,
  sort_by: "published_at",
  sort_dir: "desc",
};

export default function Articles() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, total_pages: 0 });
  const [filterOptions, setFilterOptions] = useState<ArticleFilterOptions | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Batch selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingBatchAction, setPendingBatchAction] = useState<
    "approve" | "reject" | "translate" | null
  >(null);

  // Single-article confirmation
  const [pendingAction, setPendingAction] = useState<{
    type: "reject" | "translate";
    article: Article;
  } | null>(null);

  // Filter state with localStorage persistence (no URL sync to avoid tab conflicts)
  const [filters, setFilter, setFilters] = useLocalStorageFilters<ArticleFilters>(
    "articles-filters",
    DEFAULT_FILTERS,
  );

  // Language from translation config
  const [postingLanguage, setPostingLanguage] = useState<"en" | "ka">("en");

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Per-row action loading (reject, translate)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // Schedule modal state
  const [schedulingArticle, setSchedulingArticle] = useState<Article | null>(null);

  const loadArticles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response: ArticlesResponse = await getArticles(filters);
      setArticles(response.data);
      setPagination(response.pagination);
      setSelectedIds(new Set()); // Clear selection on data change
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load articles";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  const loadFilterOptions = useCallback(async () => {
    try {
      const options = await getArticleFilterOptions();
      setFilterOptions(options);
    } catch (err) {
      console.error("Failed to load filter options", err);
    }
  }, []);

  useEffect(() => {
    loadArticles();
  }, [loadArticles]);

  useEffect(() => {
    loadFilterOptions();
  }, [loadFilterOptions]);

  // SSE: auto-refresh when articles change pipeline stage
  const { subscribe } = useServerEventsContext();
  const debouncedRefresh = useDebouncedCallback(() => {
    loadArticles();
  }, 2000);

  useEffect(() => {
    const unsubscribe = subscribe(
      [
        "article:scored",
        "article:approved",
        "article:rejected",
        "article:posted",
        "article:translated",
        "source:fetched",
      ],
      debouncedRefresh,
    );
    return unsubscribe;
  }, [subscribe, debouncedRefresh]);

  // Fetch posting language from translation config
  useEffect(() => {
    getTranslationConfig()
      .then((config) => setPostingLanguage(config.posting_language))
      .catch(() => {});
  }, []);

  const startEditing = (article: Article) => {
    setEditingId(article.id);
    if (postingLanguage === "ka") {
      setEditTitle(article.title_ka || article.title || "");
      setEditSummary(article.llm_summary_ka || article.llm_summary || "");
    } else {
      setEditTitle(article.title);
      setEditSummary(article.llm_summary || "");
    }
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditTitle("");
    setEditSummary("");
  };

  const saveEditing = async (articleId: string) => {
    setIsSaving(true);
    try {
      const updates =
        postingLanguage === "ka"
          ? { title_ka: editTitle, llm_summary_ka: editSummary }
          : { title: editTitle, llm_summary: editSummary };
      await updateArticle(articleId, updates);
      toast.success("Article updated");
      setEditingId(null);
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSort = (column: "published_at" | "importance_score" | "created_at") => {
    const newDir = filters.sort_by === column && filters.sort_dir === "desc" ? "asc" : "desc";
    setFilters({ sort_by: column, sort_dir: newDir, page: 1 });
  };

  const handleFilterChange = (key: keyof ArticleFilters, value: string | number | undefined) => {
    setFilter(key, value);
  };

  const handlePageChange = (newPage: number) => {
    setFilter("page", newPage);
  };

  const openScheduleModal = (article: Article) => {
    setSchedulingArticle(article);
  };

  const handleSchedule = async (data: {
    platforms: string[];
    scheduledAt: Date;
    title?: string;
    summary?: string;
  }) => {
    if (!schedulingArticle) return;
    try {
      const isKa =
        postingLanguage === "ka" && schedulingArticle.translation_status === "translated";
      await scheduleArticle(schedulingArticle.id, {
        platforms: data.platforms,
        scheduled_at: data.scheduledAt.toISOString(),
        ...(isKa
          ? { title_ka: data.title, llm_summary_ka: data.summary }
          : { title: data.title, llm_summary: data.summary }),
      });
      const platformList = data.platforms.join(", ");
      toast.success(`Article scheduled for ${platformList}`);
      setSchedulingArticle(null);
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to schedule";
      toast.error(message);
    }
  };

  const executeReject = async (article: Article) => {
    setBusyIds((prev) => new Set(prev).add(article.id));
    try {
      await rejectArticle(article.id);
      toast.success("Article rejected");
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reject";
      toast.error(message);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(article.id);
        return next;
      });
    }
  };

  const executeTranslate = async (article: Article) => {
    setBusyIds((prev) => new Set(prev).add(article.id));
    try {
      await translateArticle(article.id);
      toast.success("Translation queued");
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to queue translation";
      toast.error(message);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(article.id);
        return next;
      });
    }
  };

  const confirmPendingAction = async () => {
    if (!pendingAction) return;
    const { type, article } = pendingAction;
    setPendingAction(null);
    if (type === "reject") await executeReject(article);
    else await executeTranslate(article);
  };

  // Batch actions
  const confirmBatchAction = async () => {
    if (!pendingBatchAction || selectedIds.size === 0) return;
    try {
      if (pendingBatchAction === "reject") {
        await batchRejectArticles([...selectedIds]);
        toast.success(`${selectedIds.size} article(s) rejected`);
      } else if (pendingBatchAction === "translate") {
        const result = await batchTranslateArticles([...selectedIds]);
        toast.success(
          `${result.queued} article(s) queued for translation${result.skipped ? ` (${result.skipped} skipped)` : ""}`,
        );
      } else {
        await batchApproveArticles([...selectedIds]);
        toast.success(`${selectedIds.size} article(s) approved`);
      }
      loadArticles();
    } catch (err) {
      const action = pendingBatchAction;
      const message = err instanceof Error ? err.message : `Failed to batch ${action}`;
      toast.error(message);
    } finally {
      setPendingBatchAction(null);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === articles.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(articles.map((a) => a.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setFilters({
      ...DEFAULT_FILTERS,
      sector_id: undefined,
      source_id: undefined,
      status: undefined,
      rejection_type: undefined,
      category: undefined,
      search: undefined,
      min_score: undefined,
      max_score: undefined,
      date_from: undefined,
      date_to: undefined,
    });
  };

  const hasActiveFilters =
    !!filters.sector_id ||
    !!filters.source_id ||
    !!filters.status ||
    !!filters.rejection_type ||
    !!filters.category ||
    !!filters.search ||
    filters.min_score !== undefined ||
    filters.max_score !== undefined ||
    !!filters.date_from ||
    !!filters.date_to;

  const applyNeedsReview = () => {
    setFilters({
      ...DEFAULT_FILTERS,
      sector_id: undefined,
      source_id: undefined,
      search: undefined,
      max_score: undefined,
      date_from: undefined,
      date_to: undefined,
      status: "scored",
      min_score: 3,
      sort_by: "importance_score",
      sort_dir: "desc",
    });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    const d = new Date(dateStr);
    const month = d.toLocaleDateString("en-US", { month: "short" });
    const day = d.getDate();
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${month} ${day}, ${h}:${m}`;
  };

  const getStageBadgeClass = (stage: string) => {
    switch (stage) {
      case "approved":
        return "bg-emerald-500/20 text-emerald-200";
      case "rejected":
        return "bg-red-500/20 text-red-200";
      case "posted":
        return "bg-purple-500/20 text-purple-200";
      case "scored":
        return "bg-blue-500/20 text-blue-200";
      case "posting_failed":
        return "bg-orange-500/20 text-orange-200";
      case "duplicate":
        return "bg-slate-500/20 text-slate-400";
      default:
        return "bg-slate-700/40 text-slate-300";
    }
  };

  const getScoreBadgeClass = (score: number | null) => {
    if (score === null) return "bg-slate-700/40 text-slate-400";
    if (score === 5) return "bg-emerald-500 text-white";
    if (score === 4) return "bg-emerald-400/80 text-emerald-950";
    if (score === 3) return "bg-amber-400/80 text-amber-950";
    if (score === 2) return "bg-orange-400/80 text-orange-950";
    return "bg-red-400/80 text-red-950";
  };

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Articles</h1>
          <p className="mt-2 text-sm text-slate-400">{pagination.total} total articles</p>
        </div>
        <Button variant="secondary" onClick={loadArticles} loading={isLoading}>
          Refresh
        </Button>
      </section>

      {/* Quick Filters */}
      <section className="flex flex-wrap gap-2">
        <button
          onClick={applyNeedsReview}
          className={`rounded-full px-4 py-2 text-sm font-medium transition ${
            filters.status === "scored" && filters.min_score === 3
              ? "bg-amber-500/20 text-amber-200 border border-amber-500/30"
              : "border border-slate-700 text-slate-300 hover:border-slate-500"
          }`}
        >
          Needs Review
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-400 transition hover:border-red-500/30 hover:text-red-300"
          >
            Clear Filters
          </button>
        )}
      </section>

      {/* Filters */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold mb-4">Filters</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Sector filter */}
          <select
            value={filters.sector_id || ""}
            onChange={(e) => handleFilterChange("sector_id", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">All Sectors</option>
            {filterOptions?.sectors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          {/* Source filter */}
          <select
            value={filters.source_id || ""}
            onChange={(e) => handleFilterChange("source_id", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">All Sources</option>
            {filterOptions?.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || "Unnamed"}
              </option>
            ))}
          </select>

          {/* Status filter */}
          <select
            value={filters.status || ""}
            onChange={(e) => {
              const val = e.target.value;
              handleFilterChange("status", val);
              if (val !== "rejected") {
                handleFilterChange("rejection_type", undefined);
              }
            }}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">All Statuses</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          {/* Rejection type sub-filter (shown when status = rejected) */}
          {filters.status === "rejected" && (
            <select
              value={filters.rejection_type || ""}
              onChange={(e) => handleFilterChange("rejection_type", e.target.value)}
              className="rounded-xl border border-orange-800/50 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-orange-600"
              title="Filter by rejection source"
            >
              <option value="">All Rejected</option>
              <option value="pre-filter">Pre-filtered (keyword match)</option>
              <option value="llm-score">LLM Rejected (low score)</option>
              <option value="manual">Manual Rejection</option>
            </select>
          )}

          {/* Search */}
          <input
            value={filters.search || ""}
            onChange={(e) => handleFilterChange("search", e.target.value)}
            placeholder="Search title or summary..."
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />

          {/* Min Score */}
          <select
            value={filters.min_score || ""}
            onChange={(e) =>
              handleFilterChange("min_score", e.target.value ? Number(e.target.value) : undefined)
            }
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">Min Score</option>
            {SCORE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          {/* Max Score */}
          <select
            value={filters.max_score || ""}
            onChange={(e) =>
              handleFilterChange("max_score", e.target.value ? Number(e.target.value) : undefined)
            }
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">Max Score</option>
            {SCORE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          {/* Date From */}
          <input
            type="date"
            value={filters.date_from || ""}
            onChange={(e) => handleFilterChange("date_from", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600 [color-scheme:dark]"
            placeholder="From date"
          />

          {/* Date To */}
          <input
            type="date"
            value={filters.date_to || ""}
            onChange={(e) => handleFilterChange("date_to", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600 [color-scheme:dark]"
            placeholder="To date"
          />
          {/* Active category filter indicator */}
          {filters.category && (
            <div className="col-span-full flex items-center gap-2 rounded-xl border border-cyan-800/50 bg-cyan-950/20 px-4 py-2">
              <span className="text-xs text-cyan-300">
                Category: <strong>{filters.category}</strong>
              </span>
              <button
                onClick={() => handleFilterChange("category", undefined)}
                className="rounded px-1.5 py-0.5 text-xs text-cyan-400 hover:bg-cyan-900/30 hover:text-cyan-200 transition"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Active filter summary */}
      {hasActiveFilters && (
        <section className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-medium text-slate-300">
            Showing {pagination.total} article{pagination.total !== 1 ? "s" : ""}
          </span>
          {filters.sector_id && filterOptions?.sectors.find((s) => s.id === filters.sector_id) && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">
              Sector: {filterOptions.sectors.find((s) => s.id === filters.sector_id)?.name}
            </span>
          )}
          {filters.status && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">Stage: {filters.status}</span>
          )}
          {filters.min_score !== undefined && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">
              Score {">"}= {filters.min_score}
            </span>
          )}
          {filters.max_score !== undefined && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">
              Score {"<"}= {filters.max_score}
            </span>
          )}
          {filters.search && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">
              Search: "{filters.search}"
            </span>
          )}
          {filters.date_from && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">From: {filters.date_from}</span>
          )}
          {filters.date_to && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">To: {filters.date_to}</span>
          )}
          {filters.rejection_type && (
            <span className="rounded-full bg-slate-800 px-2.5 py-1">
              Rejection: {filters.rejection_type}
            </span>
          )}
        </section>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Batch Action Bar */}
      {selectedIds.size > 0 && (
        <section className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
          <span className="text-sm text-slate-300 font-medium">{selectedIds.size} selected</span>
          <Button variant="primary" size="sm" onClick={() => setPendingBatchAction("approve")}>
            Approve Selected
          </Button>
          <Button variant="danger-soft" size="sm" onClick={() => setPendingBatchAction("reject")}>
            Reject Selected
          </Button>
          {postingLanguage === "ka" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPendingBatchAction("translate")}
            >
              Translate Selected
            </Button>
          )}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-slate-500 hover:text-slate-300"
          >
            Deselect all
          </button>
        </section>
      )}

      {/* Articles Table */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="overflow-hidden">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-10" /> {/* checkbox */}
              <col className="w-[86px]" /> {/* ingested */}
              <col className="w-[86px]" /> {/* publish */}
              <col className="w-[110px]" /> {/* source */}
              <col /> {/* title/summary — takes remaining space */}
              <col className="w-[76px]" /> {/* status */}
              <col className="w-[56px]" /> {/* score */}
              <col className="w-[94px]" /> {/* actions */}
            </colgroup>
            <thead className="bg-slate-800/50">
              <tr>
                <th className="px-2 py-3">
                  <input
                    type="checkbox"
                    checked={articles.length > 0 && selectedIds.size === articles.length}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
                  />
                </th>
                <th
                  onClick={() => handleSort("created_at")}
                  className="px-1 py-2 text-left text-xs font-medium text-slate-300 cursor-pointer hover:text-white"
                >
                  Ingested{" "}
                  {filters.sort_by === "created_at" && (filters.sort_dir === "desc" ? "↓" : "↑")}
                </th>
                <th
                  onClick={() => handleSort("published_at")}
                  className="px-1 py-2 text-left text-xs font-medium text-slate-300 cursor-pointer hover:text-white"
                >
                  Publish{" "}
                  {filters.sort_by === "published_at" && (filters.sort_dir === "desc" ? "↓" : "↑")}
                </th>
                <th className="px-2 py-3 text-left font-medium text-slate-300">Source</th>
                <th className="px-2 py-3 text-left font-medium text-slate-300">Title / Summary</th>
                <th className="px-2 py-3 text-left font-medium text-slate-300">Status</th>
                <th
                  onClick={() => handleSort("importance_score")}
                  className="px-2 py-3 text-left font-medium text-slate-300 cursor-pointer hover:text-white"
                >
                  Score{" "}
                  {filters.sort_by === "importance_score" &&
                    (filters.sort_dir === "desc" ? "↓" : "↑")}
                </th>
                <th className="px-2 py-3 text-left font-medium text-slate-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {isLoading && articles.length === 0 && <SkeletonTable rows={8} columns={8} />}
              {articles.map((article) => (
                <tr
                  key={article.id}
                  className={`hover:bg-slate-800/30 ${selectedIds.has(article.id) ? "bg-slate-800/20" : ""}`}
                >
                  <td className="px-2 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(article.id)}
                      onChange={() => toggleSelect(article.id)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
                    />
                  </td>
                  <td className="px-1 py-2 text-xs text-slate-400 whitespace-nowrap">
                    {formatDate(article.created_at)}
                  </td>
                  <td className="px-1 py-2 text-xs text-slate-400 whitespace-nowrap">
                    {formatDate(article.published_at)}
                  </td>
                  <td className="px-2 py-3">
                    <div className="overflow-hidden">
                      <p className="text-slate-200 text-sm truncate">
                        {article.source_name || "Unknown"}
                      </p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="px-1.5 py-0.5 bg-slate-700/50 rounded text-xs text-slate-500">
                          {article.sector_name || "-"}
                        </span>
                        {article.url && (
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(article.url);
                              toast.success("URL copied");
                            }}
                            className="p-0.5 text-slate-500 hover:text-slate-300 transition-colors"
                            title="Copy article URL"
                          >
                            <svg
                              className="w-3 h-3"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3 overflow-hidden">
                    {editingId === article.id ? (
                      <div className="space-y-2 rounded-lg border border-slate-600/50 bg-slate-800/30 p-2">
                        <div>
                          <input
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") cancelEditing();
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                saveEditing(article.id);
                              }
                            }}
                            className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-200 outline-none focus:border-slate-400"
                            placeholder="Title"
                          />
                          <p
                            className={`mt-0.5 text-[10px] ${editTitle.length > 200 ? "text-amber-400" : "text-slate-500"}`}
                          >
                            {editTitle.length}/200
                          </p>
                        </div>
                        <div>
                          <textarea
                            value={editSummary}
                            onChange={(e) => setEditSummary(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") cancelEditing();
                            }}
                            rows={3}
                            className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300 outline-none focus:border-slate-400 resize-y"
                            placeholder="Summary"
                          />
                          <p
                            className={`text-[10px] ${editSummary.length > 500 ? "text-amber-400" : "text-slate-500"}`}
                          >
                            {editSummary.length}/500
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="xs"
                            onClick={() => saveEditing(article.id)}
                            loading={isSaving}
                            loadingText="Saving..."
                          >
                            Save
                          </Button>
                          <Button variant="ghost" size="xs" onClick={cancelEditing}>
                            Cancel
                          </Button>
                          <span className="text-[10px] text-slate-500 ml-auto">Esc to cancel</span>
                        </div>
                      </div>
                    ) : (
                      <div className="group relative">
                        {postingLanguage === "ka" ? (
                          <>
                            {article.translation_status === "translated" && article.title_ka ? (
                              <a
                                href={safeHref(article.url) ?? "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-200 hover:text-white hover:underline font-medium text-sm"
                              >
                                {article.title_ka}
                              </a>
                            ) : (
                              <a
                                href={safeHref(article.url) ?? "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-200 hover:text-white hover:underline font-medium text-sm"
                              >
                                {article.title}
                              </a>
                            )}
                            {/* Summary text (Georgian if translated, English fallback) */}
                            {article.translation_status === "translated" &&
                            article.llm_summary_ka ? (
                              <p className="text-xs text-slate-500 mt-1">
                                {article.llm_summary_ka}
                              </p>
                            ) : article.llm_summary ? (
                              <p className="text-xs text-slate-500 mt-1">{article.llm_summary}</p>
                            ) : null}
                            {/* Translation status badge (non-translated states) */}
                            {article.translation_status &&
                              article.translation_status !== "translated" && (
                                <span
                                  className={`inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                    article.translation_status === "queued"
                                      ? "bg-cyan-500/15 text-cyan-400"
                                      : article.translation_status === "translating"
                                        ? "bg-amber-500/15 text-amber-400"
                                        : article.translation_status === "failed"
                                          ? "bg-red-500/15 text-red-400"
                                          : article.translation_status === "exhausted"
                                            ? "bg-red-500/15 text-red-500"
                                            : "bg-slate-700/40 text-slate-400"
                                  }`}
                                  title={
                                    article.translation_status === "failed" ||
                                    article.translation_status === "exhausted"
                                      ? article.translation_error || undefined
                                      : undefined
                                  }
                                >
                                  {article.translation_status === "queued" && (
                                    <>
                                      <svg
                                        className="w-2.5 h-2.5"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth={2}
                                          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                                        />
                                      </svg>
                                      Translation queued
                                    </>
                                  )}
                                  {article.translation_status === "translating" && (
                                    <>
                                      <svg
                                        className="w-2.5 h-2.5 animate-spin"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                      >
                                        <circle
                                          className="opacity-25"
                                          cx="12"
                                          cy="12"
                                          r="10"
                                          stroke="currentColor"
                                          strokeWidth="4"
                                        />
                                        <path
                                          className="opacity-75"
                                          fill="currentColor"
                                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                        />
                                      </svg>
                                      Translating
                                    </>
                                  )}
                                  {article.translation_status === "failed" && "Translation failed"}
                                  {article.translation_status === "exhausted" &&
                                    "Translation exhausted"}
                                </span>
                              )}
                          </>
                        ) : (
                          <>
                            <a
                              href={safeHref(article.url) ?? "#"}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-200 hover:text-white hover:underline font-medium text-sm"
                            >
                              {article.title}
                            </a>
                            {article.llm_summary && (
                              <p className="text-xs text-slate-500 mt-1">{article.llm_summary}</p>
                            )}
                          </>
                        )}
                        {article.article_categories && article.article_categories.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {article.article_categories.slice(0, 5).map((cat, i) => (
                              <span
                                key={i}
                                onClick={() => handleFilterChange("category", cat)}
                                className="px-1.5 py-0.5 bg-slate-700/50 rounded text-[10px] text-slate-400 cursor-pointer hover:bg-slate-600 hover:text-slate-200 transition-colors"
                                title={`Filter articles by "${cat}"`}
                              >
                                {cat}
                              </span>
                            ))}
                            {article.article_categories.length > 5 && (
                              <span className="px-1.5 py-0.5 text-[10px] text-slate-500">
                                +{article.article_categories.length - 5}
                              </span>
                            )}
                          </div>
                        )}
                        <button
                          onClick={() => startEditing(article)}
                          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 bg-slate-700/80 text-slate-300 rounded text-xs hover:bg-slate-600"
                          title="Edit title & summary"
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs ${getStageBadgeClass(article.pipeline_stage)}`}
                    >
                      {article.pipeline_stage}
                    </span>
                    {article.pipeline_stage === "rejected" && article.rejection_reason && (
                      <p
                        className="mt-1 text-[10px] text-red-400/70 truncate"
                        title={article.rejection_reason}
                      >
                        {article.rejection_reason}
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-3">
                    <div className="group/score relative inline-block">
                      <span
                        className={`px-2 py-1 rounded text-xs font-bold ${getScoreBadgeClass(article.importance_score)} ${article.score_reasoning ? "cursor-help" : ""}`}
                      >
                        {article.importance_score ?? "-"}
                      </span>
                      {article.score_reasoning && (
                        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 shadow-xl opacity-0 pointer-events-none group-hover/score:opacity-100 group-hover/score:pointer-events-auto transition-opacity z-20">
                          <p className="font-medium text-slate-200 mb-1">Score Reasoning</p>
                          <p className="leading-relaxed">{article.score_reasoning}</p>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex flex-col gap-1.5 items-center">
                      {/* Schedule button (scored articles) */}
                      {article.pipeline_stage === "scored" && article.importance_score !== null && (
                        <Button
                          variant="primary"
                          size="xs"
                          fullWidth
                          onClick={() => openScheduleModal(article)}
                        >
                          Schedule
                        </Button>
                      )}
                      {/* Repost button (posted articles) */}
                      {article.pipeline_stage === "posted" && (
                        <Button
                          variant="secondary"
                          size="xs"
                          fullWidth
                          onClick={() => openScheduleModal(article)}
                        >
                          Repost
                        </Button>
                      )}
                      {/* Translate button (Georgian mode) */}
                      {postingLanguage === "ka" &&
                        article.llm_summary &&
                        ["scored", "approved", "posted"].includes(article.pipeline_stage) &&
                        (!article.translation_status ||
                          article.translation_status === "failed" ||
                          article.translation_status === "exhausted") && (
                          <button
                            onClick={() => setPendingAction({ type: "translate", article })}
                            disabled={busyIds.has(article.id)}
                            className="px-2 py-1 bg-cyan-500/20 text-cyan-200 rounded text-xs hover:bg-cyan-500/30 w-full text-center disabled:opacity-50"
                          >
                            {busyIds.has(article.id) ? "Translating..." : "Translate"}
                          </button>
                        )}
                      {/* Reject button at bottom (scored articles) */}
                      {article.pipeline_stage === "scored" && article.importance_score !== null && (
                        <Button
                          variant="danger-soft"
                          size="xs"
                          fullWidth
                          onClick={() => setPendingAction({ type: "reject", article })}
                          disabled={busyIds.has(article.id)}
                          loading={busyIds.has(article.id)}
                          loadingText="Rejecting..."
                        >
                          Reject
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!isLoading && articles.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8">
                    <EmptyState
                      title="No articles found"
                      description={
                        hasActiveFilters
                          ? "Try adjusting your filters to see more results."
                          : "Articles will appear here once the pipeline processes RSS feeds."
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-800/30">
          <p className="text-sm text-slate-400">
            Showing {(pagination.page - 1) * pagination.limit + 1} -{" "}
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handlePageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
            >
              Previous
            </Button>
            <span className="px-3 py-1 text-sm text-slate-400">
              Page {pagination.page} of {pagination.total_pages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handlePageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.total_pages}
            >
              Next
            </Button>
          </div>
        </div>
      </section>

      {/* Schedule Modal */}
      {schedulingArticle && (
        <ScheduleModal
          article={schedulingArticle}
          postingLanguage={postingLanguage}
          onClose={() => setSchedulingArticle(null)}
          onSchedule={handleSchedule}
        />
      )}

      {/* Single Article Confirmation */}
      {pendingAction && (
        <ConfirmModal
          title={pendingAction.type === "reject" ? "Reject Article" : "Translate Article"}
          message={
            pendingAction.type === "reject"
              ? `Reject "${pendingAction.article.title}"? This cannot be undone.`
              : `Translate "${pendingAction.article.title}" to Georgian?`
          }
          confirmLabel={pendingAction.type === "reject" ? "Reject" : "Translate"}
          variant={pendingAction.type === "reject" ? "danger" : "default"}
          onConfirm={confirmPendingAction}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {/* Batch Action Confirmation */}
      {pendingBatchAction && (
        <ConfirmModal
          title={
            pendingBatchAction === "approve"
              ? "Approve Articles"
              : pendingBatchAction === "translate"
                ? "Translate Articles"
                : "Reject Articles"
          }
          message={
            pendingBatchAction === "approve"
              ? `Approve ${selectedIds.size} selected article(s)? They will be queued for posting.`
              : pendingBatchAction === "translate"
                ? `Translate ${selectedIds.size} selected article(s) to Georgian? Already translated or ineligible articles will be skipped.`
                : `Reject ${selectedIds.size} selected article(s)? This cannot be undone.`
          }
          confirmLabel={
            pendingBatchAction === "approve"
              ? "Approve"
              : pendingBatchAction === "translate"
                ? "Translate"
                : "Reject"
          }
          variant={pendingBatchAction === "reject" ? "danger" : "default"}
          onConfirm={confirmBatchAction}
          onCancel={() => setPendingBatchAction(null)}
        />
      )}
    </>
  );
}
