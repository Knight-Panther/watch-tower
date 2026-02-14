import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import ConfirmModal from "../components/ConfirmModal";
import {
  listSectors,
  getScoringRule,
  saveScoringRule,
  deleteScoringRule,
  previewScoringPrompt,
  type Sector,
  type ScoringConfig,
  type ScoringRule,
} from "../api";

const DEFAULT_CONFIG: ScoringConfig = {
  priorities: [],
  ignore: [],
  score1: "Not newsworthy (press releases, minor updates, promotional content)",
  score2: "Low importance (routine news, minor developments)",
  score3: "Moderate importance (notable but not urgent)",
  score4: "High importance (significant developments, major launches)",
  score5: "Critical importance (industry-changing news, major breaking stories)",
  summaryMaxChars: 200,
  summaryTone: "professional",
  summaryLanguage: "English",
  summaryStyle: "Start with the key fact. Include company or person name when relevant.",
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

  // Preview state
  const [promptPreview, setPromptPreview] = useState<string>("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Tag input state
  const [priorityInput, setPriorityInput] = useState("");
  const [ignoreInput, setIgnoreInput] = useState("");

  // Modal state
  const [showResetModal, setShowResetModal] = useState(false);

  // Load sectors on mount
  useEffect(() => {
    const loadSectors = async () => {
      try {
        const data = await listSectors();
        setSectors(data);
        if (data.length > 0) {
          setSelectedSectorId(data[0].id);
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

  // Track changes
  const updateConfig = <K extends keyof ScoringConfig>(key: K, value: ScoringConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  // Tag management
  const addTag = (type: "priorities" | "ignore", value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (config[type].includes(trimmed)) {
      toast.error("Tag already exists");
      return;
    }
    if (config[type].length >= 20) {
      toast.error("Maximum 20 tags allowed");
      return;
    }
    updateConfig(type, [...config[type], trimmed]);
    if (type === "priorities") setPriorityInput("");
    else setIgnoreInput("");
  };

  const removeTag = (type: "priorities" | "ignore", index: number) => {
    updateConfig(
      type,
      config[type].filter((_, i) => i !== index)
    );
  };

  // Save handler
  const handleSave = async () => {
    if (!selectedSectorId) return;

    if (autoApprove !== 0 && autoReject >= autoApprove) {
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
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8 text-center">
        <p className="text-slate-400">No sectors found. Create a sector first.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {/* Header - sticky below nav */}
      <section className="sticky top-28 z-10 rounded-2xl border border-slate-800 bg-slate-900 p-5">
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
              onChange={(e) => setSelectedSectorId(e.target.value)}
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
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: Form */}
          <section className="space-y-6">
            {/* Priorities */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-lg font-semibold">Topics to Prioritize</h2>
              <p className="mt-1 text-sm text-slate-400">
                Articles about these topics will score higher.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {config.priorities.map((tag, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-3 py-1 text-sm text-emerald-200"
                  >
                    {tag}
                    <button
                      onClick={() => removeTag("priorities", i)}
                      className="ml-1 text-emerald-300 hover:text-emerald-100"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={priorityInput}
                  onChange={(e) => setPriorityInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag("priorities", priorityInput);
                    }
                  }}
                  placeholder="Add topic..."
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                />
                <button
                  onClick={() => addTag("priorities", priorityInput)}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Ignore */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-lg font-semibold">Topics to Ignore</h2>
              <p className="mt-1 text-sm text-slate-400">
                Articles about these topics will score lower.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {config.ignore.map((tag, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded-full bg-red-500/20 px-3 py-1 text-sm text-red-200"
                  >
                    {tag}
                    <button
                      onClick={() => removeTag("ignore", i)}
                      className="ml-1 text-red-300 hover:text-red-100"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={ignoreInput}
                  onChange={(e) => setIgnoreInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag("ignore", ignoreInput);
                    }
                  }}
                  placeholder="Add topic..."
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                />
                <button
                  onClick={() => addTag("ignore", ignoreInput)}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Score Definitions */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-lg font-semibold">Score Definitions</h2>
              <p className="mt-1 text-sm text-slate-400">
                Define what each score level (1-5) means for this sector.
              </p>
              <div className="mt-4 space-y-3">
                {([1, 2, 3, 4, 5] as const).map((level) => (
                  <div key={level} className="flex items-start gap-3">
                    <span className="mt-2 w-14 shrink-0 text-sm font-semibold text-slate-300">
                      {"★".repeat(level)}
                    </span>
                    <textarea
                      value={config[`score${level}` as keyof ScoringConfig] as string}
                      onChange={(e) =>
                        updateConfig(`score${level}` as keyof ScoringConfig, e.target.value)
                      }
                      rows={2}
                      className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Summary Settings */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-lg font-semibold">Summary Settings</h2>
              <p className="mt-1 text-sm text-slate-400">
                Control how article summaries are generated.
              </p>
              <div className="mt-4 space-y-4">
                <div className="flex items-center gap-4">
                  <label className="w-28 text-sm text-slate-300">Max Length</label>
                  <input
                    type="range"
                    min={50}
                    max={500}
                    step={10}
                    value={config.summaryMaxChars}
                    onChange={(e) => updateConfig("summaryMaxChars", parseInt(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-16 text-sm text-slate-400">{config.summaryMaxChars} chars</span>
                </div>
                <div className="flex items-center gap-4">
                  <label className="w-28 text-sm text-slate-300">Tone</label>
                  <select
                    value={config.summaryTone}
                    onChange={(e) =>
                      updateConfig("summaryTone", e.target.value as ScoringConfig["summaryTone"])
                    }
                    className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  >
                    {TONE_OPTIONS.map((tone) => (
                      <option key={tone} value={tone}>
                        {tone.charAt(0).toUpperCase() + tone.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-4">
                  <label className="w-28 text-sm text-slate-300">Language</label>
                  <input
                    value={config.summaryLanguage}
                    onChange={(e) => updateConfig("summaryLanguage", e.target.value)}
                    className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  />
                </div>
                <div className="flex items-start gap-4">
                  <label className="w-28 pt-2 text-sm text-slate-300">Style</label>
                  <textarea
                    value={config.summaryStyle}
                    onChange={(e) => updateConfig("summaryStyle", e.target.value)}
                    rows={2}
                    placeholder="Instructions for summary style..."
                    className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  />
                </div>
              </div>
            </div>

            {/* Score Thresholds */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="text-lg font-semibold">Score Thresholds</h2>
              <p className="mt-1 text-sm text-slate-400">
                Automatically approve or reject articles based on score.
              </p>
              <div className="mt-4 flex flex-wrap gap-6">
                <div className="flex items-center gap-3">
                  <label className="text-sm text-slate-300">Auto-approve at score:</label>
                  <select
                    value={autoApprove}
                    onChange={(e) => {
                      setAutoApprove(parseInt(e.target.value));
                      setHasChanges(true);
                    }}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  >
                    <option value={0}>OFF</option>
                    {[3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-sm text-slate-300">Auto-reject at score:</label>
                  <select
                    value={autoReject}
                    onChange={(e) => {
                      setAutoReject(parseInt(e.target.value));
                      setHasChanges(true);
                    }}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Scores between these thresholds go to manual review. Platform settings are on the{" "}
                <a href="/media-channels" className="text-emerald-400 hover:underline">
                  Media Channels
                </a>{" "}
                page.
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={handleSave}
                disabled={isSaving || !hasChanges}
                className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
              <button
                onClick={handleReset}
                disabled={isSaving}
                className="rounded-xl border border-slate-700 px-6 py-2.5 text-sm text-slate-300 transition hover:border-slate-500"
              >
                Reset to Defaults
              </button>
            </div>
          </section>

          {/* Right: Preview */}
          <section className="lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Prompt Preview</h2>
                {isPreviewLoading && <Spinner />}
              </div>
              <p className="mt-1 text-sm text-slate-400">
                This is what the LLM will receive for {selectedSector?.name ?? "this sector"}.
              </p>
              <pre className="mt-4 max-h-[600px] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs text-slate-300">
                {promptPreview || "Loading preview..."}
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
