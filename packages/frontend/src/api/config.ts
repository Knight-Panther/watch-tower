import { API_BASE, authHeaders } from "./client";

export const getFeedItemsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/feed-items-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 60);
};

export const setFeedItemsTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/feed-items-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

export const getFeedFetchRunsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/feed-fetch-runs-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load fetch runs TTL");
  }
  const data = await res.json();
  return Number(data.hours ?? 336);
};

export const setFeedFetchRunsTtl = async (hours: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/feed-fetch-runs-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ hours }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update fetch runs TTL");
  }
  const data = await res.json();
  return Number(data.hours ?? hours);
};

// LLM Telemetry TTL
export const getLlmTelemetryTtl = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/llm-telemetry-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load LLM telemetry TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setLlmTelemetryTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/llm-telemetry-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update LLM telemetry TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

// Article Images TTL
export const getArticleImagesTtl = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/article-images-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load article images TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setArticleImagesTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/article-images-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update article images TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

// Post Deliveries TTL
export const getPostDeliveriesTtl = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/post-deliveries-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load post deliveries TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setPostDeliveriesTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/post-deliveries-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update post deliveries TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

export const getDigestRunsTtl = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/digest-runs-ttl`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load digest runs TTL");
  }
  const data = await res.json();
  return Number(data.days ?? 30);
};

export const setDigestRunsTtl = async (days: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/digest-runs-ttl`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update digest runs TTL");
  }
  const data = await res.json();
  return Number(data.days ?? days);
};

// ─── Auto-Post Config (Per-Platform) ─────────────────────────────────────────
// Each platform has its own auto-post toggle. When enabled, auto-approved
// articles (score >= auto_approve_threshold) are immediately posted to that platform.

// ── Telegram (Active) ──
export const getAutoPostTelegram = async (): Promise<boolean> => {
  const res = await fetch(`${API_BASE}/config/auto-post-telegram`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load Telegram auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? true;
};

export const setAutoPostTelegram = async (enabled: boolean): Promise<boolean> => {
  const res = await fetch(`${API_BASE}/config/auto-post-telegram`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update Telegram auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? enabled;
};

// ── Facebook (Placeholder - Coming Soon) ──
// TODO: Enable when Facebook Graph API integration is complete
// To wire up:
// 1. Implement FacebookProvider in packages/social/src/facebook.ts
// 2. Add facebook case to distribution.ts worker
// 3. Uncomment these functions and the UI toggle
export const getAutoPostFacebook = async (): Promise<boolean> => {
  const res = await fetch(`${API_BASE}/config/auto-post-facebook`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load Facebook auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? false; // Default OFF for new platforms
};

export const setAutoPostFacebook = async (enabled: boolean): Promise<boolean> => {
  const res = await fetch(`${API_BASE}/config/auto-post-facebook`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update Facebook auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? enabled;
};

// ── LinkedIn (Placeholder - Coming Soon) ──
// TODO: Enable when LinkedIn API integration is complete
// To wire up:
// 1. Implement LinkedInProvider in packages/social/src/linkedin.ts
// 2. Add linkedin case to distribution.ts worker
// 3. Uncomment these functions and the UI toggle
export const getAutoPostLinkedin = async (): Promise<boolean> => {
  const res = await fetch(`${API_BASE}/config/auto-post-linkedin`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load LinkedIn auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? false; // Default OFF for new platforms
};

export const setAutoPostLinkedin = async (enabled: boolean): Promise<boolean> => {
  const res = await fetch(`${API_BASE}/config/auto-post-linkedin`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update LinkedIn auto-post setting");
  }
  const data = await res.json();
  return data.enabled ?? enabled;
};

// ─── Score Thresholds ────────────────────────────────────────────────────────
// Controls which scores trigger auto-approve, auto-reject, or manual review.

export const getAutoApproveThreshold = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/auto-approve-threshold`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load auto-approve threshold");
  }
  const data = await res.json();
  return data.value ?? 5;
};

export const setAutoApproveThreshold = async (value: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/auto-approve-threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update auto-approve threshold");
  }
  const data = await res.json();
  return data.value ?? value;
};

export const getAutoRejectThreshold = async (): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/auto-reject-threshold`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load auto-reject threshold");
  }
  const data = await res.json();
  return data.value ?? 2;
};

export const setAutoRejectThreshold = async (value: number): Promise<number> => {
  const res = await fetch(`${API_BASE}/config/auto-reject-threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update auto-reject threshold");
  }
  const data = await res.json();
  return data.value ?? value;
};

// ─── Reset Data ──────────────────────────────────────────────────────────────

export type ResetResult = {
  success: boolean;
  cleared: {
    articles: number;
    feed_fetch_runs: number;
    llm_telemetry: number;
    post_deliveries: number;
    article_images: number;
    redis_keys: number;
  };
};

/**
 * Reset all transient data (articles, telemetry, queues).
 * Preserves configuration (sectors, sources, scoring rules, app config).
 */
export const resetAllData = async (): Promise<ResetResult> => {
  const res = await fetch(`${API_BASE}/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders) },
    body: JSON.stringify({ confirm: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to reset data");
  }
  return res.json();
};
