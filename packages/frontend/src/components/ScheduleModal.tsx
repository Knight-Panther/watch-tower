import { useState } from "react";
import type { Article } from "../api";

type ScheduleModalProps = {
  article: Article;
  onClose: () => void;
  onSchedule: (data: { platform: string; scheduledAt: Date; summary?: string }) => Promise<void>;
};

const PLATFORMS = [
  { id: "telegram", label: "Telegram", enabled: true },
  { id: "facebook", label: "Facebook", enabled: false, comingSoon: true },
  { id: "linkedin", label: "LinkedIn", enabled: false, comingSoon: true },
];

export default function ScheduleModal({ article, onClose, onSchedule }: ScheduleModalProps) {
  const [summary, setSummary] = useState(article.llm_summary || "");
  const [selectedPlatform, setSelectedPlatform] = useState("telegram");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Default to now + 1 hour, rounded to next 15 min
  const getDefaultDateTime = () => {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
    return now;
  };

  const defaultDate = getDefaultDateTime();
  const [date, setDate] = useState(defaultDate.toISOString().split("T")[0]);
  const [time, setTime] = useState(
    defaultDate.toTimeString().slice(0, 5), // HH:MM
  );

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const scheduledAt = new Date(`${date}T${time}`);
      await onSchedule({
        platform: selectedPlatform,
        scheduledAt,
        summary: summary !== article.llm_summary ? summary : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePostNow = async () => {
    setIsSubmitting(true);
    try {
      await onSchedule({
        platform: selectedPlatform,
        scheduledAt: new Date(), // Immediate
        summary: summary !== article.llm_summary ? summary : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
        <h3 className="text-lg font-semibold">Approve & Schedule</h3>

        {/* Article title */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-slate-400 mb-1">Article</label>
          <p className="text-slate-200 line-clamp-2">{article.title}</p>
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
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
          </div>
        </div>

        {/* Platform selection */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-slate-400 mb-2">Platform</label>
          <div className="space-y-2">
            {PLATFORMS.map((platform) => (
              <label
                key={platform.id}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition ${
                  selectedPlatform === platform.id && platform.enabled
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-slate-800 bg-slate-900/50"
                } ${!platform.enabled ? "opacity-50 cursor-not-allowed" : "hover:border-slate-600"}`}
              >
                <input
                  type="radio"
                  name="platform"
                  value={platform.id}
                  checked={selectedPlatform === platform.id}
                  onChange={(e) => platform.enabled && setSelectedPlatform(e.target.value)}
                  disabled={!platform.enabled}
                  className="h-4 w-4 text-emerald-500 focus:ring-emerald-500 bg-slate-800 border-slate-600"
                />
                <span className="text-sm text-slate-200">{platform.label}</span>
                {platform.comingSoon && (
                  <span className="ml-auto text-xs text-slate-500">(coming soon)</span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-between">
          <button
            onClick={handlePostNow}
            disabled={isSubmitting}
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
              disabled={isSubmitting}
              className="rounded-full bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
            >
              {isSubmitting ? "Scheduling..." : "Schedule"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
