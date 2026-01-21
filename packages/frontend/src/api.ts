const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};

export type Source = {
  id: string;
  url: string;
  name: string | null;
  active: boolean;
  sector_id: string | null;
  max_age_days: number | null;
  created_at: string;
  last_fetched_at: string | null;
  sectors?: {
    id: string;
    name: string;
    slug: string;
    default_max_age_days: number;
  } | null;
};

export type Sector = {
  id: string;
  name: string;
  slug: string;
  default_max_age_days: number;
  created_at: string;
};

export const listSectors = async (): Promise<Sector[]> => {
  const res = await fetch(`${API_URL}/sectors`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load sectors");
  }
  return res.json();
};

export const createSector = async (payload: {
  name: string;
  default_max_age_days?: number;
}): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to create sector");
  }

  return res.json();
};

export const listSources = async (): Promise<Source[]> => {
  const res = await fetch(`${API_URL}/sources`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load sources");
  }
  return res.json();
};

export const createSource = async (payload: {
  url: string;
  name?: string;
  active?: boolean;
  sector_id?: string;
  max_age_days?: number | null;
}): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to create source");
  }

  return res.json();
};

export const updateSource = async (
  id: string,
  payload: {
    url?: string;
    name?: string;
    active?: boolean;
    sector_id?: string;
    max_age_days?: number | null;
  },
): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to update source");
  }

  return res.json();
};

export const deleteSource = async (id: string): Promise<void> => {
  const res = await fetch(`${API_URL}/sources/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to delete source");
  }
};

export const runIngest = async (): Promise<{ queued: boolean; jobId?: string }> => {
  const res = await fetch(`${API_URL}/ingest/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error("Failed to trigger ingest");
  }
  return res.json();
};
