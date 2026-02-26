import type { Sector } from "@watch-tower/shared";
import { API_BASE, authHeaders } from "./client";

export type { Sector };

export const listSectors = async (): Promise<Sector[]> => {
  const res = await fetch(`${API_BASE}/sectors`, {
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
  const res = await fetch(`${API_BASE}/sectors`, {
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

export const updateSector = async (
  id: string,
  payload: { default_max_age_days?: number },
): Promise<Sector> => {
  const res = await fetch(`${API_BASE}/sectors/${id}`, {
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

export const deleteSector = async (id: string): Promise<Sector> => {
  const res = await fetch(`${API_BASE}/sectors/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete sector");
  }
  return res.json();
};
