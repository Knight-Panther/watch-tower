import { API_BASE, authHeaders } from "./client";

// ─── Post Templates ──────────────────────────────────────────────────────────

export interface PostTemplateConfig {
  showBreakingLabel: boolean;
  showSectorTag: boolean;
  showTitle: boolean;
  showSummary: boolean;
  showUrl: boolean;
  showImage: boolean;
  autoCommentUrl: boolean;
  breakingEmoji: string;
  breakingText: string;
  urlLinkText: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  account_name: string;
  is_active: boolean;
  rate_limit_per_hour: number;
  post_template: PostTemplateConfig;
  is_template_custom: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Rate Limit Usage ────────────────────────────────────────────────────────

export type PlatformUsage = {
  platform: string;
  current: number;
  limit: number;
  percentage: number;
  status: "ok" | "warning" | "blocked";
};

export const listSocialAccounts = async (): Promise<SocialAccount[]> => {
  const res = await fetch(`${API_BASE}/social-accounts`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to fetch social accounts");
  }
  return res.json();
};

export const getPostTemplate = async (
  accountId: string,
): Promise<{ platform: string; template: PostTemplateConfig; is_default: boolean }> => {
  const res = await fetch(`${API_BASE}/social-accounts/${accountId}/template`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to fetch template");
  }
  return res.json();
};

export const savePostTemplate = async (
  accountId: string,
  template: PostTemplateConfig,
): Promise<{ success: boolean; platform: string; template: PostTemplateConfig }> => {
  const res = await fetch(`${API_BASE}/social-accounts/${accountId}/template`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ template }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save template");
  }
  return res.json();
};

export const resetPostTemplate = async (
  accountId: string,
): Promise<{ success: boolean; message: string; template: PostTemplateConfig }> => {
  const res = await fetch(`${API_BASE}/social-accounts/${accountId}/template`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to reset template");
  }
  return res.json();
};

export const previewPost = async (
  platform: string,
  template: PostTemplateConfig,
  article: { title: string; summary: string; url: string; sector: string },
): Promise<{ platform: string; formatted_text: string; char_count: number }> => {
  const res = await fetch(`${API_BASE}/social-accounts/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ platform, template, article }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to preview post");
  }
  return res.json();
};

// ─── Sector Post Templates ──────────────────────────────────────────────────

export type SectorTemplate = {
  id: string;
  sectorId: string;
  sectorName: string;
  platform: string;
  postTemplate: PostTemplateConfig;
};

export const listSectorTemplates = async (): Promise<SectorTemplate[]> => {
  const res = await fetch(`${API_BASE}/social-accounts/sector-templates`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch sector templates");
  return res.json();
};

export const getSectorTemplate = async (
  sectorId: string,
  platform: string,
): Promise<{ template: PostTemplateConfig; is_override: boolean }> => {
  const res = await fetch(`${API_BASE}/social-accounts/sector-templates/${sectorId}/${platform}`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to fetch sector template");
  return res.json();
};

export const saveSectorTemplate = async (
  sectorId: string,
  platform: string,
  template: PostTemplateConfig,
): Promise<{ success: boolean }> => {
  const res = await fetch(`${API_BASE}/social-accounts/sector-templates/${sectorId}/${platform}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ template }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save sector template");
  }
  return res.json();
};

export const deleteSectorTemplate = async (
  sectorId: string,
  platform: string,
): Promise<{ success: boolean }> => {
  const res = await fetch(`${API_BASE}/social-accounts/sector-templates/${sectorId}/${platform}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to delete sector template");
  return res.json();
};

export const getSocialAccountsUsage = async (): Promise<{ usage: PlatformUsage[] }> => {
  const res = await fetch(`${API_BASE}/social-accounts/usage`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    throw new Error("Failed to load usage stats");
  }
  return res.json();
};

export const updateSocialAccountRateLimit = async (
  accountId: string,
  rateLimitPerHour: number,
): Promise<{ success: boolean; platform: string; rate_limit_per_hour: number }> => {
  const res = await fetch(`${API_BASE}/social-accounts/${accountId}/rate-limit`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ rate_limit_per_hour: rateLimitPerHour }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update rate limit");
  }
  return res.json();
};
