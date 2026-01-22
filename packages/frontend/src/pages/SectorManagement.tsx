import type { Sector } from "../api";

type SectorManagementProps = {
  sectorForm: {
    name: string;
    defaultMaxAgeDays: string;
    ingestIntervalMinutes: string;
  };
  sectorErrors: {
    name?: string;
    defaultMaxAgeDays?: string;
    ingestIntervalMinutes?: string;
  };
  onCreateSector: (event: React.FormEvent<HTMLFormElement>) => void;
  onSectorFormChange: (next: SectorManagementProps["sectorForm"]) => void;
};

export default function SectorManagement({
  sectorForm,
  sectorErrors,
  onCreateSector,
  onSectorFormChange,
}: SectorManagementProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        Sector Management
      </h1>
      <p className="mt-2 text-sm text-slate-400">
        Create and manage sector defaults.
      </p>
      <form onSubmit={onCreateSector} className="mt-6 grid gap-4 md:grid-cols-[2fr,1fr]">
        <input
          value={sectorForm.name}
          onChange={(event) =>
            onSectorFormChange({ ...sectorForm, name: event.target.value })
          }
          placeholder="Sector name"
          className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
        />
        {sectorErrors.name ? (
          <p className="text-xs text-red-400">{sectorErrors.name}</p>
        ) : null}
        <input
          value={sectorForm.defaultMaxAgeDays}
          onChange={(event) =>
            onSectorFormChange({ ...sectorForm, defaultMaxAgeDays: event.target.value })
          }
          placeholder="Default max age days (1-15)"
          className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
        />
        {sectorErrors.defaultMaxAgeDays ? (
          <p className="text-xs text-red-400">{sectorErrors.defaultMaxAgeDays}</p>
        ) : null}
        <input
          value={sectorForm.ingestIntervalMinutes}
          onChange={(event) =>
            onSectorFormChange({ ...sectorForm, ingestIntervalMinutes: event.target.value })
          }
          placeholder="Interval minutes (1-4320, optional)"
          className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
        />
        {sectorErrors.ingestIntervalMinutes ? (
          <p className="text-xs text-red-400">{sectorErrors.ingestIntervalMinutes}</p>
        ) : null}
        <div className="md:col-span-2">
          <button
            type="submit"
            className="w-full rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-slate-500"
          >
            Create sector
          </button>
        </div>
      </form>
    </section>
  );
}
