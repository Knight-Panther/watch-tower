import { useState } from "react";
import { toast } from "sonner";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
  placeholder?: string;
  /** Tailwind color classes for pills (bg + text). Default: emerald */
  color?: "emerald" | "red" | "orange" | "amber" | "cyan";
  /** Minimum character length for a tag (shows warning below threshold) */
  minLength?: number;
}

const COLOR_MAP: Record<string, { pill: string; x: string }> = {
  emerald: { pill: "bg-emerald-500/20 text-emerald-200", x: "text-emerald-300 hover:text-emerald-100" },
  red: { pill: "bg-red-500/20 text-red-200", x: "text-red-300 hover:text-red-100" },
  orange: { pill: "bg-orange-500/20 text-orange-200", x: "text-orange-300 hover:text-orange-100" },
  amber: { pill: "bg-amber-500/20 text-amber-200", x: "text-amber-300 hover:text-amber-100" },
  cyan: { pill: "bg-cyan-500/20 text-cyan-200", x: "text-cyan-300 hover:text-cyan-100" },
};

export default function TagInput({
  tags,
  onChange,
  maxTags = 20,
  placeholder = "Add tag...",
  color = "emerald",
  minLength,
}: TagInputProps) {
  const [input, setInput] = useState("");
  const colors = COLOR_MAP[color] ?? COLOR_MAP.emerald;

  const addTag = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (tags.includes(trimmed)) {
      toast.error("Tag already exists");
      return;
    }
    if (tags.length >= maxTags) {
      toast.error(`Maximum ${maxTags} tags allowed`);
      return;
    }
    onChange([...tags, trimmed]);
    setInput("");
  };

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  const showMinLengthWarning = minLength && input.trim().length > 0 && input.trim().length < minLength;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag, i) => (
          <span
            key={i}
            className={`flex items-center gap-1 rounded-full px-3 py-1 text-sm ${colors.pill}`}
          >
            {tag}
            <button onClick={() => removeTag(i)} className={`ml-1 ${colors.x}`}>
              x
            </button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag(input);
            }
            if (e.key === "Escape") {
              setInput("");
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
        />
        <button
          onClick={() => addTag(input)}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
        >
          Add
        </button>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <span className="text-xs text-slate-500">
          {tags.length}/{maxTags}
        </span>
        {showMinLengthWarning && (
          <span className="text-xs text-amber-400">
            Tag should be at least {minLength} characters
          </span>
        )}
      </div>
    </div>
  );
}
