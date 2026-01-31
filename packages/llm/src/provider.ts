import type { ScoringRequest, ScoringResult, LLMProviderConfig } from "./types.js";
import { ClaudeLLMProvider } from "./claude.js";
import { OpenAILLMProvider } from "./openai.js";
import { DeepSeekLLMProvider } from "./deepseek.js";
import { LLMProviderWithFallback } from "./fallback.js";

export interface LLMProvider {
  /** Provider name for tracking */
  readonly name: string;

  /** Model identifier for tracking */
  readonly model: string;

  /** Score a single article */
  score(request: ScoringRequest): Promise<ScoringResult>;
}

/**
 * Create a single LLM provider instance.
 */
export const createLLMProvider = (config: LLMProviderConfig): LLMProvider => {
  switch (config.provider) {
    case "claude":
      return new ClaudeLLMProvider(config.apiKey, config.model);
    case "openai":
      return new OpenAILLMProvider(config.apiKey, config.model, config.baseUrl);
    case "deepseek":
      return new DeepSeekLLMProvider(config.apiKey, config.model);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
};

/**
 * Configuration for creating provider with fallback.
 */
export type LLMProviderWithFallbackConfig = {
  primary: LLMProviderConfig;
  fallback?: LLMProviderConfig;
};

/**
 * Create LLM provider with optional fallback.
 *
 * If fallback is configured and primary fails with a retryable error
 * (network, rate limit, server error), automatically tries fallback.
 *
 * @example
 * ```ts
 * const provider = createLLMProviderWithFallback({
 *   primary: { provider: "deepseek", apiKey: "...", model: "deepseek-chat" },
 *   fallback: { provider: "claude", apiKey: "...", model: "claude-sonnet-4-20250514" },
 * });
 * ```
 */
export const createLLMProviderWithFallback = (
  config: LLMProviderWithFallbackConfig,
): LLMProvider => {
  const primary = createLLMProvider(config.primary);
  const fallback = config.fallback ? createLLMProvider(config.fallback) : null;

  return new LLMProviderWithFallback(primary, fallback);
};
