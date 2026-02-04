import type { BalanceRegistryEntry, ProviderBalance } from "./types.js";
import {
  fetchDeepSeekBalance,
  fetchOpenAIBalance,
  fetchClaudeBalance,
  fetchGeminiBalance,
} from "./fetchers.js";

/**
 * Registry of providers and their balance-fetching capabilities.
 * To add a new provider:
 * 1. Add the fetcher function in fetchers.ts
 * 2. Add an entry here with the env key it depends on
 */
export const balanceRegistry: Record<string, BalanceRegistryEntry> = {
  deepseek: {
    envKey: "DEEPSEEK_API_KEY",
    displayName: "DeepSeek",
    fetchBalance: fetchDeepSeekBalance,
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    displayName: "OpenAI",
    fetchBalance: fetchOpenAIBalance,
  },
  claude: {
    envKey: "ANTHROPIC_API_KEY",
    displayName: "Claude (Anthropic)",
    fetchBalance: fetchClaudeBalance,
  },
  gemini: {
    envKey: "GOOGLE_AI_API_KEY",
    displayName: "Gemini (Google)",
    fetchBalance: fetchGeminiBalance,
  },
};

/**
 * Get list of configured providers based on environment variables.
 * Returns provider names that have their API key set.
 */
export function getConfiguredProviders(env: Record<string, string | undefined>): string[] {
  return Object.entries(balanceRegistry)
    .filter(([, config]) => {
      const key = env[config.envKey];
      return key && key.trim().length > 0;
    })
    .map(([name]) => name);
}

/**
 * Fetch balances for all configured providers.
 * Only fetches from providers that have their API key configured.
 *
 * @param env - Environment variables object (process.env or custom)
 * @returns Array of provider balances
 */
export async function getConfiguredBalances(
  env: Record<string, string | undefined>,
): Promise<ProviderBalance[]> {
  const configured = getConfiguredProviders(env);
  const results: ProviderBalance[] = [];

  // Fetch all balances in parallel
  const promises = configured.map(async (providerName) => {
    const config = balanceRegistry[providerName];
    if (!config) return null;

    const apiKey = env[config.envKey];
    if (!apiKey) return null;

    try {
      const balance = await config.fetchBalance(apiKey);
      return balance;
    } catch (err) {
      return {
        provider: providerName,
        available: false,
        currency: "USD",
        totalBalance: null,
        error: err instanceof Error ? err.message : "Unknown error",
      } as ProviderBalance;
    }
  });

  const balances = await Promise.all(promises);

  for (const balance of balances) {
    if (balance) {
      results.push(balance);
    }
  }

  return results;
}

/**
 * Get display name for a provider.
 */
export function getProviderDisplayName(provider: string): string {
  return balanceRegistry[provider]?.displayName ?? provider;
}
