import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createSector,
  deleteSector,
  getConstraints,
  listSectors,
  updateSector,
  type Constraints,
  type Sector,
} from "../api";
import ConfirmModal from "../components/ConfirmModal";
import Button from "../components/ui/Button";
import EmptyState from "../components/ui/EmptyState";
import Spinner from "../components/Spinner";

const emptySectorForm = { name: "", defaultMaxAgeDays: "5" };

export default function SectorManagement() {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sectorForm, setSectorForm] = useState(emptySectorForm);
  const [sectorErrors, setSectorErrors] = useState<{
    name?: string;
    defaultMaxAgeDays?: string;
  }>({});
  const [sectorMaxAgeDrafts, setSectorMaxAgeDrafts] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<Sector | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [sectorsData, constraintsData] = await Promise.all([
          listSectors(),
          getConstraints(),
        ]);
        setSectors(sectorsData);
        setConstraints(constraintsData);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load sectors");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const onCreateSector = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSectorErrors({});
    if (!sectorForm.name.trim()) {
      setSectorErrors((prev) => ({ ...prev, name: "Sector name is required" }));
      return;
    }

    const maMin = constraints?.maxAge.min ?? 1;
    const maMax = constraints?.maxAge.max ?? 15;
    const maxAge = Number(sectorForm.defaultMaxAgeDays);
    if (Number.isNaN(maxAge) || maxAge < maMin || maxAge > maMax) {
      setSectorErrors((prev) => ({
        ...prev,
        defaultMaxAgeDays: `Default max age must be ${maMin}-${maMax}`,
      }));
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
      const message = err instanceof Error ? err.message : "Failed to create sector";
      toast.error(message);
    }
  };

  const onSaveSectorSettings = async (sectorId: string) => {
    const sector = sectors.find((item) => item.id === sectorId);
    if (!sector) {
      toast.error("Sector not found");
      return;
    }

    const maMin = constraints?.maxAge.min ?? 1;
    const maMax = constraints?.maxAge.max ?? 15;
    const maxAgeRaw = sectorMaxAgeDrafts[sectorId] ?? String(sector.default_max_age_days);
    const maxAgeValue = Number(maxAgeRaw);
    if (Number.isNaN(maxAgeValue) || maxAgeValue < maMin || maxAgeValue > maMax) {
      toast.error(`Default max age must be between ${maMin} and ${maMax}`);
      return;
    }

    if (maxAgeValue === sector.default_max_age_days) {
      toast("No changes to save");
      return;
    }

    try {
      const updated = await updateSector(sectorId, { default_max_age_days: maxAgeValue });
      setSectors((prev) => prev.map((item) => (item.id === sectorId ? updated : item)));
      setSectorMaxAgeDrafts((prev) => {
        const next = { ...prev };
        delete next[sectorId];
        return next;
      });
      toast.success("Default max age updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update sector");
    }
  };

  const onConfirmDelete = async () => {
    if (!confirmDelete) return;
    try {
      const deleted = await deleteSector(confirmDelete.id);
      setSectors((prev) => prev.filter((item) => item.id !== deleted.id));
      toast.success("Sector deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete sector");
    } finally {
      setConfirmDelete(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sector Management</h1>
        <p className="mt-2 text-sm text-slate-400">Create and manage sector defaults.</p>
        <form onSubmit={onCreateSector} className="mt-6 grid gap-4 md:grid-cols-[2fr,1fr]">
          <input
            value={sectorForm.name}
            onChange={(event) => setSectorForm({ ...sectorForm, name: event.target.value })}
            placeholder="Sector name"
            className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
          {sectorErrors.name ? <p className="text-xs text-red-400">{sectorErrors.name}</p> : null}
          <input
            value={sectorForm.defaultMaxAgeDays}
            onChange={(event) =>
              setSectorForm({
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
            <Button variant="secondary" type="submit" fullWidth>
              Create sector
            </Button>
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
                  <p className="text-xs text-slate-500">{sector.slug}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                  <label className="flex items-center gap-2">
                    <span>Max age:</span>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={draft}
                      onChange={(e) =>
                        setSectorMaxAgeDrafts((prev) => ({ ...prev, [sector.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Escape")
                          setSectorMaxAgeDrafts((prev) => ({
                            ...prev,
                            [sector.id]: String(sector.default_max_age_days),
                          }));
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onSaveSectorSettings(sector.id);
                        }
                      }}
                      className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center text-xs text-slate-200 outline-none focus:border-slate-500"
                    />
                    <span>days</span>
                  </label>
                  {changed && (
                    <>
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => onSaveSectorSettings(sector.id)}
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setSectorMaxAgeDrafts((prev) => ({
                            ...prev,
                            [sector.id]: String(sector.default_max_age_days),
                          }))
                        }
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                  <button
                    onClick={() => setConfirmDelete(sector)}
                    className="text-xs text-red-300 hover:text-red-200 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {sectors.length === 0 ? (
            <EmptyState
              title="No sectors yet"
              description="Create your first sector using the form above."
            />
          ) : null}
        </div>
      </section>

      {confirmDelete && (
        <ConfirmModal
          title="Delete sector"
          message={
            <>
              Remove <span className="text-slate-200">{confirmDelete.name}</span>? Sources will be
              unassigned.
            </>
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={onConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
