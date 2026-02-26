import { NavLink } from "react-router-dom";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "../hooks/useServerEvents";
import { getEmergencyStop, setEmergencyStop } from "../api";

const navItems = [
  { to: "/", label: "Home" },
  { to: "/monitoring", label: "Monitoring" },
  { to: "/article-scheduler", label: "Article Scheduler" },
  { to: "/sectors", label: "Sectors" },
  { to: "/scoring-rules", label: "LLM Brain" },
  { to: "/media-channels", label: "Media Channels" },
  { to: "/image-template", label: "Image Template" },
  { to: "/site-rules", label: "Restrictions" },
  { to: "/alerts", label: "Alerts" },
  { to: "/digest", label: "Daily Digest" },
  { to: "/analytics", label: "Analytics" },
  { to: "/settings", label: "DB/Telemetry" },
];

type LayoutProps = {
  children: ReactNode;
  connectionStatus?: ConnectionStatus;
};

const statusColors: Record<ConnectionStatus, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-slate-500",
  error: "bg-red-500",
};

const statusLabels: Record<ConnectionStatus, string> = {
  connected: "Live",
  connecting: "Connecting...",
  disconnected: "Offline",
  error: "Error",
};

export default function Layout({ children, connectionStatus }: LayoutProps) {
  const headerRef = useRef<HTMLElement>(null);

  // Kill switch state
  const [emergencyStop, setEmergencyStopState] = useState(false);
  const [killSwitchLoading, setKillSwitchLoading] = useState(true);
  const [killSwitchToggling, setKillSwitchToggling] = useState(false);
  const [showKillModal, setShowKillModal] = useState(false);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty("--nav-h", `${el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadKillSwitch = useCallback(async () => {
    try {
      setKillSwitchLoading(true);
      const data = await getEmergencyStop();
      setEmergencyStopState(data.enabled);
    } catch {
      // Non-critical
    } finally {
      setKillSwitchLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKillSwitch();
  }, [loadKillSwitch]);

  const executeToggle = async () => {
    const newState = !emergencyStop;
    try {
      setKillSwitchToggling(true);
      await setEmergencyStop(newState);
      setEmergencyStopState(newState);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to toggle kill switch");
    } finally {
      setKillSwitchToggling(false);
      setShowKillModal(false);
    }
  };

  // Close modal on Escape
  useEffect(() => {
    if (!showKillModal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowKillModal(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showKillModal]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header ref={headerRef} className="sticky top-0 z-40 border-b border-slate-900/70 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-lg font-semibold">Media Watch Tower</p>
              <p className="text-xs text-slate-500">TELO Tower</p>
            </div>
            {connectionStatus && (
              <div className="flex items-center gap-1.5 rounded-full border border-slate-800 px-2.5 py-1">
                <span className={`h-2 w-2 rounded-full ${statusColors[connectionStatus]}`} />
                <span className="text-xs text-slate-400">{statusLabels[connectionStatus]}</span>
              </div>
            )}

            {/* Kill Switch — always visible */}
            {!killSwitchLoading && (
              <div
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-1.5 ${
                  emergencyStop
                    ? "border-red-700 bg-red-950/40"
                    : "border-slate-800 bg-slate-900/40"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      emergencyStop ? "bg-red-500 animate-pulse" : "bg-emerald-500"
                    }`}
                  />
                  <span className="text-xs font-medium text-slate-400">Kill Switch</span>
                </div>
                <button
                  onClick={() => setShowKillModal(true)}
                  disabled={killSwitchToggling}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                    emergencyStop
                      ? "bg-emerald-600 text-white hover:bg-emerald-500"
                      : "bg-red-600 text-white hover:bg-red-500"
                  }`}
                >
                  {killSwitchToggling
                    ? "..."
                    : emergencyStop
                      ? "RESUME POSTING"
                      : "STOP ALL POSTING"}
                </button>
              </div>
            )}
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-full border px-4 py-2 transition ${
                    isActive
                      ? "border-emerald-400/70 text-emerald-100"
                      : "border-slate-800 text-slate-300 hover:border-slate-600"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-6 py-10">
        {children}
      </main>

      <footer className="border-t border-slate-900/70 bg-slate-950/80 px-6 py-6 text-center text-xs text-slate-500">
        All Rights Reserved - TELO Tower
      </footer>

      {/* Kill Switch Confirmation Modal */}
      {showKillModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowKillModal(false)}
        >
          <div
            className={`mx-4 w-full max-w-md rounded-2xl border-2 p-6 shadow-2xl ${
              emergencyStop
                ? "border-emerald-700 bg-slate-900"
                : "border-red-700 bg-slate-900"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              {emergencyStop ? (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/20">
                  <svg className="h-5 w-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/20">
                  <svg className="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
              )}
              <h3 className="text-lg font-semibold text-slate-100">
                {emergencyStop ? "Resume Posting" : "Activate Kill Switch"}
              </h3>
            </div>

            <div className="mt-4 space-y-3">
              {emergencyStop ? (
                <>
                  <p className="text-sm text-slate-300">
                    This will <span className="font-semibold text-emerald-300">resume normal operation</span>.
                    Social media posting across all platforms (Telegram, Facebook, LinkedIn) will be re-enabled.
                  </p>
                  <p className="text-sm text-slate-400">
                    Scheduled and auto-approved articles will start posting again according to their configured rules.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-300">
                    This will <span className="font-semibold text-red-300">immediately halt ALL social media posting</span> across
                    all platforms — Telegram, Facebook, and LinkedIn.
                  </p>
                  <p className="text-sm text-slate-400">
                    The pipeline (fetch, embed, score) continues running normally, but no posts will be sent
                    until you manually resume.
                  </p>
                </>
              )}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowKillModal(false)}
                className="flex-1 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={executeToggle}
                disabled={killSwitchToggling}
                className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 ${
                  emergencyStop
                    ? "bg-emerald-600 hover:bg-emerald-500"
                    : "bg-red-600 hover:bg-red-500"
                }`}
              >
                {killSwitchToggling
                  ? "..."
                  : emergencyStop
                    ? "Resume Posting"
                    : "Stop All Posting"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
