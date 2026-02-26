import type { Source } from "@watch-tower/shared";
import { API_BASE, authHeaders } from "./client";

export type { Source };

export const listSources = async (): Promise<Source[]> => {
  const res = await fetch(`${API_BASE}/sources`, {
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
  const res = await fetch(`${API_BASE}/sources`, {
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
  const res = await fetch(`${API_BASE}/sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("Failed to update source");
  }

  return res.json();
};

export const deleteSource = async (id: string, hard = false): Promise<Source> => {
  const res = await fetch(`${API_BASE}/sources/${id}?hard=${hard}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete source");
  }
  return res.json();
};

export const runIngest = async (): Promise<{ queued: boolean; jobId?: string }> => {
  const res = await fetch(`${API_BASE}/ingest/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error("Failed to trigger ingest");
  }
  return res.json();
};

export const batchSourceAction = async (payload: {
  ids: string[];
  action: "deactivate" | "delete";
}): Promise<Source[]> => {
  const res = await fetch(`${API_BASE}/sources/batch`, {
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
