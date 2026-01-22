type DatabaseProps = {
  ttlDays: string;
  ttlError: string | null;
  onTtlChange: (value: string) => void;
  onSaveTtl: () => void;
};

export default function Database({ ttlDays, ttlError, onTtlChange, onSaveTtl }: DatabaseProps) {
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
    </section>
  );
}
