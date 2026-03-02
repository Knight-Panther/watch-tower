import { useCallback, useEffect, useRef, useState } from "react";
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
import { DEFAULT_SCORING_EXAMPLES } from "@watch-tower/shared";

const DEFAULT_CONFIG: ScoringConfig = {
  priorities: [],
  ignore: [],
  rejectKeywords: [],
  score1:
    "Noise \u2014 press releases, promotional content, SEO articles, product listings, " +
    "routine HR announcements, no new information beyond what is already known",
  score2:
    "Routine \u2014 scheduled earnings reports meeting expectations, minor personnel changes, " +
    "incremental updates to previously reported stories, conference attendance announcements",
  score3:
    "Noteworthy \u2014 new development in an ongoing story, notable partnership or collaboration, " +
    "regulatory filing, earnings with modest surprise, product launch from established company",
  score4:
    "Significant \u2014 unexpected corporate action (M&A, IPO filing, major lawsuit), " +
    "policy shift with broad impact, earnings with major surprise, security breach " +
    "affecting users, leadership change at major company",
  score5:
    "Breaking/Urgent \u2014 market-moving event, catastrophic incident, unprecedented regulatory " +
    "action, major geopolitical development affecting markets, critical infrastructure " +
    "failure, confirmed major data breach at scale",
  summaryMaxChars: 200,
  summaryTone: "professional",
  summaryLanguage: "English",
  summaryStyle: "Start with the key fact. Include company or person name when relevant.",
  examples: [],
};

const TONE_OPTIONS: ScoringConfig["summaryTone"][] = ["professional", "casual", "urgent"];

const LS_KEY = "scoringRules_sections";

/** Read persisted open/closed state from localStorage. */
function getSectionState(id: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const map = JSON.parse(raw);
    return typeof map[id] === "boolean" ? map[id] : fallback;
  } catch {
    return fallback;
  }
}

/** Persist a single section's open/closed state. */
function setSectionState(id: string, open: boolean) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[id] = open;
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/** Collapsible card section with chevron toggle. Persists state in localStorage. */
function Section({
  id,
  title,
  subtitle,
  titleClass,
  borderClass,
  badge,
  defaultOpen = false,
  headerRight,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  titleClass?: string;
  borderClass?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => getSectionState(id, defaultOpen));
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      setSectionState(id, next);
      return next;
    });
  return (
    <div className={`rounded-2xl bg-slate-900/40 p-5 ${borderClass ?? "border border-slate-800"}`}>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <h2 className={`font-semibold ${titleClass ?? ""}`}>{title}</h2>
          {badge}
        </div>
        <svg
          className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
      {open && <div className="mt-3">{children}</div>}
      {/* Show headerRight (e.g. Add button) even when collapsed, below the toggle */}
      {!open && headerRight && <div className="mt-2">{headerRight}</div>}
    </div>
  );
}

/** Auto-resize textarea to fit content. Attach via ref callback. */
const autoResize = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
};

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

  // Auto-resize textareas when config loads (sector switch)
  const textareaContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!textareaContainerRef.current) return;
    const areas = textareaContainerRef.current.querySelectorAll<HTMLTextAreaElement>(
      "textarea[data-autoresize]",
    );
    areas.forEach(autoResize);
  }, [config]);
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
      <section className="sticky top-[var(--nav-h)] z-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
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
          <section className="space-y-5" ref={textareaContainerRef}>
            {/* Priorities */}
            <Section
              id="priorities"
              title="Topics to Prioritize"
              subtitle="Articles about these topics will score higher."
              badge={
                config.priorities.length > 0 ? (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">
                    {config.priorities.length}
                  </span>
                ) : null
              }
            >
              <TagInput
                tags={config.priorities}
                onChange={(tags) => updateConfig("priorities", tags)}
                maxTags={20}
                placeholder="Add topic..."
                color="emerald"
              />
            </Section>

            {/* Ignore */}
            <Section
              id="ignore"
              title="Topics to Ignore"
              subtitle="Articles about these topics will score lower."
              badge={
                config.ignore.length > 0 ? (
                  <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] text-red-300">
                    {config.ignore.length}
                  </span>
                ) : null
              }
            >
              <TagInput
                tags={config.ignore}
                onChange={(tags) => updateConfig("ignore", tags)}
                maxTags={20}
                placeholder="Add topic..."
                color="red"
              />
            </Section>

            {/* Hard Reject Keywords */}
            <Section
              id="reject"
              title="Reject Before Scoring"
              titleClass="text-orange-200"
              subtitle="Articles matching these keywords skip LLM entirely (saves cost)."
              borderClass="border border-orange-500/20"
              badge={
                config.rejectKeywords.length > 0 ? (
                  <span className="rounded-full bg-orange-500/20 px-2 py-0.5 text-[10px] text-orange-300">
                    {config.rejectKeywords.length}
                  </span>
                ) : null
              }
            >
              <TagInput
                tags={config.rejectKeywords}
                onChange={(tags) => updateConfig("rejectKeywords", tags)}
                maxTags={50}
                placeholder="Add keyword..."
                color="orange"
              />
              <p className="mt-2 text-xs text-slate-500">
                Matches against: title, categories, URL, author. Content body is excluded to avoid false positives.
              </p>
            </Section>

            {/* Alert Keywords (read-only) */}
            <Section
              id="alerts"
              title="Alert Keywords (Injected)"
              titleClass="text-violet-200"
              subtitle={`Injected into LLM prompt for semantic matching. ${alertRuleCount} active rule${alertRuleCount !== 1 ? "s" : ""}.`}
              borderClass="border border-violet-500/20"
              badge={
                alertKeywords.length > 0 ? (
                  <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] text-violet-300">
                    {alertKeywords.length}
                  </span>
                ) : null
              }
            >
              {alertKeywords.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
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
                <p className="text-xs text-slate-500">No alert keywords for this sector.</p>
              )}
              <p className="mt-2 text-xs text-slate-500">
                Manage on{" "}
                <a href="/alerts" className="text-violet-400 hover:underline">
                  Alerts page
                </a>
              </p>
            </Section>

            {/* Score Definitions */}
            <Section id="scores" title="Score Definitions" subtitle="What each score level (1-5) means.">
              <div className="space-y-2">
                {([1, 2, 3, 4, 5] as const).map((level) => (
                  <div key={level} className="flex items-start gap-2">
                    <span className="mt-2 w-12 shrink-0 text-xs font-semibold text-slate-300">
                      {"★".repeat(level)}
                    </span>
                    <textarea
                      data-autoresize
                      value={config[`score${level}` as keyof ScoringConfig] as string}
                      onChange={(e) => {
                        updateConfig(`score${level}` as keyof ScoringConfig, e.target.value);
                        autoResize(e.target);
                      }}
                      rows={1}
                      className="flex-1 resize-y overflow-hidden rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                    />
                  </div>
                ))}
              </div>
            </Section>

            {/* Calibration Examples */}
            <Section
              id="examples"
              title="Calibration Examples"
              subtitle={`Few-shot examples in the LLM prompt. ${config.examples.length === 0 ? `Using ${DEFAULT_SCORING_EXAMPLES.length} built-in defaults.` : ""}`}
              badge={
                config.examples.length > 0 ? (
                  <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] text-cyan-300">
                    {config.examples.length}
                  </span>
                ) : null
              }
            >
              <div className="flex justify-end">
                {config.examples.length < 20 && (
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig("examples", [
                        ...config.examples,
                        { title: "", score: 3, reasoning: "" },
                      ]);
                    }}
                    className="shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                  >
                    + Add Example
                  </button>
                )}
              </div>

              {config.examples.length === 0 ? (
                <div className="mt-2 rounded-lg border border-dashed border-slate-700 p-4 text-center">
                  <p className="text-xs text-slate-500">
                    No custom examples.
                  </p>
                  <button
                    type="button"
                    onClick={() => updateConfig("examples", [...DEFAULT_SCORING_EXAMPLES])}
                    className="mt-2 text-xs text-cyan-400 hover:underline"
                  >
                    Load built-in defaults to customize
                  </button>
                </div>
              ) : (
                <div className="mt-2 space-y-3">
                  {config.examples.map((ex, idx) => (
                    <div
                      key={idx}
                      className="rounded-lg border border-slate-700 bg-slate-950/50 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 space-y-2">
                          <input
                            value={ex.title}
                            onChange={(e) => {
                              const updated = [...config.examples];
                              updated[idx] = { ...ex, title: e.target.value };
                              updateConfig("examples", updated);
                            }}
                            placeholder="Article title..."
                            maxLength={200}
                            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                          />
                          <div className="flex gap-2">
                            <select
                              value={ex.score}
                              onChange={(e) => {
                                const updated = [...config.examples];
                                updated[idx] = { ...ex, score: parseInt(e.target.value) };
                                updateConfig("examples", updated);
                              }}
                              className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                            >
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {"★".repeat(n)} {n}
                                </option>
                              ))}
                            </select>
                            <input
                              value={ex.reasoning}
                              onChange={(e) => {
                                const updated = [...config.examples];
                                updated[idx] = { ...ex, reasoning: e.target.value };
                                updateConfig("examples", updated);
                              }}
                              placeholder="Why this score..."
                              maxLength={300}
                              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                            />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const updated = config.examples.filter((_, i) => i !== idx);
                            updateConfig("examples", updated);
                          }}
                          className="mt-1 shrink-0 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-400"
                          title="Remove example"
                        >
                          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path
                              fillRule="evenodd"
                              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-slate-500">
                    {config.examples.length}/20 examples
                  </p>
                </div>
              )}
            </Section>

            {/* Summary Settings */}
            <Section
              id="summary"
              title="Summary Settings"
              subtitle={`${config.summaryMaxChars} chars, ${config.summaryTone}, ${config.summaryLanguage}`}
            >
              <div className="space-y-3">
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
                    data-autoresize
                    value={config.summaryStyle}
                    onChange={(e) => {
                      updateConfig("summaryStyle", e.target.value);
                      autoResize(e.target);
                    }}
                    rows={1}
                    placeholder="Instructions for summary style..."
                    className="flex-1 resize-y overflow-hidden rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                  />
                </div>
              </div>
            </Section>

            {/* Score Thresholds */}
            <Section
              id="thresholds"
              title="Score Thresholds"
              subtitle={`Approve: ${autoApprove === 0 ? "OFF" : `${autoApprove}+`} / Reject: ${autoReject === 0 ? "OFF" : `${autoReject}-`}`}
            >
              <div className="flex flex-wrap gap-4">
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
            </Section>

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
          <section className="xl:sticky xl:top-[calc(var(--nav-h)+6rem)] xl:self-start">
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
