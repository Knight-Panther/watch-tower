import { useState, useEffect } from "react";
import type { Article } from "../api";
import DatePicker from "./DatePicker";
import TimePicker from "./TimePicker";

type ScheduleModalProps = {
  article: Article;
  postingLanguage: "en" | "ka";
  onClose: () => void;
  onSchedule: (data: { platforms: string[]; scheduledAt: Date; title?: string; summary?: string }) => Promise<void>;
};

const PLATFORMS = [
  { id: "telegram", label: "Telegram", icon: "📨" },
  { id: "facebook", label: "Facebook", icon: "📘" },
  { id: "linkedin", label: "LinkedIn", icon: "💼" },
];

const pad = (n: number) => String(n).padStart(2, "0");

const formatLocalDate = (d: Date) => {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const formatLocalTime = (d: Date) => {
  const m = d.getMinutes();
  const snapped = Math.ceil(m / 15) * 15;
  const mins = snapped === 60 ? 0 : snapped;
  const hrs = snapped === 60 ? d.getHours() + 1 : d.getHours();
  return `${pad(hrs % 24)}:${pad(mins)}`;
};

export default function ScheduleModal({ article, postingLanguage, onClose, onSchedule }: ScheduleModalProps) {
  const isTranslated = article.translation_status === "translated" && !!article.title_ka;
  const isKaNoTranslation = postingLanguage === "ka" && !isTranslated;
  const isKa = postingLanguage === "ka" && isTranslated;
  const displayTitle = isKa && article.title_ka ? article.title_ka : article.title;
  const baseTitle = displayTitle;
  const baseSummary = isKa && article.llm_summary_ka ? article.llm_summary_ka : (article.llm_summary || "");
  const [title, setTitle] = useState(baseTitle);
  const [summary, setSummary] = useState(baseSummary);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["telegram"]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const now = new Date();
  const [date, setDate] = useState(formatLocalDate(now));
  const [time, setTime] = useState(formatLocalTime(now));

  // ESC closes modal (only if no picker dropdown consumed it first)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handler); // bubble phase (pickers use capture)
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const togglePlatform = (platformId: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platformId)
        ? prev.filter((p) => p !== platformId)
        : [...prev, platformId],
    );
  };

  const handleSubmit = async () => {
    if (selectedPlatforms.length === 0) {
      return;
    }
    setIsSubmitting(true);
    try {
      const scheduledAt = new Date(`${date}T${time}`);
      await onSchedule({
        platforms: selectedPlatforms,
        scheduledAt,
        title: title !== baseTitle ? title : undefined,
        summary: summary !== baseSummary ? summary : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePostNow = async () => {
    if (selectedPlatforms.length === 0) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onSchedule({
        platforms: selectedPlatforms,
        scheduledAt: new Date(), // Immediate
        title: title !== baseTitle ? title : undefined,
        summary: summary !== baseSummary ? summary : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Preview in local 24h format
  const previewDate = new Date(`${date}T${time}`);
  const previewStr = isNaN(previewDate.getTime())
    ? "Invalid date"
    : previewDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }) +
      ", " +
      pad(previewDate.getHours()) +
      ":" +
      pad(previewDate.getMinutes());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
        <h3 className="text-lg font-semibold">Approve & Schedule</h3>

        {/* Georgian mode: block scheduling if not translated */}
        {isKaNoTranslation ? (
          <>
            <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              <p className="font-medium">Cannot schedule — translation required</p>
              <p className="mt-1 text-red-300/80">
                Posting language is set to Georgian but this article has not been translated yet.
                Translate it first (manually or via auto-translate), then schedule.
              </p>
            </div>
            <p className="mt-3 text-xs text-slate-500 truncate">{article.title}</p>
            <div className="mt-6 flex justify-end">
              <button
                onClick={onClose}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Article title */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-slate-400 mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
              />
            </div>

            {/* Summary edit */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-slate-400 mb-1">Summary</label>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
                placeholder="Enter or edit summary..."
              />
            </div>

            {/* Date and Time */}
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Date</label>
                <DatePicker value={date} onChange={setDate} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Time</label>
                <TimePicker value={time} onChange={setTime} />
              </div>
            </div>

            {/* Local Time Preview */}
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
              <span>⏰</span>
              <span>
                Will post at:{" "}
                <span className="text-slate-200 font-medium">{previewStr}</span>
              </span>
            </div>

            {/* Platform selection (multi-select) */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-slate-400 mb-2">
                Platforms <span className="text-slate-500">(select one or more)</span>
              </label>
              <div className="space-y-2">
                {PLATFORMS.map((platform) => {
                  const isSelected = selectedPlatforms.includes(platform.id);
                  return (
                    <label
                      key={platform.id}
                      className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition ${
                        isSelected
                          ? "border-emerald-500/50 bg-emerald-500/10"
                          : "border-slate-800 bg-slate-900/50 hover:border-slate-600"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => togglePlatform(platform.id)}
                        className="h-4 w-4 rounded text-emerald-500 focus:ring-emerald-500 bg-slate-800 border-slate-600"
                      />
                      <span className="text-lg">{platform.icon}</span>
                      <span className="text-sm text-slate-200">{platform.label}</span>
                    </label>
                  );
                })}
              </div>
              {selectedPlatforms.length === 0 && (
                <p className="mt-2 text-xs text-amber-400">Select at least one platform</p>
              )}
            </div>

            {/* Actions */}
            <div className="mt-6 flex justify-between">
              <button
                onClick={handlePostNow}
                disabled={isSubmitting || selectedPlatforms.length === 0}
                className="rounded-full border border-amber-500/50 px-4 py-2 text-sm text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
              >
                Post Now
              </button>
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  disabled={isSubmitting}
                  className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting || selectedPlatforms.length === 0}
                  className="rounded-full bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                >
                  {isSubmitting ? "Scheduling..." : "Schedule"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
