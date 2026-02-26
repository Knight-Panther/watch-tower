import { API_BASE, authHeaders } from "./client";

// ─── Platform Health ──────────────────────────────────────────────────────────

export type PlatformHealth = {
  platform: string;
  healthy: boolean;
  status: "active" | "expiring" | "expired" | "error";
  error: string | null;
  expiresAt: string | null;
  daysRemaining?: number;
  lastCheck: string;
  lastPost: string | null;
  rateLimit: {
    remaining: number | null;
    limit: number | null;
    percent: number | null;
    resetsAt: string | null;
  };
};

// ─── Provider Credits/Balances ───────────────────────────────────────────────

export type ProviderBalance = {
  provider: string;
  display_name: string;
  available: boolean;
  currency: string;
  total_balance: number | null;
  granted_balance: number | null;
  topped_up_balance: number | null;
  error: string | null;
};

export type ProviderBalancesResponse = {
  providers: ProviderBalance[];
  generated_at: string;
};

export const getPlatformHealth = async (): Promise<PlatformHealth[]> => {
  const res = await fetch(`${API_BASE}/health/platforms`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch platform health");
  const data = await res.json();
  return data.platforms;
};

export const refreshPlatformHealth = async (): Promise<void> => {
  const res = await fetch(`${API_BASE}/health/platforms/refresh`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to trigger health check");
};

export const getProviderBalances = async (): Promise<ProviderBalancesResponse> => {
  const res = await fetch(`${API_BASE}/credits`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load provider balances");
  }
  return res.json();
};

export const refreshProviderBalances = async (): Promise<ProviderBalancesResponse> => {
  const res = await fetch(`${API_BASE}/credits/refresh`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to refresh provider balances");
  }
  return res.json();
};
