import type { ProviderHealthResult } from "../api";
import Spinner from "./Spinner";

type ApiHealthModalProps = {
  results: ProviderHealthResult[] | null;
  checkedAt: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

const ROLE_LABELS: Record<string, string> = {
  "llm-primary": "LLM Primary",
  "llm-fallback": "LLM Fallback",
  embeddings: "Embeddings",
  translation: "Translation",
};

const ROLE_ORDER = ["embeddings", "llm-primary", "llm-fallback", "translation"];

export default function ApiHealthModal({
  results,
  checkedAt,
  loading,
  error,
  onClose,
}: ApiHealthModalProps) {
  const sorted = results
    ? [...results].sort(
        (a, b) => (ROLE_ORDER.indexOf(a.role) ?? 99) - (ROLE_ORDER.indexOf(b.role) ?? 99),
      )
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
        <h3 className="text-lg font-semibold">API Provider Health</h3>

        {loading && (
          <div className="mt-6 flex flex-col items-center gap-3 py-8">
            <Spinner />
            <p className="text-sm text-slate-400">Pinging providers...</p>
          </div>
        )}

        {error && !loading && (
          <div className="mt-4 rounded-xl border border-red-800/50 bg-red-950/30 p-4">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {sorted && !loading && (
          <>
            <div className="mt-4 space-y-2">
              {sorted.map((r) => (
                <div
                  key={`${r.provider}-${r.role}`}
                  className={`flex items-center justify-between rounded-xl border p-3 ${
                    r.healthy
                      ? "border-slate-800 bg-slate-900/40"
                      : "border-red-800/50 bg-red-950/20"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        r.healthy ? "bg-emerald-400" : "bg-red-400"
                      }`}
                    />
                    <div>
                      <p className="text-sm font-medium">{r.displayName}</p>
                      <p className="text-xs text-slate-500">
                        {ROLE_LABELS[r.role] ?? r.role}
                        <span className="mx-1.5 text-slate-700">|</span>
                        {r.model}
                      </p>
                    </div>
                  </div>

                  <div className="text-right">
                    {r.healthy ? (
                      <span className="text-sm text-emerald-400">{r.latencyMs}ms</span>
                    ) : (
                      <span className="text-xs text-red-400">Unreachable</span>
                    )}
                  </div>
                </div>
              ))}

              {sorted.filter((r) => !r.healthy).length > 0 && (
                <div className="mt-2 space-y-1">
                  {sorted
                    .filter((r) => !r.healthy)
                    .map((r) => (
                      <p
                        key={`${r.provider}-${r.role}-err`}
                        className="text-xs text-red-400/80"
                      >
                        {r.displayName}: {r.error}
                      </p>
                    ))}
                </div>
              )}
            </div>

            {checkedAt && (
              <p className="mt-4 text-xs text-slate-500">
                Checked at {new Date(checkedAt).toLocaleTimeString()}
              </p>
            )}
          </>
        )}

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
