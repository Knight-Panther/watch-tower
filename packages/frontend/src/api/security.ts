import { API_BASE, authHeaders } from "./client";

// ─── Site Rules (Security) ───────────────────────────────────────────────────

export type AllowedDomain = {
  id: string;
  domain: string;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
};

export type SecurityConfig = {
  maxFeedSizeMb: number;
  maxArticlesPerFetch: number;
  maxArticlesPerSourceDaily: number;
  allowedOrigins: string[];
  apiRateLimitPerMinute: number;
};

// Domain Whitelist
export const getAllowedDomains = async (): Promise<AllowedDomain[]> => {
  const res = await fetch(`${API_BASE}/site-rules/domains`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch allowed domains");
  return res.json();
};

export const addAllowedDomain = async (
  domain: string,
  notes?: string,
): Promise<AllowedDomain> => {
  const res = await fetch(`${API_BASE}/site-rules/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ domain, notes }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to add domain");
  }
  return res.json();
};

export const updateAllowedDomain = async (
  id: string,
  updates: { isActive?: boolean; notes?: string },
): Promise<AllowedDomain> => {
  const res = await fetch(`${API_BASE}/site-rules/domains/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update domain");
  }
  return res.json();
};

export const deleteAllowedDomain = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/site-rules/domains/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete domain");
  }
};

// Security Config (read-only from env)
export const getSecurityConfig = async (): Promise<SecurityConfig> => {
  const res = await fetch(`${API_BASE}/site-rules/config`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch security config");
  return res.json();
};

// Kill Switch (Emergency Stop)
export const getEmergencyStop = async (): Promise<{ enabled: boolean }> => {
  const res = await fetch(`${API_BASE}/config/emergency-stop`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch emergency stop status");
  return res.json();
};

export const setEmergencyStop = async (enabled: boolean): Promise<{ enabled: boolean }> => {
  const res = await fetch(`${API_BASE}/config/emergency-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to set emergency stop");
  }
  return res.json();
};
