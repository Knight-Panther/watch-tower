export type ScoringRequest = {
  articleId: string;
  title: string;
  contentSnippet: string | null;
  sectorName?: string;
  promptTemplate?: string; // Custom prompt, or use default
};

export type ScoringResult = {
  articleId: string;
  score: number; // 1-5
  summary: string | null; // Generated summary (Phase 4)
  reasoning?: string; // Optional: why this score (for debugging)
  error?: string; // Error message if scoring failed

  // Telemetry (populated from LLM API response)
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs?: number; // API response time in milliseconds
  isFallback?: boolean; // True if fallback provider was used
};

/**
 * Supported LLM providers.
 * Extensible - add new providers as needed.
 */
export type LLMProviderType = "claude" | "openai" | "deepseek";

/**
 * Configuration for creating an LLM provider.
 */
export type LLMProviderConfig = {
  provider: LLMProviderType | string; // Extensible for future providers
  apiKey: string;
  model?: string;
  baseUrl?: string; // For custom endpoints (DeepSeek, local models, proxies)
};

/**
 * Default models per provider.
 * Used when no model is specified in config.
 */
export const DEFAULT_MODELS: Record<LLMProviderType, string> = {
  claude: "claude-sonnet-4-20250514",
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
};

/**
 * Default base URLs per provider.
 */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
};
