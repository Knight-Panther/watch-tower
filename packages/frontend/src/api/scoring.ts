import { API_BASE, authHeaders } from "./client";
import type { ScoringConfig, ScoringExample } from "@watch-tower/shared";

// Re-export shared types so existing imports from "../api" keep working
export type { ScoringConfig, ScoringExample };

export type ScoringRule = {
  id?: string;
  sector_id: string;
  sector_name: string;
  sector_slug?: string;
  config: ScoringConfig;
  is_legacy: boolean;
  auto_approve_threshold: number;
  auto_reject_threshold: number;
  prompt_preview?: string;
  legacy_prompt?: string | null;
  updated_at: string | null;
};

// ─── Scoring Rules API ──────────────────────────────────────────────────────

export const listScoringRules = async (): Promise<ScoringRule[]> => {
  const res = await fetch(`${API_BASE}/scoring-rules`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scoring rules");
  }
  return res.json();
};

export const getScoringRule = async (sectorId: string): Promise<ScoringRule> => {
  const res = await fetch(`${API_BASE}/scoring-rules/${sectorId}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load scoring rule");
  }
  return res.json();
};

export const saveScoringRule = async (
  sectorId: string,
  config: ScoringConfig,
  autoApprove: number,
  autoReject: number,
): Promise<{ success: boolean; prompt_preview: string }> => {
  const res = await fetch(`${API_BASE}/scoring-rules/${sectorId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      config,
      auto_approve_threshold: autoApprove,
      auto_reject_threshold: autoReject,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save scoring rule");
  }
  return res.json();
};

export const deleteScoringRule = async (sectorId: string): Promise<{ success: boolean }> => {
  const res = await fetch(`${API_BASE}/scoring-rules/${sectorId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete scoring rule");
  }
  return res.json();
};

export const previewScoringPrompt = async (
  config: ScoringConfig,
  sectorName: string,
): Promise<{ prompt: string }> => {
  const res = await fetch(`${API_BASE}/scoring-rules/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ config, sector_name: sectorName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to preview prompt");
  }
  return res.json();
};
