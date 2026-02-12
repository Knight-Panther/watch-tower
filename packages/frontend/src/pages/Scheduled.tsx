import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import DatePicker from "../components/DatePicker";
import TimePicker from "../components/TimePicker";
import { useLocalStorageFilters } from "../hooks/useLocalStorageFilters";
import { useServerEventsContext } from "../contexts/ServerEventsContext";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import {
  getScheduledDeliveries,
  rescheduleDelivery,
  cancelDelivery,
  getScheduledStats,
  getTranslationConfig,
  type ScheduledDelivery,
  type ScheduledFilters,
  type ScheduledResponse,
  type ScheduledStats,
} from "../api";

const STATUS_OPTIONS = [
  { value: "scheduled", label: "Scheduled" },
  { value: "posting", label: "Posting" },
  { value: "posted", label: "Posted" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const PLATFORM_OPTIONS = [
  { value: "telegram", label: "Telegram" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
];

const TIME_BLOCKS = [
  { start: 9, end: 12, label: "09:00 – 12:00" },
  { start: 12, end: 15, label: "12:00 – 15:00" },
  { start: 15, end: 18, label: "15:00 – 18:00" },
  { start: 18, end: 21, label: "18:00 – 21:00" },
  { start: 21, end: 24, label: "21:00 – 00:00" },
  { start: 0, end: 3, label: "00:00 – 03:00" },
  { start: 3, end: 6, label: "03:00 – 06:00" },
  { start: 6, end: 9, label: "06:00 – 09:00" },
];

const pad = (n: number) => String(n).padStart(2, "0");

const getDeliveryHour = (delivery: ScheduledDelivery): number => {
  if (!delivery.scheduled_at) return 0;
  return new Date(delivery.scheduled_at).getHours();
};

const isInBlock = (hour: number, start: number, end: number): boolean => {
  if (start < end) return hour >= start && hour < end;
  // Wraps midnight (e.g., 21-24)
  return hour >= start || hour < end;
};

const formatLocalDate = (d: Date) => {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function Scheduled() {
  const [deliveries, setDeliveries] = useState<ScheduledDelivery[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, total_pages: 0 });
  const [stats, setStats] = useState<ScheduledStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [postingLanguage, setPostingLanguage] = useState<"en" | "ka">("en");

  // Filter state with localStorage persistence (no URL sync to avoid tab conflicts)
  const [filters, setFilter] = useLocalStorageFilters<ScheduledFilters>("scheduled-filters", {
    page: 1,
    limit: 50,
    status: "scheduled",
    sort_by: "scheduled_at",
    sort_dir: "asc",
  });

  // Reschedule modal state
  const [rescheduleItem, setRescheduleItem] = useState<ScheduledDelivery | null>(null);
  const [newDate, setNewDate] = useState("");
  const [newTime, setNewTime] = useState("");

  // Collapsible block state: track which blocks are explicitly toggled
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());

  const loadDeliveries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response: ScheduledResponse = await getScheduledDeliveries(filters);
      setDeliveries(response.data);
      setPagination(response.pagination);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load scheduled posts";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  const loadStats = useCallback(async () => {
    try {
      const s = await getScheduledStats();
      setStats(s);
    } catch (err) {
      console.error("Failed to load stats", err);
    }
  }, []);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    getTranslationConfig()
      .then((config) => setPostingLanguage(config.posting_language))
      .catch(() => {});
  }, []);

  // SSE: auto-refresh when a delivery gets posted
  const { subscribe } = useServerEventsContext();
  const debouncedRefresh = useDebouncedCallback(() => {
    loadDeliveries();
    loadStats();
  }, 2000);

  useEffect(() => {
    const unsubscribe = subscribe(["article:posted"], debouncedRefresh);
    return unsubscribe;
  }, [subscribe, debouncedRefresh]);

  const handleFilterChange = (key: keyof ScheduledFilters, value: string | number | undefined) => {
    setFilter(key, value);
  };

  const handlePageChange = (newPage: number) => {
    setFilter("page", newPage);
  };

  const handleCancel = async (delivery: ScheduledDelivery) => {
    if (!confirm("Cancel this scheduled post?")) return;
    try {
      await cancelDelivery(delivery.id);
      toast.success("Post cancelled");
      loadDeliveries();
      loadStats();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to cancel";
      toast.error(message);
    }
  };

  const openReschedule = (delivery: ScheduledDelivery) => {
    const scheduled = delivery.scheduled_at ? new Date(delivery.scheduled_at) : new Date();
    setRescheduleItem(delivery);
    setNewDate(formatLocalDate(scheduled));
    setNewTime(scheduled.toTimeString().slice(0, 5));
  };

  const handleReschedule = async () => {
    if (!rescheduleItem) return;
    try {
      const scheduledAt = new Date(`${newDate}T${newTime}`);
      await rescheduleDelivery(rescheduleItem.id, scheduledAt.toISOString());
      toast.success("Post rescheduled");
      setRescheduleItem(null);
      loadDeliveries();
      loadStats();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reschedule";
      toast.error(message);
    }
  };

  const formatTime24 = (dateStr: string | null) => {
    if (!dateStr) return "-";
    const d = new Date(dateStr);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const formatDateShort = (dateStr: string | null) => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "scheduled":
        return "bg-blue-500/20 text-blue-200";
      case "posting":
        return "bg-amber-500/20 text-amber-200";
      case "posted":
        return "bg-emerald-500/20 text-emerald-200";
      case "failed":
        return "bg-red-500/20 text-red-200";
      case "cancelled":
        return "bg-slate-500/20 text-slate-400";
      default:
        return "bg-slate-700/40 text-slate-300";
    }
  };

  const getPlatformBadgeClass = (platform: string) => {
    switch (platform) {
      case "telegram":
        return "bg-sky-500/20 text-sky-200";
      case "facebook":
        return "bg-blue-600/20 text-blue-200";
      case "linkedin":
        return "bg-blue-700/20 text-blue-200";
      default:
        return "bg-slate-700/40 text-slate-300";
    }
  };

  // Group deliveries by time block
  const groupedBlocks = TIME_BLOCKS.map((block) => {
    const items = deliveries.filter((d) => {
      const hour = getDeliveryHour(d);
      return isInBlock(hour, block.start, block.end);
    });
    return { ...block, items };
  });

  const toggleBlock = (label: string) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const isBlockExpanded = (label: string, count: number): boolean => {
    // If user explicitly toggled, respect that
    if (collapsedBlocks.has(label)) return false;
    // Default: expanded if has items
    return count > 0;
  };

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Scheduled Posts</h1>
          <p className="mt-2 text-sm text-slate-400">
            {pagination.total} total deliveries
            {stats && stats.due_in_next_hour > 0 && (
              <span className="ml-2 text-amber-400">
                ({stats.due_in_next_hour} due in next hour)
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => {
            loadDeliveries();
            loadStats();
          }}
          className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
        >
          {isLoading ? <Spinner /> : "Refresh"}
        </button>
      </section>

      {/* Stats cards */}
      {stats && (
        <section className="grid gap-4 md:grid-cols-5">
          {STATUS_OPTIONS.map((s) => (
            <div key={s.value} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <p className="text-sm text-slate-400">{s.label}</p>
              <p className="text-2xl font-semibold text-slate-100">
                {stats.by_status[s.value] || 0}
              </p>
            </div>
          ))}
        </section>
      )}

      {/* Filters */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold mb-4">Filters</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <select
            value={filters.status || ""}
            onChange={(e) => handleFilterChange("status", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <select
            value={filters.platform || ""}
            onChange={(e) => handleFilterChange("platform", e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          >
            <option value="">All Platforms</option>
            {PLATFORM_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={filters.from || ""}
            onChange={(e) => handleFilterChange("from", e.target.value)}
            placeholder="From date"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />

          <input
            type="date"
            value={filters.to || ""}
            onChange={(e) => handleFilterChange("to", e.target.value)}
            placeholder="To date"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
        </div>
      </section>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Time Block Groups */}
      <section className="space-y-2">
        {groupedBlocks.map((block) => {
          const expanded = isBlockExpanded(block.label, block.items.length);
          const hasItems = block.items.length > 0;

          return (
            <div
              key={block.label}
              className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden"
            >
              {/* Block header */}
              <button
                onClick={() => {
                  if (hasItems) {
                    toggleBlock(block.label);
                  }
                }}
                className={`w-full flex items-center justify-between px-5 py-3 text-left transition ${
                  hasItems
                    ? "hover:bg-slate-800/50 cursor-pointer"
                    : "cursor-default opacity-60"
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Chevron */}
                  <svg
                    className={`w-4 h-4 text-slate-500 transition-transform ${
                      expanded ? "rotate-90" : ""
                    }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>

                  <span className="text-sm font-medium text-slate-200 font-mono">
                    {block.label}
                  </span>
                </div>

                {/* Count badge */}
                <span
                  className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                    hasItems
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-slate-700/40 text-slate-500"
                  }`}
                >
                  {block.items.length}
                </span>
              </button>

              {/* Block content — table of deliveries */}
              {expanded && hasItems && (
                <div className="border-t border-slate-800 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/30">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs">
                          Time
                        </th>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs">
                          Platform
                        </th>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs">
                          Source
                        </th>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs max-w-md">
                          Article
                        </th>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs">
                          Score
                        </th>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs">
                          Status
                        </th>
                        <th className="px-4 py-2 text-left font-medium text-slate-400 text-xs">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {block.items.map((delivery) => (
                        <tr key={delivery.id} className="hover:bg-slate-800/20">
                          <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap font-mono text-xs">
                            <span className="text-slate-500">
                              {formatDateShort(delivery.scheduled_at)}
                            </span>{" "}
                            {formatTime24(delivery.scheduled_at)}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${getPlatformBadgeClass(delivery.platform)}`}
                            >
                              {delivery.platform}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="max-w-[120px]">
                              <p className="text-slate-200 truncate text-xs">
                                {delivery.source_name || "Unknown"}
                              </p>
                              <p className="text-xs text-slate-500 truncate">
                                {delivery.sector_name || "-"}
                              </p>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 max-w-md">
                            <a
                              href={delivery.article_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`hover:text-white hover:underline font-medium line-clamp-1 text-xs ${
                                postingLanguage === "ka" && !delivery.article_title_ka
                                  ? "text-slate-200 italic opacity-60"
                                  : "text-slate-200"
                              }`}
                            >
                              {postingLanguage === "ka" && delivery.article_title_ka
                                ? delivery.article_title_ka
                                : delivery.article_title}
                            </a>
                            {(postingLanguage === "ka"
                              ? delivery.article_summary_ka || delivery.article_summary
                              : delivery.article_summary) && (
                              <p className={`text-xs mt-0.5 line-clamp-1 ${
                                postingLanguage === "ka" && !delivery.article_summary_ka
                                  ? "text-slate-400 italic opacity-60"
                                  : "text-slate-400"
                              }`}>
                                {postingLanguage === "ka" && delivery.article_summary_ka
                                  ? delivery.article_summary_ka
                                  : delivery.article_summary}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="px-2 py-0.5 rounded text-xs font-bold bg-slate-700/40 text-slate-300">
                              {delivery.article_score ?? "-"}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${getStatusBadgeClass(delivery.status)}`}
                            >
                              {delivery.status}
                            </span>
                            {delivery.error_message && (
                              <p
                                className="text-xs text-red-400 mt-0.5 truncate max-w-[150px]"
                                title={delivery.error_message}
                              >
                                {delivery.error_message}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {delivery.status === "scheduled" && (
                              <div className="flex gap-2">
                                <button
                                  onClick={() => openReschedule(delivery)}
                                  className="px-2 py-0.5 bg-blue-500/20 text-blue-200 rounded text-xs hover:bg-blue-500/30"
                                >
                                  Reschedule
                                </button>
                                <button
                                  onClick={() => handleCancel(delivery)}
                                  className="px-2 py-0.5 bg-red-500/20 text-red-200 rounded text-xs hover:bg-red-500/30"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {!isLoading && deliveries.length === 0 && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-6 py-8 text-center text-slate-400">
            No scheduled posts found
          </div>
        )}
      </section>

      {/* Pagination */}
      {pagination.total > 0 && (
        <section className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/40 px-6 py-3">
          <p className="text-sm text-slate-400">
            Showing {(pagination.page - 1) * pagination.limit + 1} –{" "}
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
              Page {pagination.page} of {pagination.total_pages || 1}
            </span>
            <button
              onClick={() => handlePageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.total_pages}
              className="px-3 py-1 rounded border border-slate-700 text-slate-200 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:border-slate-500"
            >
              Next
            </button>
          </div>
        </section>
      )}

      {/* Reschedule Modal */}
      {rescheduleItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Reschedule Post</h3>

            <div className="mt-4">
              <p className="text-sm text-slate-400 mb-2">Article</p>
              <p className="text-slate-200 line-clamp-2">
                {postingLanguage === "ka" && rescheduleItem.article_title_ka
                  ? rescheduleItem.article_title_ka
                  : rescheduleItem.article_title}
              </p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Date</label>
                <DatePicker value={newDate} onChange={setNewDate} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Time</label>
                <TimePicker value={newTime} onChange={setNewTime} />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setRescheduleItem(null)}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
              >
                Cancel
              </button>
              <button
                onClick={handleReschedule}
                className="rounded-full bg-blue-500/20 px-4 py-2 text-sm font-semibold text-blue-200 hover:bg-blue-500/30"
              >
                Reschedule
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
