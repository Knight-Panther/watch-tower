import { useSearchParams } from "react-router-dom";
import Articles from "./Articles";
import Scheduled from "./Scheduled";

type TabId = "articles" | "scheduled";

export default function ArticleScheduler() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read tab from URL, default to "articles"
  const tabParam = searchParams.get("tab");
  const activeTab: TabId = tabParam === "scheduled" ? "scheduled" : "articles";

  const setActiveTab = (tab: TabId) => {
    setSearchParams(tab === "articles" ? {} : { tab }, { replace: true });
  };

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Article Scheduler</h1>
        <p className="mt-1 text-sm text-slate-400">
          Browse articles and manage scheduled posts.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {[
          { id: "articles", label: "Articles" },
          { id: "scheduled", label: "Scheduled" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id
                ? "border-b-2 border-cyan-400 text-cyan-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "articles" && <Articles />}
      {activeTab === "scheduled" && <Scheduled />}
    </div>
  );
}
