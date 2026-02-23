import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { getAnalytics, type AnalyticsData } from "../api";
import { useServerEventsContext } from "../contexts/ServerEventsContext";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import Spinner from "../components/Spinner";

const SCORE_COLORS: Record<number, string> = {
  1: "bg-red-500",
  2: "bg-orange-400",
  3: "bg-amber-400",
  4: "bg-emerald-400",
  5: "bg-emerald-300",
};

const SCORE_TEXT_COLORS: Record<number, string> = {
  1: "text-red-400",
  2: "text-orange-400",
  3: "text-amber-400",
  4: "text-emerald-400",
  5: "text-emerald-300",
};

const STAGE_COLORS: Record<string, string> = {
  approved: "bg-emerald-500",
  posted: "bg-cyan-500",
  rejected: "bg-red-500",
  scored: "bg-slate-500",
};

const REJECTION_LABELS: Record<string, { label: string; color: string; description: string }> = {
  "pre-filter": {
    label: "Pre-filtered",
    color: "bg-orange-500",
    description: "Rejected by keyword rules before reaching the LLM (saves cost)",
  },
  "llm-score": {
    label: "LLM Rejected",
    color: "bg-red-500",
    description: "Scored too low by the AI and auto-rejected",
  },
  manual: {
    label: "Manual",
    color: "bg-slate-500",
    description: "Rejected by operator in the dashboard",
  },
  other: {
    label: "Other",
    color: "bg-slate-600",
    description: "Unknown rejection source",
  },
};

type SortField = "total_scored" | "approved_pct" | "avg_score" | "signal_ratio";
type SortDir = "asc" | "desc";

export default function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceSort, setSourceSort] = useState<{ field: SortField; dir: SortDir }>({
    field: "signal_ratio",
    dir: "desc",
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getAnalytics();
      setData(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load analytics";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // SSE: auto-refresh when scoring or approval events happen
  const { subscribe } = useServerEventsContext();
  const debouncedRefresh = useDebouncedCallback(() => {
    loadData();
  }, 3000);

  useEffect(() => {
    const unsubscribe = subscribe(
      ["article:scored", "article:approved", "article:rejected", "article:posted"],
      debouncedRefresh,
    );
    return unsubscribe;
  }, [subscribe, debouncedRefresh]);

  const totalScored = data
    ? Object.values(data.score_distribution).reduce((a, b) => a + b, 0)
    : 0;
  const maxScoreCount = data
    ? Math.max(...Object.values(data.score_distribution), 1)
    : 1;

  // Build approval matrix from flat rows
  const approvalMatrix = data
    ? buildApprovalMatrix(data.approval_by_score)
    : {};

  // Sort source ranking
  const sortedSources = data
    ? [...data.source_ranking].sort((a, b) => {
        const av = a[sourceSort.field] ?? 0;
        const bv = b[sourceSort.field] ?? 0;
        return sourceSort.dir === "desc" ? bv - av : av - bv;
      })
    : [];

  const toggleSourceSort = (field: SortField) => {
    setSourceSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { field, dir: "desc" },
    );
  };

  const sortIndicator = (field: SortField) =>
    sourceSort.field === field ? (sourceSort.dir === "desc" ? " \u25BC" : " \u25B2") : "";

  return (
    <div className="grid gap-6">
      <section className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-slate-400">
            Scoring patterns and approval insights over the last 30 days. Use these panels to understand how the AI scores your articles and which sources deliver the most value.
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
        >
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </section>

      {error && (
        <p className="rounded-xl border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {!loading && totalScored < 10 && !error && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-6 text-center">
          <p className="text-slate-400">
            Not enough data yet. Analytics become meaningful after 50+ scored articles.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Currently {totalScored} article{totalScored !== 1 ? "s" : ""} scored in the last 30 days.
          </p>
        </div>
      )}

      {data && totalScored >= 10 && (
        <>
          {/* Row 1: Score Distribution + Rejection Breakdown */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Score Distribution */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-sm font-semibold text-slate-200">Score Distribution</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Every article is scored 1-5 by the AI (1 = irrelevant, 5 = critical). This shows how many articles fell into each score level. Ideally most articles should cluster around 2-3, with only a few reaching 4-5. Too many 1s means noisy sources; too many 5s means scoring is too lenient.
              </p>
              <div className="mt-4 space-y-2">
                {[5, 4, 3, 2, 1].map((score) => {
                  const cnt = data.score_distribution[score] ?? 0;
                  const pct = totalScored > 0 ? (cnt / totalScored) * 100 : 0;
                  const barWidth = (cnt / maxScoreCount) * 100;
                  return (
                    <div key={score} className="flex items-center gap-3">
                      <span className={`w-6 text-right text-xs font-bold ${SCORE_TEXT_COLORS[score]}`}>
                        {score}
                      </span>
                      <div className="flex-1 h-5 rounded bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full rounded ${SCORE_COLORS[score]} transition-all`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <span className="w-16 text-right text-xs text-slate-400">
                        {cnt} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[10px] text-slate-500">
                Total scored: {totalScored} articles
              </p>
            </section>

            {/* Rejection Breakdown */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-sm font-semibold text-slate-200">Rejection Breakdown</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Articles can be rejected in three ways: pre-filter (keyword rules block them before the AI even sees them — saves cost), LLM rejection (AI scored them too low), or manual (you rejected them from the dashboard). High pre-filter counts mean your keyword rules are effective.
              </p>
              {data.rejection_breakdown.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">No rejections in this period.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {(() => {
                    const totalRejected = data.rejection_breakdown.reduce(
                      (sum, r) => sum + r.cnt,
                      0,
                    );
                    return data.rejection_breakdown.map((r) => {
                      const info = REJECTION_LABELS[r.rejection_type] ?? REJECTION_LABELS.other;
                      const pct = totalRejected > 0 ? (r.cnt / totalRejected) * 100 : 0;
                      return (
                        <div key={r.rejection_type}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-300">{info.label}</span>
                            <span className="text-slate-400">
                              {r.cnt} ({pct.toFixed(0)}%)
                            </span>
                          </div>
                          <div className="mt-1 h-3 rounded bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full rounded ${info.color}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="mt-0.5 text-[10px] text-slate-500">{info.description}</p>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </section>
          </div>

          {/* Row 2: Approval Rate by Score */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
            <h2 className="text-sm font-semibold text-slate-200">Approval Rate by Score</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Shows what happened to articles at each score level — were they posted, approved, rejected, or still pending review? This helps you tune auto-approve/reject thresholds. If score-3 articles often get manually approved, consider lowering the auto-approve threshold to save time.
            </p>
            <div className="mt-4 space-y-3">
              {[5, 4, 3, 2, 1].map((score) => {
                const row = approvalMatrix[score];
                if (!row || row.total === 0) return null;
                return (
                  <div key={score} className="flex items-center gap-3">
                    <span
                      className={`w-6 text-right text-xs font-bold ${SCORE_TEXT_COLORS[score]}`}
                    >
                      {score}
                    </span>
                    <div className="flex-1 flex h-4 rounded bg-slate-800 overflow-hidden">
                      {(["posted", "approved", "rejected", "scored"] as const).map((stage) => {
                        const cnt = row[stage] ?? 0;
                        const pct = (cnt / row.total) * 100;
                        if (pct === 0) return null;
                        return (
                          <div
                            key={stage}
                            className={`h-full ${STAGE_COLORS[stage]}`}
                            style={{ width: `${pct}%` }}
                            title={`${stage}: ${cnt} (${pct.toFixed(0)}%)`}
                          />
                        );
                      })}
                    </div>
                    <span className="w-12 text-right text-[10px] text-slate-400">{row.total}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex gap-4 text-[10px] text-slate-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded bg-cyan-500" /> Posted
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded bg-emerald-500" /> Approved
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded bg-red-500" /> Rejected
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded bg-slate-500" /> Pending
              </span>
            </div>
          </section>

          {/* Row 3: Source Value + Sector Performance */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Source Value Ranking */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-sm font-semibold text-slate-200">Source Value Ranking</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Ranks your RSS sources by quality. "Signal" is the percentage of articles scoring 4+ (high-value). Sources with low signal ratio produce mostly noise — they cost LLM budget without delivering useful articles. Consider disabling or reassigning low-signal sources.
              </p>
              {sortedSources.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  Not enough data (min 3 scored articles per source).
                </p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-slate-500">
                        <th className="pb-2 font-medium">Source</th>
                        <th
                          className="pb-2 font-medium cursor-pointer hover:text-slate-300"
                          onClick={() => toggleSourceSort("total_scored")}
                          title="Total number of articles scored by the AI from this source"
                        >
                          Scored{sortIndicator("total_scored")}
                        </th>
                        <th
                          className="pb-2 font-medium cursor-pointer hover:text-slate-300"
                          onClick={() => toggleSourceSort("approved_pct")}
                          title="Percentage of articles that were approved (auto or manual) for posting"
                        >
                          Approved{sortIndicator("approved_pct")}
                        </th>
                        <th
                          className="pb-2 font-medium cursor-pointer hover:text-slate-300"
                          onClick={() => toggleSourceSort("avg_score")}
                          title="Average AI score across all articles from this source (1-5 scale)"
                        >
                          Avg Score{sortIndicator("avg_score")}
                        </th>
                        <th
                          className="pb-2 font-medium cursor-pointer hover:text-slate-300"
                          onClick={() => toggleSourceSort("signal_ratio")}
                          title="Signal ratio — percentage of articles scoring 4 or 5 (high-value). Higher is better."
                        >
                          Signal{sortIndicator("signal_ratio")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSources.map((s) => {
                        const signalColor =
                          s.signal_ratio >= 40
                            ? "text-emerald-400"
                            : s.signal_ratio >= 15
                              ? "text-amber-400"
                              : "text-red-400";
                        return (
                          <tr
                            key={s.source_id}
                            className="border-b border-slate-800/50 hover:bg-slate-800/30"
                          >
                            <td className="py-2 text-slate-300 max-w-[160px] truncate">
                              {s.source_name ?? "Unknown"}
                            </td>
                            <td className="py-2 text-slate-400">{s.total_scored}</td>
                            <td className="py-2 text-slate-400">{s.approved_pct}%</td>
                            <td className="py-2 text-slate-400">{s.avg_score}</td>
                            <td className={`py-2 font-semibold ${signalColor}`}>
                              {s.signal_ratio}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Sector Performance */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-sm font-semibold text-slate-200">Sector Performance</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Compares performance across your sectors (e.g., Biotech, Crypto). Each sector groups multiple RSS sources. Sectors with low approval rates or low average scores may need better scoring rules or source curation on the Sectors page.
              </p>
              {data.sector_performance.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">No sector data available.</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-slate-500">
                        <th className="pb-2 font-medium">Sector</th>
                        <th className="pb-2 font-medium" title="Total articles scored in this sector over the last 30 days">Articles</th>
                        <th className="pb-2 font-medium" title="Average AI score across all articles in this sector (1-5 scale)">Avg Score</th>
                        <th className="pb-2 font-medium" title="Percentage of articles approved for posting (auto or manual)">Approved</th>
                        <th className="pb-2 font-medium" title="Number of high-value articles (scored 4 or 5) — the useful output from this sector">Signal (4+)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sector_performance.map((s) => (
                        <tr
                          key={s.sector_id}
                          className="border-b border-slate-800/50 hover:bg-slate-800/30"
                        >
                          <td className="py-2 text-slate-300">{s.sector_name ?? "Unknown"}</td>
                          <td className="py-2 text-slate-400">{s.total}</td>
                          <td className="py-2 text-slate-400">{s.avg_score}</td>
                          <td className="py-2 text-slate-400">{s.approved_pct}%</td>
                          <td className="py-2 text-emerald-400">{s.signal_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {loading && !data && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}
    </div>
  );
}

// Helper: Build approval matrix from flat API rows
function buildApprovalMatrix(
  rows: Array<{ score: number; stage: string; cnt: number }>,
): Record<number, { total: number; approved: number; posted: number; rejected: number; scored: number }> {
  const matrix: Record<
    number,
    { total: number; approved: number; posted: number; rejected: number; scored: number }
  > = {};
  for (const r of rows) {
    if (!matrix[r.score]) {
      matrix[r.score] = { total: 0, approved: 0, posted: 0, rejected: 0, scored: 0 };
    }
    const m = matrix[r.score];
    const cnt = Number(r.cnt);
    m.total += cnt;
    if (r.stage === "approved") m.approved += cnt;
    else if (r.stage === "posted") m.posted += cnt;
    else if (r.stage === "rejected") m.rejected += cnt;
    else if (r.stage === "scored") m.scored += cnt;
  }
  return matrix;
}
