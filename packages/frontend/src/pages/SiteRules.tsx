import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  getAllowedDomains,
  addAllowedDomain,
  deleteAllowedDomain,
  updateAllowedDomain,
  getSecurityConfig,
  getEmergencyStop,
  setEmergencyStop,
  getTranslationConfig,
  updateTranslationConfig,
  type AllowedDomain,
  type SecurityConfig,
  type TranslationConfig,
} from "../api";
import Spinner from "../components/Spinner";

type TabId = "domains" | "limits" | "api" | "emergency" | "translation";

export default function SiteRules() {
  // URL-based tab state
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: TabId =
    tabParam === "limits" || tabParam === "api" || tabParam === "emergency" || tabParam === "translation"
      ? tabParam
      : "domains";

  const setActiveTab = (tab: TabId) => {
    setSearchParams(tab === "domains" ? {} : { tab }, { replace: true });
  };

  // Domain whitelist state
  const [domains, setDomains] = useState<AllowedDomain[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainNotes, setNewDomainNotes] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);

  // Security config state
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  // Kill switch state
  const [emergencyStop, setEmergencyStopState] = useState(false);
  const [killSwitchLoading, setKillSwitchLoading] = useState(true);
  const [killSwitchToggling, setKillSwitchToggling] = useState(false);

  // Translation config state
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(null);

  // Load domains
  const loadDomains = useCallback(async () => {
    try {
      setDomainsLoading(true);
      const data = await getAllowedDomains();
      setDomains(data);
      setDomainsError(null);
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to load domains");
    } finally {
      setDomainsLoading(false);
    }
  }, []);

  // Load security config
  const loadSecurityConfig = useCallback(async () => {
    try {
      setConfigLoading(true);
      const data = await getSecurityConfig();
      setSecurityConfig(data);
    } catch {
      // Non-critical, just leave as null
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // Load kill switch status
  const loadKillSwitch = useCallback(async () => {
    try {
      setKillSwitchLoading(true);
      const data = await getEmergencyStop();
      setEmergencyStopState(data.enabled);
    } catch {
      // Non-critical
    } finally {
      setKillSwitchLoading(false);
    }
  }, []);

  // Load translation config
  const loadTranslationConfig = useCallback(async () => {
    try {
      const data = await getTranslationConfig();
      setTranslationConfig(data);
    } catch {
      // Non-critical
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadDomains();
    loadSecurityConfig();
    loadKillSwitch();
    loadTranslationConfig();
  }, [loadDomains, loadSecurityConfig, loadKillSwitch, loadTranslationConfig]);

  // Add domain
  const handleAddDomain = async () => {
    if (!newDomain.trim()) return;
    try {
      setAddingDomain(true);
      await addAllowedDomain(newDomain.trim(), newDomainNotes.trim() || undefined);
      setNewDomain("");
      setNewDomainNotes("");
      await loadDomains();
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to add domain");
    } finally {
      setAddingDomain(false);
    }
  };

  // Delete domain
  const handleDeleteDomain = async (id: string) => {
    if (!confirm("Remove this domain from whitelist?")) return;
    try {
      await deleteAllowedDomain(id);
      await loadDomains();
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to delete domain");
    }
  };

  // Toggle domain active
  const handleToggleDomain = async (id: string, isActive: boolean) => {
    try {
      await updateAllowedDomain(id, { isActive: !isActive });
      await loadDomains();
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : "Failed to update domain");
    }
  };

  // Toggle kill switch
  const handleToggleKillSwitch = async () => {
    const newState = !emergencyStop;
    const action = newState ? "ACTIVATE" : "DEACTIVATE";
    if (!confirm(`${action} emergency stop? ${newState ? "This will HALT ALL social posting!" : "This will resume normal posting."}`)) {
      return;
    }
    try {
      setKillSwitchToggling(true);
      await setEmergencyStop(newState);
      setEmergencyStopState(newState);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to toggle kill switch");
    } finally {
      setKillSwitchToggling(false);
    }
  };

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Restrictions</h1>
        <p className="mt-1 text-sm text-slate-400">
          Security settings, domain whitelist, and emergency controls.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {[
          { id: "domains", label: "Domain Whitelist" },
          { id: "limits", label: "Feed Limits" },
          { id: "api", label: "API Security" },
          { id: "emergency", label: "Emergency Controls" },
          { id: "translation", label: "Translation" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id
                ? "border-b-2 border-cyan-400 text-cyan-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Domain Whitelist Tab */}
      {activeTab === "domains" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold">Allowed RSS Domains</h2>
          <p className="mt-1 text-sm text-slate-400">
            Only RSS sources from these domains can be added. Protects against SSRF attacks.
          </p>

          {/* Add Domain Form */}
          <div className="mt-4 flex flex-wrap gap-3">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="example.com"
              className="flex-1 min-w-[200px] rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <input
              value={newDomainNotes}
              onChange={(e) => setNewDomainNotes(e.target.value)}
              placeholder="Notes (optional)"
              className="flex-1 min-w-[200px] rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <button
              onClick={handleAddDomain}
              disabled={addingDomain || !newDomain.trim()}
              className="rounded-full bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:opacity-50"
            >
              {addingDomain ? "Adding..." : "Add Domain"}
            </button>
          </div>

          {domainsError && (
            <p className="mt-3 text-sm text-red-400">{domainsError}</p>
          )}

          {/* Domain List */}
          {domainsLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading domains...
            </div>
          ) : domains.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">No domains configured. Add your first trusted domain above.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {domains.map((domain) => (
                <div
                  key={domain.id}
                  className={`flex items-center justify-between rounded-xl border p-3 ${
                    domain.isActive
                      ? "border-slate-800 bg-slate-950/70"
                      : "border-slate-700 bg-slate-900/50 opacity-60"
                  }`}
                >
                  <div>
                    <p className={`font-mono text-sm ${domain.isActive ? "text-slate-200" : "text-slate-400"}`}>
                      {domain.domain}
                    </p>
                    {domain.notes && (
                      <p className="mt-0.5 text-xs text-slate-500">{domain.notes}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleToggleDomain(domain.id, domain.isActive)}
                      className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                        domain.isActive
                          ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                          : "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                      }`}
                    >
                      {domain.isActive ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => handleDeleteDomain(domain.id)}
                      className="rounded-lg bg-red-500/20 px-3 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/30"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Feed Limits Tab */}
      {activeTab === "limits" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold">Feed Limits</h2>
          <p className="mt-1 text-sm text-slate-400">
            Global defaults for RSS ingestion limits. Set via environment variables.
          </p>

          {configLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading config...
            </div>
          ) : securityConfig ? (
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Max Feed Size</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.maxFeedSizeMb} MB
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  RSS feeds larger than this are rejected
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Articles Per Fetch</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.maxArticlesPerFetch}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Max articles per single RSS fetch
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Daily Per Source</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.maxArticlesPerSourceDaily}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Max articles per source per day
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Could not load configuration.</p>
          )}

          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/30 p-3">
            <p className="text-sm text-slate-300">
              To change these limits, update the environment variables:
            </p>
            <pre className="mt-2 text-xs text-slate-400 font-mono">
{`MAX_FEED_SIZE_MB=5
MAX_ARTICLES_PER_FETCH=100
MAX_ARTICLES_PER_SOURCE_DAILY=500`}
            </pre>
          </div>
        </section>
      )}

      {/* API Security Tab */}
      {activeTab === "api" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold">API Security</h2>
          <p className="mt-1 text-sm text-slate-400">
            CORS and rate limiting configuration. Set via environment variables.
          </p>

          {configLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> Loading config...
            </div>
          ) : securityConfig ? (
            <div className="mt-4 space-y-4">
              {/* Rate Limit */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">API Rate Limit</p>
                <p className="mt-2 text-2xl font-semibold text-slate-100">
                  {securityConfig.apiRateLimitPerMinute} <span className="text-sm font-normal text-slate-400">/ minute</span>
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Requests exceeding this limit receive 429 Too Many Requests
                </p>
              </div>

              {/* CORS Origins */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Allowed Origins (CORS)</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {securityConfig.allowedOrigins.map((origin, i) => (
                    <span
                      key={i}
                      className="rounded-lg bg-slate-800 px-3 py-1 font-mono text-sm text-slate-200"
                    >
                      {origin}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  Only these origins can make cross-origin requests to the API
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Could not load configuration.</p>
          )}

          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/30 p-3">
            <p className="text-sm text-slate-300">
              To change these settings, update the environment variables:
            </p>
            <pre className="mt-2 text-xs text-slate-400 font-mono">
{`ALLOWED_ORIGINS=https://yourdomain.com
API_RATE_LIMIT_PER_MINUTE=200`}
            </pre>
          </div>
        </section>
      )}

      {/* Translation Tab */}
      {activeTab === "translation" && (
        <section className="grid gap-6">
          {/* Posting Language Toggle */}
          <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-amber-200">Posting Language</h3>
                <p className="text-sm text-amber-200/70">
                  All posts will use this language. Georgian requires translation to be configured.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    updateTranslationConfig({ posting_language: "en" })
                      .then(() => toast.success("Switched to English"))
                      .catch(() => toast.error("Failed to update language"));
                    setTranslationConfig((prev) => prev ? { ...prev, posting_language: "en" } : null);
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    translationConfig?.posting_language === "en"
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
                      : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                  }`}
                >
                  English
                </button>
                <button
                  onClick={() => {
                    updateTranslationConfig({ posting_language: "ka" })
                      .then(() => toast.success("Switched to Georgian"))
                      .catch(() => toast.error("Failed to update language"));
                    setTranslationConfig((prev) => prev ? { ...prev, posting_language: "ka" } : null);
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    translationConfig?.posting_language === "ka"
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/50"
                      : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                  }`}
                >
                  Georgian
                </button>
              </div>
            </div>
          </div>

          {/* Scores to Translate */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-lg font-medium mb-4">Translate Articles with Score</h3>
            <div className="flex gap-4">
              {[3, 4, 5].map((score) => (
                <label key={score} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={translationConfig?.scores.includes(score) ?? false}
                    onChange={(e) => {
                      const newScores = e.target.checked
                        ? [...(translationConfig?.scores ?? []), score]
                        : (translationConfig?.scores ?? []).filter((s) => s !== score);
                      updateTranslationConfig({ scores: newScores })
                        .then(() => toast.success("Translation scores updated"))
                        .catch(() => toast.error("Failed to update scores"));
                      setTranslationConfig((prev) => prev ? { ...prev, scores: newScores } : null);
                    }}
                    className="rounded border-slate-600"
                  />
                  <span className="text-sm text-slate-200">Score {score}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Translation Provider & Model */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-lg font-medium mb-4">Translation Provider & Model</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm text-slate-400 mb-2">Provider</label>
                <select
                  value={translationConfig?.provider ?? "gemini"}
                  onChange={(e) => {
                    const provider = e.target.value as "gemini" | "openai";
                    const defaultModel = provider === "openai" ? "gpt-4o-mini" : "gemini-2.5-flash";
                    updateTranslationConfig({ provider, model: defaultModel })
                      .then(() => toast.success(`Provider set to ${provider}`))
                      .catch(() => toast.error("Failed to update provider"));
                    setTranslationConfig((prev) =>
                      prev ? { ...prev, provider, model: defaultModel } : null,
                    );
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm"
                >
                  <option value="gemini">Gemini (Google)</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-2">Model</label>
                <select
                  value={translationConfig?.model ?? "gemini-2.5-flash"}
                  onChange={(e) => {
                    updateTranslationConfig({ model: e.target.value })
                      .then(() => toast.success(`Model set to ${e.target.value}`))
                      .catch(() => toast.error("Failed to update model"));
                    setTranslationConfig((prev) => prev ? { ...prev, model: e.target.value } : null);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm"
                >
                  {translationConfig?.provider === "openai" ? (
                    <>
                      <option value="gpt-4o-mini">gpt-4o-mini (fast, cheap)</option>
                      <option value="gpt-4o">gpt-4o (quality)</option>
                      <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                      <option value="gpt-4.1-nano">gpt-4.1-nano</option>
                    </>
                  ) : (
                    <>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash (balanced)</option>
                      <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite (budget)</option>
                      <option value="gemini-2.5-pro">Gemini 2.5 Pro (deep reasoning)</option>
                      <option value="gemini-3-flash-preview">Gemini 3 Flash (high performance)</option>
                      <option value="gemini-3-pro-preview">Gemini 3 Pro (flagship)</option>
                    </>
                  )}
                </select>
              </div>
            </div>
          </div>

          {/* Translation Instructions */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-lg font-medium mb-4">Translation Instructions</h3>
            <p className="text-sm text-slate-400 mb-4">
              Customize how the AI translates content to Georgian
            </p>
            <textarea
              value={translationConfig?.instructions ?? ""}
              onChange={(e) => {
                setTranslationConfig((prev) =>
                  prev ? { ...prev, instructions: e.target.value } : null,
                );
              }}
              onBlur={() => {
                if (translationConfig) {
                  updateTranslationConfig({ instructions: translationConfig.instructions })
                    .then(() => toast.success("Instructions saved"))
                    .catch(() => toast.error("Failed to save instructions"));
                }
              }}
              rows={6}
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm"
              placeholder="Translate the following English news summary into Georgian..."
            />
          </div>
        </section>
      )}

      {/* Emergency Controls Tab */}
      {activeTab === "emergency" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold">Emergency Controls</h2>
          <p className="mt-1 text-sm text-slate-400">
            Critical controls for emergency situations.
          </p>

          {/* Kill Switch */}
          <div className={`mt-4 rounded-xl border-2 p-5 ${
            emergencyStop
              ? "border-red-500 bg-red-950/30"
              : "border-slate-700 bg-slate-950/70"
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">
                  Kill Switch
                </h3>
                <p className="mt-1 text-sm text-slate-400">
                  Immediately halt ALL social media posting across all platforms.
                  The pipeline (fetch, embed, score) continues, but no posts go out.
                </p>
              </div>
              {killSwitchLoading ? (
                <Spinner />
              ) : (
                <button
                  onClick={handleToggleKillSwitch}
                  disabled={killSwitchToggling}
                  className={`rounded-xl px-6 py-3 text-sm font-semibold transition ${
                    emergencyStop
                      ? "bg-emerald-600 text-white hover:bg-emerald-500"
                      : "bg-red-600 text-white hover:bg-red-500"
                  } disabled:opacity-50`}
                >
                  {killSwitchToggling
                    ? "..."
                    : emergencyStop
                      ? "RESUME POSTING"
                      : "STOP ALL POSTING"}
                </button>
              )}
            </div>

            {emergencyStop && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-900/50 p-3">
                <svg className="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span className="text-sm font-medium text-red-300">
                  EMERGENCY STOP IS ACTIVE - No posts are being sent
                </span>
              </div>
            )}
          </div>

          {/* Status */}
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Current Status</p>
            <div className="mt-2 flex items-center gap-2">
              <span className={`h-3 w-3 rounded-full ${emergencyStop ? "bg-red-500" : "bg-emerald-500"}`} />
              <span className={`text-lg font-semibold ${emergencyStop ? "text-red-300" : "text-emerald-300"}`}>
                {emergencyStop ? "Posting Halted" : "Normal Operation"}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
