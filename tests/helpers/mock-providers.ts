/**
 * Mock providers for integration tests.
 *
 * Replaces real LLM, embedding, and event-publishing API calls with in-process
 * implementations that are fast, deterministic, and free. Each factory exposes
 * test-control handles (call history, score overrides) so tests can assert on
 * provider interactions without network I/O.
 */

import type { LLMProvider } from "@watch-tower/llm";
import type { ScoringRequest, ScoringResult } from "@watch-tower/llm";
import type { EmbeddingProvider } from "@watch-tower/embeddings";
import type { EventPublisher } from "@watch-tower/worker/events";
import type { ServerEvent } from "@watch-tower/shared";

// ─── Mock LLM Provider ───────────────────────────────────────────────────────

/**
 * Extended interface that exposes test-control handles on the mock LLM provider.
 */
export type MockLLMProvider = LLMProvider & {
  /** All score() calls received, in order. Useful for assertion. */
  readonly scoreCalls: ScoringRequest[];

  /**
   * Override the score returned for the very next score() call.
   * Automatically resets to the default after use (one-shot).
   */
  setNextScore(score: number): void;

  /**
   * Override scores by article ID. Takes precedence over the default score
   * but is superseded by setNextScore() if both are set.
   */
  setScoreMap(map: Record<string, number>): void;
};

/**
 * Create a mock LLM provider that returns configurable scores without making
 * any real API calls.
 *
 * @param defaultScore - Score returned when no per-call or per-article override applies (1-5).
 * @param defaultSummary - Summary string returned in every ScoringResult.
 */
export const createMockLLMProvider = (
  defaultScore = 3,
  defaultSummary = "Test summary from mock LLM.",
): MockLLMProvider => {
  let nextScore: number | null = null;
  const scoreMap = new Map<string, number>();
  const scoreCalls: ScoringRequest[] = [];

  const provider: MockLLMProvider = {
    name: "mock",
    model: "mock-model-v1",

    get scoreCalls() {
      return scoreCalls;
    },

    setNextScore(score: number): void {
      nextScore = score;
    },

    setScoreMap(map: Record<string, number>): void {
      scoreMap.clear();
      for (const [key, val] of Object.entries(map)) {
        scoreMap.set(key, val);
      }
    },

    async score(request: ScoringRequest): Promise<ScoringResult> {
      scoreCalls.push(request);

      // Priority: one-shot override → per-article map → default
      const score = nextScore ?? scoreMap.get(request.articleId) ?? defaultScore;
      nextScore = null; // Consume the one-shot override

      return {
        articleId: request.articleId,
        score,
        summary: defaultSummary,
        reasoning: `Mock reasoning: scored ${score}/5`,
        matchedAlertKeywords: [],
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
        },
        latencyMs: 50,
      };
    },
  };

  return provider;
};

// ─── Mock Embedding Provider ─────────────────────────────────────────────────

/**
 * Create a mock embedding provider that produces deterministic 1536-dim vectors
 * without calling any external API.
 *
 * The embedding algorithm is a simple character-position hash followed by L2
 * normalization, which guarantees that identical texts produce identical vectors
 * (useful for dedup tests) while different texts produce different vectors
 * (useful for similarity search tests).
 */
export const createMockEmbeddingProvider = (): EmbeddingProvider => {
  const DIMS = 1536;

  const textToEmbedding = (text: string): number[] => {
    const embedding = new Array<number>(DIMS).fill(0);

    for (let i = 0; i < text.length; i++) {
      const idx = i % DIMS;
      embedding[idx] += text.charCodeAt(i) / 1000;
    }

    // L2 normalize so the vector lives on the unit sphere — matches pgvector
    // cosine similarity expectations.
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return magnitude > 0 ? embedding.map((v) => v / magnitude) : embedding;
  };

  return {
    name: "mock-openai",
    model: "text-embedding-3-small",
    dimensions: DIMS,

    async embed(text: string): Promise<number[]> {
      return textToEmbedding(text);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(textToEmbedding);
    },
  };
};

// ─── Mock Event Publisher ────────────────────────────────────────────────────

/**
 * Extended interface that exposes the captured event list on the mock publisher.
 */
export type MockEventPublisher = EventPublisher & {
  /** All events published, in order. */
  readonly events: ServerEvent[];
};

/**
 * Create a mock event publisher that captures published events in-memory instead
 * of writing to Redis pub/sub. Useful for asserting that pipeline stages emit
 * the correct SSE events.
 */
export const createMockEventPublisher = (): MockEventPublisher => {
  const events: ServerEvent[] = [];

  const publisher: MockEventPublisher = {
    get events() {
      return events;
    },

    async publish(event: ServerEvent): Promise<void> {
      events.push(event);
    },
  };

  return publisher;
};
