type DatabaseProps = {
  ttlDays: string;
  ttlError: string | null;
  onTtlChange: (value: string) => void;
  onSaveTtl: () => void;
  fetchRunsTtlValue: string;
  fetchRunsTtlUnit: "hours" | "days";
  fetchRunsTtlError: string | null;
  onFetchRunsTtlChange: (value: string) => void;
  onFetchRunsTtlUnitChange: (unit: "hours" | "days") => void;
  onSaveFetchRunsTtl: () => void;
};

export default function Database({
  ttlDays,
  ttlError,
  onTtlChange,
  onSaveTtl,
  fetchRunsTtlValue,
  fetchRunsTtlUnit,
  fetchRunsTtlError,
  onFetchRunsTtlChange,
  onFetchRunsTtlUnitChange,
  onSaveFetchRunsTtl,
}: DatabaseProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">Database</h1>
      <p className="mt-2 text-sm text-slate-400">
        Control retention and cleanup settings.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <input
          value={ttlDays}
          onChange={(event) => onTtlChange(event.target.value)}
          placeholder="30-60"
          className="w-28 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
        />
        <button
          onClick={onSaveTtl}
          disabled={!ttlDays.trim()}
          className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
        >
          Save TTL
        </button>
        <span className="text-xs text-slate-500">
          Feed items older than this are deleted daily.
        </span>
      </div>

      {ttlError ? (
        <p className="mt-2 text-xs text-red-400">{ttlError}</p>
      ) : null}

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <input
          value={fetchRunsTtlValue}
          onChange={(event) => onFetchRunsTtlChange(event.target.value)}
          placeholder={fetchRunsTtlUnit === "days" ? "Days" : "Hours"}
          className="w-28 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
        />
        <select
          value={fetchRunsTtlUnit}
          onChange={(event) =>
            onFetchRunsTtlUnitChange(event.target.value as "hours" | "days")
          }
          className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-600"
        >
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
        <button
          onClick={onSaveFetchRunsTtl}
          disabled={!fetchRunsTtlValue.trim()}
          className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
        >
          Save fetch runs TTL
        </button>
        <span className="text-xs text-slate-500">
          Fetch run telemetry older than this is deleted on cleanup.
        </span>
      </div>

      {fetchRunsTtlError ? (
        <p className="mt-2 text-xs text-red-400">{fetchRunsTtlError}</p>
      ) : null}
    </section>
  );
}
