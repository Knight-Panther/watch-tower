import type { Sector, Source } from "@watch-tower/shared";

export type { Sector, Source };

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};

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
  ingest_interval_minutes: number;
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
    ingest_interval_minutes?: number;
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

export const deleteSource = async (id: string, hard = false): Promise<Source> => {
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

export const getFeedFetchRunsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-fetch-runs-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load fetch runs TTL");
  }
  const data = await res.json();
  return Number(data.hours ?? 336);
};

export const setFeedFetchRunsTtl = async (hours: number): Promise<number> => {
  const res = await fetch(`${API_URL}/config/feed-fetch-runs-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ hours }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update fetch runs TTL");
  }
  const data = await res.json();
  return Number(data.hours ?? hours);
};

export const updateSector = async (
  id: string,
  payload: { default_max_age_days?: number },
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

export type StatsOverview = {
  total_sources: number;
  active_sources: number;
  items_last_24h: number;
  stale_sources: number;
  queues: {
    feed: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
    };
  };
};

export type StatsSource = {
  id: string;
  name: string | null;
  url: string;
  active: boolean;
  sector: { id: string; name: string; slug: string } | null;
  expected_interval_minutes: number | null;
  last_success_at: string | null;
  last_run: {
    status: "success" | "error";
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    item_count: number | null;
    item_added: number | null;
    error_message: string | null;
  } | null;
  is_stale: boolean;
};

export const getStatsOverview = async (): Promise<StatsOverview> => {
  const res = await fetch(`${API_URL}/stats/overview`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load stats overview");
  }
  return res.json();
};

export const getStatsSources = async (): Promise<StatsSource[]> => {
  const res = await fetch(`${API_URL}/stats/sources`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load source stats");
  }
  return res.json();
};

export type Constraints = {
  feedItemsTtl: { min: number; max: number; unit: string };
  fetchRunsTtl: { min: number; max: number; unit: string };
  interval: { min: number; max: number; unit: string };
  maxAge: { min: number; max: number; unit: string };
};

export const getConstraints = async (): Promise<Constraints> => {
  const res = await fetch(`${API_URL}/config/constraints`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load constraints");
  }
  return res.json();
};

export const deleteSector = async (id: string): Promise<Sector> => {
  const res = await fetch(`${API_URL}/sectors/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete sector");
  }
  return res.json();
};
