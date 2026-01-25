import OpenAI from "openai";
import type { EmbeddingProvider } from "./provider.js";

const DEFAULT_MODEL = "text-embedding-3-small";
const DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

// Conservative batch size to avoid token limit errors
// OpenAI limit is ~8191 tokens per input, but total request has limits too
const MAX_BATCH_SIZE = 100;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  readonly model: string;
  readonly dimensions: number;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = DIMENSIONS[model] ?? 1536;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Process in chunks to avoid API limits (token-based, not just count)
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: chunk,
      });

      // Sort by index to ensure order matches input
      const sorted = response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      results.push(...sorted);
    }

    return results;
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }
}
