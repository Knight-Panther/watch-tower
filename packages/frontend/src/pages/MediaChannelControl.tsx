import { useSearchParams } from "react-router-dom";
import PostTemplates from "./PostTemplates";
import PlatformSettings from "./PlatformSettings";

type TabId = "formats" | "platforms";

export default function MediaChannelControl() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read tab from URL, default to "formats"
  const tabParam = searchParams.get("tab");
  const activeTab: TabId = tabParam === "platforms" ? "platforms" : "formats";

  const setActiveTab = (tab: TabId) => {
    setSearchParams(tab === "formats" ? {} : { tab }, { replace: true });
  };

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Media Channel Control</h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage post formats and platform settings for social media distribution.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {[
          { id: "formats", label: "Post Formats" },
          { id: "platforms", label: "Platforms" },
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
      {activeTab === "formats" && <PostTemplates />}
      {activeTab === "platforms" && <PlatformSettings />}
    </div>
  );
}
