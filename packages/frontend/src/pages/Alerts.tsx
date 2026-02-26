import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import ConfirmModal from "../components/ConfirmModal";
import Button from "../components/ui/Button";
import EmptyState from "../components/ui/EmptyState";
import {
  listAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getAlertRule,
  testAlertRule,
  muteAlertRule,
  unmuteAlertRule,
  getAlertWeeklyStats,
  listSectors,
  getAlertWarningThreshold,
  setAlertWarningThreshold as saveWarningThreshold,
  getAlertQuietHours,
  setAlertQuietHours as saveQuietHours,
  type AlertRule,
  type AlertDelivery,
  type AlertTemplateConfig,
  type AlertWeeklyStats,
  type Sector,
} from "../api";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE: AlertTemplateConfig = {
  showUrl: true,
  showSummary: true,
  showScore: true,
  showSector: true,
  alertEmoji: "🔔",
};

const MUTE_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "12 hours", hours: 12 },
  { label: "24 hours", hours: 24 },
  { label: "48 hours", hours: 48 },
];

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

function formatMuteRemaining(muteUntil: string | null): string | null {
  if (!muteUntil) return null;
  const remaining = Date.parse(muteUntil) - Date.now();
  if (remaining <= 0) return null;
  const hours = Math.ceil(remaining / (60 * 60 * 1000));
  if (hours < 1) return "< 1h remaining";
  return `${hours}h remaining`;
}

function scoreBadgeClass(score: number): string {
  if (score <= 2)
    return "rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-medium text-slate-300";
  if (score === 3)
    return "rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-300";
  if (score === 4)
    return "rounded-full bg-orange-500/20 px-2.5 py-0.5 text-xs font-medium text-orange-300";
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
  if (status === "sent")
    return "rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300";
  if (status === "failed")
    return "rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300";
  return "rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-500";
}

// ─── Sector Selector (shared) ───────────────────────────────────────────────

function SectorSelect({
  value,
  onChange,
  sectors,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  sectors: Sector[];
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-slate-400">
        Sector <span className="text-slate-500">(optional)</span>
      </label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
      >
        <option value="">All sectors (global)</option>
        {sectors.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-slate-600">
        Scoped rules only inject keywords when scoring articles from that sector.
      </p>
    </div>
  );
}

// ─── Template Toggles (shared) ──────────────────────────────────────────────

function TemplateToggles({
  template,
  onChange,
  ruleName,
  keywords,
}: {
  template: AlertTemplateConfig;
  onChange: (t: AlertTemplateConfig) => void;
  ruleName?: string;
  keywords?: string[];
}) {
  const toggle = (key: keyof AlertTemplateConfig) => {
    onChange({ ...template, [key]: !template[key] });
  };

  // Build preview mirroring worker's formatAlertMessage
  const emoji = template.alertEmoji || "\u{1F514}";
  const name = ruleName || "My Alert Rule";
  const kw = keywords?.[0] || "keyword";
  const previewLines: string[] = [`<b>${emoji} Alert: ${name}</b>`];
  const meta = [`Keyword: ${kw}`];
  if (template.showScore !== false) meta.push("Score: 4/5 (High)");
  if (template.showSector !== false) meta.push("Sector: Technology");
  previewLines.push(meta.join(" | "));
  previewLines.push("");
  if (template.showTitle !== false) {
    previewLines.push("<b>OpenAI announces GPT-5 with real-time reasoning</b>");
  }
  if (template.showSummary !== false) {
    previewLines.push("OpenAI unveiled GPT-5 featuring real-time chain-of-thought reasoning...");
  }
  if (template.showUrl !== false) {
    previewLines.push('\n<a href="#">Read more \u2192</a>');
  }

  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-slate-400">Message Template</label>
      <div className="flex flex-wrap gap-3">
        {([
          { key: "showTitle" as const, label: "Show Title" },
          { key: "showUrl" as const, label: "Show URL" },
          { key: "showSummary" as const, label: "Show Summary" },
          { key: "showScore" as const, label: "Show Score" },
          { key: "showSector" as const, label: "Show Sector" },
        ] as const).map(({ key, label }) => (
          <label key={key} className="flex items-center gap-1.5 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={template[key] !== false}
              onChange={() => toggle(key)}
              className="rounded border-slate-600 bg-slate-950 text-cyan-500 focus:ring-0 focus:ring-offset-0"
            />
            {label}
          </label>
        ))}
      </div>
      {/* Live preview */}
      <div className="mt-2 rounded-lg border border-slate-700/50 bg-slate-950/60 px-3 py-2 font-mono text-[10px] leading-relaxed text-slate-400">
        {previewLines.map((line, i) => {
          if (line === "") return <br key={i} />;
          const html = line
            .replace(/<b>(.*?)<\/b>/g, '<span class="font-bold text-slate-200">$1</span>')
            .replace(/<a [^>]*>(.*?)<\/a>/g, '<span class="text-cyan-400 underline">$1</span>');
          return <div key={i} dangerouslySetInnerHTML={{ __html: html }} />;
        })}
      </div>
    </div>
  );
}

// ─── Create Form ─────────────────────────────────────────────────────────────

type CreateFormState = {
  name: string;
  keywordInput: string;
  keywords: string[];
  minScore: number;
  telegramChatId: string;
  sectorId: string | null;
  template: AlertTemplateConfig;
};

const INITIAL_FORM: CreateFormState = {
  name: "",
  keywordInput: "",
  keywords: [],
  minScore: 4,
  telegramChatId: "",
  sectorId: null,
  template: { ...DEFAULT_TEMPLATE },
};

type CreateFormProps = {
  onCreated: (rule: AlertRule) => void;
  sectors: Sector[];
};

function CreateForm({ onCreated, sectors }: CreateFormProps) {
  const [form, setForm] = useState<CreateFormState>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const keywordInputRef = useRef<HTMLInputElement>(null);

  const hasShortKeyword = form.keywords.some((kw) => kw.length < 3);

  const handleKeywordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitKeyword();
    }
    if (e.key === "Escape") {
      setForm((prev) => ({ ...prev, keywordInput: "" }));
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
        sector_id: form.sectorId,
        template: form.template,
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
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
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
            Keywords <span className="text-slate-500">(press Enter to add)</span>
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
                  className="ml-0.5 leading-none text-cyan-400 hover:text-cyan-200"
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
          <div className="mt-1.5 flex items-center gap-3">
            <span className="text-xs text-slate-500">{form.keywords.length}/50</span>
            {hasShortKeyword && (
              <span className="text-xs text-amber-400">
                Warning: some keywords are shorter than 3 characters and may produce excessive
                matches.
              </span>
            )}
            {form.keywordInput.trim().length > 0 && form.keywordInput.trim().length < 3 && (
              <span className="text-xs text-amber-400">Tag should be at least 3 characters</span>
            )}
          </div>
        </div>

        {/* Min Score + Chat ID + Sector row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Minimum Score
            </label>
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

          <SectorSelect
            value={form.sectorId}
            onChange={(v) => setForm((prev) => ({ ...prev, sectorId: v }))}
            sectors={sectors}
          />
        </div>

        {/* Template */}
        <TemplateToggles
          template={form.template}
          onChange={(t) => setForm((prev) => ({ ...prev, template: t }))}
          ruleName={form.name}
          keywords={form.keywords}
        />

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={isSubmitting}
            loading={isSubmitting}
            loadingText="Creating..."
          >
            Create Rule
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─── Recent Deliveries Table ─────────────────────────────────────────────────

function DeliveriesTable({ ruleId }: { ruleId: string }) {
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
        if (!cancelled) setDeliveries(detail.recent_deliveries);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load deliveries");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
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
  if (error) return <p className="py-3 text-center text-xs text-red-400">{error}</p>;
  if (!deliveries || deliveries.length === 0) {
    return <p className="py-3 text-center text-xs text-slate-500">No deliveries yet.</p>;
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800">
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
              <td
                className="max-w-xs truncate px-3 py-2 text-slate-300"
                title={d.article_title ?? ""}
              >
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

// ─── Rule Card ───────────────────────────────────────────────────────────────

type EditFormState = {
  name: string;
  keywordInput: string;
  keywords: string[];
  minScore: number;
  telegramChatId: string;
  sectorId: string | null;
  template: AlertTemplateConfig;
};

type RuleCardProps = {
  rule: AlertRule;
  sectors: Sector[];
  onToggle: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
  onUpdated: (rule: AlertRule) => void;
  isToggling: boolean;
};

function RuleCard({ rule, sectors, onToggle, onDelete, onUpdated, isToggling }: RuleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isMuting, setIsMuting] = useState(false);
  const [showMuteMenu, setShowMuteMenu] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState>({
    name: "",
    keywordInput: "",
    keywords: [],
    minScore: 4,
    telegramChatId: "",
    sectorId: null,
    template: { ...DEFAULT_TEMPLATE },
  });
  const editKeywordInputRef = useRef<HTMLInputElement>(null);
  const muteMenuRef = useRef<HTMLDivElement>(null);

  const hasShortEditKeyword = editForm.keywords.some((kw) => kw.length < 3);
  const muteRemaining = formatMuteRemaining(rule.mute_until);
  const sectorName = rule.sector_id
    ? sectors.find((s) => s.id === rule.sector_id)?.name ?? "Unknown"
    : null;

  // Close mute menu on outside click
  useEffect(() => {
    if (!showMuteMenu) return;
    const handler = (e: MouseEvent) => {
      if (muteMenuRef.current && !muteMenuRef.current.contains(e.target as Node)) {
        setShowMuteMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMuteMenu]);

  const handleEditClick = () => {
    setEditForm({
      name: rule.name,
      keywordInput: "",
      keywords: [...rule.keywords],
      minScore: rule.min_score,
      telegramChatId: rule.telegram_chat_id,
      sectorId: rule.sector_id,
      template: { ...DEFAULT_TEMPLATE, ...(rule.template ?? {}) },
    });
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const commitEditKeyword = () => {
    const trimmed = editForm.keywordInput.trim();
    if (!trimmed) return;
    if (editForm.keywords.includes(trimmed)) {
      toast.error("Keyword already added");
      return;
    }
    if (editForm.keywords.length >= 50) {
      toast.error("Maximum 50 keywords allowed");
      return;
    }
    setEditForm((prev) => ({
      ...prev,
      keywords: [...prev.keywords, trimmed],
      keywordInput: "",
    }));
    editKeywordInputRef.current?.focus();
  };

  const handleEditKeywordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEditKeyword();
    }
    if (e.key === "Escape") {
      setEditForm((prev) => ({ ...prev, keywordInput: "" }));
    }
  };

  const removeEditKeyword = (index: number) => {
    setEditForm((prev) => ({
      ...prev,
      keywords: prev.keywords.filter((_, i) => i !== index),
    }));
  };

  const handleSave = async () => {
    const name = editForm.name.trim();
    const chatId = editForm.telegramChatId.trim();

    if (!name) {
      toast.error("Rule name is required");
      return;
    }
    if (editForm.keywords.length === 0) {
      toast.error("At least one keyword is required");
      return;
    }
    if (!chatId) {
      toast.error("Telegram Chat ID is required");
      return;
    }

    setIsSaving(true);
    try {
      const updated = await updateAlertRule(rule.id, {
        name,
        keywords: editForm.keywords,
        min_score: editForm.minScore,
        telegram_chat_id: chatId,
        sector_id: editForm.sectorId,
        template: editForm.template,
      });
      onUpdated(updated);
      setIsEditing(false);
      toast.success("Alert rule updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update alert rule");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      await testAlertRule(rule.id);
      toast.success("Test alert sent! Check your Telegram.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test alert failed");
    } finally {
      setIsTesting(false);
    }
  };

  const handleMute = async (hours: number) => {
    setShowMuteMenu(false);
    setIsMuting(true);
    try {
      const updated = await muteAlertRule(rule.id, hours);
      onUpdated(updated);
      toast.success(`Alert muted for ${hours} hour${hours === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mute");
    } finally {
      setIsMuting(false);
    }
  };

  const handleUnmute = async () => {
    setIsMuting(true);
    try {
      const updated = await unmuteAlertRule(rule.id);
      onUpdated(updated);
      toast.success("Alert unmuted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to unmute");
    } finally {
      setIsMuting(false);
    }
  };

  // ── Edit mode ─────────────────────────────────────────────────────────────
  if (isEditing) {
    return (
      <div className="rounded-2xl border border-slate-700 bg-slate-900/40 p-6">
        <h3 className="mb-4 text-base font-semibold text-slate-100">Edit Alert Rule</h3>
        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Rule Name</label>
            <input
              type="text"
              placeholder="e.g., Google Mentions"
              value={editForm.name}
              onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            />
          </div>

          {/* Keywords */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Keywords <span className="text-slate-500">(press Enter to add)</span>
            </label>
            <div className="min-h-10 flex flex-wrap gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 focus-within:border-slate-500">
              {editForm.keywords.map((kw, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-cyan-500/20 px-3 py-0.5 text-sm text-cyan-200"
                >
                  {kw}
                  <button
                    type="button"
                    onClick={() => removeEditKeyword(i)}
                    className="ml-0.5 leading-none text-cyan-400 hover:text-cyan-200"
                    aria-label={`Remove keyword ${kw}`}
                  >
                    x
                  </button>
                </span>
              ))}
              <input
                ref={editKeywordInputRef}
                type="text"
                placeholder={
                  editForm.keywords.length === 0 ? "Type a keyword and press Enter..." : ""
                }
                value={editForm.keywordInput}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, keywordInput: e.target.value }))
                }
                onKeyDown={handleEditKeywordKeyDown}
                onBlur={commitEditKeyword}
                className="min-w-32 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600"
              />
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <span className="text-xs text-slate-500">{editForm.keywords.length}/50</span>
              {hasShortEditKeyword && (
                <span className="text-xs text-amber-400">
                  Warning: some keywords are shorter than 3 characters.
                </span>
              )}
            </div>
          </div>

          {/* Min Score + Chat ID + Sector */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Minimum Score
              </label>
              <select
                value={editForm.minScore}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, minScore: Number(e.target.value) }))
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
                value={editForm.telegramChatId}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, telegramChatId: e.target.value }))
                }
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
              />
            </div>

            <SectorSelect
              value={editForm.sectorId}
              onChange={(v) => setEditForm((prev) => ({ ...prev, sectorId: v }))}
              sectors={sectors}
            />
          </div>

          {/* Template */}
          <TemplateToggles
            template={editForm.template}
            onChange={(t) => setEditForm((prev) => ({ ...prev, template: t }))}
            ruleName={editForm.name}
            keywords={editForm.keywords}
          />

          {/* Save / Cancel */}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={handleCancelEdit} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
              loading={isSaving}
              loadingText="Saving..."
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Display mode ──────────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      {/* Row 1: name + badges + actions */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-bold leading-tight text-slate-100">{rule.name}</h3>
          {sectorName && (
            <span className="mt-1 inline-block rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs text-violet-300">
              {sectorName}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Active toggle */}
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

          {/* Test button */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={isTesting}
            loading={isTesting}
            loadingText="..."
          >
            Test
          </Button>

          {/* Mute / Unmute */}
          {muteRemaining ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleUnmute}
              disabled={isMuting}
            >
              Unmute
            </Button>
          ) : (
            <div className="relative" ref={muteMenuRef}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowMuteMenu((v) => !v)}
                disabled={isMuting}
              >
                Mute
              </Button>
              {showMuteMenu && (
                <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-lg">
                  {MUTE_OPTIONS.map((opt) => (
                    <button
                      key={opt.hours}
                      onClick={() => handleMute(opt.hours)}
                      className="w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Button variant="secondary" size="sm" onClick={handleEditClick}>
            Edit
          </Button>
          <Button variant="danger" size="sm" onClick={() => onDelete(rule)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Mute indicator */}
      {muteRemaining && (
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-300">
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11zM7.25 4v4.5l3.25 1.94.75-1.23-2.5-1.48V4h-1.5z" />
          </svg>
          Muted — {muteRemaining}
        </div>
      )}

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
          {rule.sent_count === 0 && rule.total_deliveries === 0
            ? "never triggered"
            : `${rule.sent_count} sent / ${rule.total_deliveries} total`}
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
          aria-expanded={expanded}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-200"
        >
          <svg
            className={[
              "h-3.5 w-3.5 transition-transform",
              expanded ? "rotate-90" : "",
            ].join(" ")}
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

// ─── Alert Settings Panel ────────────────────────────────────────────────────

function AlertSettings() {
  const [threshold, setThreshold] = useState("");
  const [thresholdLoading, setThresholdLoading] = useState(true);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [quietTz, setQuietTz] = useState("");
  const [quietLoading, setQuietLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [t, q] = await Promise.all([getAlertWarningThreshold(), getAlertQuietHours()]);
        setThreshold(String(t));
        setQuietStart(q.start ?? "");
        setQuietEnd(q.end ?? "");
        setQuietTz(q.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      } catch {
        // silent
      } finally {
        setThresholdLoading(false);
        setQuietLoading(false);
      }
    };
    load();
  }, []);

  const handleSaveThreshold = async () => {
    const val = Number(threshold);
    if (Number.isNaN(val) || val < 10 || val > 200) {
      toast.error("Threshold must be 10-200");
      return;
    }
    try {
      const updated = await saveWarningThreshold(val);
      setThreshold(String(updated));
      toast.success("Warning threshold updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleSaveQuietHours = async () => {
    // Allow clearing (both empty = disabled)
    const start = quietStart.trim() || null;
    const end = quietEnd.trim() || null;
    if ((start && !end) || (!start && end)) {
      toast.error("Set both start and end, or leave both empty to disable");
      return;
    }
    try {
      const updated = await saveQuietHours({
        start,
        end,
        timezone: quietTz.trim() || null,
      });
      setQuietStart(updated.start ?? "");
      setQuietEnd(updated.end ?? "");
      setQuietTz(updated.timezone ?? "");
      toast.success(start ? "Quiet hours updated" : "Quiet hours disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  if (thresholdLoading || quietLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h2 className="text-base font-semibold text-slate-100">Alert Settings</h2>

      {/* Warning threshold */}
      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-medium text-slate-400">
          High Volume Warning Threshold
        </label>
        <div className="flex items-center gap-2">
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="30"
            className="w-20 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
          />
          <span className="text-xs text-slate-500">alerts/hour</span>
          <button
            onClick={handleSaveThreshold}
            className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500"
          >
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-600">
          Sends a warning to Telegram when volume exceeds this. Alerts are never blocked.
        </p>
      </div>

      {/* Quiet hours */}
      <div className="mt-5 border-t border-slate-800/60 pt-4">
        <label className="mb-1.5 block text-xs font-medium text-slate-400">
          Quiet Hours <span className="text-slate-500">(leave empty to disable)</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="time"
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
          />
          <span className="text-xs text-slate-500">to</span>
          <input
            type="time"
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
          />
          <input
            type="text"
            value={quietTz}
            onChange={(e) => setQuietTz(e.target.value)}
            placeholder="e.g., Europe/London"
            className="w-44 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
          />
          <button
            onClick={handleSaveQuietHours}
            className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500"
          >
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-600">
          Alerts are suppressed during quiet hours. Supports overnight ranges (e.g., 23:00–07:00).
        </p>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Alerts() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [weeklyStats, setWeeklyStats] = useState<AlertWeeklyStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AlertRule | null>(null);

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
    listSectors().then(setSectors).catch(() => {});
    getAlertWeeklyStats().then(setWeeklyStats).catch(() => {});
  }, [loadRules]);

  const handleCreated = useCallback((rule: AlertRule) => {
    const withStats: AlertRule = {
      ...rule,
      total_deliveries: rule.total_deliveries ?? 0,
      sent_count: rule.sent_count ?? 0,
      last_triggered_at: rule.last_triggered_at ?? null,
    };
    setRules((prev) => [withStats, ...prev]);
  }, []);

  const handleUpdated = useCallback((updated: AlertRule) => {
    setRules((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
  }, []);

  const handleToggle = useCallback(async (rule: AlertRule) => {
    setTogglingIds((prev) => new Set(prev).add(rule.id));
    try {
      const updated = await updateAlertRule(rule.id, { active: !rule.active });
      setRules((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
      toast.success(updated.active ? "Alert rule enabled" : "Alert rule disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update alert rule");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(rule.id);
        return next;
      });
    }
  }, []);

  const handleDelete = useCallback((rule: AlertRule) => {
    setDeleteTarget(rule);
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAlertRule(deleteTarget.id);
      setRules((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      toast.success("Alert rule deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete alert rule");
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Keyword Alerts</h1>
          <p className="mt-1 text-sm text-slate-400">
            Instant Telegram notifications when scored articles match your keywords.
          </p>
        </div>
        {weeklyStats && weeklyStats.sent_this_week > 0 && (
          <div className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-1.5 text-sm text-cyan-300">
            {weeklyStats.sent_this_week} alert{weeklyStats.sent_this_week !== 1 ? "s" : ""} this
            week
          </div>
        )}
      </div>

      {/* Guidance */}
      <div className="rounded-2xl border border-slate-700/50 bg-slate-900/30 p-5">
        <h3 className="text-sm font-semibold text-slate-200">How alerts work</h3>
        <ul className="mt-2 space-y-1.5 text-xs text-slate-400">
          <li>
            Keywords are injected into the LLM scoring prompt for{" "}
            <span className="text-cyan-400">semantic matching</span> — "robot" can match articles
            about "humanoid manufacturer".
          </li>
          <li>
            Both conditions must match:{" "}
            <span className="text-slate-300">minimum score AND keyword match</span>.
          </li>
          <li>
            Link a rule to a <span className="text-violet-300">sector</span> to scope keywords — or
            leave global to match all sectors.
          </li>
          <li>
            Alerts are <span className="text-slate-300">never blocked or rate-limited</span>. A
            warning is sent if volume is high.
          </li>
        </ul>
      </div>

      {/* Create Form */}
      <CreateForm onCreated={handleCreated} sectors={sectors} />

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
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <Button variant="secondary" className="mt-4" onClick={loadRules}>
              Retry
            </Button>
          </div>
        )}

        {!isLoading && !error && rules.length === 0 && (
          <EmptyState
            title="No alert rules yet"
            description="Create your first keyword alert rule above to get instant Telegram notifications."
          />
        )}

        {!isLoading &&
          !error &&
          rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              sectors={sectors}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onUpdated={handleUpdated}
              isToggling={togglingIds.has(rule.id)}
            />
          ))}
      </div>

      {/* Alert Settings */}
      <AlertSettings />

      {/* Delete Confirmation */}
      {deleteTarget && (
        <ConfirmModal
          title="Delete Alert Rule"
          message={`Delete alert rule "${deleteTarget.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
