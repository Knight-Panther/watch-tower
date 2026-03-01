import { describe, it, expect } from "vitest";
import { scoringConfigSchema, defaultScoringConfig, securityEnvSchema } from "@watch-tower/shared";

describe("scoringConfigSchema", () => {
  it("parses empty object with all defaults", () => {
    const result = scoringConfigSchema.parse({});
    expect(result.priorities).toEqual([]);
    expect(result.ignore).toEqual([]);
    expect(result.rejectKeywords).toEqual([]);
    expect(result.summaryMaxChars).toBe(200);
    expect(result.summaryTone).toBe("professional");
    expect(result.summaryLanguage).toBe("English");
    expect(result.examples).toEqual([]);
  });

  it("accepts valid priorities", () => {
    const result = scoringConfigSchema.parse({ priorities: ["AI", "Biotech"] });
    expect(result.priorities).toEqual(["AI", "Biotech"]);
  });

  it("rejects priorities exceeding max 20 items", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `item${i}`);
    expect(() => scoringConfigSchema.parse({ priorities: tooMany })).toThrow();
  });

  it("rejects empty string in priorities", () => {
    expect(() => scoringConfigSchema.parse({ priorities: [""] })).toThrow();
  });

  it("accepts custom score definitions", () => {
    const result = scoringConfigSchema.parse({ score1: "Junk", score5: "Critical" });
    expect(result.score1).toBe("Junk");
    expect(result.score5).toBe("Critical");
  });

  it("rejects score definition over 500 chars", () => {
    expect(() => scoringConfigSchema.parse({ score1: "x".repeat(501) })).toThrow();
  });

  it("accepts valid examples", () => {
    const result = scoringConfigSchema.parse({
      examples: [{ title: "Test", score: 3, reasoning: "Because" }],
    });
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0].score).toBe(3);
  });

  it("rejects more than 6 examples", () => {
    const tooMany = Array.from({ length: 7 }, (_, i) => ({
      title: `Example ${i}`,
      score: 3,
      reasoning: "Reason",
    }));
    expect(() => scoringConfigSchema.parse({ examples: tooMany })).toThrow();
  });

  it("rejects example with score outside 1-5", () => {
    expect(() =>
      scoringConfigSchema.parse({ examples: [{ title: "Bad", score: 6, reasoning: "Why" }] }),
    ).toThrow();
  });

  it("validates summaryMaxChars range (50-500)", () => {
    expect(scoringConfigSchema.parse({ summaryMaxChars: 50 }).summaryMaxChars).toBe(50);
    expect(scoringConfigSchema.parse({ summaryMaxChars: 500 }).summaryMaxChars).toBe(500);
    expect(() => scoringConfigSchema.parse({ summaryMaxChars: 49 })).toThrow();
    expect(() => scoringConfigSchema.parse({ summaryMaxChars: 501 })).toThrow();
  });

  it("validates summaryTone enum", () => {
    expect(scoringConfigSchema.parse({ summaryTone: "casual" }).summaryTone).toBe("casual");
    expect(scoringConfigSchema.parse({ summaryTone: "urgent" }).summaryTone).toBe("urgent");
    expect(() => scoringConfigSchema.parse({ summaryTone: "funny" })).toThrow();
  });
});

describe("defaultScoringConfig", () => {
  it("has all expected default values", () => {
    expect(defaultScoringConfig.priorities).toEqual([]);
    expect(defaultScoringConfig.ignore).toEqual([]);
    expect(defaultScoringConfig.summaryMaxChars).toBe(200);
    expect(defaultScoringConfig.summaryTone).toBe("professional");
    expect(defaultScoringConfig.summaryLanguage).toBe("English");
    expect(defaultScoringConfig.score1).toContain("Noise");
    expect(defaultScoringConfig.score5).toContain("Breaking");
  });
});

describe("securityEnvSchema", () => {
  it("applies correct defaults", () => {
    const result = securityEnvSchema.parse({});
    expect(result.MAX_FEED_SIZE_MB).toBe(5);
    expect(result.MAX_ARTICLES_PER_FETCH).toBe(100);
    expect(result.MAX_ARTICLES_PER_SOURCE_DAILY).toBe(500);
    expect(result.ALLOWED_ORIGINS).toBe("http://localhost:5173");
    expect(result.API_RATE_LIMIT_PER_MINUTE).toBe(200);
  });

  it("coerces string to number", () => {
    const result = securityEnvSchema.parse({ MAX_FEED_SIZE_MB: "10" });
    expect(result.MAX_FEED_SIZE_MB).toBe(10);
  });

  it("rejects out-of-range values", () => {
    expect(() => securityEnvSchema.parse({ MAX_FEED_SIZE_MB: 0 })).toThrow();
    expect(() => securityEnvSchema.parse({ MAX_FEED_SIZE_MB: 51 })).toThrow();
    expect(() => securityEnvSchema.parse({ MAX_ARTICLES_PER_FETCH: 5 })).toThrow();
    expect(() => securityEnvSchema.parse({ MAX_ARTICLES_PER_FETCH: 501 })).toThrow();
  });
});
