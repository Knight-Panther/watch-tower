import { NavLink } from "react-router-dom";
import { ReactNode } from "react";
import type { ConnectionStatus } from "../hooks/useServerEvents";

const navItems = [
  { to: "/", label: "Home" },
  { to: "/monitoring", label: "Monitoring" },
  { to: "/articles", label: "Articles" },
  { to: "/scheduled", label: "Scheduled" },
  { to: "/sectors", label: "Sectors" },
  { to: "/scoring-rules", label: "Scoring Rules" },
  { to: "/post-templates", label: "Post Formats" },
  { to: "/platform-settings", label: "Platforms" },
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
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-900/70 bg-slate-950/80 backdrop-blur">
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
    </div>
  );
}
