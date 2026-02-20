import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import ScheduleModal from "../components/ScheduleModal";
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
      ["article:scored", "article:approved", "article:rejected", "article:posted", "article:translated", "source:fetched"],
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

  const handleReject = async (article: Article) => {
    try {
      await rejectArticle(article.id);
      toast.success("Article rejected");
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reject";
      toast.error(message);
    }
  };

  const handleTranslate = async (article: Article) => {
    try {
      await translateArticle(article.id);
      toast.success("Translation queued");
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to queue translation";
      toast.error(message);
    }
  };

  // Batch actions
  const handleBatchReject = async () => {
    if (selectedIds.size === 0) return;
    try {
      await batchRejectArticles([...selectedIds]);
      toast.success(`${selectedIds.size} article(s) rejected`);
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to batch reject";
      toast.error(message);
    }
  };

  const handleBatchApprove = async () => {
    if (selectedIds.size === 0) return;
    try {
      await batchApproveArticles([...selectedIds]);
      toast.success(`${selectedIds.size} article(s) approved`);
      loadArticles();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to batch approve";
      toast.error(message);
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
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
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
          <h1 className="text-3xl font-semibold tracking-tight">Articles</h1>
          <p className="mt-2 text-sm text-slate-400">{pagination.total} total articles</p>
        </div>
        <button
          onClick={loadArticles}
          className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
        >
          {isLoading ? <Spinner /> : "Refresh"}
        </button>
      </section>

      {/* Quick Filters */}
      <section className="flex flex-wrap gap-2">
        <button
          onClick={applyNeedsReview}
          className={`rounded-full px-4 py-2 text-sm font-medium transition ${
            filters.status === "scored" && filters.min_score === 3
              ? "bg-amber-500/20 text-amber-200 border border-amber-500/50"
              : "border border-slate-700 text-slate-300 hover:border-slate-500"
          }`}
        >
          Needs Review
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-400 transition hover:border-red-500/50 hover:text-red-300"
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
            onChange={(e) => handleFilterChange("status", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">All Statuses</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

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
        </div>
      </section>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Batch Action Bar */}
      {selectedIds.size > 0 && (
        <section className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
          <span className="text-sm text-slate-300 font-medium">
            {selectedIds.size} selected
          </span>
          <button
            onClick={handleBatchApprove}
            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30"
          >
            Approve Selected
          </button>
          <button
            onClick={handleBatchReject}
            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/30"
          >
            Reject Selected
          </button>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/50">
              <tr>
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={articles.length > 0 && selectedIds.size === articles.length}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
                  />
                </th>
                <th
                  onClick={() => handleSort("published_at")}
                  className="px-4 py-3 text-left font-medium text-slate-300 cursor-pointer hover:text-white"
                >
                  Date{" "}
                  {filters.sort_by === "published_at" && (filters.sort_dir === "desc" ? "↓" : "↑")}
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Source</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">
                  Title / Summary
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Status</th>
                <th
                  onClick={() => handleSort("importance_score")}
                  className="px-4 py-3 text-left font-medium text-slate-300 cursor-pointer hover:text-white"
                >
                  Score{" "}
                  {filters.sort_by === "importance_score" &&
                    (filters.sort_dir === "desc" ? "↓" : "↑")}
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {articles.map((article) => (
                <tr key={article.id} className={`hover:bg-slate-800/30 ${selectedIds.has(article.id) ? "bg-slate-800/20" : ""}`}>
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(article.id)}
                      onChange={() => toggleSelect(article.id)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
                    />
                  </td>
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                    {formatDate(article.published_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[120px]">
                      <p className="text-slate-200 text-sm truncate">{article.source_name || "Unknown"}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="px-1.5 py-0.5 bg-slate-700/50 rounded text-xs text-slate-400">
                          {article.sector_name || "-"}
                        </span>
                        {article.url && (
                          <button
                            onClick={() => navigator.clipboard.writeText(article.url)}
                            className="p-0.5 text-slate-500 hover:text-slate-300 transition-colors"
                            title="Copy article URL"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === article.id ? (
                      <div className="space-y-2">
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-200 outline-none focus:border-slate-400"
                          placeholder="Title"
                        />
                        <textarea
                          value={editSummary}
                          onChange={(e) => setEditSummary(e.target.value)}
                          rows={3}
                          className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300 outline-none focus:border-slate-400 resize-y"
                          placeholder="Summary"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveEditing(article.id)}
                            disabled={isSaving}
                            className="px-2 py-1 bg-emerald-500/20 text-emerald-200 rounded text-xs hover:bg-emerald-500/30 disabled:opacity-50"
                          >
                            {isSaving ? "Saving..." : "Save"}
                          </button>
                          <button
                            onClick={cancelEditing}
                            className="px-2 py-1 bg-slate-700/50 text-slate-300 rounded text-xs hover:bg-slate-700"
                          >
                            Cancel
                          </button>
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
                            {article.translation_status === "translated" && article.llm_summary_ka ? (
                              <p className="text-xs text-slate-400 mt-1">
                                {article.llm_summary_ka}
                              </p>
                            ) : article.llm_summary ? (
                              <p className="text-xs text-slate-400 mt-1">
                                {article.llm_summary}
                              </p>
                            ) : null}
                            {/* Translation status badge (non-translated states) */}
                            {article.translation_status && article.translation_status !== "translated" && (
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
                                  article.translation_status === "failed" || article.translation_status === "exhausted"
                                    ? article.translation_error || undefined
                                    : undefined
                                }
                              >
                                {article.translation_status === "queued" && (
                                  <>
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    Translation queued
                                  </>
                                )}
                                {article.translation_status === "translating" && (
                                  <>
                                    <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                    Translating
                                  </>
                                )}
                                {article.translation_status === "failed" && "Translation failed"}
                                {article.translation_status === "exhausted" && "Translation exhausted"}
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
                              <p className="text-xs text-slate-400 mt-1">
                                {article.llm_summary}
                              </p>
                            )}
                          </>
                        )}
                        {article.article_categories && article.article_categories.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {article.article_categories.slice(0, 5).map((cat, i) => (
                              <span key={i} className="px-1.5 py-0.5 bg-slate-700/50 rounded text-[10px] text-slate-400">
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
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs ${getStageBadgeClass(article.pipeline_stage)}`}
                    >
                      {article.pipeline_stage}
                    </span>
                    {article.pipeline_stage === "rejected" && article.rejection_reason && (
                      <p className="mt-1 text-[10px] text-red-400/70 max-w-[140px] truncate" title={article.rejection_reason}>
                        {article.rejection_reason}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="group/score relative inline-block">
                      <span
                        className={`px-2 py-1 rounded text-xs font-bold ${getScoreBadgeClass(article.importance_score)} ${article.score_reasoning ? "cursor-help" : ""}`}
                      >
                        {article.importance_score ?? "-"}
                      </span>
                      {article.score_reasoning && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 shadow-xl opacity-0 pointer-events-none group-hover/score:opacity-100 group-hover/score:pointer-events-auto transition-opacity z-20">
                          <p className="font-medium text-slate-200 mb-1">Score Reasoning</p>
                          <p className="leading-relaxed">{article.score_reasoning}</p>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1.5 items-center">
                      {/* Schedule button (scored articles) */}
                      {article.pipeline_stage === "scored" &&
                        article.importance_score !== null &&
                        article.importance_score >= 3 && (
                          <button
                            onClick={() => openScheduleModal(article)}
                            className="px-2 py-1 bg-emerald-500/20 text-emerald-200 rounded text-xs hover:bg-emerald-500/30 w-full text-center"
                          >
                            Schedule
                          </button>
                        )}
                      {/* Repost button (posted articles) */}
                      {article.pipeline_stage === "posted" && (
                        <button
                          onClick={() => openScheduleModal(article)}
                          className="px-2 py-1 bg-blue-500/20 text-blue-200 rounded text-xs hover:bg-blue-500/30 w-full text-center"
                        >
                          Repost
                        </button>
                      )}
                      {/* Translate button (Georgian mode) */}
                      {postingLanguage === "ka" &&
                        article.llm_summary &&
                        ["scored", "approved", "posted"].includes(article.pipeline_stage) &&
                        (!article.translation_status ||
                          article.translation_status === "failed" ||
                          article.translation_status === "exhausted") && (
                          <button
                            onClick={() => handleTranslate(article)}
                            className="px-2 py-1 bg-cyan-500/20 text-cyan-200 rounded text-xs hover:bg-cyan-500/30 w-full text-center"
                          >
                            Translate
                          </button>
                        )}
                      {/* Reject button at bottom (scored articles) */}
                      {article.pipeline_stage === "scored" &&
                        article.importance_score !== null &&
                        article.importance_score >= 3 && (
                          <button
                            onClick={() => handleReject(article)}
                            className="px-2 py-1 bg-red-500/20 text-red-200 rounded text-xs hover:bg-red-500/30 w-full text-center"
                          >
                            Reject
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
              {!isLoading && articles.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No articles found
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
            <button
              onClick={() => handlePageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 rounded border border-slate-700 text-slate-200 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:border-slate-500"
            >
              Previous
            </button>
            <span className="px-3 py-1 text-sm text-slate-400">
              Page {pagination.page} of {pagination.total_pages}
            </span>
            <button
              onClick={() => handlePageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.total_pages}
              className="px-3 py-1 rounded border border-slate-700 text-slate-200 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:border-slate-500"
            >
              Next
            </button>
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
    </>
  );
}
