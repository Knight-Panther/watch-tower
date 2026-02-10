// Pricing in microdollars per 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  // Gemini
  "gemini-2.5-flash": { input: 150_000, output: 600_000 },
  "gemini-2.5-flash-lite": { input: 100_000, output: 400_000 },
  "gemini-2.5-pro": { input: 1_250_000, output: 10_000_000 },
  "gemini-3-flash-preview": { input: 500_000, output: 3_000_000 },
  "gemini-3-pro-preview": { input: 2_000_000, output: 12_000_000 },
  // OpenAI
  "gpt-4o-mini": { input: 150_000, output: 600_000 },
  "gpt-4o": { input: 2_500_000, output: 10_000_000 },
  "gpt-4.1-mini": { input: 400_000, output: 1_600_000 },
  "gpt-4.1-nano": { input: 100_000, output: 400_000 },
};

export const calculateTranslationCost = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): number => {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round(inputCost + outputCost);
};
