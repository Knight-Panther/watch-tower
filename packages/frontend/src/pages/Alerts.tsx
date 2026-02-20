import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import {
  listAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getAlertRule,
  type AlertRule,
  type AlertDelivery,
} from "../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "never triggered";
  const diffMs = Date.now() - Date.parse(isoString);
  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function scoreBadgeClass(score: number): string {
  if (score <= 2) return "rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-medium text-slate-300";
  if (score === 3) return "rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-300";
  if (score === 4) return "rounded-full bg-orange-500/20 px-2.5 py-0.5 text-xs font-medium text-orange-300";
  return "rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-medium text-red-300";
}

function scoreLabel(score: number): string {
  const labels: Record<number, string> = {
    1: "Score >= 1",
    2: "Score >= 2",
    3: "Score >= 3",
    4: "Score >= 4",
    5: "Score = 5",
  };
  return labels[score] ?? `Score >= ${score}`;
}

function deliveryStatusClass(status: AlertDelivery["status"]): string {
  if (status === "sent") return "rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300";
  if (status === "failed") return "rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300";
  return "rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-400";
}

// ─── Create Form ──────────────────────────────────────────────────────────────

type CreateFormState = {
  name: string;
  keywordInput: string;
  keywords: string[];
  minScore: number;
  telegramChatId: string;
};

const INITIAL_FORM: CreateFormState = {
  name: "",
  keywordInput: "",
  keywords: [],
  minScore: 4,
  telegramChatId: "",
};

type CreateFormProps = {
  onCreated: (rule: AlertRule) => void;
};

function CreateForm({ onCreated }: CreateFormProps) {
  const [form, setForm] = useState<CreateFormState>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const keywordInputRef = useRef<HTMLInputElement>(null);

  const hasShortKeyword = form.keywords.some((kw) => kw.length < 3);

  const handleKeywordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitKeyword();
    }
  };

  const commitKeyword = () => {
    const trimmed = form.keywordInput.trim();
    if (!trimmed) return;
    if (form.keywords.includes(trimmed)) {
      toast.error("Keyword already added");
      return;
    }
    if (form.keywords.length >= 50) {
      toast.error("Maximum 50 keywords allowed");
      return;
    }
    setForm((prev) => ({ ...prev, keywords: [...prev.keywords, trimmed], keywordInput: "" }));
    keywordInputRef.current?.focus();
  };

  const removeKeyword = (index: number) => {
    setForm((prev) => ({
      ...prev,
      keywords: prev.keywords.filter((_, i) => i !== index),
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const name = form.name.trim();
    const chatId = form.telegramChatId.trim();

    if (!name) {
      toast.error("Rule name is required");
      return;
    }
    if (form.keywords.length === 0) {
      toast.error("At least one keyword is required");
      return;
    }
    if (!chatId) {
      toast.error("Telegram Chat ID is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const rule = await createAlertRule({
        name,
        keywords: form.keywords,
        min_score: form.minScore,
        telegram_chat_id: chatId,
        active: true,
      });
      onCreated(rule);
      setForm(INITIAL_FORM);
      toast.success("Alert rule created");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create alert rule";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="mb-4 text-base font-semibold text-slate-100">New Alert Rule</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-400">Rule Name</label>
          <input
            type="text"
            placeholder="e.g., Google Mentions"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
          />
        </div>

        {/* Keywords */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-400">
            Keywords{" "}
            <span className="text-slate-500">(press Enter to add)</span>
          </label>
          <div className="min-h-10 flex flex-wrap gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 focus-within:border-slate-500">
            {form.keywords.map((kw, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full bg-cyan-500/20 px-3 py-0.5 text-sm text-cyan-200"
              >
                {kw}
                <button
                  type="button"
                  onClick={() => removeKeyword(i)}
                  className="ml-0.5 text-cyan-400 hover:text-cyan-200 leading-none"
                  aria-label={`Remove keyword ${kw}`}
                >
                  x
                </button>
              </span>
            ))}
            <input
              ref={keywordInputRef}
              type="text"
              placeholder={form.keywords.length === 0 ? "Type a keyword and press Enter..." : ""}
              value={form.keywordInput}
              onChange={(e) => setForm((prev) => ({ ...prev, keywordInput: e.target.value }))}
              onKeyDown={handleKeywordKeyDown}
              onBlur={commitKeyword}
              className="min-w-32 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600"
            />
          </div>
          {hasShortKeyword && (
            <p className="mt-1.5 text-xs text-amber-400">
              Warning: some keywords are shorter than 3 characters and may produce excessive matches.
            </p>
          )}
        </div>

        {/* Min Score + Chat ID row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Minimum Score</label>
            <select
              value={form.minScore}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, minScore: Number(e.target.value) }))
              }
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              <option value={1}>1 — Any score</option>
              <option value={2}>2 — Low+</option>
              <option value={3}>3 — Medium+</option>
              <option value={4}>4 — High+</option>
              <option value={5}>5 — Critical only</option>
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Telegram Chat ID
            </label>
            <input
              type="text"
              placeholder="-100..."
              value={form.telegramChatId}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, telegramChatId: e.target.value }))
              }
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {isSubmitting ? "Creating..." : "Create Rule"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Recent Deliveries Table ──────────────────────────────────────────────────

type DeliveriesTableProps = {
  ruleId: string;
};

function DeliveriesTable({ ruleId }: DeliveriesTableProps) {
  const [deliveries, setDeliveries] = useState<AlertDelivery[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const detail = await getAlertRule(ruleId);
        if (!cancelled) {
          setDeliveries(detail.recent_deliveries);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load deliveries";
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [ruleId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <p className="py-3 text-center text-xs text-red-400">{error}</p>
    );
  }

  if (!deliveries || deliveries.length === 0) {
    return (
      <p className="py-3 text-center text-xs text-slate-500">No deliveries yet for this rule.</p>
    );
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-slate-800">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/60">
            <th className="px-3 py-2 text-left font-medium text-slate-400">Article</th>
            <th className="px-3 py-2 text-left font-medium text-slate-400">Keyword</th>
            <th className="px-3 py-2 text-left font-medium text-slate-400">Status</th>
            <th className="px-3 py-2 text-left font-medium text-slate-400">When</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id} className="border-b border-slate-800/50 last:border-0">
              <td className="max-w-xs truncate px-3 py-2 text-slate-300" title={d.article_title ?? ""}>
                {d.article_title ?? <span className="text-slate-500">Unknown</span>}
              </td>
              <td className="px-3 py-2">
                <code className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-300">
                  {d.matched_keyword}
                </code>
              </td>
              <td className="px-3 py-2">
                <span className={deliveryStatusClass(d.status)}>{d.status}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                {formatRelativeTime(d.sent_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Rule Card ────────────────────────────────────────────────────────────────

type RuleCardProps = {
  rule: AlertRule;
  onToggle: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
  isToggling: boolean;
};

function RuleCard({ rule, onToggle, onDelete, isToggling }: RuleCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      {/* Row 1: name + active toggle */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-bold text-slate-100 leading-tight">{rule.name}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => onToggle(rule)}
            disabled={isToggling}
            className={[
              "rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
              rule.active
                ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                : "bg-slate-700 text-slate-400 hover:bg-slate-600",
            ].join(" ")}
          >
            {rule.active ? "Active" : "Inactive"}
          </button>
          <button
            onClick={() => onDelete(rule)}
            className="rounded-xl border border-red-700/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/30"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Row 2: keywords */}
      {rule.keywords.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {rule.keywords.map((kw, i) => (
            <span
              key={i}
              className="rounded-full bg-cyan-500/20 px-3 py-1 text-sm text-cyan-200"
            >
              {kw}
            </span>
          ))}
        </div>
      )}

      {/* Row 3: score + chat ID + stats */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className={scoreBadgeClass(rule.min_score)}>{scoreLabel(rule.min_score)}</span>
        <span
          className="max-w-[180px] truncate font-mono text-xs text-slate-500"
          title={rule.telegram_chat_id}
        >
          {rule.telegram_chat_id}
        </span>
        <span className="text-xs text-slate-500">
          {rule.sent_count > 0
            ? `${rule.sent_count} sent`
            : "never triggered"}
        </span>
      </div>

      {/* Row 4: last triggered */}
      {rule.last_triggered_at && (
        <p className="mt-2 text-xs text-slate-500">
          Last triggered: {formatRelativeTime(rule.last_triggered_at)}
        </p>
      )}

      {/* Expand / collapse recent deliveries */}
      <div className="mt-3 border-t border-slate-800/60 pt-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
        >
          <svg
            className={["h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : ""].join(" ")}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M6 4l4 4-4 4V4z" />
          </svg>
          {expanded ? "Hide" : "Show"} recent deliveries
        </button>

        {expanded && <DeliveriesTable ruleId={rule.id} />}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Alerts() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const loadRules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listAlertRules();
      setRules(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load alert rules";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const handleCreated = useCallback((rule: AlertRule) => {
    // New rules have no deliveries yet — merge defaults
    const withStats: AlertRule = {
      ...rule,
      total_deliveries: rule.total_deliveries ?? 0,
      sent_count: rule.sent_count ?? 0,
      last_triggered_at: rule.last_triggered_at ?? null,
    };
    setRules((prev) => [withStats, ...prev]);
  }, []);

  const handleToggle = useCallback(async (rule: AlertRule) => {
    setTogglingIds((prev) => new Set(prev).add(rule.id));
    try {
      const updated = await updateAlertRule(rule.id, { active: !rule.active });
      setRules((prev) =>
        prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)),
      );
      toast.success(updated.active ? "Alert rule enabled" : "Alert rule disabled");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update alert rule";
      toast.error(message);
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(rule.id);
        return next;
      });
    }
  }, []);

  const handleDelete = useCallback(async (rule: AlertRule) => {
    const confirmed = window.confirm(
      `Delete alert rule "${rule.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      await deleteAlertRule(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast.success("Alert rule deleted");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete alert rule";
      toast.error(message);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Keyword Alerts</h1>
        <p className="mt-1 text-sm text-slate-400">
          Get instant Telegram notifications when articles match your keywords.
        </p>
      </div>

      {/* Create Form */}
      <CreateForm onCreated={handleCreated} />

      {/* Rules List */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          Alert Rules
        </h2>

        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={loadRules}
              className="mt-4 rounded-xl bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Retry
            </button>
          </div>
        )}

        {!isLoading && !error && rules.length === 0 && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center">
            <p className="text-sm text-slate-500">
              No alert rules yet. Create your first rule above.
            </p>
          </div>
        )}

        {!isLoading &&
          !error &&
          rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onToggle={handleToggle}
              onDelete={handleDelete}
              isToggling={togglingIds.has(rule.id)}
            />
          ))}
      </div>
    </div>
  );
}
