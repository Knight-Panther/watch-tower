import { NavLink, useLocation } from "react-router-dom";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { FocusTrap } from "focus-trap-react";
import { toast } from "sonner";
import type { ConnectionStatus } from "../hooks/useServerEvents";
import { getEmergencyStop, setEmergencyStop } from "../api";

const navItems = [
  { to: "/", label: "Home" },
  { to: "/monitoring", label: "Monitoring" },
  { to: "/article-scheduler", label: "Article Scheduler" },
  { to: "/scoring-rules", label: "LLM Brain" },
  { to: "/media-channels", label: "Media Channels" },
  { to: "/image-template", label: "Image Template" },
  { to: "/site-rules", label: "Restrictions" },
  { to: "/alerts", label: "Alerts" },
  { to: "/digest", label: "Digests" },
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
  const location = useLocation();

  // Kill switch state
  const [emergencyStop, setEmergencyStopState] = useState(false);
  const [killSwitchLoading, setKillSwitchLoading] = useState(true);
  const [killSwitchToggling, setKillSwitchToggling] = useState(false);
  const [showKillModal, setShowKillModal] = useState(false);

  // Mobile nav state
  const [navOpen, setNavOpen] = useState(false);

  // Close mobile nav on route change
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

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
      toast.error(err instanceof Error ? err.message : "Failed to toggle kill switch");
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

  // Close mobile nav on Escape
  useEffect(() => {
    if (!navOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navOpen]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header ref={headerRef} className="sticky top-0 z-40 border-b border-slate-900/70 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:flex-wrap md:gap-4 md:px-6 md:py-4">
          <div className="flex items-center gap-3">
            {/* Hamburger — mobile only */}
            <button
              aria-label="Toggle navigation"
              onClick={() => setNavOpen((v) => !v)}
              className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:text-slate-200 md:hidden"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                {navOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>

            <div>
              <p className="text-lg font-semibold">Media Watch Tower</p>
              <p className="text-xs text-slate-500">TELO Tower</p>
            </div>
            {connectionStatus && (
              <div className="flex items-center gap-1.5 rounded-full border border-slate-800 px-2.5 py-1">
                <span className={`h-2 w-2 rounded-full ${statusColors[connectionStatus]}`} />
                <span className="hidden text-xs text-slate-500 sm:inline">{statusLabels[connectionStatus]}</span>
              </div>
            )}

            {/* Kill Switch — always visible, wraps on narrow */}
            {!killSwitchLoading && (
              <div
                className={`flex items-center gap-2 rounded-xl border px-2 py-1 sm:gap-2.5 sm:px-3 sm:py-1.5 ${
                  emergencyStop
                    ? "border-red-700 bg-red-950/40"
                    : "border-slate-800 bg-slate-900/40"
                }`}
              >
                <div className="hidden items-center gap-1.5 sm:flex">
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
                  className={`rounded-lg px-2 py-1 text-xs font-semibold transition disabled:opacity-50 sm:px-3 ${
                    emergencyStop
                      ? "bg-emerald-600 text-white hover:bg-emerald-500"
                      : "bg-red-600 text-white hover:bg-red-500"
                  }`}
                >
                  {killSwitchToggling
                    ? "..."
                    : emergencyStop
                      ? "RESUME"
                      : "STOP"}
                </button>
              </div>
            )}
          </div>

          {/* Desktop nav — hidden on mobile */}
          <nav className="hidden flex-wrap gap-2 text-sm md:flex">
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

      {/* Mobile slide-out nav */}
      {navOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setNavOpen(false)}
          />
          <nav className="fixed inset-y-0 left-0 z-50 w-64 overflow-y-auto border-r border-slate-800 bg-slate-950 p-4 shadow-xl md:hidden">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-300">Navigation</p>
              <button
                aria-label="Close navigation"
                onClick={() => setNavOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:text-slate-200"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-2.5 text-sm transition ${
                      isActive
                        ? "bg-emerald-500/15 text-emerald-300 font-medium"
                        : "text-slate-300 hover:bg-slate-800/60"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </nav>
        </>
      )}

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
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
          <FocusTrap focusTrapOptions={{ escapeDeactivates: false, allowOutsideClick: true }}>
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
          </FocusTrap>
        </div>
      )}
    </div>
  );
}
