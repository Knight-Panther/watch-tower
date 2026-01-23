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
  onCreateSector: (event: React.FormEvent<HTMLFormElement>) => void;
  onSectorFormChange: (next: SectorManagementProps["sectorForm"]) => void;
  onDeleteSector: (sector: Sector) => void;
};

export default function SectorManagement({
  sectorForm,
  sectorErrors,
  sectors,
  onCreateSector,
  onSectorFormChange,
  onDeleteSector,
}: SectorManagementProps) {
  return (
    <>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Sector Management
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Create and manage sector defaults.
        </p>
        <form
          onSubmit={onCreateSector}
          className="mt-6 grid gap-4 md:grid-cols-[2fr,1fr]"
        >
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
              onSectorFormChange({
                ...sectorForm,
                defaultMaxAgeDays: event.target.value,
              })
            }
            placeholder="Default max age days (1-15)"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {sectorErrors.defaultMaxAgeDays ? (
            <p className="text-xs text-red-400">
              {sectorErrors.defaultMaxAgeDays}
            </p>
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
          {sectors.map((sector) => (
            <div
              key={sector.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
            >
              <div>
                <p className="text-sm font-semibold">{sector.name}</p>
                <p className="text-xs text-slate-400">{sector.slug}</p>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
                <span>Default max age: {sector.default_max_age_days} days</span>
                <button
                  onClick={() => onDeleteSector(sector)}
                  className="text-xs text-red-300 hover:text-red-200 hover:underline"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {sectors.length === 0 ? (
            <p className="text-sm text-slate-400">No sectors yet.</p>
          ) : null}
        </div>
      </section>
    </>
  );
}
