import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import {
  getScheduledDeliveries,
  rescheduleDelivery,
  cancelDelivery,
  getScheduledStats,
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

export default function Scheduled() {
  const [deliveries, setDeliveries] = useState<ScheduledDelivery[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, total_pages: 0 });
  const [stats, setStats] = useState<ScheduledStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<ScheduledFilters>({
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

  const handleFilterChange = (key: keyof ScheduledFilters, value: string | number | undefined) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value === "" ? undefined : value,
      page: 1,
    }));
  };

  const handlePageChange = (newPage: number) => {
    setFilters((prev) => ({ ...prev, page: newPage }));
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
    setNewDate(scheduled.toISOString().split("T")[0]);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reschedule";
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

      {/* Table */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Scheduled</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Platform</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Source</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300 max-w-md">Article</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Score</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Status</th>
                <th className="px-4 py-3 text-left font-medium text-slate-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {deliveries.map((delivery) => (
                <tr key={delivery.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                    {formatDate(delivery.scheduled_at)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs ${getPlatformBadgeClass(delivery.platform)}`}
                    >
                      {delivery.platform}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[120px]">
                      <p className="text-slate-200 truncate">{delivery.source_name || "Unknown"}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {delivery.sector_name || "-"}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 max-w-md">
                    <a
                      href={delivery.article_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-200 hover:text-white hover:underline font-medium line-clamp-1"
                    >
                      {delivery.article_title}
                    </a>
                    {delivery.article_summary && (
                      <p className="text-xs text-slate-400 mt-1 line-clamp-1">
                        {delivery.article_summary}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-1 rounded text-xs font-bold bg-slate-700/40 text-slate-300">
                      {delivery.article_score ?? "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs ${getStatusBadgeClass(delivery.status)}`}
                    >
                      {delivery.status}
                    </span>
                    {delivery.error_message && (
                      <p
                        className="text-xs text-red-400 mt-1 truncate max-w-[150px]"
                        title={delivery.error_message}
                      >
                        {delivery.error_message}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {delivery.status === "scheduled" && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => openReschedule(delivery)}
                          className="px-2 py-1 bg-blue-500/20 text-blue-200 rounded text-xs hover:bg-blue-500/30"
                        >
                          Reschedule
                        </button>
                        <button
                          onClick={() => handleCancel(delivery)}
                          className="px-2 py-1 bg-red-500/20 text-red-200 rounded text-xs hover:bg-red-500/30"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!isLoading && deliveries.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No scheduled posts found
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
        </div>
      </section>

      {/* Reschedule Modal */}
      {rescheduleItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Reschedule Post</h3>

            <div className="mt-4">
              <p className="text-sm text-slate-400 mb-2">Article</p>
              <p className="text-slate-200 line-clamp-2">{rescheduleItem.article_title}</p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Date</label>
                <input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Time</label>
                <input
                  type="time"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
                />
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
