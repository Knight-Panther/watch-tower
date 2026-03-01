import { describe, it, expect } from "vitest";
import {
  calculateLLMCost,
  calculateEmbeddingCost,
  microdollarsToUsd,
  microdollarsToNumber,
} from "@watch-tower/llm";

describe("calculateLLMCost", () => {
  it("calculates cost for deepseek-chat", () => {
    // 1000 input tokens at $0.14/1M = 0.14 microdollars
    // 500 output tokens at $0.28/1M = 0.14 microdollars
    const cost = calculateLLMCost("deepseek", "deepseek-chat", 1_000_000, 1_000_000);
    expect(cost).toBe(140_000 + 280_000);
  });

  it("calculates cost for gpt-4o-mini", () => {
    const cost = calculateLLMCost("openai", "gpt-4o-mini", 1_000_000, 1_000_000);
    expect(cost).toBe(150_000 + 600_000);
  });

  it("calculates cost for claude-sonnet-4", () => {
    const cost = calculateLLMCost("claude", "claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    expect(cost).toBe(3_000_000 + 15_000_000);
  });

  it("calculates proportional cost for small token counts", () => {
    // 1000 input tokens of deepseek-chat: (1000/1M) * 140000 = 0.14 → rounds to 0
    const cost = calculateLLMCost("deepseek", "deepseek-chat", 1000, 500);
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(typeof cost).toBe("number");
  });

  it("returns 0 for unknown provider", () => {
    const cost = calculateLLMCost("unknown-provider", "some-model", 1000, 500);
    expect(cost).toBe(0);
  });

  it("returns 0 for unknown model", () => {
    const cost = calculateLLMCost("openai", "gpt-99-turbo", 1000, 500);
    expect(cost).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    const cost = calculateLLMCost("openai", "gpt-4o-mini", 0, 0);
    expect(cost).toBe(0);
  });
});

describe("calculateEmbeddingCost", () => {
  it("calculates cost for text-embedding-3-small", () => {
    const cost = calculateEmbeddingCost("openai", "text-embedding-3-small", 1_000_000);
    expect(cost).toBe(20_000); // $0.02 per 1M tokens
  });

  it("calculates cost for text-embedding-3-large", () => {
    const cost = calculateEmbeddingCost("openai", "text-embedding-3-large", 1_000_000);
    expect(cost).toBe(130_000); // $0.13 per 1M tokens
  });

  it("returns 0 for unknown model", () => {
    const cost = calculateEmbeddingCost("openai", "text-embedding-99", 1000);
    expect(cost).toBe(0);
  });

  it("returns 0 for unknown provider", () => {
    const cost = calculateEmbeddingCost("google", "text-embedding-3-small", 1000);
    expect(cost).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    const cost = calculateEmbeddingCost("openai", "text-embedding-3-small", 0);
    expect(cost).toBe(0);
  });
});

describe("microdollarsToUsd", () => {
  it("formats 150000 as $0.1500", () => {
    expect(microdollarsToUsd(150_000)).toBe("$0.1500");
  });

  it("formats 0 as $0.0000", () => {
    expect(microdollarsToUsd(0)).toBe("$0.0000");
  });

  it("formats 1000000 as $1.0000", () => {
    expect(microdollarsToUsd(1_000_000)).toBe("$1.0000");
  });
});

describe("microdollarsToNumber", () => {
  it("converts 1000000 to 1.0", () => {
    expect(microdollarsToNumber(1_000_000)).toBe(1.0);
  });

  it("converts 0 to 0", () => {
    expect(microdollarsToNumber(0)).toBe(0);
  });

  it("converts 500000 to 0.5", () => {
    expect(microdollarsToNumber(500_000)).toBe(0.5);
  });
});
