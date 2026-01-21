const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export type Source = {
  id: string;
  url: string;
  name: string | null;
  active: boolean;
  created_at: string;
  last_fetched_at: string | null;
};

export const listSources = async (): Promise<Source[]> => {
  const res = await fetch(`${API_URL}/sources`);
  if (!res.ok) {
    throw new Error("Failed to load sources");
  }
  return res.json();
};

export const createSource = async (payload: {
  url: string;
  name?: string;
  active?: boolean;
}): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to create source");
  }

  return res.json();
};

export const updateSource = async (
  id: string,
  payload: { url?: string; name?: string; active?: boolean },
): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to update source");
  }

  return res.json();
};

export const deleteSource = async (id: string): Promise<void> => {
  const res = await fetch(`${API_URL}/sources/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error("Failed to delete source");
  }
};

export const runIngest = async (): Promise<{ queued: boolean; jobId?: string }> => {
  const res = await fetch(`${API_URL}/ingest/run`, { method: "POST" });
  if (!res.ok) {
    throw new Error("Failed to trigger ingest");
  }
  return res.json();
};
