import PostTemplates from "./PostTemplates";
import PlatformSettings from "./PlatformSettings";
import Tabs, { useTabState } from "../components/ui/Tabs";

const tabs = [
  { id: "formats", label: "Post Formats" },
  { id: "platforms", label: "Platforms" },
];

export default function MediaChannelControl() {
  const [activeTab, setActiveTab] = useTabState("formats", ["formats", "platforms"]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Media Channel Control</h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage post formats and platform settings for social media distribution.
        </p>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "formats" && <PostTemplates />}
      {activeTab === "platforms" && <PlatformSettings />}
    </div>
  );
}
