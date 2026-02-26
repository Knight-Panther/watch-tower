import Articles from "./Articles";
import Scheduled from "./Scheduled";
import Tabs, { useTabState } from "../components/ui/Tabs";

const tabs = [
  { id: "articles", label: "Articles" },
  { id: "scheduled", label: "Scheduled" },
];

export default function ArticleScheduler() {
  const [activeTab, setActiveTab] = useTabState("articles", ["articles", "scheduled"]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Article Scheduler</h1>
        <p className="mt-1 text-sm text-slate-400">
          Browse articles and manage scheduled posts.
        </p>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} sticky />

      {activeTab === "articles" && <Articles />}
      {activeTab === "scheduled" && <Scheduled />}
    </div>
  );
}
