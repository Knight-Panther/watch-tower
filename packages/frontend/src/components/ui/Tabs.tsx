import { useSearchParams } from "react-router-dom";
import { useRef } from "react";

type Tab = { id: string; label: string };

type TabsProps = {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
  sticky?: boolean;
};

export function useTabState<T extends string>(
  defaultTab: T,
  validTabs: readonly T[],
): [T, (tab: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get("tab") as T | null;
  const activeTab = param && validTabs.includes(param) ? param : defaultTab;
  const setActiveTab = (tab: string) => {
    setSearchParams(tab === defaultTab ? {} : { tab }, { replace: true });
  };
  return [activeTab, setActiveTab];
}

export default function Tabs({ tabs, activeTab, onChange, sticky }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    buttons?.[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      className={
        sticky
          ? "sticky top-[var(--nav-h)] z-30 flex gap-1 border-b border-slate-800 bg-slate-950/95 backdrop-blur -mx-6 px-6 py-1"
          : "flex gap-1 border-b border-slate-800"
      }
    >
      {tabs.map((tab, i) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={`px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 rounded ${
              isActive
                ? "border-b-2 border-emerald-400 text-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
