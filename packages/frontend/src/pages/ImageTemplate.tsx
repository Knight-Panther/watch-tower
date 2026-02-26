import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import Button from "../components/ui/Button";
import {
  getImageGenerationConfig,
  updateImageGenerationConfig,
  getImageTemplate,
  updateImageTemplate,
  type ImageGenerationConfig,
  type ImageTemplateConfig2,
} from "../api";

const DEFAULT_TEMPLATE: ImageTemplateConfig2 = {
  titlePosition: { x: 10, y: 70 },
  titleAlignment: "left",
  titleMaxWidth: 80,
  titleFontSize: 42,
  titleFontFamily: "Noto Sans Georgian",
  titleColor: "#FFFFFF",
  backdropEnabled: true,
  backdropColor: "#000000B3",
  backdropPadding: 24,
  backdropBorderRadius: 12,
  watermarkPosition: { x: 85, y: 5 },
  watermarkScale: 0.15,
};

const SAMPLE_TITLE = "FDA-მ დაამტკიცა რევოლუციური გენური თერაპია იშვიათი დაავადებისთვის";

const POSITION_PRESETS = [
  { label: "Top Left", x: 10, y: 10 },
  { label: "Top Center", x: 50, y: 10 },
  { label: "Center", x: 50, y: 50 },
  { label: "Bottom Left", x: 10, y: 70 },
  { label: "Bottom Center", x: 50, y: 70 },
];

const WATERMARK_PRESETS = [
  { label: "Top Right", x: 85, y: 5 },
  { label: "Top Left", x: 5, y: 5 },
  { label: "Bottom Right", x: 85, y: 90 },
  { label: "Bottom Left", x: 5, y: 90 },
];

// Parse hex color + optional alpha into { hex, opacity }
function parseColor(color: string): { hex: string; opacity: number } {
  if (color.length === 9) {
    // #RRGGBBAA
    const hex = color.slice(0, 7);
    const alpha = parseInt(color.slice(7), 16) / 255;
    return { hex, opacity: Math.round(alpha * 100) };
  }
  return { hex: color.slice(0, 7), opacity: 100 };
}

// Combine hex + opacity back
function buildColor(hex: string, opacity: number): string {
  if (opacity >= 100) return hex;
  const alpha = Math.round((opacity / 100) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `${hex}${alpha}`;
}

export default function ImageTemplate() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Generation config
  const [genConfig, setGenConfig] = useState<ImageGenerationConfig>({
    enabled: false,
    minScore: 4,
    quality: "medium",
    size: "1024x1536",
    prompt: "",
  });

  // Template config
  const [template, setTemplate] = useState<ImageTemplateConfig2>(DEFAULT_TEMPLATE);

  // Canvas ref for live preview
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showGrid, setShowGrid] = useState(false);

  // Load config on mount
  useEffect(() => {
    const load = async () => {
      try {
        const [gen, tmpl] = await Promise.all([getImageGenerationConfig(), getImageTemplate()]);
        setGenConfig(gen);
        setTemplate(tmpl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load config";
        toast.error(msg);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  // Redraw canvas preview whenever template changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    // Draw gradient background (simulating AI image)
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#1a1a3e");
    grad.addColorStop(0.5, "#2d1b4e");
    grad.addColorStop(1, "#0d2137");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Add subtle pattern
    ctx.globalAlpha = 0.1;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.arc(
        Math.sin(i * 0.8) * W * 0.3 + W * 0.5,
        Math.cos(i * 0.6) * H * 0.3 + H * 0.5,
        30 + i * 15,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = i % 2 === 0 ? "#4a9eff" : "#ff6b9d";
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Title position
    const titleX = (template.titlePosition.x / 100) * W;
    const titleY = (template.titlePosition.y / 100) * H;
    const maxW = (template.titleMaxWidth / 100) * W;

    // Scale font size for preview (canvas is smaller than actual image)
    const scale = W / 1024;
    const fontSize = template.titleFontSize * scale;

    // Word wrap (match backend font family for accurate wrapping)
    ctx.font = `bold ${fontSize}px "${template.titleFontFamily}", sans-serif`;
    ctx.textBaseline = "top";
    const words = SAMPLE_TITLE.split(" ");
    const lines: string[] = [];
    let currentLine = words[0] || "";

    for (let i = 1; i < words.length; i++) {
      const test = currentLine + " " + words[i];
      if (ctx.measureText(test).width > maxW) {
        lines.push(currentLine);
        currentLine = words[i];
      } else {
        currentLine = test;
      }
    }
    lines.push(currentLine);

    const lineHeight = fontSize * 1.35;
    const textBlockHeight = lines.length * lineHeight;

    // Backdrop
    if (template.backdropEnabled) {
      const { hex, opacity } = parseColor(template.backdropColor);
      const pad = template.backdropPadding * scale;
      const radius = template.backdropBorderRadius * scale;

      ctx.globalAlpha = opacity / 100;
      ctx.fillStyle = hex;

      const bx = titleX - pad;
      const by = titleY - pad;
      const bw = maxW + pad * 2;
      const bh = textBlockHeight + pad * 2;

      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, radius);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Title text (match backend: textBaseline "top", same font, same alignment logic)
    ctx.fillStyle = template.titleColor;
    ctx.font = `bold ${fontSize}px "${template.titleFontFamily}", sans-serif`;
    ctx.textBaseline = "top";
    ctx.textAlign = template.titleAlignment as CanvasTextAlign;

    const textX =
      template.titleAlignment === "center"
        ? titleX + maxW / 2
        : template.titleAlignment === "right"
          ? titleX + maxW
          : titleX;

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], textX, titleY + i * lineHeight);
    }

    // Watermark placeholder (matches backend position/scale exactly)
    const wmWidth = template.watermarkScale * W;
    const wmX = (template.watermarkPosition.x / 100) * W - wmWidth / 2;
    const wmY = (template.watermarkPosition.y / 100) * H;

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `bold ${wmWidth * 0.3}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("XTelo", wmX + wmWidth / 2, wmY);
    ctx.globalAlpha = 1;

    // Grid guides
    if (showGrid) {
      ctx.save();
      ctx.strokeStyle = "rgba(99, 200, 160, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);

      // Thirds
      for (const frac of [1 / 3, 2 / 3]) {
        ctx.beginPath();
        ctx.moveTo(W * frac, 0);
        ctx.lineTo(W * frac, H);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, H * frac);
        ctx.lineTo(W, H * frac);
        ctx.stroke();
      }

      // Center crosshair
      ctx.strokeStyle = "rgba(99, 200, 160, 0.55)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();

      // Safe margins (10%)
      ctx.strokeStyle = "rgba(250, 200, 80, 0.25)";
      ctx.setLineDash([2, 6]);
      const mx = W * 0.1;
      const my = H * 0.1;
      ctx.strokeRect(mx, my, W - mx * 2, H - my * 2);

      ctx.restore();
    }

    // Reset
    ctx.textAlign = "left";
  }, [template, genConfig.size, showGrid]);

  const updateGen = <K extends keyof ImageGenerationConfig>(
    key: K,
    value: ImageGenerationConfig[K],
  ) => {
    setGenConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const updateTmpl = <K extends keyof ImageTemplateConfig2>(
    key: K,
    value: ImageTemplateConfig2[K],
  ) => {
    setTemplate((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await Promise.all([updateImageGenerationConfig(genConfig), updateImageTemplate(template)]);
      toast.success("Image settings saved");
      setHasChanges(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setTemplate(DEFAULT_TEMPLATE);
    setHasChanges(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner /> <span className="ml-2 text-slate-400">Loading...</span>
      </div>
    );
  }

  const { hex: backdropHex, opacity: backdropOpacity } = parseColor(template.backdropColor);

  return (
    <div className="grid gap-6">
      {/* Header */}
      <section className="sticky top-28 z-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Image Template</h1>
            <p className="mt-1 text-sm text-slate-400">
              Configure AI image generation and news card layout.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={handleReset} disabled={isSaving}>
              Reset Defaults
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={handleSave}
              disabled={isSaving || !hasChanges}
              loading={isSaving}
              loadingText="Saving..."
            >
              Save
            </Button>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Controls */}
        <div className="space-y-6">
          {/* Generation Settings */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h2 className="text-lg font-semibold">Generation Settings</h2>
            <p className="mt-1 text-sm text-slate-400">
              Control when and how images are generated.
            </p>
            <div className="mt-4 space-y-4">
              {/* Enable toggle */}
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Enable Image Generation</p>
                  <p className="text-xs text-slate-500">
                    Generate AI images for high-scoring articles
                  </p>
                </div>
                <button
                  onClick={() => updateGen("enabled", !genConfig.enabled)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    genConfig.enabled ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      genConfig.enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Min Score */}
              <div className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-200">Minimum Score</p>
                  <span className="text-sm font-mono text-emerald-400">{genConfig.minScore}</span>
                </div>
                <p className="text-xs text-slate-500">
                  Only generate images for articles scored at or above this threshold.
                </p>
                <div className="mt-2 flex gap-2">
                  {[3, 4, 5].map((s) => (
                    <button
                      key={s}
                      onClick={() => updateGen("minScore", s)}
                      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                        genConfig.minScore === s
                          ? "bg-emerald-600 text-white"
                          : "border border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {s}+
                    </button>
                  ))}
                </div>
              </div>

              {/* Quality */}
              <div className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <p className="text-sm font-medium text-slate-200">Quality</p>
                <div className="mt-2 flex gap-2">
                  {["low", "medium", "high"].map((q) => (
                    <button
                      key={q}
                      onClick={() => updateGen("quality", q)}
                      className={`rounded-lg px-4 py-1.5 text-sm font-medium capitalize transition ${
                        genConfig.quality === q
                          ? "bg-emerald-600 text-white"
                          : "border border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              {/* Size */}
              <div className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <p className="text-sm font-medium text-slate-200">Image Size</p>
                <div className="mt-2 flex gap-2">
                  {[
                    { value: "1024x1024", label: "Square" },
                    { value: "1024x1536", label: "Portrait" },
                    { value: "1536x1024", label: "Landscape" },
                  ].map((s) => (
                    <button
                      key={s.value}
                      onClick={() => updateGen("size", s.value)}
                      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                        genConfig.size === s.value
                          ? "bg-emerald-600 text-white"
                          : "border border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Image Generation Prompt */}
              <div className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
                <p className="text-sm font-medium text-slate-200">Image Prompt</p>
                <p className="text-xs text-slate-500">
                  System prompt sent to the AI image generator. Use{" "}
                  <code className="text-emerald-400">{"{summary}"}</code> as a placeholder for
                  the article&apos;s English summary.
                </p>
                <textarea
                  value={genConfig.prompt}
                  onChange={(e) => updateGen("prompt", e.target.value)}
                  rows={5}
                  placeholder="Create a professional, visually striking editorial illustration for a news article. The image should work well as a social media news card background with text overlay. Use modern, clean design with bold colors and clear visual hierarchy. Do NOT include any text, words, or letters in the image. Article topic: {summary}"
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>
          </section>

          {/* Title Settings */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h2 className="text-lg font-semibold">Title Overlay</h2>
            <div className="mt-4 space-y-4">
              {/* Position presets */}
              <div>
                <p className="text-sm text-slate-400">Position Preset</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {POSITION_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => {
                        updateTmpl("titlePosition", { x: p.x, y: p.y });
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                        template.titlePosition.x === p.x && template.titlePosition.y === p.y
                          ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                          : "border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* X/Y sliders */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-500">
                    X Position ({template.titlePosition.x}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={template.titlePosition.x}
                    onChange={(e) =>
                      updateTmpl("titlePosition", {
                        ...template.titlePosition,
                        x: Number(e.target.value),
                      })
                    }
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">
                    Y Position ({template.titlePosition.y}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={template.titlePosition.y}
                    onChange={(e) =>
                      updateTmpl("titlePosition", {
                        ...template.titlePosition,
                        y: Number(e.target.value),
                      })
                    }
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
              </div>

              {/* Alignment */}
              <div>
                <p className="text-xs text-slate-500">Alignment</p>
                <div className="mt-1 flex gap-2">
                  {(["left", "center", "right"] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => updateTmpl("titleAlignment", a)}
                      className={`rounded-lg px-4 py-1.5 text-xs capitalize transition ${
                        template.titleAlignment === a
                          ? "bg-emerald-600 text-white"
                          : "border border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>

              {/* Max Width */}
              <div>
                <label className="text-xs text-slate-500">
                  Max Width ({template.titleMaxWidth}%)
                </label>
                <input
                  type="range"
                  min={20}
                  max={100}
                  value={template.titleMaxWidth}
                  onChange={(e) => updateTmpl("titleMaxWidth", Number(e.target.value))}
                  className="mt-1 w-full accent-emerald-500"
                />
              </div>

              {/* Font Size */}
              <div>
                <label className="text-xs text-slate-500">
                  Font Size ({template.titleFontSize}px)
                </label>
                <input
                  type="range"
                  min={16}
                  max={96}
                  value={template.titleFontSize}
                  onChange={(e) => updateTmpl("titleFontSize", Number(e.target.value))}
                  className="mt-1 w-full accent-emerald-500"
                />
              </div>

              {/* Title Color */}
              <div className="flex items-center gap-3">
                <label className="text-xs text-slate-500">Color</label>
                <input
                  type="color"
                  value={template.titleColor.slice(0, 7)}
                  onChange={(e) => updateTmpl("titleColor", e.target.value)}
                  className="h-8 w-8 cursor-pointer rounded border border-slate-700 bg-transparent"
                />
                <span className="font-mono text-xs text-slate-500">{template.titleColor}</span>
              </div>
            </div>
          </section>

          {/* Backdrop Settings */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Backdrop</h2>
              <button
                onClick={() => updateTmpl("backdropEnabled", !template.backdropEnabled)}
                className={`relative h-6 w-11 rounded-full transition-colors ${
                  template.backdropEnabled ? "bg-emerald-500" : "bg-slate-600"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                    template.backdropEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            {template.backdropEnabled && (
              <div className="mt-4 space-y-4">
                <div className="flex items-center gap-3">
                  <label className="text-xs text-slate-500">Color</label>
                  <input
                    type="color"
                    value={backdropHex}
                    onChange={(e) =>
                      updateTmpl("backdropColor", buildColor(e.target.value, backdropOpacity))
                    }
                    className="h-8 w-8 cursor-pointer rounded border border-slate-700 bg-transparent"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">Opacity ({backdropOpacity}%)</label>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={backdropOpacity}
                    onChange={(e) =>
                      updateTmpl("backdropColor", buildColor(backdropHex, Number(e.target.value)))
                    }
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">
                    Padding ({template.backdropPadding}px)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={template.backdropPadding}
                    onChange={(e) => updateTmpl("backdropPadding", Number(e.target.value))}
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">
                    Border Radius ({template.backdropBorderRadius}px)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    value={template.backdropBorderRadius}
                    onChange={(e) => updateTmpl("backdropBorderRadius", Number(e.target.value))}
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Watermark Settings */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h2 className="text-lg font-semibold">Watermark</h2>
            <div className="mt-4 space-y-4">
              <div>
                <p className="text-xs text-slate-500">Position Preset</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WATERMARK_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => updateTmpl("watermarkPosition", { x: p.x, y: p.y })}
                      className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                        template.watermarkPosition.x === p.x &&
                        template.watermarkPosition.y === p.y
                          ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                          : "border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-500">
                    X ({template.watermarkPosition.x}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={template.watermarkPosition.x}
                    onChange={(e) =>
                      updateTmpl("watermarkPosition", {
                        ...template.watermarkPosition,
                        x: Number(e.target.value),
                      })
                    }
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">
                    Y ({template.watermarkPosition.y}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={template.watermarkPosition.y}
                    onChange={(e) =>
                      updateTmpl("watermarkPosition", {
                        ...template.watermarkPosition,
                        y: Number(e.target.value),
                      })
                    }
                    className="mt-1 w-full accent-emerald-500"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-500">
                  Scale ({Math.round(template.watermarkScale * 100)}%)
                </label>
                <input
                  type="range"
                  min={5}
                  max={100}
                  value={Math.round(template.watermarkScale * 100)}
                  onChange={(e) => updateTmpl("watermarkScale", Number(e.target.value) / 100)}
                  className="mt-1 w-full accent-emerald-500"
                />
              </div>
            </div>
          </section>
        </div>

        {/* Right: Live Preview */}
        <div className="lg:sticky lg:top-48 lg:self-start">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Live Preview</h2>
              <button
                onClick={() => setShowGrid((v) => !v)}
                className={[
                  "rounded-lg border px-3 py-1 text-xs font-medium transition",
                  showGrid
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    : "border-slate-700 text-slate-500 hover:border-slate-500",
                ].join(" ")}
              >
                Grid
              </button>
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Preview shows approximate layout. Actual images use AI-generated backgrounds.
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-800">
              <canvas
                ref={canvasRef}
                width={genConfig.size === "1536x1024" ? 768 : 512}
                height={
                  genConfig.size === "1024x1024"
                    ? 512
                    : genConfig.size === "1536x1024"
                      ? 512
                      : 768
                }
                className="w-full"
                style={{
                  aspectRatio:
                    genConfig.size === "1024x1024"
                      ? "1/1"
                      : genConfig.size === "1536x1024"
                        ? "3/2"
                        : "2/3",
                }}
              />
            </div>
          </section>

          {/* Cost estimate */}
          <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
            <h3 className="text-sm font-semibold text-slate-300">Estimated Cost</h3>
            <p className="mt-2 text-xs text-slate-500">
              Based on {genConfig.quality} quality, {genConfig.size} size:
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <span className="text-slate-500">Per image:</span>
              <span className="text-slate-300">
                $
                {(
                  (genConfig.quality === "low"
                    ? genConfig.size === "1024x1024"
                      ? 5
                      : 6
                    : genConfig.quality === "high"
                      ? genConfig.size === "1024x1024"
                        ? 36
                        : 52
                      : genConfig.size === "1024x1024"
                        ? 11
                        : 15) / 1000
                ).toFixed(3)}
              </span>
              <span className="text-slate-500">~30/day:</span>
              <span className="text-slate-300">
                $
                {(
                  ((genConfig.quality === "low"
                    ? genConfig.size === "1024x1024"
                      ? 5
                      : 6
                    : genConfig.quality === "high"
                      ? genConfig.size === "1024x1024"
                        ? 36
                        : 52
                      : genConfig.size === "1024x1024"
                        ? 11
                        : 15) /
                    1000) *
                  30
                ).toFixed(2)}
                /day
              </span>
              <span className="text-slate-500">~30/day (monthly):</span>
              <span className="text-slate-300">
                ~$
                {(
                  ((genConfig.quality === "low"
                    ? genConfig.size === "1024x1024"
                      ? 5
                      : 6
                    : genConfig.quality === "high"
                      ? genConfig.size === "1024x1024"
                        ? 36
                        : 52
                      : genConfig.size === "1024x1024"
                        ? 11
                        : 15) /
                    1000) *
                  30 *
                  30
                ).toFixed(0)}
                /mo
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
