import { useEffect, useMemo, useState } from "react";
import {
  createSource,
  deleteSource,
  listSources,
  runIngest,
  type Source,
  updateSource,
} from "./api";

const emptyForm = { url: "", name: "" };

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [isTriggering, setIsTriggering] = useState(false);

  const activeCount = useMemo(
    () => sources.filter((source) => source.active).length,
    [sources],
  );

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setSources(await listSources());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sources");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.url) {
      setError("URL is required");
      return;
    }

    try {
      const created = await createSource({ url: form.url, name: form.name });
      setSources((prev) => [created, ...prev]);
      setForm(emptyForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create source");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update source");
    }
  };

  const onDelete = async (source: Source) => {
    const confirmed = window.confirm(
      `Remove ${source.name ?? source.url}?`,
    );
    if (!confirmed) {
      return;
    }

    try {
      await deleteSource(source.id);
      setSources((prev) => prev.filter((item) => item.id !== source.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete source");
    }
  };

  const onRunIngest = async () => {
    setIsTriggering(true);
    setError(null);
    try {
      await runIngest();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger ingest");
    } finally {
      setIsTriggering(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Media Watch Tower
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {activeCount} active sources · {sources.length} total
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
            className="mt-4 grid gap-4 md:grid-cols-[2fr,1fr,auto]"
          >
            <input
              value={form.url}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, url: event.target.value }))
              }
              placeholder="RSS URL"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <input
              value={form.name}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Name (optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            />
            <button
              type="submit"
              className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-white"
            >
              Add
            </button>
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

          <div className="mt-4 grid gap-3">
            {sources.map((source) => (
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
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {!isLoading && sources.length === 0 ? (
              <p className="text-sm text-slate-400">No sources yet.</p>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
