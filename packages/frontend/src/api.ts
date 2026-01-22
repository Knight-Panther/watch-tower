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
  ingest_interval_minutes: number | null;
  created_at: string;
  last_fetched_at: string | null;
  sectors?: {
    id: string;
    name: string;
    slug: string;
    default_max_age_days: number;
    ingest_interval_minutes: number | null;
  } | null;
};

export type Sector = {
  id: string;
  name: string;
  slug: string;
  default_max_age_days: number;
  ingest_interval_minutes: number | null;
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
  ingest_interval_minutes?: number | null;
}): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create sector");
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
  ingest_interval_minutes?: number | null;
}): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create source");
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
    ingest_interval_minutes?: number | null;
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

export const deleteSource = async (
  id: string,
  hard = false,
): Promise<Source> => {
  const res = await fetch(`${API_URL}/sources/${id}?hard=${hard}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete source");
  }
  return res.json();
};

export const batchSourceAction = async (payload: {
  ids: string[];
  action: "deactivate" | "delete";
}): Promise<Source[]> => {
  const res = await fetch(`${API_URL}/sources/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update sources");
  }
  return res.json();
};

export const getFeedItemsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-items-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 60);
};

export const setFeedItemsTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-items-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

export const getIngestInterval = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/ingest-interval`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load ingest interval");
  }
  const data = await res.json();
  return Number(data.minutes ?? 15);
};

export const setIngestInterval = async (minutes: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/ingest-interval`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ minutes }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update ingest interval");
  }
  const data = await res.json();
  return Number(data.minutes ?? minutes);
};

export const updateSector = async (
  id: string,
  payload: { default_max_age_days?: number; ingest_interval_minutes?: number | null },
): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update sector");
  }
  return res.json();
};
