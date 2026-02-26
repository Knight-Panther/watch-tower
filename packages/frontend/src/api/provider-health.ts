import { API_BASE, authHeaders } from "./client";

// ─── Provider Health Check ────────────────────────────────────────────────

export type ProviderHealthResult = {
  provider: string;
  role: string;
  displayName: string;
  model: string;
  healthy: boolean;
  latencyMs: number;
  error: string | null;
};

export type ProviderHealthResponse = {
  results: ProviderHealthResult[];
  checked_at: string;
};

export const checkProviderHealth = async (): Promise<ProviderHealthResponse> => {
  const res = await fetch(`${API_BASE}/health/providers`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to check provider health");
  }
  return res.json();
};
