import { API_BASE, authHeaders } from "./client";

// ─── Digest Config ───────────────────────────────────────────────────────────

export type DigestConfig = {
  enabled: boolean;
  time: string;
  timezone: string;
  days: number[];
  minScore: number;
  language: string;
  systemPrompt: string;
  telegramChatId: string;
  telegramEnabled: boolean;
  facebookEnabled: boolean;
  linkedinEnabled: boolean;
  provider: string;
  model: string;
  translationProvider: string;
  translationModel: string;
  translationPrompt: string;
  imageTelegram: boolean;
  imageFacebook: boolean;
  imageLinkedin: boolean;
  lastDigestSentAt: string | null;
};

export const getDigestConfig = async (): Promise<DigestConfig> => {
  const res = await fetch(`${API_BASE}/config/digest`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to load digest config");
  return res.json();
};

export const updateDigestConfig = async (
  config: Partial<Omit<DigestConfig, "lastDigestSentAt">>,
): Promise<void> => {
  const res = await fetch(`${API_BASE}/config/digest`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update digest config");
  }
};

export const sendTestDigest = async (): Promise<{ queued: boolean; message: string }> => {
  const res = await fetch(`${API_BASE}/config/digest/test`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to send test digest");
  }
  return res.json();
};

// ─── Digest History ─────────────────────────────────────────────────────────

export type DigestRun = {
  id: string;
  sentAt: string;
  isTest: boolean;
  language: string;
  articleCount: number;
  channels: string[];
  channelResults: Record<string, string>;
  provider: string;
  model: string;
  minScore: number;
  statsScanned: number;
  statsScored: number;
  statsAboveThreshold: number;
};

export const getDigestHistory = async (limit = 30): Promise<DigestRun[]> => {
  const res = await fetch(`${API_BASE}/config/digest/history?limit=${limit}`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to load digest history");
  return res.json();
};

export const clearDigestHistory = async (): Promise<{ deleted: number }> => {
  const res = await fetch(`${API_BASE}/config/digest/history`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to clear digest history");
  return res.json();
};
