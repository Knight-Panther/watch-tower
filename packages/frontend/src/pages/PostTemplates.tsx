import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import ConfirmModal from "../components/ConfirmModal";
import Button from "../components/ui/Button";
import {
  listSocialAccounts,
  savePostTemplate,
  resetPostTemplate,
  previewPost,
  listSectors,
  listSectorTemplates,
  getSectorTemplate,
  saveSectorTemplate,
  deleteSectorTemplate,
  type SocialAccount,
  type PostTemplateConfig,
  type Sector,
} from "../api";

// Default templates per platform
const DEFAULT_TEMPLATES: Record<string, PostTemplateConfig> = {
  telegram: {
    showBreakingLabel: true,
    showSectorTag: true,
    showTitle: true,
    showSummary: true,
    showUrl: true,
    showImage: true,
    autoCommentUrl: false,
    breakingEmoji: "🔴",
    breakingText: "BREAKING",
    urlLinkText: "Read more →",
  },
  linkedin: {
    showBreakingLabel: false,
    showSectorTag: false,
    showTitle: true,
    showSummary: true,
    showUrl: true,
    showImage: true,
    autoCommentUrl: false,
    breakingEmoji: "",
    breakingText: "",
    urlLinkText: "🔗 Full article",
  },
  facebook: {
    showBreakingLabel: false,
    showSectorTag: false,
    showTitle: true,
    showSummary: false,
    showUrl: true,
    showImage: true,
    autoCommentUrl: false,
    breakingEmoji: "",
    breakingText: "",
    urlLinkText: "Read more ↓",
  },
};

// Sample article for preview
const SAMPLE_ARTICLE = {
  title: "FDA Approves Revolutionary Gene Therapy for Rare Disease",
  summary:
    "The FDA has granted breakthrough therapy designation to a new gene therapy treatment targeting sickle cell disease, marking a significant milestone in genetic medicine.",
  url: "https://example.com/article/fda-gene-therapy",
  sector: "Biotech",
};

export default function PostTemplates() {
  // Data state
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    () => localStorage.getItem("postTemplates_selectedAccountId") ?? "",
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Sector state
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [selectedSectorId, setSelectedSectorId] = useState<string>(""); // "" = All (Default)
  const [sectorOverrides, setSectorOverrides] = useState<Set<string>>(new Set()); // "sectorId:platform"
  const isSectorMode = selectedSectorId !== "";

  // Template state
  const [template, setTemplate] = useState<PostTemplateConfig>(DEFAULT_TEMPLATES.telegram);
  const [hasChanges, setHasChanges] = useState(false);

  // Preview state
  const [preview, setPreview] = useState<string>("");
  const [previewCharCount, setPreviewCharCount] = useState(0);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Modal state
  const [showResetModal, setShowResetModal] = useState(false);

  // Get selected account
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Load accounts + sectors on mount
  useEffect(() => {
    const load = async () => {
      try {
        const [accountsData, sectorsData, overridesData] = await Promise.all([
          listSocialAccounts(),
          listSectors(),
          listSectorTemplates(),
        ]);
        setAccounts(accountsData);
        setSectors(sectorsData);
        // Build set of "sectorId:platform" keys that have overrides
        setSectorOverrides(new Set(overridesData.map((o) => `${o.sectorId}:${o.platform}`)));
        if (accountsData.length > 0) {
          const saved = localStorage.getItem("postTemplates_selectedAccountId");
          const match = saved && accountsData.find((a) => a.id === saved);
          if (!match) {
            setSelectedAccountId(accountsData[0].id);
            localStorage.setItem("postTemplates_selectedAccountId", accountsData[0].id);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load data";
        toast.error(message);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  // Load template when account or sector changes
  useEffect(() => {
    if (!selectedAccount) return;

    const loadTemplate = async () => {
      if (isSectorMode) {
        try {
          const result = await getSectorTemplate(selectedSectorId, selectedAccount.platform);
          setTemplate(result.template);
        } catch {
          // No override — fall back to platform default
          setTemplate(selectedAccount.post_template);
        }
      } else {
        setTemplate(selectedAccount.post_template);
      }
      setHasChanges(false);
    };
    loadTemplate();
  }, [selectedAccount, selectedSectorId, isSectorMode]);

  // Update preview when template changes (debounced)
  const updatePreview = useCallback(async () => {
    if (!selectedAccount) return;

    setIsPreviewLoading(true);
    try {
      const result = await previewPost(selectedAccount.platform, template, SAMPLE_ARTICLE);
      setPreview(result.formatted_text);
      setPreviewCharCount(result.char_count);
    } catch {
      // Silent fail for preview
    } finally {
      setIsPreviewLoading(false);
    }
  }, [selectedAccount, template]);

  useEffect(() => {
    const timer = setTimeout(updatePreview, 300);
    return () => clearTimeout(timer);
  }, [updatePreview]);

  // Update template field
  const updateTemplate = <K extends keyof PostTemplateConfig>(
    key: K,
    value: PostTemplateConfig[K],
  ) => {
    setTemplate((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  // Save handler
  const handleSave = async () => {
    if (!selectedAccountId || !selectedAccount) return;

    setIsSaving(true);
    try {
      if (isSectorMode) {
        await saveSectorTemplate(selectedSectorId, selectedAccount.platform, template);
        // Track override
        setSectorOverrides((prev) => {
          const next = new Set(prev);
          next.add(`${selectedSectorId}:${selectedAccount.platform}`);
          return next;
        });
        toast.success("Sector template saved");
      } else {
        const result = await savePostTemplate(selectedAccountId, template);
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === selectedAccountId
              ? { ...a, post_template: result.template, is_template_custom: true }
              : a,
          ),
        );
        toast.success("Template saved");
      }
      setHasChanges(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Reset handler
  const handleReset = () => {
    setShowResetModal(true);
  };

  const confirmReset = async () => {
    setShowResetModal(false);
    if (!selectedAccountId || !selectedAccount) return;

    setIsSaving(true);
    try {
      if (isSectorMode) {
        await deleteSectorTemplate(selectedSectorId, selectedAccount.platform);
        // Remove override tracking
        setSectorOverrides((prev) => {
          const next = new Set(prev);
          next.delete(`${selectedSectorId}:${selectedAccount.platform}`);
          return next;
        });
        // Fall back to platform default
        setTemplate(selectedAccount.post_template);
        toast.success("Sector override removed — using platform default");
      } else {
        const result = await resetPostTemplate(selectedAccountId);
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === selectedAccountId
              ? { ...a, post_template: result.template, is_template_custom: false }
              : a,
          ),
        );
        setTemplate(result.template);
        toast.success("Template reset to defaults");
      }
      setHasChanges(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner /> <span className="ml-2 text-slate-400">Loading...</span>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-center">
        <p className="text-slate-400">
          No social accounts configured. Add a social account in the database to customize
          templates.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {/* Header - sticky below nav */}
      <section className="sticky top-28 z-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Post Templates</h1>
            <p className="mt-1 text-sm text-slate-400">
              Customize how posts are formatted for each social platform.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              <strong className="text-slate-400">All (Default)</strong> = base template for the
              platform. Pick a sector to override it. Sectors marked with{" "}
              <strong className="text-slate-400">*</strong> already have a custom override.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-400">Sector:</label>
            <select
              value={selectedSectorId}
              onChange={(e) => setSelectedSectorId(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              <option value="">All (Default)</option>
              {sectors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {selectedAccount && sectorOverrides.has(`${s.id}:${selectedAccount.platform}`)
                    ? " *"
                    : ""}
                </option>
              ))}
            </select>

            <span className="text-slate-600">|</span>

            <label className="text-sm text-slate-400">Platform:</label>
            <select
              value={selectedAccountId}
              onChange={(e) => {
                setSelectedAccountId(e.target.value);
                localStorage.setItem("postTemplates_selectedAccountId", e.target.value);
              }}
              className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.platform.charAt(0).toUpperCase() + a.platform.slice(1)} - {a.account_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isSectorMode &&
          selectedAccount &&
          sectorOverrides.has(`${selectedSectorId}:${selectedAccount.platform}`) && (
            <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <p className="text-sm text-emerald-200">
                Custom override active for{" "}
                <strong>{sectors.find((s) => s.id === selectedSectorId)?.name}</strong> on{" "}
                {selectedAccount.platform}.
              </p>
            </div>
          )}

        {isSectorMode &&
          selectedAccount &&
          !sectorOverrides.has(`${selectedSectorId}:${selectedAccount.platform}`) && (
            <div className="mt-4 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3">
              <p className="text-sm text-blue-200">
                No override for{" "}
                <strong>{sectors.find((s) => s.id === selectedSectorId)?.name}</strong> — using
                platform default. Customize and save to create a sector-specific template.
              </p>
            </div>
          )}

        {!isSectorMode && selectedAccount && !selectedAccount.is_template_custom && (
          <div className="mt-4 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3">
            <p className="text-sm text-blue-200">
              Using default template for {selectedAccount.platform}. Customize and save to create a
              custom template.
            </p>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Template Editor */}
        <section className="space-y-6">
          {/* Content Toggles */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h2 className="text-lg font-semibold">Post Components</h2>
            <p className="mt-1 text-sm text-slate-400">
              Toggle which elements appear in your posts.
            </p>
            <div className="mt-4 space-y-3">
              {/* Breaking Label */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Breaking Label</p>
                  <p className="text-xs text-slate-500">Show "BREAKING" prefix with emoji</p>
                </div>
                <button
                  onClick={() => updateTemplate("showBreakingLabel", !template.showBreakingLabel)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    template.showBreakingLabel ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      template.showBreakingLabel ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Breaking Emoji & Text (only show when breaking label is enabled) */}
              {template.showBreakingLabel && (
                <div className="ml-4 flex gap-3 border-l-2 border-slate-700 pl-4">
                  <div className="flex-1">
                    <label className="text-xs text-slate-500">Emoji</label>
                    <input
                      value={template.breakingEmoji}
                      onChange={(e) => updateTemplate("breakingEmoji", e.target.value)}
                      maxLength={10}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-slate-500">Text</label>
                    <input
                      value={template.breakingText}
                      onChange={(e) => updateTemplate("breakingText", e.target.value)}
                      maxLength={20}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                    />
                  </div>
                </div>
              )}

              {/* Sector Tag */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Sector Tag</p>
                  <p className="text-xs text-slate-500">Show sector name (BIOTECH, CRYPTO, etc.)</p>
                </div>
                <button
                  onClick={() => updateTemplate("showSectorTag", !template.showSectorTag)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    template.showSectorTag ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      template.showSectorTag ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Title */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Title</p>
                  <p className="text-xs text-slate-500">Show article title</p>
                </div>
                <button
                  onClick={() => updateTemplate("showTitle", !template.showTitle)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    template.showTitle ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      template.showTitle ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Summary */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Summary</p>
                  <p className="text-xs text-slate-500">Show LLM-generated summary</p>
                </div>
                <button
                  onClick={() => updateTemplate("showSummary", !template.showSummary)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    template.showSummary ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      template.showSummary ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* URL */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">URL Link</p>
                  <p className="text-xs text-slate-500">Show link to full article</p>
                </div>
                <button
                  onClick={() => updateTemplate("showUrl", !template.showUrl)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    template.showUrl ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      template.showUrl ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* URL Link Text (only show when URL is enabled) */}
              {template.showUrl && (
                <div className="ml-4 border-l-2 border-slate-700 pl-4">
                  <label className="text-xs text-slate-500">Link Text</label>
                  <input
                    value={template.urlLinkText}
                    onChange={(e) => updateTemplate("urlLinkText", e.target.value)}
                    maxLength={30}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  />
                </div>
              )}

              {/* Image */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Image</p>
                  <p className="text-xs text-slate-500">Attach AI-generated image to post</p>
                </div>
                <button
                  onClick={() => updateTemplate("showImage", !template.showImage)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    template.showImage ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      template.showImage ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Auto-Comment URL (Facebook & LinkedIn — posts source link as first comment) */}
              {template.showImage &&
                (selectedAccount?.platform === "facebook" ||
                  selectedAccount?.platform === "linkedin") && (
                  <div className="ml-4 border-l-2 border-slate-700 pl-4">
                    <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-slate-200">Auto-Comment URL</p>
                        <p className="text-xs text-slate-500">
                          Post source link as first comment instead of in text
                        </p>
                      </div>
                      <button
                        onClick={() => updateTemplate("autoCommentUrl", !template.autoCommentUrl)}
                        className={`relative h-6 w-11 rounded-full transition-colors ${
                          template.autoCommentUrl ? "bg-emerald-500" : "bg-slate-600"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                            template.autoCommentUrl ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                )}
            </div>
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
              {isSectorMode ? "Save Sector Override" : "Save Template"}
            </Button>
            <Button variant="secondary" size="lg" onClick={handleReset} disabled={isSaving}>
              {isSectorMode ? "Remove Override" : "Reset to Default"}
            </Button>
          </div>
        </section>

        {/* Right: Preview */}
        <section className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Live Preview</h2>
              {isPreviewLoading && <Spinner />}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Preview with sample {selectedAccount?.platform ?? "platform"} post.
            </p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              {selectedAccount?.platform === "telegram" ? (
                <div
                  className="whitespace-pre-wrap text-sm text-slate-200"
                  dangerouslySetInnerHTML={{
                    __html: preview
                      // Strip all tags except <b>, </b>, <a ...>, </a>
                      .replace(/<(?!\/?b>|\/?a[\s>])[^>]*>/gi, "")
                      .replace(/<b>/g, '<strong class="font-semibold">')
                      .replace(/<\/b>/g, "</strong>")
                      .replace(
                        /<a /g,
                        '<a class="text-blue-400 underline" rel="noopener noreferrer" ',
                      )
                      .replace(/\n\n/g, "<br/><br/>"),
                  }}
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm text-slate-200">{preview}</pre>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
              <span>Character count: {previewCharCount}</span>
              {selectedAccount?.platform === "telegram" && previewCharCount > 4096 && (
                <span className="text-amber-400">Exceeds Telegram limit (4096)</span>
              )}
            </div>
          </div>

          {/* Sample Article Info */}
          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-sm font-semibold text-slate-300">Sample Article</h3>
            <p className="mt-2 text-xs text-slate-500">
              <span className="text-slate-500">Title:</span> {SAMPLE_ARTICLE.title}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              <span className="text-slate-500">Sector:</span> {SAMPLE_ARTICLE.sector}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              <span className="text-slate-500">Summary:</span> {SAMPLE_ARTICLE.summary}
            </p>
          </div>
        </section>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetModal && (
        <ConfirmModal
          title={isSectorMode ? "Remove Sector Override" : "Reset to Default"}
          message={
            isSectorMode
              ? `This will remove the custom template for "${sectors.find((s) => s.id === selectedSectorId)?.name}" on ${selectedAccount?.platform ?? "platform"}. Posts will use the platform default. Continue?`
              : `This will reset the ${selectedAccount?.platform ?? "platform"} template to its default settings. Continue?`
          }
          confirmLabel={isSectorMode ? "Remove" : "Reset"}
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={confirmReset}
          onCancel={() => setShowResetModal(false)}
        />
      )}
    </div>
  );
}
