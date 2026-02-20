import { useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import {
  getDigestConfig,
  updateDigestConfig,
  sendTestDigest,
  type DigestConfig,
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

You will receive today's scored article feed. Identify what matters, merge related stories, skip noise.

Output ONLY bullet points. Each bullet is ONE short sentence — what happened and a brief hint at why it matters. End with source [#IDs].

Example:
\u2022 Supreme Court struck down most Trump tariffs — could trigger $175B in refunds and reshape trade policy [#2, #5]

Rules:
- ONE sentence per bullet. Maximum 30 words. No filler, no elaboration.
- End each bullet with source references like [#1] or [#1, #3]
- Merge related articles into one bullet
- 5-15 bullets depending on the day
- Most impactful first
- Write in English`;

const DEFAULT_TRANSLATION_PROMPT =
  "Translate the following intelligence briefing to Georgian. " +
  "Be concise — do not expand or elaborate, match the original length. " +
  "Keep bullet point structure exactly as-is. " +
  "Keep ALL HTML tags (<b>, <a href>, etc.) and URLs completely unchanged. " +
  "Only translate the human-readable text. Output the translation only, nothing else.";

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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DigestSettings() {
  const [config, setConfig] = useState<DigestConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load config on mount
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
      });
      toast.success("Digest settings saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await sendTestDigest();
      toast.success(result.message);
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
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8 text-center">
          <p className="text-sm text-red-400">{error ?? "Failed to load config"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header + Master Toggle ───────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Daily Digest</h1>
          <p className="mt-1 text-sm text-slate-400">
            LLM-generated intelligence briefing delivered to Telegram.
          </p>
        </div>
        <button
          onClick={() => setConfig({ ...config, enabled: !config.enabled })}
          className={[
            "shrink-0 rounded-full px-5 py-2.5 text-sm font-medium transition-colors",
            config.enabled
              ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
              : "bg-slate-700 text-slate-400 hover:bg-slate-600",
          ].join(" ")}
        >
          {config.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      {/* ── Schedule ─────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold text-slate-100">Schedule</h2>
        <p className="mt-1 text-xs text-slate-500">
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
                    "rounded-full px-4 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
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

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold text-slate-100">Content</h2>
        <p className="mt-1 text-xs text-slate-500">
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
                    ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
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
                    ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
                    : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                ].join(" ")}
              >
                Georgian
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              English: digest in English | Georgian: digest translated to Georgian after generation
            </p>
          </div>
        </div>
      </section>

      {/* ── System Prompt ────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">System Prompt</h2>
            <p className="mt-1 text-xs text-slate-500">
              Full LLM instruction sent with every digest. Controls role, output format, and style.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfig({ ...config, systemPrompt: DEFAULT_SYSTEM_PROMPT })}
            className="shrink-0 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-100"
          >
            Reset Default
          </button>
        </div>

        <textarea
          value={config.systemPrompt}
          onChange={(e) => {
            if (e.target.value.length <= 2000) {
              setConfig({ ...config, systemPrompt: e.target.value });
            }
          }}
          rows={12}
          placeholder="Enter the full system prompt for the digest LLM..."
          className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 font-mono text-xs leading-relaxed text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-500"
        />
        <div className="mt-1 flex items-center justify-between">
          {!config.systemPrompt.trim() ? (
            <p className="text-xs text-amber-400">
              System prompt is empty — LLM will generate without instructions
            </p>
          ) : (
            <span />
          )}
          <p className="text-xs text-slate-500">
            {config.systemPrompt.length}/2000
          </p>
        </div>
      </section>

      {/* ── AI Model ──────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold text-slate-100">Digest AI Model</h2>
        <p className="mt-1 text-xs text-slate-500">
          LLM used to analyze articles and generate the digest briefing.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
      </section>

      {/* ── Translation Model ──────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold text-slate-100">Translation Model</h2>
        <p className="mt-1 text-xs text-slate-500">
          Used when language is set to Georgian — translates the English digest output.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
      </section>

      {/* ── Delivery Channels ──────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-lg font-semibold text-slate-100">Delivery Channels</h2>
        <p className="mt-1 text-xs text-slate-500">
          Choose where to send the digest. At least one channel must be enabled.
        </p>

        <div className="mt-4 space-y-3">
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
              <button
                type="button"
                onClick={() => setConfig({ ...config, telegramEnabled: !config.telegramEnabled })}
                className={[
                  "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                  config.telegramEnabled
                    ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
                    : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                ].join(" ")}
              >
                {config.telegramEnabled ? "ON" : "OFF"}
              </button>
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
              <button
                type="button"
                onClick={() => setConfig({ ...config, facebookEnabled: !config.facebookEnabled })}
                className={[
                  "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                  config.facebookEnabled
                    ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
                    : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                ].join(" ")}
              >
                {config.facebookEnabled ? "ON" : "OFF"}
              </button>
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
              <button
                type="button"
                onClick={() => setConfig({ ...config, linkedinEnabled: !config.linkedinEnabled })}
                className={[
                  "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                  config.linkedinEnabled
                    ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
                    : "bg-slate-700 text-slate-400 hover:bg-slate-600",
                ].join(" ")}
              >
                {config.linkedinEnabled ? "ON" : "OFF"}
              </button>
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
      </section>

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="rounded-full bg-cyan-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save Settings"}
        </button>
        <button
          onClick={handleTest}
          disabled={isTesting}
          className="rounded-full border border-slate-700 bg-slate-800 px-5 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
        >
          {isTesting ? "Sending..." : "Send Test Digest"}
        </button>
        {!config.enabled && (
          <span className="text-xs text-slate-500">
            Test digest works even when disabled
          </span>
        )}
      </div>
    </div>
  );
}
