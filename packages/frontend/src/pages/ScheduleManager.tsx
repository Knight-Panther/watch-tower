import type { Sector } from "../api";

type ScheduleManagerProps = {
  ingestIntervalMinutes: string;
  ingestIntervalError: string | null;
  onSaveIngestInterval: () => void;
  onIngestIntervalChange: (value: string) => void;
  sectors: Sector[];
  sectorMaxAgeDrafts: Record<string, string>;
  sectorIntervalDrafts: Record<string, string>;
  onSectorMaxAgeDraftChange: (id: string, value: string) => void;
  onSectorIntervalDraftChange: (id: string, value: string) => void;
  onSaveSectorSettings: (id: string) => void;
};

export default function ScheduleManager({
  ingestIntervalMinutes,
  ingestIntervalError,
  onSaveIngestInterval,
  onIngestIntervalChange,
  sectors,
  sectorMaxAgeDrafts,
  sectorIntervalDrafts,
  onSectorMaxAgeDraftChange,
  onSectorIntervalDraftChange,
  onSaveSectorSettings,
}: ScheduleManagerProps) {
  return (
    <>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-3xl font-semibold tracking-tight">Schedule Manager</h1>
        <p className="mt-2 text-sm text-slate-400">
          Effective interval: source override &gt; sector override &gt; global.
        </p>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Global interval</h2>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <input
            value={ingestIntervalMinutes}
            onChange={(event) => onIngestIntervalChange(event.target.value)}
            placeholder="1-4320 minutes"
            className="w-40 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
        <button
          onClick={onSaveIngestInterval}
          disabled={!ingestIntervalMinutes.trim()}
          className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
        >
          Save global interval
        </button>
          <span className="text-xs text-slate-500">In minutes (1 min - 3 days).</span>
        </div>
        {ingestIntervalError ? (
          <p className="mt-2 text-xs text-red-400">{ingestIntervalError}</p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Schedule by sectors</h2>
        <div className="mt-2 text-xs text-slate-500">
          Update default max age and interval overrides per sector.
        </div>
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
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Default max age
                  </span>
                  <input
                    value={
                      sectorMaxAgeDrafts[sector.id] ??
                      String(sector.default_max_age_days)
                    }
                    onChange={(event) =>
                      onSectorMaxAgeDraftChange(sector.id, event.target.value)
                    }
                    className="w-24 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Interval (min)
                  </span>
                <input
                  value={
                    sectorIntervalDrafts[sector.id] ??
                    String(sector.ingest_interval_minutes ?? "")
                  }
                  onChange={(event) =>
                    onSectorIntervalDraftChange(sector.id, event.target.value)
                  }
                  className="w-32 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                />
                </div>
                <button
                  onClick={() => onSaveSectorSettings(sector.id)}
                  className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 hover:text-white"
                >
                  Save
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
