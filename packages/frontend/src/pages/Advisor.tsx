import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getLatestAdvisorReport,
  getAdvisorHistory,
  getAdvisorConfig,
  updateAdvisorConfig,
  triggerAdvisorRun,
  clearAdvisorHistory,
  getAdvisorDataRange,
  getAdvisorReport,
  type AdvisorReport,
  type AdvisorReportSummary,
  type AdvisorConfig,
  type AdvisorRecommendation,
  type AdvisorDataRange,
} from "../api";
import { useServerEvents } from "../hooks/useServerEvents";

// ─── Constants ──────────────────────────────────────────────────────────────

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tbilisi",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
];

const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "claude-sonnet-4-20250514", label: "Sonnet 4" },
    { value: "claude-opus-4-20250514", label: "Opus 4" },
    { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "o3-mini", label: "o3-mini" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek Chat" },
    { value: "deepseek-reasoner", label: "DeepSeek Reasoner" },
  ],
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

const CATEGORY_LABELS: Record<string, string> = {
  source: "Sources",
  keyword: "Keywords",
  threshold: "Thresholds",
  prompt: "Prompts",
  interval: "Intervals",
  dedup: "Dedup",
  cost: "Cost",
  alert: "Alerts",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-500/20 text-red-400 border-red-500/30",
  medium: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  low: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
};

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-emerald-500",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function costDisplay(microdollars: number | null | undefined): string {
  if (!microdollars) return "$0.00";
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// ─── Recommendation Card (advisory-only, no apply actions) ──────────────────

function RecommendationCard({ rec }: { rec: AdvisorRecommendation }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
      <div className="flex items-start gap-3">
        <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY_DOT[rec.priority]}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[rec.priority]}`}
            >
              {rec.priority.toUpperCase()}
            </span>
            <span className="rounded-md bg-slate-700/50 px-2 py-0.5 text-xs text-slate-400">
              {CATEGORY_LABELS[rec.category] ?? rec.category}
            </span>
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-slate-200">{rec.title}</h3>
          <p className="mt-1 text-sm text-slate-400 leading-relaxed">{rec.reason}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Section ───────────────────────────────────────────────────────

function DataWarningBanner({ dataRange, windowDays }: { dataRange: AdvisorDataRange; windowDays: number }) {
  if (dataRange.total_scored === 0) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
        No scored articles in database. Run the pipeline first to generate data for analysis.
      </div>
    );
  }

  const warnings: string[] = [];

  if (dataRange.available_days < windowDays) {
    warnings.push(
      `Only ${dataRange.available_days} day${dataRange.available_days === 1 ? "" : "s"} of scored data available (window is set to ${windowDays} days).`,
    );
  }

  if (windowDays > dataRange.feed_items_ttl_days) {
    warnings.push(
      `Analysis window (${windowDays}d) exceeds article retention (${dataRange.feed_items_ttl_days}d). Older articles are auto-deleted.`,
    );
  }

  if (dataRange.articles_in_window === 0) {
    warnings.push("No scored articles within the configured window. Analysis will have no data.");
  } else if (dataRange.articles_in_window < 20) {
    warnings.push(
      `Only ${dataRange.articles_in_window} scored article${dataRange.articles_in_window === 1 ? "" : "s"} in the ${windowDays}-day window. Results may be limited.`,
    );
  }

  if (warnings.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
      {warnings.map((w, i) => (
        <p key={i} className={i > 0 ? "mt-1" : ""}>{w}</p>
      ))}
    </div>
  );
}

function AdvisorSettings({
  config,
  onUpdate,
  dataRange,
}: {
  config: AdvisorConfig;
  onUpdate: (c: AdvisorConfig) => void;
  dataRange: AdvisorDataRange | null;
}) {
  const [form, setForm] = useState(config);
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(config), [config]);

  const models = PROVIDER_MODELS[form.provider] ?? [];

  // Auto-select first model when provider changes
  const handleProviderChange = (provider: string) => {
    const firstModel = PROVIDER_MODELS[provider]?.[0]?.value ?? "";
    setForm((f) => ({ ...f, provider, model: firstModel }));
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await updateAdvisorConfig(form);
      onUpdate(form);
      toast.success("Advisor settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = JSON.stringify(form) !== JSON.stringify(config);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
      <h2 className="text-lg font-semibold text-slate-200">Settings</h2>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Enabled */}
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-blue-500"
          />
          <span className="text-sm text-slate-300">Enabled (daily analysis)</span>
        </label>

        {/* Schedule */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Schedule Time</label>
          <input
            type="time"
            value={form.time}
            onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200"
          />
        </div>

        {/* Timezone */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Timezone</label>
          <select
            value={form.timezone}
            onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        {/* Provider */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">AI Provider</label>
          <select
            value={form.provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200"
          >
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
            <option value="deepseek">DeepSeek</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>

        {/* Model */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Model</label>
          <select
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200"
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Window Days */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Analysis Window ({form.window_days} days)
          </label>
          <input
            type="range"
            min={1}
            max={60}
            value={form.window_days}
            onChange={(e) =>
              setForm((f) => ({ ...f, window_days: Number(e.target.value) }))
            }
            className="w-full"
          />
          {dataRange && form.window_days > dataRange.available_days && dataRange.total_scored > 0 && (
            <p className="mt-1 text-xs text-amber-400">
              Only {dataRange.available_days}d of data available
            </p>
          )}
          {dataRange && form.window_days > dataRange.feed_items_ttl_days && (
            <p className="mt-1 text-xs text-amber-400">
              Exceeds article retention ({dataRange.feed_items_ttl_days}d)
            </p>
          )}
        </div>
      </div>

      {hasChanges && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── History Row ────────────────────────────────────────────────────────────

function HistoryRow({
  report,
  isActive,
  onClick,
}: {
  report: AdvisorReportSummary;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-4 rounded-lg border px-4 py-3 text-sm text-left transition ${
        isActive
          ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-blue-500/20"
          : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600 hover:bg-slate-800/50"
      }`}
    >
      <div
        className={`h-2 w-2 shrink-0 rounded-full ${
          report.status === "ready"
            ? "bg-emerald-500"
            : report.status === "failed"
              ? "bg-red-500"
              : "bg-amber-500 animate-pulse"
        }`}
      />
      <span className="font-mono text-xs text-slate-500 shrink-0">{shortId(report.id)}</span>
      <span className="text-slate-400 w-20 shrink-0">{relativeTime(report.createdAt)}</span>
      <span className="flex-1 text-slate-300 truncate">{report.summary ?? "No summary"}</span>
      <span className="text-slate-500 text-xs shrink-0">
        {report.recommendationCount} recs
      </span>
      <span className="text-slate-500 text-xs shrink-0">{costDisplay(report.llmCostMicrodollars)}</span>
      <span className="text-slate-600 text-xs capitalize shrink-0">{report.triggeredBy}</span>
    </button>
  );
}

// ─── Main Page Component ────────────────────────────────────────────────────

export default function Advisor() {
  const [latestReport, setLatestReport] = useState<AdvisorReport | null>(null);
  const [viewingReport, setViewingReport] = useState<AdvisorReport | null>(null);
  const [history, setHistory] = useState<AdvisorReportSummary[]>([]);
  const [config, setConfig] = useState<AdvisorConfig | null>(null);
  const [dataRange, setDataRange] = useState<AdvisorDataRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filterPriority, setFilterPriority] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

  // The report currently displayed — either a specifically selected one or the latest
  const report = viewingReport ?? latestReport;
  const isViewingLatest = !viewingReport || viewingReport.id === latestReport?.id;

  const loadData = useCallback(async () => {
    try {
      const [r, h, c, dr] = await Promise.all([
        getLatestAdvisorReport(),
        getAdvisorHistory(10),
        getAdvisorConfig(),
        getAdvisorDataRange(),
      ]);
      setLatestReport(r);
      setViewingReport(null); // Reset to latest on refresh
      setHistory(h);
      setConfig(c);
      setDataRange(dr);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load advisor data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useServerEvents({
    onEvent: (event) => {
      if (event.type === "advisor:report_ready") {
        loadData();
        const d = event.data as { recommendationCount: number; highPriorityCount: number };
        const highStr = d.highPriorityCount > 0 ? ` (${d.highPriorityCount} high priority)` : "";
        toast.success(`SmartHub: ${d.recommendationCount} new recommendations${highStr}`);
      }
    },
  });

  const handleRunNow = async () => {
    // Warn if data is limited
    if (dataRange) {
      if (dataRange.total_scored === 0) {
        toast.error("No scored articles in database. Run the pipeline first.");
        return;
      }
      const window = config?.window_days ?? 30;
      if (dataRange.available_days < window && dataRange.articles_in_window < 20) {
        const ok = confirm(
          `Only ${dataRange.available_days} day(s) of data available (${dataRange.articles_in_window} articles) ` +
            `but window is set to ${window} days. Analysis may be limited. Continue?`,
        );
        if (!ok) return;
      }
    }
    try {
      setRunning(true);
      await triggerAdvisorRun();
      toast.success("Advisor analysis queued");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to trigger run");
    } finally {
      setRunning(false);
    }
  };

  const handleViewReport = async (id: string) => {
    // If clicking the latest, just reset
    if (id === latestReport?.id) {
      setViewingReport(null);
      return;
    }
    try {
      const full = await getAdvisorReport(id);
      setViewingReport(full);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load report");
    }
  };

  // Filter recommendations
  const recs = (report?.recommendations ?? []).filter((r) => {
    if (filterPriority && r.priority !== filterPriority) return false;
    if (filterCategory && r.category !== filterCategory) return false;
    return true;
  });

  // Categories present in recommendations
  const activeCategories = new Set(
    (report?.recommendations ?? []).map((r) => r.category),
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">SmartHub</h1>
          <p className="text-sm text-slate-400">
            Pipeline Intelligence Advisor
            {report && (
              <>
                {" "}
                &middot; Last analysis: {relativeTime(report.createdAt)} &middot;{" "}
                {report.recommendationCount} recommendations
              </>
            )}
          </p>
        </div>
        <button
          onClick={handleRunNow}
          disabled={running}
          className="rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-400 transition hover:bg-blue-500/20 disabled:opacity-50"
        >
          {running ? "Queued..." : "Run Now"}
        </button>
      </div>

      {/* Report identification header + Summary */}
      {report && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ${
                  isViewingLatest
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                    : "bg-slate-700/50 text-slate-400 border border-slate-600/50"
                }`}
              >
                {isViewingLatest ? "LATEST" : "HISTORICAL"}
              </span>
              <div>
                <span className="text-sm font-semibold text-slate-200">
                  Report #{shortId(report.id)}
                </span>
                <span className="mx-2 text-slate-600">&middot;</span>
                <span className="text-sm text-slate-400">
                  {formatFullDate(report.createdAt)}
                </span>
              </div>
            </div>
            {!isViewingLatest && (
              <button
                onClick={() => setViewingReport(null)}
                className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-400 transition hover:border-blue-500/40 hover:text-blue-400"
              >
                Back to Latest
              </button>
            )}
          </div>

          {report.summary && (
            <p className="text-sm text-slate-300 leading-relaxed">{report.summary}</p>
          )}
          <div className="mt-2 flex gap-4 text-xs text-slate-500">
            <span>{report.llmProvider}/{report.llmModel}</span>
            <span>{costDisplay(report.llmCostMicrodollars)}</span>
            <span>{report.llmLatencyMs ? `${(report.llmLatencyMs / 1000).toFixed(1)}s` : ""}</span>
            <span className="capitalize">{report.triggeredBy}</span>
          </div>
        </div>
      )}

      {/* Data availability warning */}
      {config && dataRange && (
        <DataWarningBanner dataRange={dataRange} windowDays={config.window_days} />
      )}

      {/* No report state */}
      {!report && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center">
          <p className="text-slate-400">No advisor reports yet. Click "Run Now" to generate your first analysis.</p>
        </div>
      )}

      {/* Filters */}
      {report && (report.recommendations?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {/* Priority filters */}
          <button
            onClick={() => setFilterPriority(null)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              !filterPriority
                ? "bg-slate-600 text-white"
                : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            All
          </button>
          {(["high", "medium", "low"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setFilterPriority(filterPriority === p ? null : p)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filterPriority === p
                  ? PRIORITY_COLORS[p]
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}

          <div className="mx-2 w-px bg-slate-700" />

          {/* Category filters */}
          {Array.from(activeCategories).map((cat) => (
            <button
              key={cat}
              onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filterCategory === cat
                  ? "bg-blue-500/20 text-blue-400"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {CATEGORY_LABELS[cat] ?? cat}
            </button>
          ))}
        </div>
      )}

      {/* Recommendations */}
      {report && recs.length > 0 && (
        <div className="space-y-3">
          {recs.map((rec) => (
            <RecommendationCard key={rec.id} rec={rec} />
          ))}
        </div>
      )}

      {/* Settings */}
      {config && <AdvisorSettings config={config} onUpdate={setConfig} dataRange={dataRange} />}

      {/* History */}
      {history.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">Report History</h2>
            <button
              onClick={async () => {
                if (!confirm(`Clear all ${history.length} report(s)? This cannot be undone.`)) return;
                try {
                  const { cleared } = await clearAdvisorHistory();
                  setLatestReport(null);
                  setViewingReport(null);
                  setHistory([]);
                  toast.success(`Cleared ${cleared} report(s)`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to clear history");
                }
              }}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-red-400 transition hover:border-red-500 hover:bg-red-500/10"
            >
              Clear All
            </button>
          </div>
          <div className="space-y-2">
            {history.map((h) => (
              <HistoryRow
                key={h.id}
                report={h}
                isActive={h.id === report?.id}
                onClick={() => handleViewReport(h.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
