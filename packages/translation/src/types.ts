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
  isTransient?: boolean; // True for 429, 500, 503, network errors
};
