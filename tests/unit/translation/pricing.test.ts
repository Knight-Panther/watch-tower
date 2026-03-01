import { describe, it, expect } from "vitest";
import { calculateTranslationCost } from "@watch-tower/translation";

describe("calculateTranslationCost", () => {
  it("calculates cost for gemini-2.5-flash", () => {
    // Pricing: input 150,000 µ$/1M tokens, output 600,000 µ$/1M tokens
    const cost = calculateTranslationCost("gemini-2.5-flash", 1000, 500);
    // input: (1000/1M) * 150,000 = 150 µ$
    // output: (500/1M) * 600,000 = 300 µ$
    // total: 450 µ$
    expect(cost).toBe(450);
  });

  it("calculates cost for larger token counts", () => {
    // 100K input, 50K output with gemini-2.5-flash
    const cost = calculateTranslationCost("gemini-2.5-flash", 100_000, 50_000);
    // input: (100K/1M) * 150,000 = 15,000 µ$
    // output: (50K/1M) * 600,000 = 30,000 µ$
    // total: 45,000 µ$
    expect(cost).toBe(45_000);
  });

  it("calculates cost for gpt-4o-mini", () => {
    // Pricing: input 150,000 µ$/1M, output 600,000 µ$/1M (same as gemini-2.5-flash)
    const cost = calculateTranslationCost("gpt-4o-mini", 100_000, 50_000);
    expect(cost).toBe(45_000);
  });

  it("calculates cost for gpt-4o (expensive)", () => {
    // Pricing: input 2,500,000 µ$/1M, output 10,000,000 µ$/1M
    const cost = calculateTranslationCost("gpt-4o", 10_000, 5_000);
    // input: (10K/1M) * 2,500,000 = 25,000 µ$
    // output: (5K/1M) * 10,000,000 = 50,000 µ$
    // total: 75,000 µ$
    expect(cost).toBe(75_000);
  });

  it("calculates cost for gemini-2.5-pro", () => {
    // Pricing: input 1,250,000 µ$/1M, output 10,000,000 µ$/1M
    const cost = calculateTranslationCost("gemini-2.5-pro", 10_000, 5_000);
    // input: (10K/1M) * 1,250,000 = 12,500 µ$
    // output: (5K/1M) * 10,000,000 = 50,000 µ$
    // total: 62,500 µ$
    expect(cost).toBe(62_500);
  });

  it("returns 0 for unknown model", () => {
    const cost = calculateTranslationCost("unknown-model", 100_000, 50_000);
    expect(cost).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    const cost = calculateTranslationCost("gemini-2.5-flash", 0, 0);
    expect(cost).toBe(0);
  });

  it("handles input-only scenario", () => {
    const cost = calculateTranslationCost("gemini-2.5-flash", 1_000_000, 0);
    // input: (1M/1M) * 150,000 = 150,000
    // output: 0
    expect(cost).toBe(150_000);
  });

  it("handles output-only scenario", () => {
    const cost = calculateTranslationCost("gemini-2.5-flash", 0, 1_000_000);
    // output: (1M/1M) * 600,000 = 600,000
    expect(cost).toBe(600_000);
  });

  it("rounds to nearest integer", () => {
    // Pick values that produce a fractional result
    const cost = calculateTranslationCost("gemini-2.5-pro", 1, 1);
    // input: (1/1M) * 1,250,000 = 1.25
    // output: (1/1M) * 10,000,000 = 10
    // total: 11.25 → rounds to 11
    expect(cost).toBe(11);
  });
});
