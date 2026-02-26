import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import Button from "../components/ui/Button";
import {
  getDigestConfig,
  updateDigestConfig,
  sendTestDigest,
  getDigestHistory,
  clearDigestHistory,
  type DigestConfig,
  type DigestRun,
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

You will receive today's scored article feed — it may contain 10 or 100+ articles. Your job is NOT to summarize every article. Your job is to FILTER ruthlessly and surface only what a decision-maker must know today.

Output ONLY bullet points. Each bullet is ONE short sentence — what happened and a brief hint at why it matters. End with source [#IDs].

Example:
\u2022 Supreme Court struck down most Trump tariffs — could trigger $175B in refunds and reshape trade policy [#2, #5]

Rules:
- ONE sentence per bullet. Maximum 30 words. No filler, no elaboration.
- End each bullet with source references like [#1] or [#1, #3]
- Merge related articles into one bullet
- TARGET 7-12 bullets. Slow news day: 5-7. Major day: up to 12. NEVER exceed 12.
- The number of bullets must NOT scale with input size — 30 articles and 100 articles should produce roughly the same number of bullets
- Skip anything routine, incremental, or already well-known. Only surface genuine developments.
- Most impactful first
- Write in English`;

const DEFAULT_TRANSLATION_PROMPT =
  "Translate the following intelligence briefing to Georgian. " +
  "Be concise — do not expand or elaborate. Each bullet must stay ONE short sentence. " +
  "Do not add words, explanations, or context that is not in the original. " +
  "Keep bullet point structure exactly as-is. " +
  "Keep ALL HTML tags (<b>, <a href>, etc.) and URLs completely unchanged. " +
  "Only translate the human-readable text. Output the translation only, nothing else.";

// ─── LocalStorage collapse helpers ───────────────────────────────────────────

const LS_PREFIX = "digestSettings_";
const defaultOpen: Record<string, boolean> = {
  prompt: false,
  digestModel: false,
  translationModel: false,
  channels: false,
  history: true,
};

function readCollapse(key: string): boolean {
  try {
    const v = localStorage.getItem(LS_PREFIX + key);
    if (v !== null) return v === "1";
  } catch { /* noop */ }
  return defaultOpen[key] ?? false;
}

function writeCollapse(key: string, open: boolean) {
  try {
    localStorage.setItem(LS_PREFIX + key, open ? "1" : "0");
  } catch { /* noop */ }
}

// ─── Collapsible section component ──────────────────────────────────────────

function Collapsible({
  storeKey,
  title,
  subtitle,
  trailing,
  children,
}: {
  storeKey: string;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readCollapse(storeKey));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeCollapse(storeKey, next);
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-6 text-left"
      >
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trailing}
          <svg
            className={`h-5 w-5 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && <div className="border-t border-slate-800 p-6 pt-4">{children}</div>}
    </section>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLastSent(iso: string | null): string {
  if (!iso) return "Never sent";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never sent";
  const now = Date.now();
  const diffMs = now - d.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "Less than an hour ago";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

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

function shortModelName(model: string): string {
  return MODEL_SHORT_NAMES[model] ?? model;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DigestSettings() {
  const [config, setConfig] = useState<DigestConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DigestRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const data = await getDigestHistory(30);
      setHistory(data);
    } catch { /* silent */ } finally {
      setHistoryLoading(false);
    }
  };

  const [isClearing, setIsClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleClearHistory = async () => {
    setShowClearConfirm(false);
    setIsClearing(true);
    try {
      const result = await clearDigestHistory();
      setHistory([]);
      toast.success(`Cleared ${result.deleted} digest history record${result.deleted === 1 ? "" : "s"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to clear history";
      toast.error(msg);
    } finally {
      setIsClearing(false);
    }
  };

  // Load config + history on mount
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getDigestConfig();
        if (!cancelled) setConfig(data);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load digest config";
          setError(msg);
          toast.error(msg);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setIsSaving(true);
    try {
      await updateDigestConfig({
        enabled: config.enabled,
        time: config.time,
        timezone: config.timezone,
        days: config.days,
        minScore: config.minScore,
        language: config.language,
        systemPrompt: config.systemPrompt,
        telegramChatId: config.telegramChatId,
        telegramEnabled: config.telegramEnabled,
        facebookEnabled: config.facebookEnabled,
        linkedinEnabled: config.linkedinEnabled,
        provider: config.provider,
        model: config.model,
        translationProvider: config.translationProvider,
        translationModel: config.translationModel,
        translationPrompt: config.translationPrompt,
        imageTelegram: config.imageTelegram,
        imageFacebook: config.imageFacebook,
        imageLinkedin: config.imageLinkedin,
      });
      toast.success("Digest settings saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  // ── D5: Poll for test digest result ────────────────────────────────────────
  const [isPolling, setIsPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const preTestCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await sendTestDigest();
      toast.success(result.message);

      // Start polling for the new digest run
      preTestCountRef.current = history.length;
      setIsPolling(true);
      const startedAt = Date.now();
      const MAX_POLL_MS = 120_000; // 2 minutes
      const POLL_INTERVAL_MS = 5_000;

      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > MAX_POLL_MS) {
          stopPolling();
          toast.info("Digest is still processing — refresh history manually when ready");
          return;
        }
        try {
          const data = await getDigestHistory(30);
          if (data.length > preTestCountRef.current) {
            setHistory(data);
            stopPolling();
            toast.success("Digest result received");
          }
        } catch { /* keep polling */ }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send test digest";
      toast.error(msg);
    } finally {
      setIsTesting(false);
    }
  };

  const reloadConfig = async () => {
    try {
      const data = await getDigestConfig();
      setConfig(data);
    } catch { /* silent */ }
  };

  const toggleDay = (day: number) => {
    if (!config) return;
    const days = config.days.includes(day)
      ? config.days.filter((d) => d !== day)
      : [...config.days, day].sort((a, b) => a - b);
    setConfig({ ...config, days });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Spinner />
      </div>
    );
  }

  // Error state
  if (error || !config) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Daily Digest</h1>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-center">
          <p className="text-sm text-red-400">{error ?? "Failed to load config"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Sticky Header ──────────────────────────────────────────────── */}
      <div className="sticky top-[var(--nav-h,73px)] z-30 -mx-1 bg-slate-950/95 px-1 pb-4 pt-1 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-100">Daily Digest</h1>
            <p className="mt-0.5 text-sm text-slate-400">
              LLM-generated intelligence briefing delivered to Telegram.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setConfig({ ...config, enabled: !config.enabled })}
              className={[
                "rounded-full px-4 py-2 text-sm font-medium transition-colors",
                config.enabled
                  ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                  : "bg-slate-700 text-slate-400 hover:bg-slate-600",
              ].join(" ")}
            >
              {config.enabled ? "Enabled" : "Disabled"}
            </button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={isSaving}
              loading={isSaving}
              loadingText="Saving..."
            >
              Save Settings
            </Button>
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={isTesting || isPolling}
              loading={isTesting}
              loadingText="Sending..."
            >
              {isPolling ? "Waiting..." : "Send Test"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Schedule + Content — side by side ─────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Schedule */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold text-slate-100">Schedule</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            When to compile and deliver the digest.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Time */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Delivery Time
              </label>
              <input
                type="time"
                value={config.time}
                onChange={(e) => setConfig({ ...config, time: e.target.value })}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
              />
            </div>

            {/* Timezone */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Timezone
              </label>
              <select
                value={config.timezone}
                onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Active Days */}
          <div className="mt-4">
            <label className="mb-2 block text-xs font-medium text-slate-400">
              Active Days
            </label>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((day) => {
                const active = config.days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleDay(day.value)}
                    className={[
                      "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                        : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                    ].join(" ")}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Content */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold text-slate-100">Content</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Which articles to include and how to present them.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Min Score */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Minimum Score
              </label>
              <select
                value={config.minScore}
                onChange={(e) => setConfig({ ...config, minScore: Number(e.target.value) })}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
              >
                <option value={1}>1 — All scored</option>
                <option value={2}>2 — Low+</option>
                <option value={3}>3 — Medium+</option>
                <option value={4}>4 — High+</option>
                <option value={5}>5 — Critical only</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">LLM reads all articles above this threshold</p>
            </div>

            {/* Language */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Language
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, language: "en" })}
                  className={[
                    "rounded-full px-4 py-2 text-sm font-medium transition-colors",
                    config.language === "en"
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  English
                </button>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, language: "ka" })}
                  className={[
                    "rounded-full px-4 py-2 text-sm font-medium transition-colors",
                    config.language === "ka"
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  Georgian
                </button>
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                English: digest in English | Georgian: translated after generation
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* ── System Prompt (collapsible) ──────────────────────────────── */}
      <Collapsible
        storeKey="prompt"
        title="System Prompt"
        subtitle="Full LLM instruction sent with every digest. Controls role, output format, and style."
        trailing={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfig({ ...config, systemPrompt: DEFAULT_SYSTEM_PROMPT });
            }}
            className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-100"
          >
            Reset Default
          </button>
        }
      >
        <textarea
          value={config.systemPrompt}
          onChange={(e) => {
            if (e.target.value.length <= 2000) {
              setConfig({ ...config, systemPrompt: e.target.value });
            }
          }}
          rows={12}
          placeholder="Enter the full system prompt for the digest LLM..."
          className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 font-mono text-xs leading-relaxed text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-500"
        />
        <div className="mt-1 flex items-center justify-between">
          {!config.systemPrompt.trim() ? (
            <p className="text-xs text-amber-400">
              System prompt is empty — LLM will generate without instructions
            </p>
          ) : (
            <span />
          )}
          <p className="text-xs text-slate-500">{config.systemPrompt.length}/2000</p>
        </div>
      </Collapsible>

      {/* ── Digest AI Model (collapsible) ────────────────────────────── */}
      <Collapsible
        storeKey="digestModel"
        title="Digest AI Model"
        subtitle="LLM used to analyze articles and generate the digest briefing."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Provider
            </label>
            <select
              value={config.provider}
              onChange={(e) => {
                const provider = e.target.value;
                const models = DIGEST_MODELS[provider];
                setConfig({
                  ...config,
                  provider,
                  model: models?.[0]?.value ?? "",
                });
              }}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              <option value="claude">Claude (Anthropic)</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Gemini (Google AI)</option>
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Model
            </label>
            <select
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              {(DIGEST_MODELS[config.provider] ?? []).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Collapsible>

      {/* ── Translation Model (collapsible) ──────────────────────────── */}
      <Collapsible
        storeKey="translationModel"
        title="Translation Model"
        subtitle="Used when language is set to Georgian — translates the English digest output."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Provider
            </label>
            <select
              value={config.translationProvider}
              onChange={(e) => {
                const provider = e.target.value;
                const models = TRANSLATION_MODELS[provider];
                setConfig({
                  ...config,
                  translationProvider: provider,
                  translationModel: models?.[0]?.value ?? "",
                });
              }}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              <option value="gemini">Gemini (Google AI)</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Model
            </label>
            <select
              value={config.translationModel}
              onChange={(e) => setConfig({ ...config, translationModel: e.target.value })}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              {(TRANSLATION_MODELS[config.translationProvider] ?? []).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Translation Prompt */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Translation Instructions
            </label>
            <button
              type="button"
              onClick={() => setConfig({ ...config, translationPrompt: DEFAULT_TRANSLATION_PROMPT })}
              className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-500 transition-colors hover:text-slate-300"
            >
              Reset Default
            </button>
          </div>
          <textarea
            value={config.translationPrompt}
            onChange={(e) => {
              if (e.target.value.length <= 1000) {
                setConfig({ ...config, translationPrompt: e.target.value });
              }
            }}
            rows={4}
            placeholder="Instructions for the translation model..."
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 font-mono text-xs leading-relaxed text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-500"
          />
          <p className="mt-1 text-right text-xs text-slate-600">
            {config.translationPrompt.length}/1000
          </p>
        </div>
      </Collapsible>

      {/* ── Delivery Channels (collapsible) ──────────────────────────── */}
      <Collapsible
        storeKey="channels"
        title="Delivery Channels"
        subtitle="Choose where to send the digest. At least one channel must be enabled."
      >
        <div className="space-y-3">
          {/* Telegram */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-lg">TG</span>
                <div>
                  <p className="text-sm font-medium text-slate-200">Telegram</p>
                  <p className="text-xs text-slate-500">Bot API — rich HTML formatting</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, imageTelegram: !config.imageTelegram })}
                  disabled={!config.telegramEnabled}
                  title={config.telegramEnabled ? "Attach cover image" : "Enable Telegram first"}
                  className={[
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    !config.telegramEnabled
                      ? "cursor-not-allowed bg-slate-800 text-slate-600 opacity-50"
                      : config.imageTelegram
                        ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/50"
                        : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  IMG
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !config.telegramEnabled;
                    setConfig({
                      ...config,
                      telegramEnabled: next,
                      ...(next ? {} : { imageTelegram: false }),
                    });
                  }}
                  className={[
                    "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                    config.telegramEnabled
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  {config.telegramEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-slate-400">
                Chat ID (required for Telegram delivery)
              </label>
              <input
                type="text"
                value={String(config.telegramChatId || "")}
                onChange={(e) => setConfig({ ...config, telegramChatId: e.target.value })}
                placeholder="-100..."
                className={[
                  "w-full max-w-sm rounded-lg border px-3 py-1.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-500",
                  config.telegramEnabled && !String(config.telegramChatId || "").trim()
                    ? "border-amber-500/60 bg-slate-900"
                    : "border-slate-700 bg-slate-900",
                ].join(" ")}
              />
              {config.telegramEnabled && !String(config.telegramChatId || "").trim() && (
                <p className="mt-1 text-xs text-amber-400">
                  Chat ID is required — Telegram delivery will be skipped without it
                </p>
              )}
            </div>
          </div>

          {/* Facebook */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-lg">FB</span>
                <div>
                  <p className="text-sm font-medium text-slate-200">Facebook</p>
                  <p className="text-xs text-slate-500">Page post — uses connected page</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, imageFacebook: !config.imageFacebook })}
                  disabled={!config.facebookEnabled}
                  title={config.facebookEnabled ? "Attach cover image" : "Enable Facebook first"}
                  className={[
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    !config.facebookEnabled
                      ? "cursor-not-allowed bg-slate-800 text-slate-600 opacity-50"
                      : config.imageFacebook
                        ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/50"
                        : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  IMG
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !config.facebookEnabled;
                    setConfig({
                      ...config,
                      facebookEnabled: next,
                      ...(next ? {} : { imageFacebook: false }),
                    });
                  }}
                  className={[
                    "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                    config.facebookEnabled
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  {config.facebookEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
          </div>

          {/* LinkedIn */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-lg">IN</span>
                <div>
                  <p className="text-sm font-medium text-slate-200">LinkedIn</p>
                  <p className="text-xs text-slate-500">Profile/org post — uses connected account</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, imageLinkedin: !config.imageLinkedin })}
                  disabled={!config.linkedinEnabled}
                  title={config.linkedinEnabled ? "Attach cover image" : "Enable LinkedIn first"}
                  className={[
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    !config.linkedinEnabled
                      ? "cursor-not-allowed bg-slate-800 text-slate-600 opacity-50"
                      : config.imageLinkedin
                        ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/50"
                        : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  IMG
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !config.linkedinEnabled;
                    setConfig({
                      ...config,
                      linkedinEnabled: next,
                      ...(next ? {} : { imageLinkedin: false }),
                    });
                  }}
                  className={[
                    "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                    config.linkedinEnabled
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                  ].join(" ")}
                >
                  {config.linkedinEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* No channels warning */}
        {!config.telegramEnabled && !config.facebookEnabled && !config.linkedinEnabled && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5">
            <p className="text-xs font-medium text-red-400">
              No delivery channels enabled — digest has nowhere to send
            </p>
          </div>
        )}

        {/* Last sent */}
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-500">Last scheduled digest</p>
              <p className="mt-0.5 text-sm font-medium text-slate-300">
                {formatLastSent(config.lastDigestSentAt)}
              </p>
              {config.lastDigestSentAt && (
                <p className="mt-0.5 text-xs text-slate-600">
                  {new Date(config.lastDigestSentAt).toLocaleString()}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={reloadConfig}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-500 transition-colors hover:text-slate-300"
            >
              Refresh
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-600">
            Test digests don't update this — only scheduled runs do.
          </p>
        </div>
      </Collapsible>

      {/* ── Digest History (collapsible) ─────────────────────────────── */}
      <Collapsible
        storeKey="history"
        title="Digest History"
        subtitle="Recent digest runs with delivery status and pipeline stats."
        trailing={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowClearConfirm(true);
              }}
              disabled={isClearing || history.length === 0}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
            >
              {isClearing ? "Clearing..." : "Clear All"}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                loadHistory();
              }}
              disabled={historyLoading}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-500 transition-colors hover:text-slate-300 disabled:opacity-50"
            >
              {historyLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
        }
      >
        {isPolling && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
            <Spinner />
            <p className="text-xs font-medium text-amber-200">
              Waiting for digest result... polling every 5s
            </p>
          </div>
        )}

        {history.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-8 text-center">
            <p className="text-sm text-slate-500">
              {historyLoading ? "Loading..." : "No digest runs yet"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Date & Time</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Type</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Lang</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Channels</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Articles</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Model</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-300">Pipeline Stats</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {history.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-800/30">
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">
                      {new Date(run.sentAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      <span className="text-slate-500">
                        {new Date(run.sentAt).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={[
                          "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                          run.isTest
                            ? "bg-amber-500/20 text-amber-200"
                            : "bg-emerald-500/20 text-emerald-200",
                        ].join(" ")}
                      >
                        {run.isTest ? "Test" : "Scheduled"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs font-medium uppercase text-slate-400">
                      {run.language}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {run.channels.map((ch) => {
                          const status = run.channelResults?.[ch] ?? "unknown";
                          const ok = status === "sent";
                          return (
                            <span
                              key={ch}
                              className={[
                                "inline-block rounded px-1.5 py-0.5 text-xs font-medium",
                                ok
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : "bg-red-500/20 text-red-300",
                              ].join(" ")}
                              title={`${ch}: ${status}`}
                            >
                              {ch === "telegram" ? "TG" : ch === "facebook" ? "FB" : "LI"}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center text-slate-300">{run.articleCount}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-500" title={run.model}>
                      {shortModelName(run.model)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">
                      Scanned: {run.statsScanned} | Scored: {run.statsScored} | {run.minScore}+: {run.statsAboveThreshold}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Collapsible>

      {/* ── Clear History Confirmation Modal ──────────────────────────── */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-100">Clear Digest History</h3>
            <p className="mt-2 text-sm text-slate-400">
              This will permanently delete all {history.length} digest history
              record{history.length === 1 ? "" : "s"}. This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setShowClearConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleClearHistory}>
                Clear All
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
