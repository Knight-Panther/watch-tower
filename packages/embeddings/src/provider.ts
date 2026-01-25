import { OpenAIEmbeddingProvider } from "./openai.js";

export interface EmbeddingProvider {
  /** Model identifier for tracking */
  readonly model: string;

  /** Vector dimensions produced by this model */
  readonly dimensions: number;

  /** Generate embeddings for multiple texts (batch) */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Generate embedding for single text */
  embed(text: string): Promise<number[]>;
}

export type EmbeddingProviderConfig = {
  provider: "openai";
  apiKey: string;
  model?: string; // default: text-embedding-3-small
};

export const createEmbeddingProvider = (config: EmbeddingProviderConfig): EmbeddingProvider => {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(config.apiKey, config.model);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
};
