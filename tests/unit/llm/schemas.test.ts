import { describe, it, expect } from "vitest";
import { parseScoringResponse, ScoringResponseSchema } from "@watch-tower/llm";

describe("ScoringResponseSchema", () => {
  it("coerces string score to number", () => {
    const result = ScoringResponseSchema.parse({ score: "3", summary: "Test" });
    expect(result.score).toBe(3);
    expect(typeof result.score).toBe("number");
  });

  it("rounds decimal scores", () => {
    const result = ScoringResponseSchema.parse({ score: 3.7 });
    expect(result.score).toBe(4);
  });

  it("rejects score below 1", () => {
    expect(() => ScoringResponseSchema.parse({ score: 0 })).toThrow();
  });

  it("rejects score above 5", () => {
    expect(() => ScoringResponseSchema.parse({ score: 10 })).toThrow();
  });

  it("defaults matched_alert_keywords to empty array", () => {
    const result = ScoringResponseSchema.parse({ score: 3 });
    expect(result.matched_alert_keywords).toEqual([]);
  });

  it("truncates summary over 500 chars at word boundary", () => {
    const longSummary = "word ".repeat(120); // 600 chars
    const result = ScoringResponseSchema.parse({ score: 3, summary: longSummary });
    expect(result.summary!.length).toBeLessThanOrEqual(500);
    expect(result.summary!.endsWith("...")).toBe(true);
  });

  it("keeps summary under 500 chars unchanged", () => {
    const result = ScoringResponseSchema.parse({ score: 3, summary: "Short summary" });
    expect(result.summary).toBe("Short summary");
  });

  it("truncates reasoning over 1000 chars", () => {
    const longReasoning = "a".repeat(1500);
    const result = ScoringResponseSchema.parse({ score: 3, reasoning: longReasoning });
    expect(result.reasoning!.length).toBe(1003); // 1000 + "..."
    expect(result.reasoning!.endsWith("...")).toBe(true);
  });

  it("allows missing summary", () => {
    const result = ScoringResponseSchema.parse({ score: 3 });
    expect(result.summary).toBeUndefined();
  });

  it("allows missing reasoning", () => {
    const result = ScoringResponseSchema.parse({ score: 3 });
    expect(result.reasoning).toBeUndefined();
  });

  it("preserves matched_alert_keywords", () => {
    const result = ScoringResponseSchema.parse({
      score: 4,
      matched_alert_keywords: ["FDA approval", "data breach"],
    });
    expect(result.matched_alert_keywords).toEqual(["FDA approval", "data breach"]);
  });
});

describe("parseScoringResponse", () => {
  it("parses valid JSON response", () => {
    const result = parseScoringResponse(
      '{"score": 3, "summary": "Good article", "reasoning": "Because reasons"}',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(3);
      expect(result.data.summary).toBe("Good article");
      expect(result.data.reasoning).toBe("Because reasons");
    }
  });

  it("strips markdown json fences", () => {
    const result = parseScoringResponse(
      '```json\n{"score": 4, "summary": "Breaking news"}\n```',
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.score).toBe(4);
  });

  it("strips plain code fences", () => {
    const result = parseScoringResponse('```\n{"score": 2, "summary": "Routine"}\n```');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.score).toBe(2);
  });

  it("extracts JSON from text with preamble", () => {
    const result = parseScoringResponse(
      'Here is my analysis:\n{"score": 5, "summary": "Critical", "reasoning": "Very important"}',
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.score).toBe(5);
  });

  it("handles string score coercion", () => {
    const result = parseScoringResponse('{"score": "3", "summary": "Test"}');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(3);
      expect(typeof result.data.score).toBe("number");
    }
  });

  it("handles score with alert keywords", () => {
    const result = parseScoringResponse(
      '{"score": 4, "summary": "FDA news", "matched_alert_keywords": ["FDA approval"]}',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matched_alert_keywords).toEqual(["FDA approval"]);
    }
  });

  it("defaults matched_alert_keywords when missing", () => {
    const result = parseScoringResponse('{"score": 3, "summary": "Test"}');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matched_alert_keywords).toEqual([]);
    }
  });

  it("ignores extra fields in JSON", () => {
    const result = parseScoringResponse(
      '{"score": 3, "summary": "Test", "extra_field": "ignored", "another": 42}',
    );
    expect(result.success).toBe(true);
  });

  it("fails on malformed JSON", () => {
    const result = parseScoringResponse("{score: 3, summary: bad}");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeDefined();
  });

  it("fails on empty string", () => {
    const result = parseScoringResponse("");
    expect(result.success).toBe(false);
  });

  it("fails when no JSON object found", () => {
    const result = parseScoringResponse("This is just plain text with no JSON");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("No JSON object found");
  });

  it("fails on missing score field", () => {
    const result = parseScoringResponse('{"summary": "No score here"}');
    expect(result.success).toBe(false);
  });
});
