export type TranslationResult = {
  titleKa: string | null;
  summaryKa: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  error?: string;
};
