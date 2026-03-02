import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import Button from "../components/ui/Button";
import { useServerEvents } from "../hooks/useServerEvents";
import {
  listDigestSlots,
  getDigestSlotHistory,
  createDigestSlot,
  updateDigestSlot,
  deleteDigestSlot,
  testDigestSlot,
  clearDigestSlotHistory,
  listPendingDrafts,
  editDraft,
  approveDraft,
  scheduleDraft,
  discardDraft,
  type DigestSlot,
  type DigestSlotRun,
  type DigestSlotCreate,
  type DigestSlotUpdate,
  type DigestDraft,
  listSectors,
  type Sector,
  getDigestSlotDefaults,
  type DigestSlotDefaultsResponse,
} from "../api";

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Tbilisi",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

const DIGEST_MODELS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
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

const TRANSLATION_MODELS: Record<string, { value: string; label: string }[]> = {
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  openai: [
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
};

const DEFAULT_SYSTEM_PROMPT = `You are a senior intelligence analyst. Deliver a telegraphic daily briefing.

You will receive today's scored article feed \u2014 it may contain 10 or 100+ articles. Your job is NOT to summarize every article. Your job is to FILTER ruthlessly and surface only what a decision-maker must know today.

Output ONLY bullet points. Each bullet is ONE short sentence \u2014 what happened and a brief hint at why it matters. End with source [#IDs].

Example:
\u2022 Supreme Court struck down most Trump tariffs \u2014 could trigger $175B in refunds and reshape trade policy [#2, #5]

Rules:
- ONE sentence per bullet. Maximum 30 words. No filler, no elaboration.
- End each bullet with source references like [#1] or [#1, #3]
- Merge related articles into one bullet
- TARGET 7-12 bullets. Slow news day: 5-7. Major day: up to 12. NEVER exceed 12.
- The number of bullets must NOT scale with input size \u2014 30 articles and 100 articles should produce roughly the same number of bullets
- Skip anything routine, incremental, or already well-known. Only surface genuine developments.
- Most impactful first
- Write in English`;

const DEFAULT_TRANSLATION_PROMPT =
  "Translate the following intelligence briefing to Georgian. " +
  "Be concise \u2014 do not expand or elaborate. Each bullet must stay ONE short sentence. " +
  "Do not add words, explanations, or context that is not in the original. " +
  "Keep bullet point structure exactly as-is. " +
  "Keep ALL HTML tags (<b>, <a href>, etc.) and URLs completely unchanged. " +
  "Only translate the human-readable text. Output the translation only, nothing else.";

const MODEL_SHORT_NAMES: Record<string, string> = {
  "claude-sonnet-4-20250514": "Sonnet 4",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-opus-4-20250514": "Opus 4",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "o3-mini": "o3-mini",
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-reasoner": "DeepSeek R1",
  "gemini-2.5-flash": "Gemini Flash",
  "gemini-2.5-pro": "Gemini Pro",
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  gemini: "Gemini",
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useEscapeKey(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortModelName(m: string): string {
  return MODEL_SHORT_NAMES[m] ?? m;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function expiryText(expiresAt: string): { text: string; urgency: "normal" | "amber" | "red" } {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return { text: "Expired", urgency: "red" };
  const hrs = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hrs >= 12) return { text: `${hrs}h left`, urgency: "normal" };
  if (hrs >= 6) return { text: `${hrs}h ${mins}m left`, urgency: "amber" };
  if (hrs >= 1) return { text: `${hrs}h ${mins}m left`, urgency: "red" };
  return { text: `${mins}m left`, urgency: "red" };
}

function daysLabel(days: number[]): string {
  if (!days || days.length === 0) return "None";
  if (days.length === 7) return "Daily";
  if (JSON.stringify([...days].sort()) === JSON.stringify([1, 2, 3, 4, 5])) return "Mon\u2013Fri";
  if (JSON.stringify([...days].sort()) === JSON.stringify([6, 7])) return "Weekends";
  return days.map((d) => DAYS.find((dd) => dd.value === d)?.label ?? "?").join(", ");
}

type SlotFormData = {
  name: string;
  enabled: boolean;
  time: string;
  timezone: string;
  days: number[];
  min_score: number;
  max_articles: number;
  sector_ids: string[] | null;
  language: "en" | "ka";
  system_prompt: string | null;
  translation_prompt: string | null;
  provider: string;
  model: string;
  translation_provider: string;
  translation_model: string;
  auto_post: boolean;
  telegram_chat_id: string | null;
  telegram_enabled: boolean;
  facebook_enabled: boolean;
  linkedin_enabled: boolean;
  telegram_language: "en" | "ka";
  facebook_language: "en" | "ka";
  linkedin_language: "en" | "ka";
  image_telegram: boolean;
  image_facebook: boolean;
  image_linkedin: boolean;
};

/** Current local time as HH:MM, rounded up to next 5 min */
function currentTimeHHMM(): string {
  const now = new Date();
  const m = now.getMinutes();
  const rounded = Math.ceil((m + 1) / 5) * 5;
  const d = new Date(now);
  d.setMinutes(rounded, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function slotToForm(s?: DigestSlot, d?: DigestSlotDefaultsResponse | null): SlotFormData {
  return {
    name: s?.name ?? "",
    enabled: s?.enabled ?? d?.enabled ?? true,
    time: s?.time ?? currentTimeHHMM(),
    timezone: s?.timezone ?? d?.timezone ?? "Asia/Tbilisi",
    days: (s?.days as number[]) ?? d?.days ?? [1, 2, 3, 4, 5, 6, 7],
    min_score: s?.min_score ?? d?.min_score ?? 3,
    max_articles: s?.max_articles ?? d?.max_articles ?? 50,
    sector_ids: (s?.sector_ids as string[]) ?? null,
    language: (s?.language as "en" | "ka") ?? d?.language ?? "en",
    system_prompt: s?.system_prompt ?? null,
    translation_prompt: s?.translation_prompt ?? null,
    provider: s?.provider ?? d?.provider ?? "openai",
    model: s?.model ?? d?.model ?? "gpt-4o",
    translation_provider: s?.translation_provider ?? d?.translation_provider ?? "gemini",
    translation_model: s?.translation_model ?? d?.translation_model ?? "gemini-2.5-flash",
    auto_post: s?.auto_post ?? d?.auto_post ?? true,
    telegram_chat_id: s?.telegram_chat_id ?? null,
    telegram_enabled: s?.telegram_enabled ?? d?.telegram_enabled ?? true,
    facebook_enabled: s?.facebook_enabled ?? d?.facebook_enabled ?? false,
    linkedin_enabled: s?.linkedin_enabled ?? d?.linkedin_enabled ?? false,
    telegram_language: (s?.telegram_language as "en" | "ka") ?? d?.telegram_language ?? "en",
    facebook_language: (s?.facebook_language as "en" | "ka") ?? d?.facebook_language ?? "en",
    linkedin_language: (s?.linkedin_language as "en" | "ka") ?? d?.linkedin_language ?? "en",
    image_telegram: s?.image_telegram ?? d?.image_telegram ?? false,
    image_facebook: s?.image_facebook ?? d?.image_facebook ?? false,
    image_linkedin: s?.image_linkedin ?? d?.image_linkedin ?? false,
  };
}

// ─── ConfirmDialog ──────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmVariant = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscapeKey(open, onCancel);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-100">{title}</h3>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── SlotFormModal ──────────────────────────────────────────────────────────

function SlotFormModal({
  open,
  editingSlot,
  sectors,
  onSave,
  onClose,
  defaults,
}: {
  open: boolean;
  editingSlot: DigestSlot | null;
  sectors: Sector[];
  onSave: (data: DigestSlotCreate | DigestSlotUpdate, id?: string) => Promise<void>;
  onClose: () => void;
  defaults: DigestSlotDefaultsResponse | null;
}) {
  const [form, setForm] = useState<SlotFormData>(() =>
    slotToForm(editingSlot ?? undefined, defaults),
  );
  const [saving, setSaving] = useState(false);
  const isEdit = !!editingSlot;

  useEscapeKey(open, onClose);

  // Reset form when editingSlot changes
  useEffect(() => {
    if (open) setForm(slotToForm(editingSlot ?? undefined, defaults));
  }, [open, editingSlot]);

  const update = <K extends keyof SlotFormData>(key: K, value: SlotFormData[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggleDay = (day: number) => {
    const days = form.days.includes(day)
      ? form.days.filter((d) => d !== day)
      : [...form.days, day].sort();
    update("days", days);
  };

  const handleLanguageChange = (lang: "en" | "ka") => {
    setForm((f) => ({
      ...f,
      language: lang,
      // When switching to English, force all channels to English (no translation available)
      // When switching to Georgian, default all channels to Georgian
      telegram_language: lang,
      facebook_language: lang,
      linkedin_language: lang,
    }));
  };

  const handleProviderChange = (provider: string) => {
    const models = DIGEST_MODELS[provider];
    update("provider", provider);
    if (models && models.length > 0) update("model", models[0].value);
  };

  const handleTranslationProviderChange = (provider: string) => {
    const models = TRANSLATION_MODELS[provider];
    update("translation_provider", provider);
    if (models && models.length > 0) update("translation_model", models[0].value);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (form.days.length === 0) {
      toast.error("Select at least one day");
      return;
    }
    if (!form.telegram_enabled && !form.facebook_enabled && !form.linkedin_enabled) {
      toast.error("At least one platform must be enabled");
      return;
    }
    setSaving(true);
    try {
      await onSave(form, editingSlot?.id);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save slot");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-6">
          <h2 className="text-lg font-semibold text-slate-100">
            {isEdit ? "Edit Digest Slot" : "Create Digest Slot"}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] space-y-6 overflow-y-auto p-6">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-slate-300">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="e.g., Morning Biotech Brief"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            />
            <p className="mt-1 text-xs text-slate-500">A short name to identify this digest slot</p>
          </div>

          {/* Schedule */}
          <fieldset className="space-y-3 rounded-xl border border-slate-800 p-4">
            <legend className="px-2 text-sm font-medium text-slate-400">Schedule</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400">Time</label>
                <input
                  type="text"
                  placeholder="HH:MM"
                  pattern="\d{2}:\d{2}"
                  value={form.time}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d:]/g, "");
                    if (v.length <= 5) update("time", v);
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400">Timezone</label>
                <select
                  value={form.timezone}
                  onChange={(e) => update("timezone", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400">Active Days</label>
              <div className="mt-1 flex gap-1">
                {DAYS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleDay(d.value)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      form.days.includes(d.value)
                        ? "bg-cyan-600/30 text-cyan-300 border border-cyan-600/50"
                        : "bg-slate-800 text-slate-500 border border-slate-700 hover:border-slate-600"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>

          {/* Content Rules */}
          <fieldset className="space-y-3 rounded-xl border border-slate-800 p-4">
            <legend className="px-2 text-sm font-medium text-slate-400">Content Rules</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400">Min Score</label>
                <select
                  value={form.min_score}
                  onChange={(e) => update("min_score", Number(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                >
                  {[1, 2, 3, 4, 5].map((s) => (
                    <option key={s} value={s}>
                      {s}{" "}
                      {s === 1
                        ? "\u2014 All"
                        : s === 2
                          ? "\u2014 Low+"
                          : s === 3
                            ? "\u2014 Medium+"
                            : s === 4
                              ? "\u2014 High+"
                              : "\u2014 Critical"}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Only articles scoring at or above this
                </p>
              </div>
              <div>
                <label className="block text-xs text-slate-400">Max Articles</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={form.max_articles}
                  onChange={(e) =>
                    update("max_articles", Math.min(100, Math.max(1, Number(e.target.value) || 50)))
                  }
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Cap fed to AI. Top by score prioritized.
                </p>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400">Sectors</label>
              <select
                value={form.sector_ids === null ? "__all__" : "__custom__"}
                onChange={(e) => {
                  if (e.target.value === "__all__") update("sector_ids", null);
                  else update("sector_ids", []);
                }}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
              >
                <option value="__all__">All sectors</option>
                <option value="__custom__">Select specific sectors</option>
              </select>
              {form.sector_ids !== null && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sectors.map((sec) => {
                    const selected = form.sector_ids?.includes(sec.id) ?? false;
                    return (
                      <button
                        key={sec.id}
                        type="button"
                        onClick={() => {
                          const ids = form.sector_ids ?? [];
                          update(
                            "sector_ids",
                            selected ? ids.filter((id) => id !== sec.id) : [...ids, sec.id],
                          );
                        }}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                          selected
                            ? "bg-violet-500/20 text-violet-300 border border-violet-500/40"
                            : "bg-slate-800 text-slate-500 border border-slate-700 hover:border-slate-600"
                        }`}
                      >
                        {sec.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-xs text-slate-500">
                Leave as "All" for a full briefing. Select specific sectors to focus.
              </p>
            </div>
            <div>
              <label className="block text-xs text-slate-400">Language</label>
              <div className="mt-1 flex gap-2">
                {(["en", "ka"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => handleLanguageChange(lang)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                      form.language === lang
                        ? "bg-cyan-600/30 text-cyan-300 border border-cyan-600/50"
                        : "bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600"
                    }`}
                  >
                    {lang === "en" ? "English" : "Georgian"}
                  </button>
                ))}
              </div>
              {form.language === "ka" && (
                <p className="mt-1.5 text-xs text-cyan-400/70">
                  Both English and Georgian versions are generated. Each channel below can receive
                  either language at no extra cost.
                </p>
              )}
            </div>
          </fieldset>

          {/* AI Model */}
          <fieldset className="space-y-3 rounded-xl border border-slate-800 p-4">
            <legend className="px-2 text-sm font-medium text-slate-400">AI Model</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400">Provider</label>
                <select
                  value={form.provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                >
                  {Object.keys(DIGEST_MODELS).map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABELS[p] ?? p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400">Model</label>
                <select
                  value={form.model}
                  onChange={(e) => update("model", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                >
                  {(DIGEST_MODELS[form.provider] ?? []).map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <details className="group">
              <summary className="flex cursor-pointer items-center justify-between">
                <span className="text-xs text-slate-400">
                  System Prompt{" "}
                  <span className="text-slate-600 group-open:hidden">(click to expand)</span>
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    update("system_prompt", null);
                  }}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  Reset Default
                </button>
              </summary>
              <textarea
                value={form.system_prompt ?? DEFAULT_SYSTEM_PROMPT}
                onChange={(e) => update("system_prompt", e.target.value)}
                rows={8}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-slate-500"
              />
              <p className="mt-1 text-xs text-slate-500">
                {(form.system_prompt ?? DEFAULT_SYSTEM_PROMPT).length} / 2000 chars
              </p>
            </details>
          </fieldset>

          {/* Translation (visible when ka) */}
          {form.language === "ka" && (
            <fieldset className="space-y-3 rounded-xl border border-slate-800 p-4">
              <legend className="px-2 text-sm font-medium text-slate-400">Translation</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400">Provider</label>
                  <select
                    value={form.translation_provider}
                    onChange={(e) => handleTranslationProviderChange(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  >
                    {Object.keys(TRANSLATION_MODELS).map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p] ?? p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400">Model</label>
                  <select
                    value={form.translation_model}
                    onChange={(e) => update("translation_model", e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  >
                    {(TRANSLATION_MODELS[form.translation_provider] ?? []).map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <details className="group">
                <summary className="flex cursor-pointer items-center justify-between">
                  <span className="text-xs text-slate-400">
                    Translation Prompt{" "}
                    <span className="text-slate-600 group-open:hidden">(click to expand)</span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      update("translation_prompt", null);
                    }}
                    className="text-xs text-slate-500 hover:text-slate-300"
                  >
                    Reset Default
                  </button>
                </summary>
                <textarea
                  value={form.translation_prompt ?? DEFAULT_TRANSLATION_PROMPT}
                  onChange={(e) => update("translation_prompt", e.target.value)}
                  rows={6}
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-slate-500"
                />
              </details>
            </fieldset>
          )}

          {/* Delivery */}
          <fieldset className="space-y-3 rounded-xl border border-slate-800 p-4">
            <legend className="px-2 text-sm font-medium text-slate-400">Delivery</legend>
            <div>
              <label className="block text-xs text-slate-400">Auto-Post</label>
              <div className="mt-1 flex gap-2">
                {([true, false] as const).map((val) => (
                  <button
                    key={String(val)}
                    type="button"
                    onClick={() => update("auto_post", val)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                      form.auto_post === val
                        ? val
                          ? "bg-cyan-600/30 text-cyan-300 border border-cyan-600/50"
                          : "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                        : "bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600"
                    }`}
                  >
                    {val ? "Auto" : "Manual"}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {form.auto_post
                  ? "Digest generates and posts automatically at scheduled time."
                  : "Digest generates as a draft. You review, edit, and approve it."}
              </p>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={form.telegram_enabled}
                  onChange={(e) => update("telegram_enabled", e.target.checked)}
                  className="rounded border-slate-600 bg-slate-950 text-cyan-500 focus:ring-0"
                />
                Telegram
              </label>
              {form.telegram_enabled && (
                <div className="ml-6 flex items-center gap-3">
                  <input
                    type="text"
                    value={form.telegram_chat_id ?? ""}
                    onChange={(e) => update("telegram_chat_id", e.target.value || null)}
                    placeholder="Chat ID (e.g., -100...)"
                    className="w-52 rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                  />
                  {form.language === "ka" && (
                    <div className="flex gap-1">
                      {(["en", "ka"] as const).map((l) => (
                        <button
                          key={l}
                          type="button"
                          onClick={() => update("telegram_language", l)}
                          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase transition ${form.telegram_language === l ? "bg-cyan-600/30 text-cyan-300" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.facebook_enabled}
                    onChange={(e) => update("facebook_enabled", e.target.checked)}
                    className="rounded border-slate-600 bg-slate-950 text-cyan-500 focus:ring-0"
                  />
                  Facebook
                </label>
                {form.facebook_enabled && form.language === "ka" && (
                  <div className="flex gap-1">
                    {(["en", "ka"] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => update("facebook_language", l)}
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase transition ${form.facebook_language === l ? "bg-cyan-600/30 text-cyan-300" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.linkedin_enabled}
                    onChange={(e) => update("linkedin_enabled", e.target.checked)}
                    className="rounded border-slate-600 bg-slate-950 text-cyan-500 focus:ring-0"
                  />
                  LinkedIn
                </label>
                {form.linkedin_enabled && form.language === "ka" && (
                  <div className="flex gap-1">
                    {(["en", "ka"] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => update("linkedin_language", l)}
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase transition ${form.linkedin_language === l ? "bg-cyan-600/30 text-cyan-300" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500">At least one channel must be enabled.</p>
            </div>
            <div>
              <label className="block text-xs text-slate-400">Cover Image</label>
              <div className="mt-1 flex gap-3">
                {(["telegram", "facebook", "linkedin"] as const).map((p) => {
                  const key = `image_${p}` as keyof SlotFormData;
                  return (
                    <label key={p} className="flex items-center gap-1.5 text-xs text-slate-400">
                      <input
                        type="checkbox"
                        checked={form[key] as boolean}
                        onChange={(e) => update(key, e.target.checked as never)}
                        className="rounded border-slate-600 bg-slate-950 text-cyan-500 focus:ring-0"
                      />
                      {p === "telegram" ? "TG" : p === "facebook" ? "FB" : "LI"}
                    </label>
                  );
                })}
              </div>
            </div>
          </fieldset>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-slate-800 p-6">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={saving}>
            {isEdit ? "Save Changes" : "Create Slot"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── DraftPreviewModal ─────────────────────────────────────────────────────

function DraftPreviewModal({
  draft,
  slot,
  onClose,
  onApprove,
  onSchedule,
  onDiscard,
  onEdit,
}: {
  draft: DigestDraft;
  slot?: DigestSlot | null;
  onClose: () => void;
  onApprove: () => void;
  onSchedule: () => void;
  onDiscard: () => void;
  onEdit: () => void;
}) {
  useEscapeKey(true, onClose);
  const expiry = expiryText(draft.expires_at);
  const isDraft = draft.status === "draft";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              Draft Preview {draft.slot_name && `\u2014 ${draft.slot_name}`}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Generated {relativeTime(draft.generated_at)} {"\u00B7"} {draft.article_count} articles{" "}
              {"\u00B7"} {shortModelName(draft.model)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6">
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
            <pre className="whitespace-pre-wrap text-sm text-slate-200">
              {draft.translated_text || draft.generated_text}
            </pre>
          </div>

          <div className="mt-4 space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
            <div className="flex flex-wrap gap-4">
              <span>
                Articles: {draft.article_count} of {draft.stats_above_threshold} qualifying
              </span>
              <span>LLM: {shortModelName(draft.model)}</span>
              {draft.llm_cost_microdollars != null && (
                <span>${(draft.llm_cost_microdollars / 1_000_000).toFixed(4)}</span>
              )}
              {draft.translation_model && (
                <>
                  <span className="text-slate-600">|</span>
                  <span>Translation: {shortModelName(draft.translation_model)}</span>
                  {draft.translation_cost_microdollars != null && (
                    <span>${(draft.translation_cost_microdollars / 1_000_000).toFixed(4)}</span>
                  )}
                </>
              )}
              {(draft.llm_cost_microdollars != null ||
                draft.translation_cost_microdollars != null) && (
                <>
                  <span className="text-slate-600">|</span>
                  <span className="font-medium text-slate-300">
                    Total: $
                    {(
                      ((draft.llm_cost_microdollars ?? 0) +
                        (draft.translation_cost_microdollars ?? 0)) /
                      1_000_000
                    ).toFixed(4)}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-4">
              <span
                className={
                  expiry.urgency === "red"
                    ? "text-red-400"
                    : expiry.urgency === "amber"
                      ? "text-amber-400"
                      : ""
                }
              >
                {expiry.text}
              </span>
              {slot && (slot.image_telegram || slot.image_facebook || slot.image_linkedin) && (
                <span className="text-emerald-400/70">
                  Images:{" "}
                  {[
                    slot.image_telegram && "TG",
                    slot.image_facebook && "FB",
                    slot.image_linkedin && "LI",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              )}
              {slot && !slot.image_telegram && !slot.image_facebook && !slot.image_linkedin && (
                <span className="text-slate-500">Images: off</span>
              )}
            </div>
          </div>
        </div>

        {isDraft && (
          <div className="flex justify-between border-t border-slate-800 p-6">
            <Button variant="danger" size="sm" onClick={onDiscard}>
              Discard
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="secondary" size="sm" onClick={onSchedule}>
                Schedule
              </Button>
              <Button variant="primary" size="sm" onClick={onApprove}>
                Post Now
              </Button>
            </div>
          </div>
        )}
        {draft.status === "approved" && !draft.sent_at && (
          <div className="flex items-center justify-between border-t border-slate-800 p-6">
            <span className="text-sm text-emerald-400">
              {draft.scheduled_at
                ? `Posting at ${new Date(draft.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Approved"}
            </span>
            <Button variant="secondary" size="sm" onClick={onSchedule}>
              Reschedule
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DraftEditModal ─────────────────────────────────────────────────────────

function DraftEditModal({
  draft,
  onClose,
  onSave,
}: {
  draft: DigestDraft;
  onClose: () => void;
  onSave: (text: string, translatedText: string | null) => Promise<void>;
}) {
  const [text, setText] = useState(draft.generated_text);
  const [translated, setTranslated] = useState(draft.translated_text ?? "");
  const [saving, setSaving] = useState(false);

  useEscapeKey(true, onClose);

  const handleSave = async () => {
    if (!text.trim()) {
      toast.error("Text cannot be empty");
      return;
    }
    setSaving(true);
    try {
      await onSave(text, translated || null);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-800 p-6">
          <h2 className="text-lg font-semibold text-slate-100">
            Edit Draft {draft.slot_name && `\u2014 ${draft.slot_name}`}
          </h2>
          <p className="mt-1 text-xs text-amber-400">
            Changes are saved immediately but not posted until approved.
          </p>
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto p-6">
          <div>
            <label className="block text-sm font-medium text-slate-300">English Text</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              className="mt-1 w-full resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-slate-500"
            />
          </div>
          {draft.translated_text !== null && (
            <div>
              <label className="block text-sm font-medium text-slate-300">
                Georgian Translation
              </label>
              <textarea
                value={translated}
                onChange={(e) => setTranslated(e.target.value)}
                rows={8}
                className="mt-1 w-full resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-slate-500"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-800 p-6">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── ScheduleModal ──────────────────────────────────────────────────────────

function ScheduleModal({
  draft,
  onClose,
  onSchedule,
}: {
  draft: DigestDraft;
  onClose: () => void;
  onSchedule: (scheduledAt: string) => Promise<void>;
}) {
  const [date, setDate] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });
  const [time, setTime] = useState(() => {
    const d = new Date(Date.now() + 3600_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [saving, setSaving] = useState(false);

  useEscapeKey(true, onClose);

  const handleSchedule = async () => {
    const dt = new Date(`${date}T${time}`);
    if (isNaN(dt.getTime())) {
      toast.error("Invalid date/time");
      return;
    }
    if (dt.getTime() < Date.now() - 120_000) {
      toast.error("Scheduled time must be in the future");
      return;
    }
    setSaving(true);
    try {
      await onSchedule(dt.toISOString());
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to schedule");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-100">Schedule Delivery</h3>
        <p className="mt-1 text-sm text-slate-400">
          Draft for "{draft.slot_name}" will be posted at the selected time.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSchedule} loading={saving}>
            Schedule
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

export default function DigestSettings() {
  const [slots, setSlots] = useState<DigestSlot[]>([]);
  const [drafts, setDrafts] = useState<DigestDraft[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [slotDefaults, setSlotDefaults] = useState<DigestSlotDefaultsResponse | null>(null);
  const [history, setHistory] = useState<DigestSlotRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [testingSlotId, setTestingSlotId] = useState<string | null>(null);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editingSlot, setEditingSlot] = useState<DigestSlot | null>(null);
  const [previewDraft, setPreviewDraft] = useState<DigestDraft | null>(null);
  const [editingDraft, setEditingDraft] = useState<DigestDraft | null>(null);
  const [schedulingDraft, setSchedulingDraft] = useState<DigestDraft | null>(null);

  // Confirm dialogs
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    confirmVariant: "danger" | "primary";
    onConfirm: () => void;
  }>({
    open: false,
    title: "",
    message: "",
    confirmLabel: "",
    confirmVariant: "danger",
    onConfirm: () => {},
  });

  // Test polling
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Load data ──
  const loadAll = useCallback(async () => {
    try {
      const [slotData, draftData, sectorData, defaultsData] = await Promise.all([
        listDigestSlots(),
        listPendingDrafts(),
        listSectors(),
        getDigestSlotDefaults(),
      ]);
      setSlots(slotData);
      setDrafts(draftData);
      setSectors(sectorData);
      setSlotDefaults(defaultsData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load digest data");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadHistory = useCallback(
    async (slotId?: string) => {
      setHistoryLoading(true);
      try {
        if (slotId) {
          const data = await getDigestSlotHistory(slotId, 30);
          setHistory(data.runs);
        } else if (slots.length > 0) {
          // Load from all slots, merge & sort by sent_at desc
          const results = await Promise.all(slots.map((s) => getDigestSlotHistory(s.id, 30)));
          const merged = results.flatMap((r) => r.runs);
          merged.sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
          setHistory(merged);
        }
      } catch {
        /* silent */
      } finally {
        setHistoryLoading(false);
      }
    },
    [slots],
  );

  // SSE: auto-refresh when a new draft is ready
  useServerEvents({
    onEvent: (event) => {
      if (event.type === "digest:draft-ready") {
        toast.info(
          `New digest draft: ${event.data.slotName} (${event.data.articleCount} articles)`,
        );
        loadAll();
      }
      if (event.type === "digest:sent") {
        const label = event.data.isTest ? "Test digest" : "Digest";
        toast.success(
          `${label} sent: ${event.data.slotName} (${event.data.articleCount} articles)`,
        );
        loadAll();
        if (slots.length > 0) loadHistory();
      }
    },
  });

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (slots.length > 0 && history.length === 0) loadHistory();
  }, [slots, history.length, loadHistory]);

  // ── Slot CRUD ──
  const handleSaveSlot = async (data: DigestSlotCreate | DigestSlotUpdate, id?: string) => {
    if (id) {
      await updateDigestSlot(id, data);
      toast.success("Slot updated");
    } else {
      await createDigestSlot(data as DigestSlotCreate);
      toast.success("Slot created");
    }
    await loadAll();
  };

  const handleDeleteSlot = (slot: DigestSlot) => {
    setConfirmState({
      open: true,
      title: "Delete digest slot?",
      message: `Delete "${slot.name}"? The schedule will be removed permanently. Digest history will be preserved.`,
      confirmLabel: "Delete",
      confirmVariant: "danger",
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, open: false }));
        try {
          await deleteDigestSlot(slot.id);
          toast.success("Slot deleted");
          await loadAll();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to delete slot");
        }
      },
    });
  };

  const handleClearHistory = () => {
    if (history.length === 0) return;
    setConfirmState({
      open: true,
      title: "Clear digest history?",
      message: `This will permanently delete ${history.length} history record${history.length > 1 ? "s" : ""}. Drafts are not affected.`,
      confirmLabel: "Clear",
      confirmVariant: "danger",
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, open: false }));
        try {
          await Promise.all(slots.map((s) => clearDigestSlotHistory(s.id)));
          setHistory([]);
          toast.success("History cleared");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to clear history");
        }
      },
    });
  };

  const handleTestSlot = async (slot: DigestSlot) => {
    setTestingSlotId(slot.id);
    try {
      await testDigestSlot(slot.id);
      toast.success(`Test digest queued for "${slot.name}"`);

      // Poll for result
      const preCount = history.length;
      const startedAt = Date.now();
      stopPolling();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > 120_000) {
          stopPolling();
          setTestingSlotId(null);
          toast.info("Digest is still processing \u2014 refresh manually");
          return;
        }
        try {
          const data = await getDigestSlotHistory(slot.id, 30);
          if (data.runs.length > preCount) {
            stopPolling();
            setTestingSlotId(null);
            toast.success("Test digest result received");
            await loadAll();
            await loadHistory();
          }
        } catch {
          /* keep polling */
        }
      }, 5_000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to queue test");
      setTestingSlotId(null);
    }
  };

  // ── Draft actions ──
  const handleApproveDraft = (draft: DigestDraft) => {
    // We don't have per-draft platform info easily, so show generic message
    setConfirmState({
      open: true,
      title: "Send digest now?",
      message: `This will post the digest for "${draft.slot_name}" immediately. This action cannot be undone.`,
      confirmLabel: "Send Now",
      confirmVariant: "primary",
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, open: false }));
        try {
          await approveDraft(draft.slot_id, draft.id);
          toast.success("Digest approved & delivery queued");
          setPreviewDraft(null);
          await loadAll();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to approve");
        }
      },
    });
  };

  const handleDiscardDraft = (draft: DigestDraft) => {
    setConfirmState({
      open: true,
      title: "Discard this draft?",
      message: `The draft for "${draft.slot_name}" will be discarded. ${draft.article_count} articles will become available for future digests.`,
      confirmLabel: "Discard",
      confirmVariant: "danger",
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, open: false }));
        try {
          await discardDraft(draft.slot_id, draft.id);
          toast.success("Draft discarded");
          setPreviewDraft(null);
          await loadAll();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to discard");
        }
      },
    });
  };

  const handleEditDraftSave = async (text: string, translatedText: string | null) => {
    if (!editingDraft) return;
    await editDraft(editingDraft.slot_id, editingDraft.id, {
      generated_text: text,
      translated_text: translatedText,
    });
    toast.success("Draft updated");
    await loadAll();
  };

  const handleScheduleDraft = async (scheduledAt: string) => {
    if (!schedulingDraft) return;
    await scheduleDraft(schedulingDraft.slot_id, schedulingDraft.id, scheduledAt);
    toast.success("Draft scheduled");
    setPreviewDraft(null);
    await loadAll();
  };

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Digests</h1>
          <p className="mt-0.5 text-sm text-slate-500">Multi-schedule intelligence briefings</p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setEditingSlot(null);
            setFormOpen(true);
          }}
        >
          + New Slot
        </Button>
      </div>

      {/* How It Works — collapsible guide */}
      <details className="group rounded-2xl border border-slate-800 bg-slate-900/40">
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-slate-400 hover:text-slate-200">
          How digests work
          <span className="ml-1.5 text-xs text-slate-600 group-open:hidden">
            {"(click to expand)"}
          </span>
        </summary>
        <div className="border-t border-slate-800 px-5 pb-4 pt-3 text-xs leading-relaxed text-slate-400">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 font-semibold text-slate-300">Article Selection</p>
              <ul className="list-inside list-disc space-y-1">
                <li>
                  <b className="text-slate-300">Lookback window</b> — picks articles scored since
                  the last successful run for this slot, capped at 24 h.
                </li>
                <li>
                  <b className="text-slate-300">Min Score filter</b> — only articles at or above the
                  slot{"'"}s threshold are included.
                </li>
                <li>
                  <b className="text-slate-300">Priority order</b> — highest scores first (5{" "}
                  {"\u2192"} 4 {"\u2192"} 3), newest first within ties.
                </li>
                <li>
                  <b className="text-slate-300">Max Articles cap</b> — hard limit fed to the AI.
                  Lower scores get truncated first.
                </li>
                <li>
                  <b className="text-slate-300">Sector filter</b> — optional. Leave blank for all
                  sectors.
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-1.5 font-semibold text-slate-300">Pipeline</p>
              <ol className="list-inside list-decimal space-y-1">
                <li>Scheduler fires at the configured time {"\u0026"} timezone.</li>
                <li>AI reads selected articles and writes a curated briefing (7-12 bullets).</li>
                <li>
                  If language is Georgian, the briefing is translated automatically (English AI{" "}
                  {"\u2192"} Georgian translation).
                </li>
                <li>
                  <b className="text-slate-300">Per-channel language</b> — when set to Georgian,
                  each channel (Telegram, Facebook, LinkedIn) can independently receive English or
                  Georgian at no extra cost, since both versions already exist.
                </li>
                <li>
                  <b className="text-slate-300">Auto-post</b> — sends immediately to enabled
                  channels.
                </li>
                <li>
                  <b className="text-slate-300">Manual</b> — saves a draft (expires in 24 h).
                  Preview, edit, then post or schedule.
                </li>
              </ol>
              <p className="mt-2 text-slate-500">
                Tip: use <b className="text-slate-400">Test</b> on a slot to preview output without
                affecting the schedule.
              </p>
            </div>
          </div>
        </div>
      </details>

      {/* Pending Drafts Banner */}
      {drafts.length > 0 && (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <h2 className="text-sm font-semibold text-amber-300">
            Pending Digests ({drafts.length})
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((d) => {
              const expiry = expiryText(d.expires_at);
              return (
                <div
                  key={d.id}
                  className={`rounded-xl border p-4 ${
                    expiry.urgency === "red"
                      ? "border-red-500/40 bg-red-500/5"
                      : expiry.urgency === "amber"
                        ? "border-amber-500/30 bg-amber-500/5"
                        : "border-slate-700 bg-slate-900/60"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200">{d.slot_name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {d.article_count} articles {"\u00B7"} {relativeTime(d.generated_at)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 text-xs ${
                        expiry.urgency === "red"
                          ? "text-red-400"
                          : expiry.urgency === "amber"
                            ? "text-amber-400"
                            : "text-slate-500"
                      }`}
                      title="Time before this draft auto-expires. Drafts expire 24h after generation if not approved."
                    >
                      {expiry.text}
                    </span>
                  </div>
                  {/* Score distribution sparkline */}
                  {d.score_distribution &&
                    Object.keys(d.score_distribution).length > 0 &&
                    (() => {
                      const dist = d.score_distribution!;
                      const total = Object.values(dist).reduce((a, b) => a + b, 0);
                      if (total === 0) return null;
                      const SPARK_COLORS: Record<number, string> = {
                        1: "bg-red-500",
                        2: "bg-orange-400",
                        3: "bg-amber-400",
                        4: "bg-emerald-400",
                        5: "bg-emerald-300",
                      };
                      const SPARK_TEXT: Record<number, string> = {
                        1: "text-red-400",
                        2: "text-orange-400",
                        3: "text-amber-400",
                        4: "text-emerald-400",
                        5: "text-emerald-300",
                      };
                      const segments = [1, 2, 3, 4, 5]
                        .map((s) => ({ score: s, count: dist[String(s)] ?? 0 }))
                        .filter((s) => s.count > 0);
                      return (
                        <div className="mt-2">
                          <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
                            {segments.map(({ score, count }) => (
                              <div
                                key={score}
                                className={SPARK_COLORS[score]}
                                style={{ width: `${(count / total) * 100}%` }}
                                title={`Score ${score}: ${count} articles`}
                              />
                            ))}
                          </div>
                          <div className="mt-0.5 flex w-full">
                            {segments.map(({ score, count }) => (
                              <div
                                key={score}
                                className={`text-center text-[9px] leading-tight ${SPARK_TEXT[score]}`}
                                style={{ width: `${(count / total) * 100}%` }}
                              >
                                {count / total >= 0.08 ? `${score}:${count}` : count}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                  {/* Stats row: model, funnel, cost */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                    <span title={`LLM: ${d.provider}/${d.model}`}>{shortModelName(d.model)}</span>
                    <span className="text-slate-700">{"\u00B7"}</span>
                    <span
                      title={`${d.stats_scanned} scanned \u2192 ${d.stats_scored} scored \u2192 ${d.stats_above_threshold} above threshold`}
                    >
                      {d.stats_scanned} {"\u2192"} {d.stats_above_threshold} qualifying
                    </span>
                    {(d.llm_cost_microdollars || d.translation_cost_microdollars) && (
                      <>
                        <span className="text-slate-700">{"\u00B7"}</span>
                        <span>
                          $
                          {(
                            ((d.llm_cost_microdollars ?? 0) +
                              (d.translation_cost_microdollars ?? 0)) /
                            1_000_000
                          ).toFixed(4)}
                        </span>
                      </>
                    )}
                    {d.edited && (
                      <>
                        <span className="text-slate-700">{"\u00B7"}</span>
                        <span className="text-amber-400/80">Edited</span>
                      </>
                    )}
                  </div>

                  <div className="mt-2.5 flex items-center gap-2">
                    <Button size="xs" variant="secondary" onClick={() => setPreviewDraft(d)}>
                      Preview
                    </Button>
                    {d.status === "draft" ? (
                      <Button size="xs" variant="primary" onClick={() => handleApproveDraft(d)}>
                        Post Now
                      </Button>
                    ) : d.status === "approved" && d.scheduled_at ? (
                      <>
                        <span className="text-xs text-emerald-400">
                          Posting{" "}
                          {new Date(d.scheduled_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <Button size="xs" variant="secondary" onClick={() => setSchedulingDraft(d)}>
                          Reschedule
                        </Button>
                      </>
                    ) : d.status === "approved" ? (
                      <span className="text-xs text-emerald-400">Approved</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Slot List */}
      {slots.length === 0 ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center">
          <p className="text-lg font-medium text-slate-300">No digest slots yet</p>
          <p className="mt-2 text-sm text-slate-500">
            Create your first digest slot to start sending AI-curated intelligence briefings. Each
            slot is an independent schedule with its own timing, content rules, and delivery
            channels.
          </p>
          <div className="mt-6">
            <Button
              variant="primary"
              onClick={() => {
                setEditingSlot(null);
                setFormOpen(true);
              }}
            >
              Create First Slot
            </Button>
          </div>
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-400">Digest Slots ({slots.length})</h2>
          {slots.map((slot) => {
            const days = Array.isArray(slot.days) ? (slot.days as number[]) : [];
            const platforms: { label: string; lang?: "en" | "ka" }[] = [];
            if (slot.telegram_enabled)
              platforms.push({
                label: "TG",
                lang: slot.language === "ka" ? slot.telegram_language : undefined,
              });
            if (slot.facebook_enabled)
              platforms.push({
                label: "FB",
                lang: slot.language === "ka" ? slot.facebook_language : undefined,
              });
            if (slot.linkedin_enabled)
              platforms.push({
                label: "LI",
                lang: slot.language === "ka" ? slot.linkedin_language : undefined,
              });
            const sectorNames =
              slot.sector_ids && Array.isArray(slot.sector_ids)
                ? (slot.sector_ids as string[])
                    .map((id) => sectors.find((s) => s.id === id)?.name)
                    .filter(Boolean)
                : null;

            return (
              <div
                key={slot.id}
                className={`rounded-2xl border bg-slate-900/40 p-5 ${
                  slot.enabled ? "border-slate-800" : "border-slate-800/50 opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left: name + badges */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          slot.enabled ? "bg-emerald-400" : "bg-slate-600"
                        }`}
                      />
                      <h3 className="text-sm font-semibold text-slate-100">{slot.name}</h3>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          slot.auto_post
                            ? "bg-cyan-600/20 text-cyan-300"
                            : "bg-amber-500/20 text-amber-300"
                        }`}
                      >
                        {slot.auto_post ? "Auto" : "Manual"}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {platforms.map((p) => (
                        <span
                          key={p.label}
                          className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400"
                        >
                          {p.label}
                          {p.lang ? (
                            <span
                              className={p.lang === "ka" ? " text-violet-300" : " text-slate-500"}
                            >
                              {" "}
                              {p.lang.toUpperCase()}
                            </span>
                          ) : null}
                        </span>
                      ))}
                      {slot.language === "ka" && (
                        <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-xs text-violet-300">
                          KA
                        </span>
                      )}
                      {sectorNames ? (
                        sectorNames.map((name) => (
                          <span
                            key={name}
                            className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs text-violet-300/80"
                          >
                            {name}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-slate-500">All sectors</span>
                      )}
                    </div>
                    {/* Metadata row: model, min score, max articles, cover images */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span
                        className="rounded-full bg-slate-800/60 px-2 py-0.5 text-xs text-slate-500"
                        title={`LLM: ${slot.provider}/${slot.model}`}
                      >
                        {shortModelName(slot.model)}
                      </span>
                      <span
                        className="rounded-full bg-slate-800/60 px-2 py-0.5 text-xs text-slate-500"
                        title="Minimum importance score for inclusion"
                      >
                        {"\u2265"}
                        {slot.min_score}
                      </span>
                      <span
                        className="rounded-full bg-slate-800/60 px-2 py-0.5 text-xs text-slate-500"
                        title="Maximum articles per digest"
                      >
                        max {slot.max_articles}
                      </span>
                      {(slot.image_telegram || slot.image_facebook || slot.image_linkedin) && (
                        <span
                          className="rounded-full bg-slate-800/60 px-2 py-0.5 text-xs text-slate-500"
                          title={`Cover images: ${[slot.image_telegram && "TG", slot.image_facebook && "FB", slot.image_linkedin && "LI"].filter(Boolean).join(", ")}`}
                        >
                          {"IMG "}
                          {[
                            slot.image_telegram && "TG",
                            slot.image_facebook && "FB",
                            slot.image_linkedin && "LI",
                          ]
                            .filter(Boolean)
                            .join("+")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right: schedule + stats + actions */}
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium text-slate-300">
                      {slot.time} {slot.timezone === "UTC" ? "UTC" : slot.timezone.split("/").pop()}
                    </p>
                    <p className="text-xs text-slate-500">{daysLabel(days)}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Last: {relativeTime(slot.last_run_at)} {"\u00B7"} {slot.total_runs ?? 0} runs
                    </p>
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => handleTestSlot(slot)}
                        loading={testingSlotId === slot.id}
                        loadingText="Testing..."
                      >
                        Test
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => {
                          setEditingSlot(slot);
                          setFormOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="xs" variant="danger" onClick={() => handleDeleteSlot(slot)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* History */}
      {slots.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40">
          <div className="flex items-center justify-between p-5">
            <h2 className="text-sm font-semibold text-slate-400">History</h2>
            <div className="flex gap-2">
              {history.length > 0 && (
                <Button size="xs" variant="danger" onClick={handleClearHistory}>
                  Clear
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={() => loadHistory()}
                loading={historyLoading}
              >
                Refresh
              </Button>
            </div>
          </div>
          {history.length === 0 ? (
            <div className="border-t border-slate-800 px-5 py-8 text-center text-sm text-slate-500">
              No digests sent yet. Configure a slot and use the Test button to verify.
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800 bg-slate-900/60 text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Slot</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Lang</th>
                    <th className="px-4 py-2 font-medium">Funnel</th>
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 font-medium">Channels</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {history.map((r) => {
                    const slot = slots.find((s) => s.id === r.slot_id);
                    return (
                      <tr key={r.id} className="text-slate-300">
                        <td className="whitespace-nowrap px-4 py-2">
                          {new Date(r.sent_at).toLocaleString("en-GB", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-4 py-2">
                          {slot?.name ?? <span className="italic text-slate-500">deleted</span>}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-xs ${
                              r.is_test
                                ? "bg-amber-500/20 text-amber-300"
                                : "bg-emerald-500/20 text-emerald-300"
                            }`}
                          >
                            {r.is_test ? "Test" : "Live"}
                          </span>
                        </td>
                        <td className="px-4 py-2 uppercase">{r.language}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1 whitespace-nowrap text-xs">
                            <span
                              className="text-slate-500"
                              title="Total articles in lookback window"
                            >
                              {r.stats_scanned} <span className="text-[10px]">scanned</span>
                            </span>
                            <span className="text-slate-600">{"\u2192"}</span>
                            <span
                              className="text-slate-400"
                              title="Articles with score >= min_score"
                            >
                              {r.stats_above_threshold}{" "}
                              <span className="text-[10px]">qualified</span>
                            </span>
                            <span className="text-slate-600">{"\u2192"}</span>
                            <span
                              className="font-medium text-slate-200"
                              title="Articles fed to the AI"
                            >
                              {r.article_count}{" "}
                              <span className="text-[10px] font-normal">used</span>
                            </span>
                            {r.max_articles != null && r.article_count >= r.max_articles && (
                              <span
                                className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-300"
                                title={`${r.stats_above_threshold} qualified but limited to ${r.max_articles} max`}
                              >
                                cap:{r.max_articles}
                              </span>
                            )}
                          </div>
                          {r.score_distribution && Object.keys(r.score_distribution).length > 0 && (
                            <div className="mt-0.5 flex gap-1.5 text-[10px]">
                              {[5, 4, 3, 2, 1].map((score) => {
                                const cnt = (r.score_distribution as Record<string, number>)?.[
                                  String(score)
                                ];
                                if (!cnt) return null;
                                return (
                                  <span
                                    key={score}
                                    className={
                                      score >= 4
                                        ? "text-emerald-400/70"
                                        : score === 3
                                          ? "text-amber-400/70"
                                          : "text-slate-500"
                                    }
                                  >
                                    {"\u2605"}
                                    {score}:{cnt}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2">{shortModelName(r.model)}</td>
                        <td className="px-4 py-2">
                          {(r.channels ?? []).map((ch) => {
                            const result = r.channel_results
                              ? (r.channel_results as Record<string, string>)[ch]
                              : null;
                            return (
                              <span
                                key={ch}
                                className={`mr-1 rounded px-1.5 py-0.5 text-xs ${
                                  result === "sent"
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : "bg-red-500/20 text-red-300"
                                }`}
                              >
                                {ch}
                              </span>
                            );
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── Modals ── */}
      <SlotFormModal
        open={formOpen}
        editingSlot={editingSlot}
        sectors={sectors}
        onSave={handleSaveSlot}
        onClose={() => setFormOpen(false)}
        defaults={slotDefaults}
      />

      {previewDraft && (
        <DraftPreviewModal
          draft={previewDraft}
          slot={slots.find((s) => s.id === previewDraft.slot_id) ?? null}
          onClose={() => setPreviewDraft(null)}
          onApprove={() => handleApproveDraft(previewDraft)}
          onSchedule={() => {
            setSchedulingDraft(previewDraft);
            setPreviewDraft(null);
          }}
          onDiscard={() => handleDiscardDraft(previewDraft)}
          onEdit={() => {
            setEditingDraft(previewDraft);
            setPreviewDraft(null);
          }}
        />
      )}

      {editingDraft && (
        <DraftEditModal
          draft={editingDraft}
          onClose={() => setEditingDraft(null)}
          onSave={handleEditDraftSave}
        />
      )}

      {schedulingDraft && (
        <ScheduleModal
          draft={schedulingDraft}
          onClose={() => setSchedulingDraft(null)}
          onSchedule={handleScheduleDraft}
        />
      )}

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        confirmVariant={confirmState.confirmVariant}
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
      />
    </div>
  );
}
