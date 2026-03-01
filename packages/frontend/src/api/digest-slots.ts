import { API_BASE, authHeaders } from "./client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DigestSlot = {
  id: string;
  name: string;
  enabled: boolean;
  time: string;
  timezone: string;
  days: number[];
  min_score: number;
  max_articles: number;
  sector_ids: string[] | null;
  language: "en" | "ka";
  system_prompt: string | null;
  translation_prompt: string | null;
  provider: string;
  model: string;
  translation_provider: string;
  translation_model: string;
  auto_post: boolean;
  telegram_chat_id: string | null;
  telegram_enabled: boolean;
  facebook_enabled: boolean;
  linkedin_enabled: boolean;
  telegram_language: "en" | "ka";
  facebook_language: "en" | "ka";
  linkedin_language: "en" | "ka";
  image_telegram: boolean;
  image_facebook: boolean;
  image_linkedin: boolean;
  created_at: string;
  updated_at: string;
  // Enriched from list endpoint
  total_runs?: number;
  last_run_at?: string | null;
};

export type DigestSlotRun = {
  id: string;
  slot_id: string | null;
  sent_at: string;
  is_test: boolean;
  language: string;
  article_count: number;
  channels: string[];
  channel_results: Record<string, string> | null;
  provider: string;
  model: string;
  min_score: number;
  stats_scanned: number;
  stats_scored: number;
  stats_above_threshold: number;
  max_articles: number | null;
  score_distribution: Record<string, number> | null;
  created_at: string;
};

export type DigestSlotDetail = DigestSlot & {
  recent_runs: DigestSlotRun[];
};

export type DigestSlotCreate = {
  name: string;
  enabled?: boolean;
  time?: string;
  timezone?: string;
  days?: number[];
  min_score?: number;
  max_articles?: number;
  sector_ids?: string[] | null;
  language?: "en" | "ka";
  system_prompt?: string | null;
  translation_prompt?: string | null;
  provider?: string;
  model?: string;
  translation_provider?: string;
  translation_model?: string;
  auto_post?: boolean;
  telegram_chat_id?: string | null;
  telegram_enabled?: boolean;
  facebook_enabled?: boolean;
  linkedin_enabled?: boolean;
  telegram_language?: "en" | "ka";
  facebook_language?: "en" | "ka";
  linkedin_language?: "en" | "ka";
  image_telegram?: boolean;
  image_facebook?: boolean;
  image_linkedin?: boolean;
};

export type DigestSlotUpdate = Partial<Omit<DigestSlotCreate, "name">> & {
  name?: string;
};

export type DigestDraft = {
  id: string;
  slot_id: string;
  status: "draft" | "approved" | "sent" | "expired" | "discarded" | "send_failed";
  generated_text: string;
  translated_text: string | null;
  edited: boolean;
  article_count: number;
  article_ids: string[];
  provider: string;
  model: string;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
  llm_cost_microdollars: number | null;
  translation_provider: string | null;
  translation_model: string | null;
  translation_cost_microdollars: number | null;
  stats_scanned: number;
  stats_scored: number;
  stats_above_threshold: number;
  max_articles: number | null;
  score_distribution: Record<string, number> | null;
  channels: string[] | null;
  channel_results: Record<string, string> | null;
  generated_at: string;
  approved_at: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  expires_at: string;
  created_at: string;
  // Enriched (from pending endpoint)
  slot_name?: string;
};

// ─── Defaults (DB-confirmed) ────────────────────────────────────────────────

export type DigestSlotDefaultsResponse = {
  enabled: boolean;
  time: string;
  timezone: string;
  days: number[];
  min_score: number;
  max_articles: number;
  language: "en" | "ka";
  provider: string;
  model: string;
  translation_provider: string;
  translation_model: string;
  auto_post: boolean;
  telegram_enabled: boolean;
  facebook_enabled: boolean;
  linkedin_enabled: boolean;
  telegram_language: "en" | "ka";
  facebook_language: "en" | "ka";
  linkedin_language: "en" | "ka";
  image_telegram: boolean;
  image_facebook: boolean;
  image_linkedin: boolean;
};

export const getDigestSlotDefaults = async (): Promise<DigestSlotDefaultsResponse> => {
  const res = await fetch(`${API_BASE}/digest-slots/defaults`, { headers: authHeaders });
  if (!res.ok) {
    throw new Error("Failed to load digest slot defaults");
  }
  return res.json();
};

// ─── CRUD ───────────────────────────────────────────────────────────────────

export const listDigestSlots = async (): Promise<DigestSlot[]> => {
  const res = await fetch(`${API_BASE}/digest-slots`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load digest slots");
  }
  return res.json();
};

export const getDigestSlot = async (id: string): Promise<DigestSlotDetail> => {
  const res = await fetch(`${API_BASE}/digest-slots/${id}`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load digest slot");
  }
  return res.json();
};

export const createDigestSlot = async (payload: DigestSlotCreate): Promise<DigestSlot> => {
  const res = await fetch(`${API_BASE}/digest-slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create digest slot");
  }
  return res.json();
};

export const updateDigestSlot = async (
  id: string,
  payload: DigestSlotUpdate,
): Promise<DigestSlot> => {
  const res = await fetch(`${API_BASE}/digest-slots/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update digest slot");
  }
  return res.json();
};

export const deleteDigestSlot = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/digest-slots/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete digest slot");
  }
};

// ─── Test / History ─────────────────────────────────────────────────────────

export const testDigestSlot = async (
  id: string,
): Promise<{ queued: boolean; slot_id: string }> => {
  const res = await fetch(`${API_BASE}/digest-slots/${id}/test`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to queue test digest");
  }
  return res.json();
};

export const getDigestSlotHistory = async (
  id: string,
  limit = 20,
): Promise<{ slot_id: string; total_returned: number; runs: DigestSlotRun[] }> => {
  const res = await fetch(`${API_BASE}/digest-slots/${id}/history?limit=${limit}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load digest slot history");
  }
  return res.json();
};

export const clearDigestSlotHistory = async (
  id: string,
): Promise<{ cleared: number }> => {
  const res = await fetch(`${API_BASE}/digest-slots/${id}/history`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to clear digest slot history");
  }
  return res.json();
};

// ─── Draft Operations ───────────────────────────────────────────────────────

export const listPendingDrafts = async (): Promise<DigestDraft[]> => {
  const res = await fetch(`${API_BASE}/digest-slots/drafts/pending`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load pending drafts");
  }
  return res.json();
};

export const listDrafts = async (slotId: string, limit = 20): Promise<DigestDraft[]> => {
  const res = await fetch(`${API_BASE}/digest-slots/${slotId}/drafts?limit=${limit}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load drafts");
  }
  return res.json();
};

export const getDraft = async (slotId: string, draftId: string): Promise<DigestDraft> => {
  const res = await fetch(`${API_BASE}/digest-slots/${slotId}/drafts/${draftId}`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load draft");
  }
  return res.json();
};

export const editDraft = async (
  slotId: string,
  draftId: string,
  payload: { generated_text?: string; translated_text?: string | null },
): Promise<DigestDraft> => {
  const res = await fetch(`${API_BASE}/digest-slots/${slotId}/drafts/${draftId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to edit draft");
  }
  return res.json();
};

export const approveDraft = async (
  slotId: string,
  draftId: string,
): Promise<{ queued: boolean; draft_id: string }> => {
  const res = await fetch(`${API_BASE}/digest-slots/${slotId}/drafts/${draftId}/approve`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to approve draft");
  }
  return res.json();
};

export const scheduleDraft = async (
  slotId: string,
  draftId: string,
  scheduledAt: string,
): Promise<{ scheduled: boolean; draft_id: string; scheduled_at: string }> => {
  const res = await fetch(`${API_BASE}/digest-slots/${slotId}/drafts/${draftId}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ scheduled_at: scheduledAt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to schedule draft");
  }
  return res.json();
};

export const discardDraft = async (
  slotId: string,
  draftId: string,
): Promise<{ success: boolean; draft_id: string }> => {
  const res = await fetch(`${API_BASE}/digest-slots/${slotId}/drafts/${draftId}/discard`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to discard draft");
  }
  return res.json();
};
