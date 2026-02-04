import type { ProviderBalance } from "./types.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROVIDER BALANCE API STATUS (as of Feb 2026)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * | Provider  | Balance API | Notes                                            |
 * |-----------|-------------|--------------------------------------------------|
 * | DeepSeek  | YES         | GET /user/balance - works perfectly              |
 * | OpenAI    | NO          | Deprecated billing endpoints, no replacement     |
 * | Claude    | NO          | Anthropic has no public balance API              |
 * | Gemini    | NO          | Google AI has no public balance API              |
 *
 * TODO: Check periodically if OpenAI/Anthropic/Google add balance APIs.
 *       OpenAI community has requested this feature multiple times.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Fetch DeepSeek balance.
 * API: GET https://api.deepseek.com/user/balance
 */
export async function fetchDeepSeekBalance(apiKey: string): Promise<ProviderBalance | null> {
  try {
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        provider: "deepseek",
        available: false,
        currency: "USD",
        totalBalance: null,
        error: `API error: ${response.status} - ${text.slice(0, 100)}`,
      };
    }

    const data = (await response.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency: string;
        total_balance: string;
        granted_balance: string;
        topped_up_balance: string;
      }>;
    };

    const balanceInfo = data.balance_infos?.[0];
    if (!balanceInfo) {
      return {
        provider: "deepseek",
        available: data.is_available ?? false,
        currency: "USD",
        totalBalance: null,
        error: "No balance info returned",
      };
    }

    return {
      provider: "deepseek",
      available: data.is_available ?? true,
      currency: balanceInfo.currency || "USD",
      totalBalance: parseFloat(balanceInfo.total_balance) || 0,
      grantedBalance: parseFloat(balanceInfo.granted_balance) || 0,
      toppedUpBalance: parseFloat(balanceInfo.topped_up_balance) || 0,
    };
  } catch (err) {
    return {
      provider: "deepseek",
      available: false,
      currency: "USD",
      totalBalance: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * OpenAI balance.
 * Note: OpenAI deprecated their billing API endpoints. There is no public API
 * to check credit balance - this is a known community request.
 * See: https://community.openai.com/t/add-api-endpoint-to-check-remaining-credits-or-balance-on-openai-account/1365221
 */
export async function fetchOpenAIBalance(_apiKey: string): Promise<ProviderBalance | null> {
  // OpenAI does not provide a balance API
  // The old /dashboard/billing/ endpoints are deprecated/restricted
  return {
    provider: "openai",
    available: true,
    currency: "USD",
    totalBalance: null,
    error: "No balance API - check platform.openai.com/usage",
  };
}

/**
 * Claude/Anthropic balance.
 * Note: Anthropic doesn't have a public balance API as of 2025.
 * Returns null to indicate balance checking is not supported.
 */
export async function fetchClaudeBalance(_apiKey: string): Promise<ProviderBalance | null> {
  // Anthropic doesn't expose a balance API
  // Return a placeholder indicating the provider is configured but balance unavailable
  return {
    provider: "claude",
    available: true,
    currency: "USD",
    totalBalance: null,
    error: "Balance API not available - check console.anthropic.com",
  };
}

/**
 * Google Gemini balance.
 * Note: Google AI doesn't have a public balance API.
 * Returns null to indicate balance checking is not supported.
 */
export async function fetchGeminiBalance(_apiKey: string): Promise<ProviderBalance | null> {
  // Google AI doesn't expose a balance API
  return {
    provider: "gemini",
    available: true,
    currency: "USD",
    totalBalance: null,
    error: "Balance API not available - check console.cloud.google.com",
  };
}
