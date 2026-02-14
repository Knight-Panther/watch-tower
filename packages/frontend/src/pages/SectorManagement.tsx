import type { Sector } from "../api";

type SectorManagementProps = {
  sectorForm: {
    name: string;
    defaultMaxAgeDays: string;
  };
  sectorErrors: {
    name?: string;
    defaultMaxAgeDays?: string;
  };
  sectors: Sector[];
  sectorMaxAgeDrafts: Record<string, string>;
  onCreateSector: (event: React.FormEvent<HTMLFormElement>) => void;
  onSectorFormChange: (next: SectorManagementProps["sectorForm"]) => void;
  onDeleteSector: (sector: Sector) => void;
  onSectorMaxAgeDraftChange: (sectorId: string, value: string) => void;
  onSaveSectorSettings: (sectorId: string) => void;
};

export default function SectorManagement({
  sectorForm,
  sectorErrors,
  sectors,
  sectorMaxAgeDrafts,
  onCreateSector,
  onSectorFormChange,
  onDeleteSector,
  onSectorMaxAgeDraftChange,
  onSaveSectorSettings,
}: SectorManagementProps) {
  return (
    <>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-3xl font-semibold tracking-tight">Sector Management</h1>
        <p className="mt-2 text-sm text-slate-400">Create and manage sector defaults.</p>
        <form onSubmit={onCreateSector} className="mt-6 grid gap-4 md:grid-cols-[2fr,1fr]">
          <input
            value={sectorForm.name}
            onChange={(event) => onSectorFormChange({ ...sectorForm, name: event.target.value })}
            placeholder="Sector name"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {sectorErrors.name ? <p className="text-xs text-red-400">{sectorErrors.name}</p> : null}
          <input
            value={sectorForm.defaultMaxAgeDays}
            onChange={(event) =>
              onSectorFormChange({
                ...sectorForm,
                defaultMaxAgeDays: event.target.value,
              })
            }
            placeholder="Default max age days (1-15)"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {sectorErrors.defaultMaxAgeDays ? (
            <p className="text-xs text-red-400">{sectorErrors.defaultMaxAgeDays}</p>
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

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Current sector settings</h2>
        <p className="mt-2 text-xs text-slate-500">
          Review current sectors or remove them. Sources keep their items until TTL cleanup.
        </p>
        <div className="mt-4 grid gap-3">
          {sectors.map((sector) => {
            const draft = sectorMaxAgeDrafts[sector.id] ?? String(sector.default_max_age_days);
            const changed = Number(draft) !== sector.default_max_age_days;
            return (
              <div
                key={sector.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold">{sector.name}</p>
                  <p className="text-xs text-slate-400">{sector.slug}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                  <label className="flex items-center gap-2">
                    <span>Max age:</span>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={draft}
                      onChange={(e) => onSectorMaxAgeDraftChange(sector.id, e.target.value)}
                      className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center text-xs text-slate-200 outline-none focus:border-slate-500"
                    />
                    <span>days</span>
                  </label>
                  {changed && (
                    <button
                      onClick={() => onSaveSectorSettings(sector.id)}
                      className="rounded-lg border border-emerald-700 bg-emerald-900/40 px-3 py-1 text-xs font-medium text-emerald-300 transition hover:border-emerald-500"
                    >
                      Save
                    </button>
                  )}
                  <button
                    onClick={() => onDeleteSector(sector)}
                    className="text-xs text-red-300 hover:text-red-200 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {sectors.length === 0 ? <p className="text-sm text-slate-400">No sectors yet.</p> : null}
        </div>
      </section>
    </>
  );
}
