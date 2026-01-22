import { NavLink } from "react-router-dom";
import { ReactNode } from "react";

const navItems = [
  { to: "/", label: "Home" },
  { to: "/sectors", label: "Sector Management" },
  { to: "/schedule", label: "Schedule Manager" },
  { to: "/database", label: "Database" },
];

type LayoutProps = {
  children: ReactNode;
};

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-900/70 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-lg font-semibold">Media Watch Tower</p>
            <p className="text-xs text-slate-500">TELO Tower</p>
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
