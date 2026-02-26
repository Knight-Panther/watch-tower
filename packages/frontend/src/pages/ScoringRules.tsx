import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import ConfirmModal from "../components/ConfirmModal";
import { SkeletonText } from "../components/ui/Skeleton";
import TagInput from "../components/ui/TagInput";
import Button from "../components/ui/Button";
import {
  listSectors,
  getScoringRule,
  saveScoringRule,
  deleteScoringRule,
  previewScoringPrompt,
  getAlertSectorKeywords,
  type Sector,
  type ScoringConfig,
  type ScoringRule,
} from "../api";

const DEFAULT_CONFIG: ScoringConfig = {
  priorities: [],
  ignore: [],
  rejectKeywords: [],
  score1: "Not newsworthy (press releases, minor updates, promotional content)",
  score2: "Low importance (routine news, minor developments)",
  score3: "Moderate importance (notable but not urgent)",
  score4: "High importance (significant developments, major launches)",
  score5: "Critical importance (industry-changing news, major breaking stories)",
  summaryMaxChars: 200,
  summaryTone: "professional",
  summaryLanguage: "English",
  summaryStyle: "Start with the key fact. Include company or person name when relevant.",
  examples: [],
};

const TONE_OPTIONS: ScoringConfig["summaryTone"][] = ["professional", "casual", "urgent"];

export default function ScoringRules() {
  // Data state
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [selectedSectorId, setSelectedSectorId] = useState<string>("");
  const [currentRule, setCurrentRule] = useState<ScoringRule | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [config, setConfig] = useState<ScoringConfig>(DEFAULT_CONFIG);
  const [autoApprove, setAutoApprove] = useState(5);
  const [autoReject, setAutoReject] = useState(2);
  const [hasChanges, setHasChanges] = useState(false);

  // Alert keywords state (read-only, from alert rules)
  const [alertKeywords, setAlertKeywords] = useState<string[]>([]);
  const [alertRuleCount, setAlertRuleCount] = useState(0);

  // Preview state
  const [promptPreview, setPromptPreview] = useState<string>("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Modal state
  const [showResetModal, setShowResetModal] = useState(false);

  // Load sectors on mount
  useEffect(() => {
    const loadSectors = async () => {
      try {
        const data = await listSectors();
        setSectors(data);
        if (data.length > 0) {
          const saved = localStorage.getItem("scoringRules_sectorId");
          const valid = saved && data.some((s) => s.id === saved);
          setSelectedSectorId(valid ? saved : data[0].id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load sectors";
        toast.error(message);
      } finally {
        setIsLoading(false);
      }
    };
    loadSectors();
  }, []);

  // Load rule when sector changes
  const loadRule = useCallback(async () => {
    if (!selectedSectorId) return;

    setIsLoading(true);
    try {
      const rule = await getScoringRule(selectedSectorId);
      setCurrentRule(rule);
      setConfig(rule.config);
      setAutoApprove(rule.auto_approve_threshold);
      setAutoReject(rule.auto_reject_threshold);
      setPromptPreview(rule.prompt_preview ?? "");
      setHasChanges(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load scoring rule";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [selectedSectorId]);

  useEffect(() => {
    loadRule();
  }, [loadRule]);

  // Load alert keywords when sector changes
  useEffect(() => {
    if (!selectedSectorId) return;
    let cancelled = false;
    const loadAlertKeywords = async () => {
      try {
        const data = await getAlertSectorKeywords(selectedSectorId);
        if (!cancelled) {
          setAlertKeywords(data.keywords);
          setAlertRuleCount(data.rule_count);
        }
      } catch {
        if (!cancelled) {
          setAlertKeywords([]);
          setAlertRuleCount(0);
        }
      }
    };
    loadAlertKeywords();
    return () => {
      cancelled = true;
    };
  }, [selectedSectorId]);

  // Update preview when config changes (debounced)
  useEffect(() => {
    const sector = sectors.find((s) => s.id === selectedSectorId);
    if (!sector) return;

    const timer = setTimeout(async () => {
      setIsPreviewLoading(true);
      try {
        const result = await previewScoringPrompt(config, sector.name);
        setPromptPreview(result.prompt);
      } catch {
        // Silent fail for preview
      } finally {
        setIsPreviewLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [config, selectedSectorId, sectors]);

  // Build full preview including alert keywords suffix (client-side, matches worker behavior)
  const fullPreview = (() => {
    if (!promptPreview) return "";
    if (alertKeywords.length === 0) return promptPreview;
    return `${promptPreview}

ALERT KEYWORD MATCHING:
Check if any of these alert keywords are semantically relevant to this article: [${alertKeywords.join(", ")}]
Include a "matched_alert_keywords" field in your JSON response — an array of matched keyword strings.
Only include keywords that are clearly relevant to the article's core topic, not just mentioned in passing.
If no keywords match, return an empty array.
Example: {"reasoning": "...", "score": 3, "summary": "...", "matched_alert_keywords": ["keyword1"]}`;
  })();

  // Track changes
  const updateConfig = <K extends keyof ScoringConfig>(key: K, value: ScoringConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  // Save handler
  const handleSave = async () => {
    if (!selectedSectorId) return;

    if (autoApprove !== 0 && autoReject !== 0 && autoReject >= autoApprove) {
      toast.error("Auto-reject threshold must be less than auto-approve");
      return;
    }

    setIsSaving(true);
    try {
      await saveScoringRule(selectedSectorId, config, autoApprove, autoReject);
      toast.success("Scoring rule saved");
      setHasChanges(false);
      await loadRule(); // Reload to get fresh data
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Reset to defaults
  const handleReset = () => {
    if (!selectedSectorId) return;
    setShowResetModal(true);
  };

  const confirmReset = async () => {
    setShowResetModal(false);
    setIsSaving(true);
    try {
      await deleteScoringRule(selectedSectorId);
      toast.success("Reset to defaults");
      await loadRule();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const selectedSector = sectors.find((s) => s.id === selectedSectorId);

  if (isLoading && sectors.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner /> <span className="ml-2 text-slate-400">Loading...</span>
      </div>
    );
  }

  if (sectors.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-center">
        <p className="text-slate-400">No sectors found. Create a sector first.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {/* Header - sticky below nav */}
      <section className="sticky top-28 z-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">LLM Brain</h1>
            <p className="mt-1 text-sm text-slate-400">
              Configure how articles are scored and summarized per sector.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400">Sector:</label>
            <select
              value={selectedSectorId}
              onChange={(e) => {
                setSelectedSectorId(e.target.value);
                localStorage.setItem("scoringRules_sectorId", e.target.value);
              }}
              className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              {sectors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {currentRule?.is_legacy && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <p className="text-sm text-amber-200">
              This sector uses a legacy prompt format. Saving will migrate to the new structured
              format.
            </p>
          </div>
        )}
      </section>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner /> <span className="ml-2 text-slate-400">Loading rule...</span>
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[2fr_3fr]">
          {/* Left: Form controls */}
          <section className="space-y-5">
            {/* Priorities */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="font-semibold">Topics to Prioritize</h2>
              <p className="mt-1 text-xs text-slate-400">
                Articles about these topics will score higher.
              </p>
              <div className="mt-3">
                <TagInput
                  tags={config.priorities}
                  onChange={(tags) => updateConfig("priorities", tags)}
                  maxTags={20}
                  placeholder="Add topic..."
                  color="emerald"
                />
              </div>
            </div>

            {/* Ignore */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="font-semibold">Topics to Ignore</h2>
              <p className="mt-1 text-xs text-slate-400">
                Articles about these topics will score lower.
              </p>
              <div className="mt-3">
                <TagInput
                  tags={config.ignore}
                  onChange={(tags) => updateConfig("ignore", tags)}
                  maxTags={20}
                  placeholder="Add topic..."
                  color="red"
                />
              </div>
            </div>

            {/* Hard Reject Keywords */}
            <div className="rounded-2xl border border-orange-500/20 bg-slate-900/40 p-5">
              <h2 className="font-semibold text-orange-200">Reject Before Scoring</h2>
              <p className="mt-1 text-xs text-slate-400">
                Articles matching these keywords skip LLM entirely (saves cost).
              </p>
              <div className="mt-3">
                <TagInput
                  tags={config.rejectKeywords}
                  onChange={(tags) => updateConfig("rejectKeywords", tags)}
                  maxTags={50}
                  placeholder="Add keyword..."
                  color="orange"
                />
              </div>
            </div>

            {/* Alert Keywords (read-only) */}
            <div className="rounded-2xl border border-violet-500/20 bg-slate-900/40 p-5">
              <h2 className="font-semibold text-violet-200">Alert Keywords (Injected)</h2>
              <p className="mt-1 text-xs text-slate-400">
                Injected into LLM prompt for semantic matching. Manage on{" "}
                <a href="/alerts" className="text-violet-400 hover:underline">
                  Alerts
                </a>
                .
              </p>
              {alertKeywords.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {alertKeywords.map((kw, i) => (
                    <span
                      key={i}
                      className="rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs text-violet-200"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-500">No alert keywords for this sector.</p>
              )}
              <p className="mt-2 text-xs text-slate-500">
                {alertRuleCount} active rule{alertRuleCount !== 1 ? "s" : ""} for this sector
              </p>
            </div>

            {/* Score Definitions */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="font-semibold">Score Definitions</h2>
              <div className="mt-3 space-y-2">
                {([1, 2, 3, 4, 5] as const).map((level) => (
                  <div key={level} className="flex items-start gap-2">
                    <span className="mt-2 w-12 shrink-0 text-xs font-semibold text-slate-300">
                      {"★".repeat(level)}
                    </span>
                    <textarea
                      value={config[`score${level}` as keyof ScoringConfig] as string}
                      onChange={(e) =>
                        updateConfig(`score${level}` as keyof ScoringConfig, e.target.value)
                      }
                      rows={1}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Summary Settings */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="font-semibold">Summary Settings</h2>
              <div className="mt-3 space-y-3">
                <div className="flex items-center gap-3">
                  <label className="w-20 text-xs text-slate-300">Max Length</label>
                  <input
                    type="range"
                    min={50}
                    max={500}
                    step={10}
                    value={config.summaryMaxChars}
                    onChange={(e) => updateConfig("summaryMaxChars", parseInt(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-14 text-xs text-slate-400">{config.summaryMaxChars} ch</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className="w-20 text-xs text-slate-300">Tone</label>
                  <select
                    value={config.summaryTone}
                    onChange={(e) =>
                      updateConfig(
                        "summaryTone",
                        e.target.value as ScoringConfig["summaryTone"],
                      )
                    }
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                  >
                    {TONE_OPTIONS.map((tone) => (
                      <option key={tone} value={tone}>
                        {tone.charAt(0).toUpperCase() + tone.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <label className="w-20 text-xs text-slate-300">Language</label>
                  <input
                    value={config.summaryLanguage}
                    onChange={(e) => updateConfig("summaryLanguage", e.target.value)}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                  />
                </div>
                <div className="flex items-start gap-3">
                  <label className="w-20 pt-1.5 text-xs text-slate-300">Style</label>
                  <textarea
                    value={config.summaryStyle}
                    onChange={(e) => updateConfig("summaryStyle", e.target.value)}
                    rows={2}
                    placeholder="Instructions for summary style..."
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                  />
                </div>
              </div>
            </div>

            {/* Score Thresholds */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="font-semibold">Score Thresholds</h2>
              <div className="mt-3 flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-300">Auto-approve:</label>
                  <select
                    value={autoApprove}
                    onChange={(e) => {
                      setAutoApprove(parseInt(e.target.value));
                      setHasChanges(true);
                    }}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200"
                  >
                    <option value={0}>OFF</option>
                    {[3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-300">Auto-reject:</label>
                  <select
                    value={autoReject}
                    onChange={(e) => {
                      setAutoReject(parseInt(e.target.value));
                      setHasChanges(true);
                    }}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200"
                  >
                    <option value={0}>OFF</option>
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {autoApprove !== 0 && autoReject !== 0 && autoReject >= autoApprove && (
                <p className="mt-2 rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">
                  Conflict: auto-reject ({autoReject}) must be lower than auto-approve (
                  {autoApprove}).
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <Button
                variant="primary"
                size="lg"
                onClick={handleSave}
                disabled={isSaving || !hasChanges}
                loading={isSaving}
                loadingText="Saving..."
              >
                Save Changes
              </Button>
              <Button variant="secondary" size="lg" onClick={handleReset} disabled={isSaving}>
                Reset to Defaults
              </Button>
            </div>
          </section>

          {/* Right: Sticky prompt preview */}
          <section className="xl:sticky xl:top-44 xl:self-start">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Prompt Preview</h2>
                {isPreviewLoading && <Spinner />}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Full prompt for {selectedSector?.name ?? "this sector"}. Updates live.
              </p>
              <pre className="mt-3 max-h-[calc(100vh-14rem)] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-relaxed text-slate-300">
                {fullPreview || (
                  <span className="block space-y-2">
                    {Array.from({ length: 12 }, (_, i) => (
                      <SkeletonText
                        key={i}
                        className={`h-3 ${i % 3 === 0 ? "w-full" : i % 3 === 1 ? "w-4/5" : "w-3/5"}`}
                      />
                    ))}
                  </span>
                )}
              </pre>
            </div>
          </section>
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {showResetModal && (
        <ConfirmModal
          title="Reset to Defaults"
          message="This will delete any custom rules for this sector. Are you sure?"
          confirmLabel="Reset"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={confirmReset}
          onCancel={() => setShowResetModal(false)}
        />
      )}
    </div>
  );
}
