import { Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import { Toaster } from "sonner";
import Layout from "./components/Layout";
import PageErrorFallback from "./components/PageErrorFallback";
import NotFound from "./components/NotFound";
import Monitoring from "./pages/Monitoring";
import Settings from "./pages/Settings";
import Home from "./pages/Home";
import ArticleScheduler from "./pages/ArticleScheduler";
import ScoringRules from "./pages/ScoringRules";
import MediaChannelControl from "./pages/MediaChannelControl";
import ImageTemplate from "./pages/ImageTemplate";
import SiteRules from "./pages/SiteRules";
import Alerts from "./pages/Alerts";
import DigestSettings from "./pages/DigestSettings";
import Analytics from "./pages/Analytics";
import {
  ServerEventsProvider,
  useServerEventsContext,
} from "./contexts/ServerEventsContext";

function AppShell({ children }: { children: React.ReactNode }) {
  const { status } = useServerEventsContext();
  return <Layout connectionStatus={status}>{children}</Layout>;
}

export default function App() {
  return (
    <ServerEventsProvider>
      <AppShell>
        <Toaster richColors position="top-right" />
        <Routes>
          <Route path="/" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><Home /></ErrorBoundary>} />
          <Route path="/monitoring" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><Monitoring /></ErrorBoundary>} />
          <Route path="/article-scheduler" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><ArticleScheduler /></ErrorBoundary>} />
          <Route path="/scoring-rules" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><ScoringRules /></ErrorBoundary>} />
          <Route path="/media-channels" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><MediaChannelControl /></ErrorBoundary>} />
          <Route path="/image-template" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><ImageTemplate /></ErrorBoundary>} />
          <Route path="/site-rules" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><SiteRules /></ErrorBoundary>} />
          <Route path="/alerts" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><Alerts /></ErrorBoundary>} />
          <Route path="/digest" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><DigestSettings /></ErrorBoundary>} />
          <Route path="/analytics" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><Analytics /></ErrorBoundary>} />
          <Route path="/settings" element={<ErrorBoundary FallbackComponent={PageErrorFallback}><Settings /></ErrorBoundary>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppShell>
    </ServerEventsProvider>
  );
}
