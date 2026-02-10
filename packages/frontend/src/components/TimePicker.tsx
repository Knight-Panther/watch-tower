import { useState, useRef, useEffect } from "react";

type TimePickerProps = {
  value: string; // HH:MM
  onChange: (value: string) => void;
};

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const pad = (n: number) => String(n).padStart(2, "0");

export default function TimePicker({ value, onChange }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value || "00:00");
  const hourRef = useRef<HTMLDivElement>(null);
  const minuteRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [selectedHour, selectedMinute] = (value || "12:00").split(":");

  // Sync input when external value changes
  useEffect(() => {
    setInputValue(value || "00:00");
  }, [value]);

  const setHour = (h: string) => {
    const v = `${h}:${selectedMinute}`;
    onChange(v);
    setInputValue(v);
  };

  const setMinute = (m: string) => {
    const v = `${selectedHour}:${m}`;
    onChange(v);
    setInputValue(v);
  };

  // Parse flexible typed input: "14:30", "1430", "14.30", "14 30", "9:5" etc.
  const applyInput = (raw: string) => {
    const cleaned = raw.replace(/[.\s]/g, ":").replace(/[^0-9:]/g, "");
    let h: number, m: number;

    if (cleaned.includes(":")) {
      const parts = cleaned.split(":");
      h = parseInt(parts[0]) || 0;
      m = parseInt(parts[1]) || 0;
    } else if (cleaned.length >= 3) {
      h = parseInt(cleaned.slice(0, -2)) || 0;
      m = parseInt(cleaned.slice(-2)) || 0;
    } else {
      h = parseInt(cleaned) || 0;
      m = 0;
    }

    h = Math.max(0, Math.min(23, h));
    m = Math.max(0, Math.min(59, m));

    const v = `${pad(h)}:${pad(m)}`;
    onChange(v);
    setInputValue(v);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      applyInput(inputValue);
      setOpen(false);
      inputRef.current?.blur();
    }
    if (e.key === "Escape") {
      setInputValue(value);
      setOpen(false);
      inputRef.current?.blur();
    }
    // Arrow keys to nudge time
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const [hStr, mStr] = (value || "00:00").split(":");
      let h = parseInt(hStr), m = parseInt(mStr);
      const step = e.shiftKey ? 15 : 1; // Shift+arrow = 15 min jumps
      if (e.key === "ArrowUp") {
        m += step;
        while (m >= 60) { m -= 60; h = (h + 1) % 24; }
      } else {
        m -= step;
        while (m < 0) { m += 60; h = (h - 1 + 24) % 24; }
      }
      const v = `${pad(h)}:${pad(m)}`;
      onChange(v);
      setInputValue(v);
    }
  };

  // Scroll selected into view on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        hourRef.current
          ?.querySelector("[data-selected=true]")
          ?.scrollIntoView({ block: "center", behavior: "instant" });
        minuteRef.current
          ?.querySelector("[data-selected=true]")
          ?.scrollIntoView({ block: "center", behavior: "instant" });
      });
    }
  }, [open]);

  // Live-scroll dropdown as user types
  useEffect(() => {
    if (!open) return;
    const cleaned = inputValue.replace(/[.\s]/g, ":").replace(/[^0-9:]/g, "");
    let typedH: string | null = null;
    let typedM: string | null = null;

    if (cleaned.includes(":")) {
      const [hPart, mPart] = cleaned.split(":");
      if (hPart.length > 0) typedH = pad(Math.min(23, parseInt(hPart) || 0));
      if (mPart && mPart.length > 0) typedM = pad(Math.min(59, parseInt(mPart) || 0));
    } else if (cleaned.length >= 1 && cleaned.length <= 2) {
      typedH = pad(Math.min(23, parseInt(cleaned) || 0));
    } else if (cleaned.length >= 3) {
      typedH = pad(Math.min(23, parseInt(cleaned.slice(0, -2)) || 0));
      typedM = pad(Math.min(59, parseInt(cleaned.slice(-2)) || 0));
    }

    if (typedH) {
      const el = hourRef.current?.querySelector(`[data-hour="${typedH}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (typedM) {
      const el = minuteRef.current?.querySelector(`[data-minute="${typedM}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [inputValue, open]);

  // ESC closes dropdown first (stops propagation so modal doesn't close)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        applyInput(inputValue);
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", handler, true); // capture phase
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, inputValue]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        applyInput(inputValue);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, inputValue]);

  return (
    <div className="relative" ref={containerRef}>
      {/* Editable text input + clock icon to toggle dropdown */}
      <div className="flex items-center rounded-xl border border-slate-800 bg-slate-900 overflow-hidden focus-within:border-slate-600">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => applyInput(inputValue)}
          onKeyDown={handleKeyDown}
          placeholder="HH:MM"
          maxLength={5}
          className="w-full bg-transparent px-4 py-3 text-sm text-slate-200 outline-none font-mono"
        />
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault(); // Don't steal focus from input
            setOpen(!open);
          }}
          className="px-3 py-3 text-slate-400 hover:text-slate-200 transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </button>
      </div>

      {/* Scroll dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 rounded-xl border border-slate-700 bg-slate-900 shadow-xl overflow-hidden">
          {/* Column headers */}
          <div className="flex border-b border-slate-700">
            <div className="w-16 text-center py-1.5 text-xs text-slate-400 font-medium">Hour</div>
            <div className="w-px bg-slate-700" />
            <div className="w-16 text-center py-1.5 text-xs text-slate-400 font-medium">Min</div>
          </div>

          <div className="flex">
            {/* Hours */}
            <div ref={hourRef} className="h-52 w-16 overflow-y-auto py-1">
              {HOURS.map((h) => {
                const isSelected = h === selectedHour;
                return (
                  <button
                    key={h}
                    type="button"
                    data-selected={isSelected}
                    data-hour={h}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setHour(h);
                    }}
                    className={`w-full py-1.5 text-center text-sm font-mono transition ${
                      isSelected
                        ? "bg-emerald-500/25 text-emerald-200 font-semibold"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    {h}
                  </button>
                );
              })}
            </div>

            <div className="w-px bg-slate-700/50" />

            {/* Minutes */}
            <div ref={minuteRef} className="h-52 w-16 overflow-y-auto py-1">
              {MINUTES.map((m) => {
                const isSelected = m === selectedMinute;
                const isQuarter = parseInt(m) % 15 === 0;
                return (
                  <button
                    key={m}
                    type="button"
                    data-selected={isSelected}
                    data-minute={m}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setMinute(m);
                    }}
                    className={`w-full py-1.5 text-center text-sm font-mono transition ${
                      isSelected
                        ? "bg-emerald-500/25 text-emerald-200 font-semibold"
                        : isQuarter
                          ? "text-slate-200 hover:bg-slate-800"
                          : "text-slate-400 hover:bg-slate-800"
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
