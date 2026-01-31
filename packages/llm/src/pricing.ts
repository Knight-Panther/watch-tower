/**
 * LLM and Embedding pricing configuration.
 * Prices are in microdollars per 1M tokens ($1 = 1,000,000 microdollars).
 * This allows integer math for precision and easy aggregation.
 */

// LLM pricing: { input: price per 1M input tokens, output: price per 1M output tokens }
export const LLM_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  deepseek: {
    "deepseek-chat": { input: 140_000, output: 280_000 }, // $0.14/$0.28 per 1M
  },
  openai: {
    "gpt-4o-mini": { input: 150_000, output: 600_000 }, // $0.15/$0.60 per 1M
    "gpt-4o": { input: 2_500_000, output: 10_000_000 }, // $2.50/$10.00 per 1M
  },
  claude: {
    "claude-sonnet-4-20250514": { input: 3_000_000, output: 15_000_000 }, // $3.00/$15.00 per 1M
    "claude-3-5-sonnet-20241022": { input: 3_000_000, output: 15_000_000 },
    "claude-3-haiku-20240307": { input: 250_000, output: 1_250_000 }, // $0.25/$1.25 per 1M
  },
};

// Embedding pricing: price per 1M tokens
export const EMBEDDING_PRICING: Record<string, Record<string, number>> = {
  openai: {
    "text-embedding-3-small": 20_000, // $0.02 per 1M tokens
    "text-embedding-3-large": 130_000, // $0.13 per 1M tokens
    "text-embedding-ada-002": 100_000, // $0.10 per 1M tokens
  },
};

/**
 * Calculate cost in microdollars for an LLM call.
 * Returns 0 if pricing not found for provider/model combo.
 */
export const calculateLLMCost = (
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number => {
  const pricing = LLM_PRICING[provider]?.[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round(inputCost + outputCost);
};

/**
 * Calculate cost in microdollars for an embedding call.
 * Returns 0 if pricing not found for provider/model combo.
 */
export const calculateEmbeddingCost = (
  provider: string,
  model: string,
  tokens: number,
): number => {
  const pricing = EMBEDDING_PRICING[provider]?.[model];
  if (!pricing) return 0;

  return Math.round((tokens / 1_000_000) * pricing);
};

/**
 * Convert microdollars to formatted USD string.
 * @example microdollarsToUsd(150000) => "$0.1500"
 */
export const microdollarsToUsd = (microdollars: number): string => {
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
};

/**
 * Convert microdollars to number (USD).
 * @example microdollarsToNumber(150000) => 0.15
 */
export const microdollarsToNumber = (microdollars: number): number => {
  return microdollars / 1_000_000;
};
