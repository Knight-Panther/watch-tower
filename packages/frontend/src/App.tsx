import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  createSector,
  createSource,
  listSectors,
  listSources,
  runIngest,
  type Sector,
  type Source,
  updateSource,
} from "./api";

const emptySourceForm = {
  url: "",
  name: "",
  sectorId: "",
  maxAgeDays: "",
};
const emptySectorForm = { name: "", defaultMaxAgeDays: "5" };

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceForm, setSourceForm] = useState(emptySourceForm);
  const [sectorForm, setSectorForm] = useState(emptySectorForm);
  const [isTriggering, setIsTriggering] = useState(false);
  const [maxAgeDrafts, setMaxAgeDrafts] = useState<Record<string, string>>({});
  const [confirmSource, setConfirmSource] = useState<Source | null>(null);

  const activeCount = useMemo(
    () => sources.filter((source) => source.active).length,
    [sources],
  );

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [sourcesData, sectorsData] = await Promise.all([
        listSources(),
        listSectors(),
      ]);
      setSources(sourcesData);
      setSectors(sectorsData);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load sources";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sourceForm.url) {
      setError("URL is required");
      return;
    }

    const maxAge =
      sourceForm.maxAgeDays.trim() === ""
        ? null
        : Number(sourceForm.maxAgeDays);
    if (maxAge !== null && (Number.isNaN(maxAge) || maxAge < 1 || maxAge > 15)) {
      setError("Max age must be between 1 and 15");
      return;
    }

    try {
      const created = await createSource({
        url: sourceForm.url,
        name: sourceForm.name,
        sector_id: sourceForm.sectorId || undefined,
        max_age_days: maxAge,
      });
      setSources((prev) => [created, ...prev]);
      setSourceForm(emptySourceForm);
      toast.success("Source added");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create source";
      setError(message);
      toast.error(message);
    }
  };

  const onToggle = async (source: Source) => {
    try {
      const updated = await updateSource(source.id, {
        active: !source.active,
      });
      setSources((prev) =>
        prev.map((item) => (item.id === source.id ? updated : item)),
      );
      toast.success(source.active ? "Source deactivated" : "Source activated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update source";
      setError(message);
      toast.error(message);
    }
  };

  const onDelete = async (source: Source) => {
    setConfirmSource(source);
  };

  const confirmDeactivate = async () => {
    if (!confirmSource) {
      return;
    }
    try {
      const updated = await updateSource(confirmSource.id, { active: false });
      setSources((prev) =>
        prev.map((item) => (item.id === confirmSource.id ? updated : item)),
      );
      toast.success("Source deactivated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to deactivate source";
      setError(message);
      toast.error(message);
    } finally {
      setConfirmSource(null);
    }
  };

  const onSaveMaxAge = async (source: Source) => {
    const rawValue =
      maxAgeDrafts[source.id] ??
      String(
        source.max_age_days ??
          source.sectors?.default_max_age_days ??
          5,
      );

    if (rawValue.trim() === "") {
      try {
        const updated = await updateSource(source.id, { max_age_days: null });
        setSources((prev) =>
          prev.map((item) => (item.id === source.id ? updated : item)),
        );
        setMaxAgeDrafts((prev) => {
          const next = { ...prev };
          delete next[source.id];
          return next;
        });
        toast.success("Max age updated");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update source";
        setError(message);
        toast.error(message);
      }
      return;
    }

    const value = Number(rawValue);
    if (Number.isNaN(value) || value < 1 || value > 15) {
      setError("Max age must be between 1 and 15");
      return;
    }
    try {
      const updated = await updateSource(source.id, { max_age_days: value });
      setSources((prev) =>
        prev.map((item) => (item.id === source.id ? updated : item)),
      );
      setMaxAgeDrafts((prev) => ({ ...prev, [source.id]: String(value) }));
      toast.success("Max age updated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update source";
      setError(message);
      toast.error(message);
    }
  };

  const onCreateSector = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sectorForm.name.trim()) {
      setError("Sector name is required");
      return;
    }

    const maxAge = Number(sectorForm.defaultMaxAgeDays);
    if (Number.isNaN(maxAge) || maxAge < 1 || maxAge > 15) {
      setError("Default max age must be between 1 and 15");
      return;
    }

    try {
      const created = await createSector({
        name: sectorForm.name.trim(),
        default_max_age_days: maxAge,
      });
      setSectors((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSectorForm(emptySectorForm);
      toast.success("Sector created");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create sector";
      setError(message);
      toast.error(message);
    }
  };

  const onRunIngest = async () => {
    setIsTriggering(true);
    setError(null);
    try {
      await runIngest();
      toast.success("Ingest triggered");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to trigger ingest";
      setError(message);
      toast.error(message);
    } finally {
      setIsTriggering(false);
    }
  };

  const groupedSources = useMemo(() => {
    const groups = new Map<string, { title: string; sources: Source[] }>();

    sources.forEach((source) => {
      const sectorName = source.sectors?.name ?? "No sector";
      const maxAge =
        source.max_age_days ?? source.sectors?.default_max_age_days ?? 5;
      const key = `${sectorName}::${maxAge}`;
      const title = `${sectorName} - max age ${maxAge} days`;
      const group = groups.get(key) ?? { title, sources: [] };
      group.sources.push(source);
      groups.set(key, group);
    });

    return Array.from(groups.values()).sort((a, b) =>
      a.title.localeCompare(b.title),
    );
  }, [sources]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Toaster richColors position="top-right" />
      <section className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Media Watch Tower
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {activeCount} active sources - {sources.length} total
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onRunIngest}
              disabled={isTriggering}
              className="rounded-full border border-emerald-500/50 px-4 py-2 text-sm text-emerald-200 transition hover:border-emerald-300 disabled:opacity-50"
            >
              {isTriggering ? "Triggering..." : "Run ingest"}
            </button>
            <button
              onClick={refresh}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
            >
              Refresh
            </button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Add source</h2>
          <form
            onSubmit={onSubmit}
            className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]"
          >
            <input
              value={sourceForm.url}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, url: event.target.value }))
              }
              placeholder="RSS URL"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <input
              value={sourceForm.name}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Name (optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <select
              value={sourceForm.sectorId}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, sectorId: event.target.value }))
              }
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            >
              <option value="">No sector</option>
              {sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
            <input
              value={sourceForm.maxAgeDays}
              onChange={(event) =>
                setSourceForm((prev) => ({ ...prev, maxAgeDays: event.target.value }))
              }
              placeholder="Max age days (1-15, optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <div className="md:col-span-2">
              <button
                type="submit"
                className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-white"
              >
                Add
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Add sector</h2>
          <form onSubmit={onCreateSector} className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr]">
            <input
              value={sectorForm.name}
              onChange={(event) =>
                setSectorForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Sector name"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <input
              value={sectorForm.defaultMaxAgeDays}
              onChange={(event) =>
                setSectorForm((prev) => ({
                  ...prev,
                  defaultMaxAgeDays: event.target.value,
                }))
              }
              placeholder="Default max age days (1-15)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
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
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sources</h2>
            {isLoading ? (
              <span className="text-xs text-slate-400">Loading...</span>
            ) : null}
          </div>

          {error ? (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          ) : null}

          <div className="mt-4 grid gap-6">
            {groupedSources.map((group) => (
              <div key={group.title} className="rounded-xl border border-slate-800">
                <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
                  <p className="text-sm font-semibold text-slate-200">
                    {group.title}
                  </p>
                  <span className="text-xs text-slate-500">
                    {group.sources.length} sources
                  </span>
                </div>
                <div className="grid gap-3 p-4">
                  {group.sources.map((source) => (
                    <div
                      key={source.id}
                      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-semibold">
                          {source.name ?? "Untitled source"}
                        </p>
                        <p className="text-xs text-slate-400">{source.url}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <select
                          value={source.sector_id ?? ""}
                          onChange={async (event) => {
                            try {
                              const updated = await updateSource(source.id, {
                                sector_id: event.target.value || null,
                              });
                              setSources((prev) =>
                                prev.map((item) =>
                                  item.id === source.id ? updated : item,
                                ),
                              );
                              toast.success("Sector updated");
                            } catch (err) {
                              const message =
                                err instanceof Error
                                  ? err.message
                                  : "Failed to update source";
                              setError(message);
                              toast.error(message);
                            }
                          }}
                          className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                        >
                          <option value="">No sector</option>
                          {sectors.map((sector) => (
                            <option key={sector.id} value={sector.id}>
                              {sector.name}
                            </option>
                          ))}
                        </select>
                        <input
                          value={
                            maxAgeDrafts[source.id] ??
                            String(
                              source.max_age_days ??
                                source.sectors?.default_max_age_days ??
                                5,
                            )
                          }
                          onChange={(event) =>
                            setMaxAgeDrafts((prev) => ({
                              ...prev,
                              [source.id]: event.target.value,
                            }))
                          }
                          className="w-20 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200"
                        />
                        <button
                          onClick={() => onSaveMaxAge(source)}
                          className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-500"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => onToggle(source)}
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            source.active
                              ? "bg-emerald-500/20 text-emerald-200"
                              : "bg-slate-700/40 text-slate-300"
                          }`}
                        >
                          {source.active ? "Active" : "Inactive"}
                        </button>
                        <button
                          onClick={() => onDelete(source)}
                          className="text-xs text-red-300 hover:text-red-200"
                        >
                          Deactivate
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!isLoading && sources.length === 0 ? (
              <p className="text-sm text-slate-400">No sources yet.</p>
            ) : null}
          </div>
        </section>
      </section>

      {confirmSource ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <h3 className="text-lg font-semibold">Deactivate source</h3>
            <p className="mt-2 text-sm text-slate-400">
              Disable{" "}
              <span className="text-slate-200">
                {confirmSource.name ?? confirmSource.url}
              </span>
              ?
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmSource(null)}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeactivate}
                className="rounded-full bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200"
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
