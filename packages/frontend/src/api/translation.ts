import { API_BASE, authHeaders } from "./client";

// ─── Translation Config ─────────────────────────────────────────────────────

export type TranslationConfig = {
  posting_language: "en" | "ka";
  scores: number[];
  provider: "gemini" | "openai";
  model: string;
  instructions: string;
};

export const getTranslationConfig = async (): Promise<TranslationConfig> => {
  const res = await fetch(`${API_BASE}/config/translation`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get translation config");
  return res.json();
};

export const updateTranslationConfig = async (
  config: Partial<TranslationConfig>,
): Promise<void> => {
  const res = await fetch(`${API_BASE}/config/translation`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to update translation config");
};
