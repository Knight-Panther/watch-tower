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
  scheduleArticle,
  type Article,
  type ArticleFilters,
  type ArticleFilterOptions,
  type ArticlesResponse,
} from "../api";

const PIPELINE_STAGES = [
  { value: "ingested", label: "Ingested" },
  { value: "embedded", label: "Embedded" },
  { value: "scored", label: "Scored" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "posted", label: "Posted" },
  { value: "duplicate", label: "Duplicate" },
];

const SCORE_OPTIONS = [1, 2, 3, 4, 5];

export default function Articles() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, total_pages: 0 });
  const [filterOptions, setFilterOptions] = useState<ArticleFilterOptions | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state with localStorage persistence (no URL sync to avoid tab conflicts)
  const [filters, setFilter, setFilters] = useLocalStorageFilters<ArticleFilters>(
    "articles-filters",
    {
      page: 1,
      limit: 50,
      sort_by: "published_at",
      sort_dir: "desc",
    },
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
      ["article:scored", "article:approved", "article:rejected", "article:posted", "source:fetched"],
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
      setEditTitle(article.title_ka || "");
      setEditSummary(article.llm_summary_ka || "");
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
        </div>
      </section>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Articles Table */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/50">
              <tr>
                <th
                  onClick={() => handleSort("published_at")}
                  className="px-4 py-3 text-left font-medium text-slate-300 cursor-pointer hover:text-white"
                >
                  Date{" "}
                  {filters.sort_by === "published_at" && (filters.sort_dir === "desc" ? "↓" : "↑")}
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Source</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Sector</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300 max-w-md">
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
                <tr key={article.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                    {formatDate(article.published_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[150px]">
                      <p className="text-slate-200 truncate">{article.source_name || "Unknown"}</p>
                      <p
                        className="text-xs text-slate-500 truncate"
                        title={article.source_url || ""}
                      >
                        {article.source_url}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-1 bg-slate-700/50 rounded text-xs text-slate-300">
                      {article.sector_name || "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-md">
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
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-200 hover:text-white hover:underline font-medium line-clamp-1"
                              >
                                {article.title_ka}
                              </a>
                            ) : (
                              <a
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-200 hover:text-white hover:underline font-medium line-clamp-1 italic opacity-60"
                              >
                                {article.title}
                              </a>
                            )}
                            {article.translation_status === "translated" && article.llm_summary_ka ? (
                              <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                                {article.llm_summary_ka}
                              </p>
                            ) : article.translation_status === "translating" ? (
                              <span className="text-xs text-amber-400 mt-1 inline-block">
                                Translating...
                              </span>
                            ) : article.translation_status === "failed" ? (
                              <span className="text-xs text-red-400 mt-1 inline-block">
                                Translation failed
                              </span>
                            ) : article.llm_summary ? (
                              <p className="text-xs text-slate-500 mt-1 line-clamp-2 italic opacity-60">
                                {article.llm_summary}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-200 hover:text-white hover:underline font-medium line-clamp-1"
                            >
                              {article.title}
                            </a>
                            {article.llm_summary && (
                              <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                                {article.llm_summary}
                              </p>
                            )}
                          </>
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
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs font-bold ${getScoreBadgeClass(article.importance_score)}`}
                    >
                      {article.importance_score ?? "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {article.pipeline_stage === "scored" &&
                      article.importance_score !== null &&
                      article.importance_score >= 3 && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => openScheduleModal(article)}
                            className="px-2 py-1 bg-emerald-500/20 text-emerald-200 rounded text-xs hover:bg-emerald-500/30"
                          >
                            Schedule
                          </button>
                          <button
                            onClick={() => handleReject(article)}
                            className="px-2 py-1 bg-red-500/20 text-red-200 rounded text-xs hover:bg-red-500/30"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    {article.pipeline_stage === "posted" && (
                      <button
                        onClick={() => openScheduleModal(article)}
                        className="px-2 py-1 bg-blue-500/20 text-blue-200 rounded text-xs hover:bg-blue-500/30"
                      >
                        Repost
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!isLoading && articles.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
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
